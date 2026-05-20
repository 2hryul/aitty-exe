using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Aitty.Models;

namespace Aitty.Services;

/// <summary>
/// OpenAI ChatCompletion API 서비스.
/// - 스트리밍: stream_options.include_usage=true → 마지막 청크에서 usage 수집
/// - 모델 목록: /v1/models API 동적 조회 (gpt- 접두사 필터)
/// - 인증: Authorization: Bearer {apiKey}
/// </summary>
public class OpenAiService : IAiService
{
    // 기본값은 공식 OpenAI. SetBaseUrl로 Shinhan Hands, Azure OpenAI, vLLM, OpenRouter 등 호환 게이트웨이 연결 가능
    private const string DefaultBaseUrl = "https://api.openai.com";

    private string _baseUrl = DefaultBaseUrl;
    private string ChatUrl   => $"{_baseUrl}/v1/chat/completions";
    private string ModelsUrl => $"{_baseUrl}/v1/models";

    private static readonly string[] DefaultModels =
    [
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-4-turbo",
        "gpt-3.5-turbo",
    ];

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private HttpClient _httpClient = HttpClientHelper.Create(allowInsecureSsl: false);

    public void SetAllowInsecureSsl(bool allow)
    {
        var oldClient = _httpClient;
        _httpClient = HttpClientHelper.Create(allow);
        try { oldClient.Dispose(); } catch { /* ignore */ }
    }

    private readonly List<AiChatMessage> _history = new();
    private readonly object _historyLock = new();

    private string _apiKey = string.Empty;
    private string _model = "gpt-4o";
    private string? _systemPrompt;

    /// <summary>
    /// 게이트웨이(LiteLLM 등)의 "This token can only access models=[...]" 응답에서 추출한
    /// 허용 모델 목록. ListModelsAsync가 /v1/models 미지원 시 이 목록을 반환하여 UI 드롭다운 자동 채움.
    /// </summary>
    private List<string> _discoveredModels = new();

    public string ProviderName  => "openai";
    public string CurrentModel  => _model;
    public string? SystemPrompt => _systemPrompt;
    public bool IsConfigured => !string.IsNullOrWhiteSpace(_apiKey);
    public IReadOnlyList<AiChatMessage> History => _history.AsReadOnly();
    public string CurrentBaseUrl => _baseUrl;

    // ── IAiService 디폴트 노출 (SoT) ──────────────────────── //
    public string DefaultModel => "gpt-4o-mini";
    public string? DefaultSystemPrompt => null;
    public string BaseUrl => _baseUrl;

    public OpenAiService() { }

    public void SetApiKey(string apiKey)
    {
        var changed = !string.Equals(_apiKey, apiKey?.Trim() ?? string.Empty, StringComparison.Ordinal);
        _apiKey = apiKey?.Trim() ?? string.Empty;
        if (changed) _discoveredModels.Clear();  // API 키별로 허용 모델이 다름 → 재발견 필요
    }

    /// <summary>
    /// OpenAI 호환 Base URL 설정. 사용자가 full URL(/v1/chat/completions 또는 /v1)을 붙여넣어도
    /// 자동으로 base까지만 잘라 저장 → Chat/Models URL은 동적으로 조합.
    /// 빈 값이면 공식 OpenAI로 복원.
    /// </summary>
    public void SetBaseUrl(string? url)
    {
        var before = _baseUrl;
        if (string.IsNullOrWhiteSpace(url))
        {
            _baseUrl = DefaultBaseUrl;
        }
        else
        {
            var trimmed = url.Trim().TrimEnd('/');
            // 사용자가 /v1/chat/completions 혹은 /v1 까지 포함해서 붙여넣는 경우 정규화
            if (trimmed.EndsWith("/v1/chat/completions", StringComparison.OrdinalIgnoreCase))
                trimmed = trimmed[..^"/v1/chat/completions".Length];
            else if (trimmed.EndsWith("/v1", StringComparison.OrdinalIgnoreCase))
                trimmed = trimmed[..^"/v1".Length];
            _baseUrl = string.IsNullOrWhiteSpace(trimmed) ? DefaultBaseUrl : trimmed;
        }
        AiRequestLogger.LogSetting("openai", "BaseUrl", $"input={url} normalized={_baseUrl} ChatUrl={ChatUrl}");
        if (before != _baseUrl)
        {
            AiRequestLogger.LogInfo($"[OpenAI] Base URL changed: {before} → {_baseUrl}");
            _discoveredModels.Clear();  // 다른 게이트웨이 → 허용 모델 재발견 필요
        }
    }

