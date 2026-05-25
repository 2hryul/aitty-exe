using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Aitty.Models;

namespace Aitty.Services;

public class ClaudeApiService : IAiService
{
    private const string DefaultBaseUrl = "https://api.anthropic.com";
    private const string ApiUrl = DefaultBaseUrl + "/v1/messages";
    private const string ModelsUrl = DefaultBaseUrl + "/v1/models";
    private const string ApiVersion = "2023-06-01";
    private const string DefaultModelConst = "claude-sonnet-4-5-20250929";

    // Fallback 모델 — 네트워크/API 응답 실패 시에만 사용. 실제 모델 목록은 GET /v1/models로 조회.
    private static readonly string[] KnownModels =
    [
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
        "claude-opus-4-5-20251101",
        "claude-sonnet-4-5-20250929",
    ];

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    // 모델 목록 캐시 (10분) — GeminiService와 동일 패턴, 가용성 체크와 모델 조회를 동일 호출로 통합
    private List<string>? _cachedModels;
    private DateTime _modelsCachedAt = DateTime.MinValue;
    private static readonly TimeSpan ModelCacheTtl = TimeSpan.FromMinutes(10);

    private HttpClient _httpClient = HttpClientHelper.Create(allowInsecureSsl: false, timeout: TimeSpan.FromMinutes(10));

    public void SetAllowInsecureSsl(bool allow)
    {
        var oldClient = _httpClient;
        _httpClient = HttpClientHelper.Create(allow, timeout: TimeSpan.FromMinutes(10));
        try { oldClient.Dispose(); } catch { /* ignore */ }
    }

    private readonly List<AiChatMessage> _conversationHistory = new();
    private readonly object _historyLock = new();

    private string _apiKey = string.Empty;
    private string _model = DefaultModelConst;
    private string? _systemPrompt;
    private int _maxTokens = 4096;

    public string ProviderName  => "claude";
    public bool IsConfigured => !string.IsNullOrEmpty(_apiKey);
    public string CurrentModel  => _model;
    public string? SystemPrompt => _systemPrompt;
    public IReadOnlyList<AiChatMessage> History => _conversationHistory.AsReadOnly();

    // ── IAiService 디폴트 노출 (SoT) ──────────────────────── //
    public string DefaultModel => DefaultModelConst;
    public string? DefaultSystemPrompt => null;
    public string BaseUrl => DefaultBaseUrl;

    /// <summary>
    /// 실제 Anthropic API에 GET /v1/models 호출하여 가용성 확인.
    /// - 네트워크 차단/SSL 오류/잘못된 API 키 모두 false 반환
    /// - 단순 IsConfigured만 보면 잘못된 키나 오프라인에서도 true가 되어 사용자에게 거짓 성공 표시되는 문제 방지
    /// </summary>
    public async Task<bool> IsEngineAvailableAsync(CancellationToken ct = default)
    {
        if (!IsConfigured)
        {
            AiRequestLogger.LogInfo("[Claude] IsEngineAvailable: not configured (no API key)");
            return false;
        }

        var sw = Stopwatch.StartNew();
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, ModelsUrl);
            req.Headers.Add("anthropic-version", ApiVersion);
            req.Headers.Add("x-api-key", _apiKey);
            AiRequestLogger.LogRequest(req, note: "Claude 가용성 확인용 GET /v1/models");

