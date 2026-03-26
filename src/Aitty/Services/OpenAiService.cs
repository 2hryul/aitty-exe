using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
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
    private const string ApiUrl      = "https://api.openai.com/v1/chat/completions";
    private const string ModelsUrl   = "https://api.openai.com/v1/models";

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

    private static readonly HttpClient SharedHttpClient = new() { Timeout = TimeSpan.FromMinutes(5) };
    private readonly HttpClient _httpClient = SharedHttpClient;
    private readonly List<AiChatMessage> _history = new();
    private readonly object _historyLock = new();

    private string _apiKey = string.Empty;
    private string _model = "gpt-4o";
    private string? _systemPrompt;

    public string ProviderName  => "openai";
    public string CurrentModel  => _model;
    public string? SystemPrompt => _systemPrompt;
    public bool IsConfigured => !string.IsNullOrWhiteSpace(_apiKey);
    public IReadOnlyList<AiChatMessage> History => _history.AsReadOnly();

    public OpenAiService() { }

    public void SetApiKey(string apiKey)
    {
        _apiKey = apiKey.Trim();
    }

    public void SetModel(string model) => _model = model;
    public void SetSystemPrompt(string? prompt) => _systemPrompt = prompt;
    public void SetHistory(IEnumerable<AiChatMessage> messages)
    {
        lock (_historyLock) { _history.Clear(); _history.AddRange(messages); }
    }
    public void ClearHistory() { lock (_historyLock) _history.Clear(); }

    // ── 가용성 확인 ───────────────────────────────────────── //

    public async Task<bool> IsEngineAvailableAsync(CancellationToken ct = default)
    {
        if (!IsConfigured) return false;
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, ModelsUrl);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
            using var response = await _httpClient.SendAsync(req, ct);
            return response.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    // ── 모델 목록 (gpt- 필터, 이름 역순 정렬) ─────────────── //

    public async Task<List<string>> ListModelsAsync(CancellationToken ct = default)
    {
        if (!IsConfigured) return DefaultModels.ToList();
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, ModelsUrl);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
            using var response = await _httpClient.SendAsync(req, ct);
            if (!response.IsSuccessStatusCode) return DefaultModels.ToList();

            var json = await response.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(json);

            if (!doc.RootElement.TryGetProperty("data", out var data))
                return DefaultModels.ToList();

            var models = data.EnumerateArray()
                .Select(m => m.TryGetProperty("id", out var id) ? id.GetString() : null)
                .Where(id => id != null && id.StartsWith("gpt-"))
                .Select(id => id!)
                .OrderByDescending(id => id)
                .ToList();

            return models.Count > 0 ? models : DefaultModels.ToList();
        }
        catch { return DefaultModels.ToList(); }
    }

    // ── 비스트리밍 전송 ───────────────────────────────────── //

    public async Task<AiChatResponse> SendMessageAsync(string userMessage, CancellationToken ct = default)
    {
        if (!IsConfigured)
            throw new InvalidOperationException("OpenAI API 키가 설정되지 않았습니다.");

        var sw = Stopwatch.StartNew();
        lock (_historyLock)
            _history.Add(new AiChatMessage { Role = "user", Content = userMessage });

        var body = BuildRequestBody(stream: false);
        var json = JsonSerializer.Serialize(body, JsonOptions);
        using var httpReq = new HttpRequestMessage(HttpMethod.Post, ApiUrl)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
        httpReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

        using var response = await _httpClient.SendAsync(httpReq, ct);
        var responseText = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
        {
            lock (_historyLock)
                _history.RemoveAt(_history.Count - 1);
            throw new Exception(BuildApiError(response.StatusCode, responseText));
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

        var sw = Stopwatch.StartNew();
        lock (_historyLock)
            _history.Add(new AiChatMessage { Role = "user", Content = userMessage });

        var body = BuildRequestBody(stream: true);
        var json = JsonSerializer.Serialize(body, JsonOptions);

        using var request = new HttpRequestMessage(HttpMethod.Post, ApiUrl)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

        using var response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            lock (_historyLock)
                _history.RemoveAt(_history.Count - 1);
            var errorBody = await response.Content.ReadAsStringAsync(ct)
                .ConfigureAwait(false);
            throw new Exception(BuildApiError(response.StatusCode, errorBody));
        }

        var builder     = new StringBuilder();
        var finishReason = "stop";
        int inputTokens  = 0;
        int outputTokens = 0;

        using var stream = await response.Content.ReadAsStreamAsync(ct)
            .ConfigureAwait(false);
        using var reader = new System.IO.StreamReader(stream);

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

                // delta 텍스트 청크
                if (choice.TryGetProperty("delta", out var delta) &&
                    delta.TryGetProperty("content", out var contentEl) &&
                    contentEl.ValueKind == JsonValueKind.String)
                {
                    var chunk = contentEl.GetString();
                    if (!string.IsNullOrEmpty(chunk))
                    {
                        builder.Append(chunk);
                        onChunk(chunk);
                    }
                }
            }
            catch { /* 파싱 오류 무시 */ }
        }

        sw.Stop();
        var fullContent = builder.ToString();
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
            };
        }

        return new { model = _model, messages };
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
}