    public void SetModel(string model) => _model = model;
    public void SetSystemPrompt(string? prompt) => _systemPrompt = prompt;
    public void SetHistory(IEnumerable<AiChatMessage> messages)
    {
        lock (_historyLock) { _history.Clear(); _history.AddRange(messages); }
    }
    public void ClearHistory() { lock (_historyLock) _history.Clear(); }

    /// <summary>현재 Base URL이 공식 OpenAI가 아닌 호환 게이트웨이인지 여부.</summary>
    private bool IsCustomBaseUrl => !_baseUrl.Equals(DefaultBaseUrl, StringComparison.OrdinalIgnoreCase);

    // ── 가용성 확인 ───────────────────────────────────────── //

    public async Task<bool> IsEngineAvailableAsync(CancellationToken ct = default)
    {
        if (!IsConfigured)
        {
            AiRequestLogger.LogInfo("[OpenAI] IsEngineAvailable: not configured (no API key)");
            return false;
        }

        // 커스텀 게이트웨이(vLLM, Shinhan Hands 등)는 GET /v1/models 미구현 가능성이 높음.
        // Postman처럼 실제 엔드포인트(POST /v1/chat/completions)로만 검증하거나, 그것도 불필요하므로 API 키 존재로 판정.
        // 공식 OpenAI만 GET /v1/models로 표준 검증 (토큰 미소모, 빠름).
        if (IsCustomBaseUrl)
        {
            AiRequestLogger.LogInfo($"[OpenAI] 커스텀 Base URL 감지 ({_baseUrl}) — GET /v1/models 스킵, API 키 존재만으로 가용 판정 (실제 검증은 POST /v1/chat/completions에서)");
            return true;
        }

        var sw = Stopwatch.StartNew();
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, ModelsUrl);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
            AiRequestLogger.LogRequest(req, note: "공식 OpenAI 가용성 확인용 GET /v1/models");
            using var response = await _httpClient.SendAsync(req, ct);
            var body = await response.Content.ReadAsStringAsync(ct);
            sw.Stop();
            AiRequestLogger.LogResponse(response, body, sw.ElapsedMilliseconds);
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            sw.Stop();
            AiRequestLogger.LogException("IsEngineAvailableAsync", ex, sw.ElapsedMilliseconds);
            return false;
        }
    }

    // ── 모델 목록 ─────────────────────────────────────────── //

    public async Task<List<string>> ListModelsAsync(CancellationToken ct = default)
    {
        if (!IsConfigured) return IsCustomBaseUrl ? new List<string>(_discoveredModels) : DefaultModels.ToList();

        // 커스텀 게이트웨이는 GET /v1/models 미구현 가능 → 이전 채팅에서 감지된 허용 모델 목록 반환.
        // 아직 감지 전이라면 빈 목록 → 사용자가 모델명 직접 입력.
        if (IsCustomBaseUrl)
        {
            if (_discoveredModels.Count > 0)
            {
                AiRequestLogger.LogInfo($"[OpenAI] 커스텀 Base URL — 감지된 허용 모델 반환: [{string.Join(", ", _discoveredModels)}]");
                return new List<string>(_discoveredModels);
            }
            AiRequestLogger.LogInfo($"[OpenAI] 커스텀 Base URL — GET /v1/models 스킵. 모델 아직 감지 안 됨(첫 채팅 시 자동 감지).");
            return new List<string>();
        }

        var sw = Stopwatch.StartNew();
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, ModelsUrl);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
            AiRequestLogger.LogRequest(req, note: "공식 OpenAI 모델 목록 GET /v1/models");
            using var response = await _httpClient.SendAsync(req, ct);
            var json = await response.Content.ReadAsStringAsync(ct);
            sw.Stop();
            AiRequestLogger.LogResponse(response, json, sw.ElapsedMilliseconds);
            if (!response.IsSuccessStatusCode)
            {
                // 커스텀 게이트웨이가 /v1/models 미지원이면 빈 목록 반환
                // → UI에서 사용자가 직접 모델명 입력 가능 (Shinhan Hands는 qwen2.5-coder:7b 등)
                return IsCustomBaseUrl ? new List<string>() : DefaultModels.ToList();
            }

            using var doc = JsonDocument.Parse(json);

            if (!doc.RootElement.TryGetProperty("data", out var data))
                return IsCustomBaseUrl ? new List<string>() : DefaultModels.ToList();

            // 커스텀 게이트웨이는 gpt- 접두사 필터 제외 (qwen, llama, claude 등 다양한 모델)
            var models = data.EnumerateArray()
                .Select(m => m.TryGetProperty("id", out var id) ? id.GetString() : null)
                .Where(id => !string.IsNullOrWhiteSpace(id))
                .Where(id => IsCustomBaseUrl || id!.StartsWith("gpt-"))
                .Select(id => id!)
                .OrderByDescending(id => id)
                .ToList();

            if (models.Count > 0) return models;
            return IsCustomBaseUrl ? new List<string>() : DefaultModels.ToList();
        }
        catch (Exception ex)
        {
            sw.Stop();
            AiRequestLogger.LogException("ListModelsAsync", ex, sw.ElapsedMilliseconds);
            return IsCustomBaseUrl ? new List<string>() : DefaultModels.ToList();
        }
    }

    // ── 비스트리밍 전송 ───────────────────────────────────── //

    public async Task<AiChatResponse> SendMessageAsync(string userMessage, CancellationToken ct = default)
    {
        if (!IsConfigured)
            throw new InvalidOperationException("OpenAI API 키가 설정되지 않았습니다.");

        var sw = Stopwatch.StartNew();
        lock (_historyLock)
            _history.Add(new AiChatMessage { Role = "user", Content = userMessage });

        // 게이트웨이가 API 키별로 모델을 제한하는 경우 1회 자동 교정 후 재시도
        HttpResponseMessage? response = null;
        string responseText = string.Empty;
        for (int attempt = 0; attempt < 2; attempt++)
        {
            var body = BuildRequestBody(stream: false);
            var json = JsonSerializer.Serialize(body, JsonOptions);
            using var httpReq = new HttpRequestMessage(HttpMethod.Post, ChatUrl)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json")
            };
            httpReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
            AiRequestLogger.LogRequest(httpReq, bodyJson: json,
                note: attempt == 0 ? "비스트리밍 채팅 전송" : $"비스트리밍 재시도 (모델 자동 교정 → {_model})");

            try
            {
                response = await _httpClient.SendAsync(httpReq, ct);
                responseText = await response.Content.ReadAsStringAsync(ct);
                AiRequestLogger.LogResponse(response, responseText, sw.ElapsedMilliseconds);
            }
            catch (Exception ex)
            {
                AiRequestLogger.LogException("SendMessageAsync.Send", ex, sw.ElapsedMilliseconds);
                lock (_historyLock)
                    _history.RemoveAt(_history.Count - 1);
                response?.Dispose();
                throw;
            }

            if (response.IsSuccessStatusCode) break;

            // 401 + "models=['X', 'Y', ...]" 패턴이면 모델 자동 교정 + 재시도 (단 1회)
            if (attempt == 0 && response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
            {
                var allowedList = ExtractAllowedModels(responseText);
                if (allowedList.Count > 0)
                {
                    // 발견된 모델 전체를 캐시 — ListModelsAsync가 반환하여 UI 드롭다운 채움
                    _discoveredModels = allowedList;
                    AiRequestLogger.LogInfo($"[OpenAI] 🔍 허용 모델 감지: [{string.Join(", ", allowedList)}]");

                    var target = allowedList[0];
                    if (!string.Equals(target, _model, StringComparison.Ordinal))
                    {
                        var oldModel = _model;
                        _model = target;
                        AiRequestLogger.LogInfo($"[OpenAI] 🔧 모델 자동 교정: '{oldModel}' → '{target}' (API 키에 허용된 모델로 교체, 재시도)");
                        response.Dispose();
                        response = null;
                        continue;
                    }
                }
            }

            // 기타 오류 또는 재시도 소진
            lock (_historyLock)
                _history.RemoveAt(_history.Count - 1);
            var err = BuildApiError(response.StatusCode, responseText);
            response.Dispose();
            throw new Exception(err);
        }

        using var doc = JsonDocument.Parse(responseText);
        var root = doc.RootElement;

        var text = root.TryGetProperty("choices", out var choices) && choices.GetArrayLength() > 0
            ? choices[0].GetProperty("message").GetProperty("content").GetString() ?? string.Empty
            : string.Empty;

        var finishReason = root.TryGetProperty("choices", out var ch2) && ch2.GetArrayLength() > 0
            ? ch2[0].TryGetProperty("finish_reason", out var fr) ? fr.GetString() ?? "stop" : "stop"
            : "stop";

        int inputTokens = 0, outputTokens = 0;
        if (root.TryGetProperty("usage", out var usage))
        {
            inputTokens  = usage.TryGetProperty("prompt_tokens",     out var pt) ? pt.GetInt32()  : 0;
            outputTokens = usage.TryGetProperty("completion_tokens", out var ct2) ? ct2.GetInt32() : 0;
        }

        lock (_historyLock)
            _history.Add(new AiChatMessage { Role = "assistant", Content = text });
        sw.Stop();
        response?.Dispose();

        return new AiChatResponse
        {
            Content      = text,
            Model        = _model,
            InputTokens  = inputTokens,
            OutputTokens = outputTokens,
            FinishReason = finishReason,
            DurationMs   = sw.ElapsedMilliseconds,
        };
    }

    // ── SSE 스트리밍 전송 (include_usage로 마지막 청크에서 usage 수집) ── //

    public async Task<AiChatResponse> SendStreamingAsync(string userMessage, Action<string> onChunk, CancellationToken ct = default)
    {
        if (!IsConfigured)
            throw new InvalidOperationException("OpenAI API 키가 설정되지 않았습니다.");

        // 커스텀 Base URL(Shinhan Hands/vLLM/LiteLLM 등)도 SSE 지원하는 게이트웨이가 있을 수 있으므로
        // 일단 스트리밍으로 시도 → 빈 응답/실패 시 아래 non-streaming 폴백이 자동 구제 (한 번의 사용자 요청 범위 내 1회)
        var sw = Stopwatch.StartNew();
        lock (_historyLock)
            _history.Add(new AiChatMessage { Role = "user", Content = userMessage });

        // 게이트웨이의 API 키별 모델 제한 감지 → 1회 자동 교정 + 재시도
        HttpResponseMessage response = null!;
        for (int attempt = 0; attempt < 2; attempt++)
        {
            var body = BuildRequestBody(stream: true);
            var json = JsonSerializer.Serialize(body, JsonOptions);
            var request = new HttpRequestMessage(HttpMethod.Post, ChatUrl)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json"),
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
            AiRequestLogger.LogRequest(request, bodyJson: json,
                note: attempt == 0 ? "스트리밍 채팅 전송 (SSE)" : $"스트리밍 재시도 (모델 자동 교정 → {_model})");

            try
            {
                response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)
                    .ConfigureAwait(false);
                // 스트림 본문은 루프 종료 후 별도로 로깅 (rawStreamLog 누적)
                AiRequestLogger.LogResponse(response, bodyText: "(streaming body — captured below)", sw.ElapsedMilliseconds);
            }
            catch (Exception ex)
            {
                AiRequestLogger.LogException("SendStreamingAsync.Send", ex, sw.ElapsedMilliseconds);
                lock (_historyLock)
                    _history.RemoveAt(_history.Count - 1);
                request.Dispose();
                throw;
            }

            if (response.IsSuccessStatusCode)
            {
                request.Dispose();  // 요청 메시지는 여기서 해제 (응답은 아래 스트림 읽기 후 dispose)
                break;
            }

            // 401 + 모델 제한 에러 → 자동 교정 후 재시도
            var errorBody = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            AiRequestLogger.LogInfo($"[OpenAI] 스트리밍 HTTP 오류 본문: {errorBody}");
            if (attempt == 0 && response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
            {
                var allowedList = ExtractAllowedModels(errorBody);
                if (allowedList.Count > 0)
                {
                    _discoveredModels = allowedList;
                    AiRequestLogger.LogInfo($"[OpenAI] 🔍 허용 모델 감지: [{string.Join(", ", allowedList)}]");

                    var target = allowedList[0];
                    if (!string.Equals(target, _model, StringComparison.Ordinal))
                    {
                        var oldModel = _model;
                        _model = target;
                        AiRequestLogger.LogInfo($"[OpenAI] 🔧 스트리밍 모델 자동 교정: '{oldModel}' → '{target}' (재시도)");
                        response.Dispose();
                        request.Dispose();
                        continue;
                    }
                }
            }

            lock (_historyLock)
                _history.RemoveAt(_history.Count - 1);
            response.Dispose();
            request.Dispose();
            throw new Exception(BuildApiError(response.StatusCode, errorBody));
        }
        using var _disposeResp = response; // 아래 스트림 읽기 후 dispose 보장

        var builder     = new StringBuilder();
        var finishReason = "stop";
        int inputTokens  = 0;
        int outputTokens = 0;

        // 스트림 본문 전체 캡처 — 빈 응답 등 디버깅용. 4KB 상한(앞 2KB + 뒤 2KB).
        var rawStreamLog = new StringBuilder();
        int lineCount = 0;

        using var stream = await response.Content.ReadAsStreamAsync(ct)
            .ConfigureAwait(false);
        using var reader = new System.IO.StreamReader(stream);

        while (!reader.EndOfStream && !ct.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(ct)
                .ConfigureAwait(false);
            if (line is null) break;
            // 빈 줄도 포함해서 기록 (SSE 프레임 구분자 진단용) — 단 파싱은 스킵
            lineCount++;
            if (rawStreamLog.Length < 4096) rawStreamLog.Append(line).Append('\n');
            if (string.IsNullOrWhiteSpace(line)) continue;

            // SSE 표준은 "data: " (공백 포함)이지만 일부 게이트웨이는 공백 없이 "data:"로 보내는 경우가 있어 둘 다 허용
            string data;
            if (line.StartsWith("data: ", StringComparison.Ordinal))       data = line[6..];
            else if (line.StartsWith("data:", StringComparison.Ordinal))   data = line[5..];
            else continue;

            if (data == "[DONE]") break;

            try
            {
                using var doc  = JsonDocument.Parse(data);
                var root = doc.RootElement;

                // usage 전용 청크 (choices 배열이 비어 있음)
                if (root.TryGetProperty("usage", out var usageEl) && usageEl.ValueKind == JsonValueKind.Object)
                {
                    inputTokens  = usageEl.TryGetProperty("prompt_tokens",     out var pt)  ? pt.GetInt32()  : inputTokens;
                    outputTokens = usageEl.TryGetProperty("completion_tokens", out var ct2) ? ct2.GetInt32() : outputTokens;
                }

                if (!root.TryGetProperty("choices", out var choices) || choices.GetArrayLength() == 0)
                    continue;

                var choice = choices[0];

                // finish_reason 캡처
                if (choice.TryGetProperty("finish_reason", out var fr) && fr.ValueKind == JsonValueKind.String)
                    finishReason = fr.GetString() ?? finishReason;

                // delta 청크 — content + reasoning_content 둘 다 지원
                // (Qwen/DeepSeek thinking 모델은 초반에 reasoning_content만 전송하기도 함)
                if (choice.TryGetProperty("delta", out var delta))
                {
                    if (delta.TryGetProperty("content", out var contentEl) &&
                        contentEl.ValueKind == JsonValueKind.String)
                    {
                        var chunk = contentEl.GetString();
                        if (!string.IsNullOrEmpty(chunk))
                        {
                            builder.Append(chunk);
                            onChunk(chunk);
                        }
                    }
                    if (delta.TryGetProperty("reasoning_content", out var rcEl) &&
                        rcEl.ValueKind == JsonValueKind.String)
                    {
                        var rc = rcEl.GetString();
                        if (!string.IsNullOrEmpty(rc))
                        {
                            builder.Append(rc);
                            onChunk(rc);
                        }
                    }
                }
            }
            catch { /* 파싱 오류 무시 */ }
        }

        // 스트림 본문 로그 (진단용) — 너무 길면 앞/뒤로 자르기
        string streamLogStr;
        if (rawStreamLog.Length <= 4096)
        {
            streamLogStr = rawStreamLog.ToString();
        }
        else
        {
            var s = rawStreamLog.ToString();
            streamLogStr = s[..2048] + "\n…[truncated]…\n" + s[^2048..];
        }
        AiRequestLogger.LogInfo($"[OpenAI] 스트림 본문 (총 {lineCount}줄, content={builder.Length}B):\n{streamLogStr}");

        var fullContent = builder.ToString();

        // 빈 응답 → non-streaming 폴백 1회 (게이트웨이가 스트리밍 미지원/변형 포맷일 때 구제)
        if (string.IsNullOrEmpty(fullContent))
        {
            AiRequestLogger.LogInfo("[OpenAI] 스트리밍 빈 응답 감지 → non-streaming 폴백 1회 시도");
            try
            {
                // SendMessageAsync 진입 시 _history에 user 재추가 → 중복 방지를 위해 현재 user 제거
                lock (_historyLock)
                    if (_history.Count > 0 && _history[^1].Role == "user")
                        _history.RemoveAt(_history.Count - 1);

                var fallback = await SendMessageAsync(userMessage, ct).ConfigureAwait(false);
                fullContent = fallback.Content;
                if (!string.IsNullOrEmpty(fullContent))
                    onChunk(fullContent);  // UI 스트림에 일괄 전송
                finishReason = fallback.FinishReason;
                inputTokens  = fallback.InputTokens;
                outputTokens = fallback.OutputTokens;

                // SendMessageAsync가 이미 assistant 메시지를 _history에 추가함 → 아래 중복 추가 방지
                sw.Stop();
                return new AiChatResponse
                {
                    Content      = fullContent,
                    Model        = _model,
                    InputTokens  = inputTokens,
                    OutputTokens = outputTokens,
                    FinishReason = finishReason,
                    DurationMs   = sw.ElapsedMilliseconds,
                };
            }
            catch (Exception ex)
            {
                AiRequestLogger.LogException("SendStreamingAsync.Fallback", ex, sw.ElapsedMilliseconds);
                // 폴백 실패 — 아래 빈 응답 반환 경로로 계속 (UI는 "No content returned" 표시)
            }
        }

        sw.Stop();
        lock (_historyLock)
            _history.Add(new AiChatMessage { Role = "assistant", Content = fullContent });

        return new AiChatResponse
        {
            Content      = fullContent,
            Model        = _model,
            InputTokens  = inputTokens,
            OutputTokens = outputTokens,
            FinishReason = finishReason,
            DurationMs   = sw.ElapsedMilliseconds,
        };
    }

    public void Dispose() { GC.SuppressFinalize(this); }

    // ── 내부 헬퍼 ─────────────────────────────────────────── //

    // 호환 게이트웨이(Shinhan Hands/vLLM/LiteLLM 등)에서 Postman 정상 동작을 맞추기 위한 기본값.
    // - max_tokens 누락 시 일부 게이트웨이가 0/짧게 잘라 빈 응답을 반환하는 사례 확인됨.
    // - stop=null은 명시해도 영향 없음(Postman 바디와 동일하게 유지).
    private const int DefaultMaxTokens = 4096;

    private object BuildRequestBody(bool stream)
    {
        var messages = new List<object>();
        if (!string.IsNullOrWhiteSpace(_systemPrompt))
            messages.Add(new { role = "system", content = _systemPrompt });
        messages.AddRange(_history.Select(m => new { role = m.Role, content = m.Content }));

        if (stream)
        {
            return new
            {
                model = _model,
                messages,
                stream = true,
                stream_options = new { include_usage = true },
                max_tokens = DefaultMaxTokens,
            };
        }

        return new { model = _model, messages, max_tokens = DefaultMaxTokens };
    }

    private static string BuildApiError(System.Net.HttpStatusCode code, string body)
    {
        var status = (int)code;
        var detail = ParseApiErrorMessage(body);
        return status switch
        {
            401 => "OpenAI API 키가 유효하지 않습니다 (401 Unauthorized). API 키를 확인하세요.",
            403 => "OpenAI API 접근 권한 없음 (403 Forbidden). API 키 권한을 확인하세요.",
            429 => "OpenAI API 요청 한도 초과 (429 Too Many Requests). 잠시 후 다시 시도하세요.",
            400 => $"잘못된 요청 (400 Bad Request): {detail}",
            _   => $"OpenAI API 오류 ({status}): {detail}",
        };
    }

    private static string ParseApiErrorMessage(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return "Unknown error";
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("error", out var error) &&
                error.TryGetProperty("message", out var msg))
                return msg.GetString() ?? "Unknown error";
        }
        catch { }
        return body.Length > 200 ? body[..200] : body;
    }

    // ── 모델 자동 교정 ──────────────────────────────────────── //
    // 일부 게이트웨이(Shinhan Hands 등)는 API 키별로 허용 모델이 제한됨.
    // 오류 응답 예: "This token can only access models=['Qwen3.5-9B']. Tried to access gpt-4o"
    // 이 패턴을 감지해서 자동으로 모델명을 교체하고 재시도.
    private static readonly Regex AllowedModelsPattern = new(
        @"can\s+only\s+access\s+models?\s*=\s*\[([^\]]+)\]",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>
    /// 401 응답 본문에서 허용된 모델명 전체 추출.
    /// 예: "models=['Qwen3.5-9B']"       → ["Qwen3.5-9B"]
    /// 예: "models=['a', 'b', \"c\"]"    → ["a", "b", "c"]
    /// 매치 없으면 빈 리스트.
    /// </summary>
    internal static List<string> ExtractAllowedModels(string? errorBody)
    {
        var result = new List<string>();
        if (string.IsNullOrEmpty(errorBody)) return result;
        var match = AllowedModelsPattern.Match(errorBody);
        if (!match.Success) return result;
        foreach (var raw in match.Groups[1].Value.Split(','))
        {
            var trimmed = raw.Trim().Trim('\'', '"', ' ');
            if (!string.IsNullOrWhiteSpace(trimmed)) result.Add(trimmed);
        }
        return result;
    }

    /// <summary>하위 호환용 — 첫 번째 허용 모델 반환 (없으면 null).</summary>
    internal static string? TryExtractAllowedModel(string? errorBody)
    {
        var list = ExtractAllowedModels(errorBody);
        return list.Count > 0 ? list[0] : null;
    }
}
