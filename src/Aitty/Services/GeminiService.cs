using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using Aitty.Models;

namespace Aitty.Services;

/// <summary>
/// Google Gemini API 서비스.
/// /v1beta/models/{model}:streamGenerateContent (SSE 스트리밍) 사용.
/// 대화 이력은 매 요청 시 contents 배열로 전달 (context 토큰 방식 아님).
/// </summary>
public class GeminiService : IAiService
{
    private HttpClient _httpClient = HttpClientHelper.Create(allowInsecureSsl: false);

    public void SetAllowInsecureSsl(bool allow)
    {
        var oldClient = _httpClient;
        _httpClient = HttpClientHelper.Create(allow);
        try { oldClient.Dispose(); } catch { /* ignore */ }
    }

    private readonly List<AiChatMessage> _history = new();
    private readonly object _historyLock = new();

    private const string BaseUrl = "https://generativelanguage.googleapis.com/v1beta";

    // 429 재시도: 최대 3회, 대기 시간 5s → 30s → 60s
    private const int MaxRetries = 3;
    private static readonly int[] RetryWaitSeconds = [5, 30, 60];

    // 기본 모델 목록 (API 키 없을 때 or 조회 실패 시 fallback)
    private static readonly string[] DefaultModels =
    [
        "gemini-2.0-flash",
        "gemini-1.5-pro",
        "gemini-1.5-flash"
    ];

    private string _apiKey = string.Empty;
    private string _model = "gemini-2.0-flash";
    private string? _systemPrompt;

    // 모델 목록 캐시 (10분) - 불필요한 API 반복 호출 방지
    private List<string>? _cachedModels;
    private DateTime _modelsCachedAt = DateTime.MinValue;
    private static readonly TimeSpan ModelCacheTtl = TimeSpan.FromMinutes(10);

    public GeminiService() { }

    public string ProviderName  => "gemini";
    public string CurrentModel  => _model;
    public string? SystemPrompt => _systemPrompt;
    public bool IsConfigured => !string.IsNullOrWhiteSpace(_apiKey);
    public IReadOnlyList<AiChatMessage> History => _history.AsReadOnly();

    public void SetApiKey(string apiKey)
    {
        _apiKey = apiKey.Trim();
        // API 키 변경 시 캐시 무효화
        _cachedModels = null;
        _modelsCachedAt = DateTime.MinValue;
    }
    public void SetModel(string model) => _model = model;
    public void SetSystemPrompt(string? prompt) => _systemPrompt = prompt;
    public void SetHistory(IEnumerable<AiChatMessage> messages)
    {
        lock (_historyLock) { _history.Clear(); _history.AddRange(messages); }
    }
    public void ClearHistory() { lock (_historyLock) _history.Clear(); }

    // ── 가용성 확인 ───────────────────────────────────────── //

