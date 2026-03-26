using System.IO;
using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using Aitty.Models;

namespace Aitty.Services;

/// <summary>
/// Ollama /api/generate 기반 LLM 서비스.
/// /api/chat 대신 /api/generate를 사용해 구버전 Ollama 호환성 확보.
/// context 토큰으로 대화 이력 유지.
/// </summary>
public class LocalLlmService : IAiService
{
    private static readonly HttpClient SharedHttpClient = new() { Timeout = TimeSpan.FromMinutes(5) };
    private readonly HttpClient _httpClient = SharedHttpClient;
    private readonly List<AiChatMessage> _conversationHistory = new();
    private readonly object _historyLock = new();

    // Ollama /api/generate context 토큰 (대화 연속성 유지)
    private long[]? _context;

    private string _baseUrl = GetDefaultBaseUrl();
    private string _model = "qwen2.5-coder:7b";
    private string? _systemPrompt = "You are a local Linux SSH assistant. Analyze terminal output, explain issues, and suggest safe next commands. Prefer minimal-risk commands first.";
    private string? _apiKey;

    public LocalLlmService() { }

    public string ProviderName => "ollama";
    public bool IsConfigured => true;
    public string CurrentModel  => _model;
    public string? SystemPrompt => _systemPrompt;
    public string CurrentBaseUrl => _baseUrl;
    public IReadOnlyList<AiChatMessage> History => _conversationHistory.AsReadOnly();

    public void SetBaseUrl(string url)
    {
        if (!string.IsNullOrWhiteSpace(url))
            _baseUrl = url.TrimEnd('/');
    }

    public void SetApiKey(string apiKey)
    {
        _apiKey = string.IsNullOrWhiteSpace(apiKey) ? null : apiKey.Trim();
    }

    public void Configure(AiConfig config)
    {
        if (!string.IsNullOrWhiteSpace(config.Model))
            _model = config.Model;

        if (!string.IsNullOrWhiteSpace(config.SystemPrompt))
            _systemPrompt = config.SystemPrompt;
    }

    public void SetModel(string model) => _model = model;

    public void SetSystemPrompt(string? systemPrompt) => _systemPrompt = systemPrompt;

    // ── 모델 목록 ─────────────────────────────────────────── //