            using var response = await _httpClient.SendAsync(req, ct);
            var body = await response.Content.ReadAsStringAsync(ct);
            sw.Stop();
            AiRequestLogger.LogResponse(response, body, sw.ElapsedMilliseconds);
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            sw.Stop();
            AiRequestLogger.LogException("Claude.IsEngineAvailableAsync", ex, sw.ElapsedMilliseconds);
            return false;
        }
    }

    /// <summary>
    /// 실제 GET /v1/models 응답을 파싱하여 사용 가능 모델 목록 반환.
    /// 10분 캐시. 네트워크 실패/응답 오류 시 KnownModels 정적 목록으로 폴백.
    /// </summary>
    public async Task<List<string>> ListModelsAsync(CancellationToken ct = default)
    {
        if (!IsConfigured) return new List<string>(KnownModels);

        // 캐시 유효 시 API 호출 생략
        if (_cachedModels != null && DateTime.UtcNow - _modelsCachedAt < ModelCacheTtl)
            return new List<string>(_cachedModels);

        var sw = Stopwatch.StartNew();
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, ModelsUrl);
            req.Headers.Add("anthropic-version", ApiVersion);
            req.Headers.Add("x-api-key", _apiKey);
            AiRequestLogger.LogRequest(req, note: "Claude 모델 목록 GET /v1/models");

            using var response = await _httpClient.SendAsync(req, ct);
            var json = await response.Content.ReadAsStringAsync(ct);
            sw.Stop();
            AiRequestLogger.LogResponse(response, json, sw.ElapsedMilliseconds);

            if (!response.IsSuccessStatusCode)
                return _cachedModels is not null ? new List<string>(_cachedModels) : new List<string>(KnownModels);

            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("data", out var data))
                return new List<string>(KnownModels);

            var models = data.EnumerateArray()
                .Select(m => m.TryGetProperty("id", out var id) ? id.GetString() : null)
                .Where(id => !string.IsNullOrWhiteSpace(id))
                .Select(id => id!)
                .OrderByDescending(id => id)
                .ToList();

            if (models.Count == 0) return new List<string>(KnownModels);

            _cachedModels = models;
            _modelsCachedAt = DateTime.UtcNow;
            return new List<string>(models);
        }
        catch (Exception ex)
        {
            sw.Stop();
            AiRequestLogger.LogException("Claude.ListModelsAsync", ex, sw.ElapsedMilliseconds);
            return _cachedModels is not null ? new List<string>(_cachedModels) : new List<string>(KnownModels);
        }
    }

    public ClaudeApiService() { }

    public void Configure(AiConfig config)
    {
        var keyChanged = !string.Equals(_apiKey, config.ApiKey ?? string.Empty, StringComparison.Ordinal);
        _apiKey = config.ApiKey ?? string.Empty;
        _model = string.IsNullOrEmpty(config.Model) ? DefaultModel : config.Model;
        _systemPrompt = config.SystemPrompt;
        _maxTokens = config.MaxTokens > 0 ? config.MaxTokens : 4096;
        if (keyChanged)
        {
            _cachedModels = null;
            _modelsCachedAt = DateTime.MinValue;
        }
    }

    public void SetApiKey(string apiKey)
    {
        var changed = !string.Equals(_apiKey, apiKey ?? string.Empty, StringComparison.Ordinal);
        _apiKey = apiKey ?? string.Empty;
        if (changed)
        {
            // API 키가 바뀌면 다른 모델 권한일 수 있으므로 캐시 무효화
            _cachedModels = null;
            _modelsCachedAt = DateTime.MinValue;
        }
    }

    public void SetModel(string model)
    {
        _model = model;
    }

    public void SetSystemPrompt(string? systemPrompt)
    {
        _systemPrompt = systemPrompt;
    }

    public async Task<AiChatResponse> SendMessageAsync(string userMessage, CancellationToken ct = default)
    {
        if (!IsConfigured)
            throw new InvalidOperationException("Claude API key not configured. Use 'config set api-key <KEY>' to set it.");

        lock (_historyLock)
            _conversationHistory.Add(new AiChatMessage { Role = "user", Content = userMessage });

        List<ClaudeMessageItem> messagesCopy;
        lock (_historyLock)
            messagesCopy = _conversationHistory.Select(m => new ClaudeMessageItem { Role = m.Role, Content = m.Content }).ToList();

        var requestBody = new ClaudeRequest
        {
            Model = _model,
            MaxTokens = _maxTokens,
            System = _systemPrompt,
            Messages = messagesCopy
        };

        var json = JsonSerializer.Serialize(requestBody, JsonOptions);
        using var request = new HttpRequestMessage(HttpMethod.Post, ApiUrl)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
        request.Headers.Add("anthropic-version", ApiVersion);
        request.Headers.Add("x-api-key", _apiKey);

        var response = await _httpClient.SendAsync(request, ct);
        var responseJson = await response.Content.ReadAsStringAsync(ct);

        if (!response.IsSuccessStatusCode)
        {
            lock (_historyLock)
                _conversationHistory.RemoveAt(_conversationHistory.Count - 1);
            var errorDetail = TryExtractError(responseJson);
            throw new HttpRequestException($"Claude API error ({response.StatusCode}): {errorDetail}");
        }

        var result = JsonSerializer.Deserialize<ClaudeResponse>(responseJson, JsonOptions);
        if (result is null)
            throw new InvalidOperationException("Failed to parse Claude API response");

        var assistantContent = string.Join("\n",
            result.Content?.Where(c => c.Type == "text").Select(c => c.Text) ?? []);

        lock (_historyLock)
            _conversationHistory.Add(new AiChatMessage { Role = "assistant", Content = assistantContent });

        return new AiChatResponse
        {
            Content = assistantContent,
            Model = result.Model ?? _model,
            InputTokens = result.Usage?.InputTokens ?? 0,
            OutputTokens = result.Usage?.OutputTokens ?? 0
        };
    }

    public async Task<AiChatResponse> SendStreamingAsync(string userMessage, Action<string> onChunk, CancellationToken ct = default)
    {
        if (!IsConfigured)
            throw new InvalidOperationException("Claude API key not configured. Use 'config set api-key <KEY>' to set it.");

        var sw = Stopwatch.StartNew();
        lock (_historyLock)
            _conversationHistory.Add(new AiChatMessage { Role = "user", Content = userMessage });

        List<ClaudeMessageItem> messagesCopy;
        lock (_historyLock)
            messagesCopy = _conversationHistory.Select(m => new ClaudeMessageItem { Role = m.Role, Content = m.Content }).ToList();

        var requestBody = new ClaudeRequest
        {
            Model = _model,
            MaxTokens = _maxTokens,
            System = _systemPrompt,
            Stream = true,
            Messages = messagesCopy
        };

        var json = JsonSerializer.Serialize(requestBody, JsonOptions);
        var request = new HttpRequestMessage(HttpMethod.Post, ApiUrl)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
        request.Headers.Add("anthropic-version", ApiVersion);
        request.Headers.Add("x-api-key", _apiKey);

        // 운영 디버깅용 로깅 — IsEngineAvailable/ListModels와 동일 패턴.
        // 사용자 빈 응답 호소 시 ai_api.log로 API 호출/응답 즉시 식별 가능.
        AiRequestLogger.LogRequest(request, bodyJson: json, note: $"Claude SendStreamingAsync model={_model} userMsgLen={userMessage?.Length ?? -1}");

        var response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            lock (_historyLock)
                _conversationHistory.RemoveAt(_conversationHistory.Count - 1);
            var errorJson = await response.Content.ReadAsStringAsync(ct)
                .ConfigureAwait(false);
            AiRequestLogger.LogResponse(response, errorJson, sw.ElapsedMilliseconds);
            var errorDetail = TryExtractError(errorJson);
            throw new HttpRequestException($"Claude API error ({response.StatusCode}): {errorDetail}");
        }

        var contentBuilder = new StringBuilder();
        var finishReason = "stop";
        int inputTokens  = 0;
        int outputTokens = 0;

        using var stream = await response.Content.ReadAsStreamAsync(ct)
            .ConfigureAwait(false);
        using var reader = new StreamReader(stream);

        while (!reader.EndOfStream && !ct.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(ct)
                .ConfigureAwait(false);
            if (string.IsNullOrEmpty(line)) continue;
            if (!line.StartsWith("data: ")) continue;

            var data = line[6..];
            if (data == "[DONE]") break;

            try
            {
                using var doc  = JsonDocument.Parse(data);
                var root = doc.RootElement;
                var type = root.TryGetProperty("type", out var t) ? t.GetString() : null;

                switch (type)
                {
                    // message_start: input_tokens 수집
                    case "message_start":
                        if (root.TryGetProperty("message", out var msg) &&
                            msg.TryGetProperty("usage", out var startUsage))
                            inputTokens = startUsage.TryGetProperty("input_tokens", out var it) ? it.GetInt32() : 0;
                        break;

                    // content_block_delta: 실제 텍스트 청크
                    case "content_block_delta":
                        if (root.TryGetProperty("delta", out var delta) &&
                            delta.TryGetProperty("text", out var textEl) &&
                            textEl.ValueKind == JsonValueKind.String)
                        {
                            var chunk = textEl.GetString();
                            if (!string.IsNullOrEmpty(chunk))
                            {
                                contentBuilder.Append(chunk);
                                onChunk(chunk);
                            }
                        }
                        break;

                    // message_delta: output_tokens + stop_reason 수집
                    case "message_delta":
                        if (root.TryGetProperty("usage", out var msgUsage))
                            outputTokens = msgUsage.TryGetProperty("output_tokens", out var ot) ? ot.GetInt32() : outputTokens;
                        if (root.TryGetProperty("delta", out var msgDelta) &&
                            msgDelta.TryGetProperty("stop_reason", out var sr) &&
                            sr.ValueKind == JsonValueKind.String)
                            finishReason = sr.GetString() ?? finishReason;
                        break;
                }
            }
            catch { /* Skip malformed SSE events */ }
        }

        sw.Stop();
        var result = contentBuilder.ToString();
        lock (_historyLock)
            _conversationHistory.Add(new AiChatMessage { Role = "assistant", Content = result });

        return new AiChatResponse
        {
            Content      = result,
            Model        = _model,
            InputTokens  = inputTokens,
            OutputTokens = outputTokens,
            FinishReason = finishReason,
            DurationMs   = sw.ElapsedMilliseconds,
        };
    }

    public void SetHistory(IEnumerable<AiChatMessage> messages)
    {
        lock (_historyLock)
        {
            _conversationHistory.Clear();
            _conversationHistory.AddRange(messages);
        }
    }

    public void ClearHistory()
    {
        lock (_historyLock)
            _conversationHistory.Clear();
    }

    public void Dispose()
    {
        GC.SuppressFinalize(this);
    }

    private static string TryExtractError(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("error", out var error))
            {
                if (error.TryGetProperty("message", out var msg))
                    return msg.GetString() ?? json;
            }
        }
        catch { }
        return json;
    }
}

// Claude API request/response DTOs
internal class ClaudeRequest
{
    public string Model { get; set; } = string.Empty;
    public int MaxTokens { get; set; }
    public string? System { get; set; }
    public bool? Stream { get; set; }
    public List<ClaudeMessageItem> Messages { get; set; } = new();
}

internal class ClaudeMessageItem
{
    public string Role { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
}

internal class ClaudeResponse
{
    public string? Model { get; set; }
    public List<ClaudeContentBlock>? Content { get; set; }
    public ClaudeUsage? Usage { get; set; }
}

internal class ClaudeContentBlock
{
    public string Type { get; set; } = string.Empty;
    public string Text { get; set; } = string.Empty;
}

internal class ClaudeUsage
{
    public int InputTokens { get; set; }
    public int OutputTokens { get; set; }
}

internal class ClaudeSseEvent
{
    public string? Type { get; set; }
    public ClaudeSseDelta? Delta { get; set; }
}

internal class ClaudeSseDelta
{
    public string? Type { get; set; }
    public string? Text { get; set; }
}