    // 실제 API 호출로 유효성 확인 (잘못된 키 false)
    public async Task<bool> IsEngineAvailableAsync(CancellationToken ct = default)
    {
        if (!IsConfigured) return false;
        try
        {
            using var response = await _httpClient.GetAsync($"{BaseUrl}/models?key={_apiKey}", ct);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    // ── 모델 목록 ─────────────────────────────────────────── //

    public async Task<List<string>> ListModelsAsync(CancellationToken ct = default)
    {
        if (!IsConfigured) return DefaultModels.ToList();

        // 캐시 유효 시 API 호출 생략
        if (_cachedModels != null && DateTime.UtcNow - _modelsCachedAt < ModelCacheTtl)
            return _cachedModels;

        try
        {
            using var response = await _httpClient.GetAsync($"{BaseUrl}/models?key={_apiKey}", ct);
            if (!response.IsSuccessStatusCode)
                return _cachedModels ?? [];

            var json = await response.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(json);

            var models = new List<string>();
            if (doc.RootElement.TryGetProperty("models", out var arr))
            {
                foreach (var item in arr.EnumerateArray())
                {
                    var supportsGenerate = false;
                    if (item.TryGetProperty("supportedGenerationMethods", out var methods))
                        supportsGenerate = methods.EnumerateArray()
                            .Any(m => m.GetString() == "generateContent");

                    if (!supportsGenerate) continue;

                    if (item.TryGetProperty("name", out var name))
                    {
                        var modelId = (name.GetString() ?? "").Replace("models/", "");
                        if (!string.IsNullOrWhiteSpace(modelId))
                            models.Add(modelId);
                    }
                }
            }

            _cachedModels = models.Count > 0 ? models : [];
            _modelsCachedAt = DateTime.UtcNow;
            return _cachedModels;
        }
        catch
        {
            return _cachedModels ?? [];
        }
    }

    // ── 비스트리밍 전송 ───────────────────────────────────── //

    public async Task<AiChatResponse> SendMessageAsync(string userMessage, CancellationToken ct = default)
    {
        if (!IsConfigured)
            throw new InvalidOperationException("Gemini API 키가 설정되지 않았습니다.");

        lock (_historyLock)
            _history.Add(new AiChatMessage { Role = "user", Content = userMessage });

        var body = BuildRequestBody();
        var json = JsonSerializer.Serialize(body);
        using var content = new StringContent(json, Encoding.UTF8, "application/json");

        var url = $"{BaseUrl}/models/{_model}:generateContent?key={_apiKey}";
        HttpResponseMessage response;
        try
        {
            response = await _httpClient.PostAsync(url, content, ct);
        }
        catch
        {
            lock (_historyLock)
                _history.RemoveAt(_history.Count - 1);
            throw;
        }

        using (response)
        {
            var responseText = await response.Content.ReadAsStringAsync(ct);
            if (!response.IsSuccessStatusCode)
            {
                lock (_historyLock)
                    _history.RemoveAt(_history.Count - 1);
                throw new Exception(BuildApiError(response.StatusCode, responseText));
            }

            var text = ParseResponseText(responseText);
            lock (_historyLock)
                _history.Add(new AiChatMessage { Role = "assistant", Content = text });

            return new AiChatResponse { Content = text, Model = _model };
        }
    }

    // ── SSE 스트리밍 전송 (429 자동 재시도 포함) ─────────────── //

    public async Task<AiChatResponse> SendStreamingAsync(string userMessage, Action<string> onChunk, CancellationToken ct = default)
    {
        if (!IsConfigured)
            throw new InvalidOperationException("Gemini API 키가 설정되지 않았습니다.");

        var sw = Stopwatch.StartNew();

        int historyIndex;
        lock (_historyLock)
        {
            historyIndex = _history.Count;
            _history.Add(new AiChatMessage { Role = "user", Content = userMessage });
        }

        Exception? lastEx = null;

        for (int attempt = 0; attempt < MaxRetries; attempt++)
        {
            try
            {
                var fullContent = await DoStreamAsync(onChunk, ct).ConfigureAwait(false);
                sw.Stop();
                lock (_historyLock)
                    _history.Add(new AiChatMessage { Role = "assistant", Content = fullContent });

                return new AiChatResponse
                {
                    Content      = fullContent,
                    Model        = _model,
                    InputTokens  = 0,
                    OutputTokens = 0,
                    FinishReason = "stop",
                    DurationMs   = sw.ElapsedMilliseconds,
                };
            }
            catch (Exception ex)
            {
                lastEx = ex;
                var isRateLimit = ex.Message.Contains("429");

                // 429 + 재시도 여유 있을 때만 대기 후 재시도
                if (!isRateLimit || attempt >= MaxRetries - 1 || ct.IsCancellationRequested)
                    break;

                var wait = ParseRetryDelaySec(ex) ?? RetryWaitSeconds[attempt];
                onChunk($"\r\n\x1b[33m⏳ Gemini 요청 한도. {wait}초 후 재시도 ({attempt + 1}/{MaxRetries - 1})...\x1b[0m\r\n");
                await Task.Delay(TimeSpan.FromSeconds(wait), ct).ConfigureAwait(false);
            }
        }

        // 모든 재시도 실패 → 이력 롤백
        lock (_historyLock)
        {
            if (_history.Count > historyIndex)
                _history.RemoveAt(historyIndex);
        }

        throw lastEx!;
    }

    // SSE 실제 전송 (단일 시도)
    private async Task<string> DoStreamAsync(Action<string> onChunk, CancellationToken ct)
    {
        var body = BuildRequestBody();
        var json = JsonSerializer.Serialize(body);

        using var request = new HttpRequestMessage(HttpMethod.Post,
            $"{BaseUrl}/models/{_model}:streamGenerateContent?key={_apiKey}&alt=sse")
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };

        using var response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(ct)
                .ConfigureAwait(false);
            throw new Exception(BuildApiError(response.StatusCode, errorBody));
        }

        var builder = new StringBuilder();
        using var stream = await response.Content.ReadAsStreamAsync(ct)
            .ConfigureAwait(false);
        using var reader = new StreamReader(stream);

        while (!reader.EndOfStream && !ct.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(ct)
                .ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(line)) continue;
            if (!line.StartsWith("data: ")) continue;

            var data = line[6..];
            if (data == "[DONE]") break;

            try
            {
                using var doc = JsonDocument.Parse(data);
                var chunk = ExtractChunkText(doc.RootElement);
                if (!string.IsNullOrEmpty(chunk))
                {
                    builder.Append(chunk);
                    onChunk(chunk);
                }
            }
            catch { /* 파싱 오류 무시 */ }
        }