    public async Task<List<string>> ListModelsAsync(CancellationToken ct = default)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, $"{_baseUrl}/api/tags");
        AddAuthHeader(req);
        using var response = await _httpClient.SendAsync(req, ct);
        response.EnsureSuccessStatusCode();

        using var stream = await response.Content.ReadAsStreamAsync(ct);
        JsonDocument doc;
        try { doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct); }
        catch (JsonException) { return new List<string>(); }
        using var _ = doc;

        var models = new List<string>();
        if (doc.RootElement.TryGetProperty("models", out var modelArray))
        {
            foreach (var item in modelArray.EnumerateArray())
            {
                if (item.TryGetProperty("name", out var name))
                {
                    var value = name.GetString();
                    if (!string.IsNullOrWhiteSpace(value))
                        models.Add(value);
                }
            }
        }
        return models;
    }

    public async Task<bool> IsEngineAvailableAsync(CancellationToken ct = default)
    {
        try { _ = await ListModelsAsync(ct); return true; }
        catch { return false; }
    }

    // ── 메시지 전송 (비스트리밍) ──────────────────────────── //

    public async Task<AiChatResponse> SendMessageAsync(string userMessage, CancellationToken ct = default)
    {
        lock (_historyLock)
            _conversationHistory.Add(new AiChatMessage { Role = "user", Content = userMessage });

        var requestBody = BuildGenerateRequest(userMessage, stream: false);
        var json = JsonSerializer.Serialize(requestBody);
        using var httpReq = new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/api/generate")
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
        AddAuthHeader(httpReq);
        using var response = await _httpClient.SendAsync(httpReq, ct);
        var responseText = await response.Content.ReadAsStringAsync(ct);
        response.EnsureSuccessStatusCode();

        using var doc = JsonDocument.Parse(responseText);

        // context 토큰 저장
        if (doc.RootElement.TryGetProperty("context", out var ctxElement))
            _context = ctxElement.EnumerateArray().Select(x => x.GetInt64()).ToArray();

        var message = doc.RootElement.TryGetProperty("response", out var r)
            ? r.GetString() ?? string.Empty
            : string.Empty;

        lock (_historyLock)
            _conversationHistory.Add(new AiChatMessage { Role = "assistant", Content = message });

        return new AiChatResponse
        {
            Content = message,
            Model = _model,
            InputTokens = 0,
            OutputTokens = 0
        };
    }

    // ── 스트리밍 메시지 전송 ──────────────────────────────── //

    public async Task<AiChatResponse> SendStreamingAsync(string userMessage, Action<string> onChunk, CancellationToken ct = default)
    {
        lock (_historyLock)
            _conversationHistory.Add(new AiChatMessage { Role = "user", Content = userMessage });

        var sw = Stopwatch.StartNew();
        var requestBody = BuildGenerateRequest(userMessage, stream: true);
        var json = JsonSerializer.Serialize(requestBody);
        using var httpRequest = new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/api/generate")
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
        AddAuthHeader(httpRequest);

        using var response = await _httpClient.SendAsync(httpRequest, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);
        response.EnsureSuccessStatusCode();

        var builder = new StringBuilder();
        using var stream = await response.Content.ReadAsStreamAsync(ct)
            .ConfigureAwait(false);
        using var reader = new StreamReader(stream);

        while (!reader.EndOfStream && !ct.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(ct)
                .ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(line)) continue;

            using var doc = JsonDocument.Parse(line);

            // 청크 텍스트 수집
            if (doc.RootElement.TryGetProperty("response", out var responseChunk))
            {
                var chunk = responseChunk.GetString() ?? string.Empty;
                if (chunk.Length > 0)
                {
                    builder.Append(chunk);
                    onChunk(chunk);
                }
            }

            // 완료 시 context 토큰 저장
            if (doc.RootElement.TryGetProperty("done", out var doneEl) && doneEl.GetBoolean())
            {
                if (doc.RootElement.TryGetProperty("context", out var ctxEl))
                    _context = ctxEl.EnumerateArray().Select(x => x.GetInt64()).ToArray();
                break;
            }
        }

        sw.Stop();
        var fullContent = builder.ToString();
        lock (_historyLock)
            _conversationHistory.Add(new AiChatMessage { Role = "assistant", Content = fullContent });

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

    // ── SSH 분석 / 명령 제안 ──────────────────────────────── //

    public async Task<string> AnalyzeSshOutputAsync(string recentOutput, CancellationToken ct = default)
    {
        var prompt = $"Recent SSH output:\n{recentOutput}\n\nAnalyze the output, explain issues if any, and suggest the next safe action.";
        var response = await SendMessageAsync(prompt, ct);
        return response.Content;
    }

    public async Task<string> SuggestCommandAsync(string recentOutput, CancellationToken ct = default)
    {
        var prompt = $"Recent SSH output:\n{recentOutput}\n\nSuggest one safe next shell command only, followed by a short reason.";
        var response = await SendMessageAsync(prompt, ct);
        return response.Content;
    }

    // ── 이력 초기화 ───────────────────────────────────────── //

    public void SetHistory(IEnumerable<AiChatMessage> messages)
    {
        lock (_historyLock)
        {
            _conversationHistory.Clear();
            _conversationHistory.AddRange(messages);
            _context = null;
        }
    }

    public void ClearHistory()
    {
        lock (_historyLock)
        {
            _conversationHistory.Clear();
            _context = null;
        }
    }

    public void Dispose()
    {
        GC.SuppressFinalize(this);
    }

    // ── Open WebUI / Ollama 진단 로그 ────────────────────── //

    /// <summary>
    /// [C-2] SSRF 방어: 사용자 입력 URL의 스킴을 검증.
    /// http/https만 허용, 클라우드 메타데이터 서비스(169.254.169.254)만 차단.
    /// 로컬/사설 IP는 사용자가 직접 설정한 Ollama 엔드포인트이므로 허용.
    /// </summary>
    internal static bool IsUrlAllowed(string url)
    {
        try
        {
            var uri = new Uri(url, UriKind.Absolute);

            // 스킴: http / https 만 허용
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
                return false;

            // 호스트명 → IP 변환 (모든 반환 IP 검사하여 DNS 리바인딩 방어)
            IPAddress[] addresses;
            if (IPAddress.TryParse(uri.Host, out var ip))
                addresses = [ip];
            else
            {
                addresses = Dns.GetHostAddresses(uri.Host);
                if (addresses.Length == 0) return false;
            }

            // 모든 IP에서 클라우드 메타데이터 서비스(169.254.x.x) 차단
            return !addresses.Any(IsCloudMetadataIp);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>클라우드 인스턴스 메타데이터 서비스 IP (169.254.0.0/16) 판별.</summary>
    private static bool IsCloudMetadataIp(IPAddress ip)
    {
        var b = ip.GetAddressBytes();
        return b.Length == 4 && b[0] == 169 && b[1] == 254;
    }

    public async Task<OpenWebUiDiagnosisResult> DiagnoseOpenWebUiAsync(string? endpoint = null, CancellationToken ct = default)
    {
        var baseUrl = string.IsNullOrWhiteSpace(endpoint) ? _baseUrl : NormalizeBaseUrl(endpoint);

        // [C-2] SSRF 방어: 클라우드 메타데이터 주소(169.254.x.x) 차단
        if (!string.IsNullOrWhiteSpace(endpoint) && !IsUrlAllowed(baseUrl))
        {
            return new OpenWebUiDiagnosisResult
            {
                Success = false,
                IsBlocked = true,
                BaseUrl = baseUrl,
                Logs = new List<string> { $"[{DateTime.Now:HH:mm:ss.fff}] [BLOCKED] 클라우드 메타데이터 주소는 연결이 차단됩니다: {baseUrl}" }
            };
        }
        var logs = new List<string>();

        static string Short(string? s)
        {
            if (string.IsNullOrWhiteSpace(s)) return "(empty)";
            var oneLine = s.Replace("\r", " ").Replace("\n", " ").Trim();
            return oneLine.Length > 220 ? oneLine[..220] + "..." : oneLine;
        }

        static string Stamp() => DateTime.Now.ToString("HH:mm:ss.fff");
        void Log(string message) => logs.Add($"[{Stamp()}] {message}");

        Log($"baseUrl={baseUrl}");

        var isOpenWebUi = false;
        var modelsCount = 0;
        var okCount = 0;

        async Task ProbeGet(string route, Func<string, Task>? onSuccess = null)
        {
            var url = $"{baseUrl}{route}";
            var sw = Stopwatch.StartNew();
            try
            {
                using var response = await _httpClient.GetAsync(url, ct);
                var body = await response.Content.ReadAsStringAsync(ct);
                sw.Stop();

                Log($"GET {url} -> {(int)response.StatusCode} {response.ReasonPhrase} ({sw.ElapsedMilliseconds}ms)");
                Log($"RESP {route}: {Short(body)}");

                if (response.IsSuccessStatusCode)
                {
                    okCount++;
                    if (onSuccess is not null) await onSuccess(body);
                }
            }
            catch (Exception ex)
            {
                sw.Stop();
                Log($"GET {route} -> ERROR ({sw.ElapsedMilliseconds}ms): {ex.Message}");
            }
        }

        async Task ProbePostJson(string route, string jsonBody, Func<string, Task>? onSuccess = null)
        {
            var url = $"{baseUrl}{route}";
            var sw = Stopwatch.StartNew();
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Post, url)
                {
                    Content = new StringContent(jsonBody, Encoding.UTF8, "application/json")
                };
                Log($"REQ POST {url}: {Short(jsonBody)}");

                using var response = await _httpClient.SendAsync(req, ct);
                var body = await response.Content.ReadAsStringAsync(ct);
                sw.Stop();

                Log($"POST {url} -> {(int)response.StatusCode} {response.ReasonPhrase} ({sw.ElapsedMilliseconds}ms)");
                Log($"RESP {route}: {Short(body)}");

                if (response.IsSuccessStatusCode)
                {
                    okCount++;
                    if (onSuccess is not null) await onSuccess(body);
                }
            }
            catch (Exception ex)
            {
                sw.Stop();
                Log($"POST {url} -> ERROR ({sw.ElapsedMilliseconds}ms): {ex.Message}");
            }
        }

        await ProbeGet("/api/version", body =>
        {
            var lower = body.ToLowerInvariant();
            if (lower.Contains("open webui") || lower.Contains("open-webui"))
                isOpenWebUi = true;
            return Task.CompletedTask;
        });

        await ProbeGet("/api/tags", body =>
        {
            try
            {
                using var doc = JsonDocument.Parse(body);
                if (doc.RootElement.TryGetProperty("models", out var arr) && arr.ValueKind == JsonValueKind.Array)
                    modelsCount = arr.GetArrayLength();
            }
            catch { /* ignored */ }
            return Task.CompletedTask;
        });

        await ProbeGet("/api/models", body =>
        {
            var lower = body.ToLowerInvariant();
            if (lower.Contains("open webui") || lower.Contains("open-webui"))
                isOpenWebUi = true;
            return Task.CompletedTask;
        });

        var showBody = JsonSerializer.Serialize(new { model = _model });
        await ProbePostJson("/api/show", showBody);

        var success = okCount > 0;
        Log($"summary: success={success}, okCount={okCount}, modelsCount={modelsCount}, isOpenWebUi={isOpenWebUi}");

        return new OpenWebUiDiagnosisResult
        {
            Success = success,
            BaseUrl = baseUrl,
            IsOpenWebUi = isOpenWebUi,
            ModelsCount = modelsCount,
            Logs = logs
        };
    }

    // ── 요청 빌더 ─────────────────────────────────────────── //

    private object BuildGenerateRequest(string prompt, bool stream)
    {
        return new
        {
            model = _model,
            prompt,
            stream,
            system = _systemPrompt,
            context = _context,         // null이면 새 대화, 있으면 이전 대화 이어서
            options = new { temperature = 0.2 }
        };
    }

    private static string GetDefaultBaseUrl()
    {
        var fromEnv = Environment.GetEnvironmentVariable("AITTY_OLLAMA_ENDPOINT");
        return string.IsNullOrWhiteSpace(fromEnv) ? "http://127.0.0.1:11434" : NormalizeBaseUrl(fromEnv);
    }

    private void AddAuthHeader(HttpRequestMessage request)
    {
        if (_apiKey is not null)
            request.Headers.Add("Authorization", $"Bearer {_apiKey}");
    }

    private static string NormalizeBaseUrl(string url) => url.Trim().TrimEnd('/');
}

public class OpenWebUiDiagnosisResult
{
    public bool Success { get; set; }
    public bool IsBlocked { get; set; }
    public string BaseUrl { get; set; } = string.Empty;
    public bool IsOpenWebUi { get; set; }
    public int ModelsCount { get; set; }
    public List<string> Logs { get; set; } = new();
}