        return builder.ToString();
    }

    // Gemini 429 응답에서 retryDelay 파싱 ("30s" 형식)
    private static int? ParseRetryDelaySec(Exception ex)
    {
        var match = System.Text.RegularExpressions.Regex.Match(ex.Message, @"(\d+)s");
        return match.Success && int.TryParse(match.Groups[1].Value, out var sec) ? sec : null;
    }

    public void Dispose() { GC.SuppressFinalize(this); }

    // ── 내부 헬퍼 ─────────────────────────────────────────── //

    private object BuildRequestBody()
    {
        // Gemini는 role이 "user" / "model" (assistant X)
        var contents = _history.Select(m => new
        {
            role = m.Role == "assistant" ? "model" : "user",
            parts = new[] { new { text = m.Content } }
        }).ToArray();

        var config = new { temperature = 0.2 };

        if (!string.IsNullOrWhiteSpace(_systemPrompt))
        {
            return new
            {
                contents,
                systemInstruction = new { parts = new[] { new { text = _systemPrompt } } },
                generationConfig = config
            };
        }

        return new { contents, generationConfig = config };
    }

    private static string BuildApiError(System.Net.HttpStatusCode code, string body)
    {
        var status = (int)code;
        var detail = ParseApiErrorMessage(body);

        return status switch
        {
            429 => $"Gemini API 요청 한도 초과 (429 Too Many Requests). 잠시 후 다시 시도하세요.",
            401 => "Gemini API 키가 유효하지 않습니다 (401 Unauthorized). API 키를 확인하세요.",
            403 => "Gemini API 접근 권한 없음 (403 Forbidden). API 키 권한을 확인하세요.",
            400 => $"잘못된 요청 (400 Bad Request): {detail}",
            _   => $"Gemini API 오류 ({status}): {detail}"
        };
    }

    private static string ParseApiErrorMessage(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return "Unknown error";
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("error", out var err))
            {
                if (err.TryGetProperty("message", out var msg))
                    return msg.GetString() ?? "Unknown error";
            }
        }
        catch { /* ignored */ }
        return body.Length > 200 ? body[..200] : body;
    }

    private static string ParseResponseText(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            return ExtractChunkText(doc.RootElement);
        }
        catch { return string.Empty; }
    }

    private static string ExtractChunkText(JsonElement root)
    {
        if (!root.TryGetProperty("candidates", out var candidates)) return string.Empty;
        foreach (var candidate in candidates.EnumerateArray())
        {
            if (!candidate.TryGetProperty("content", out var content)) continue;
            if (!content.TryGetProperty("parts", out var parts)) continue;
            foreach (var part in parts.EnumerateArray())
            {
                if (part.TryGetProperty("text", out var text))
                    return text.GetString() ?? string.Empty;
            }
        }
        return string.Empty;
    }
}
