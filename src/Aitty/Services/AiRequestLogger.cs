using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;

namespace Aitty.Services;

/// <summary>
/// AI API 호출 전용 진단 로거.
///
/// 기록 위치: %LOCALAPPDATA%\Aitty\logs\ai_api.log (매 실행마다 초기화)
///
/// 기록 항목:
///   - 환경 정보 덤프 (base_url 정규화 결과, HTTP_PROXY/HTTPS_PROXY/NO_PROXY, SSL 정책)
///   - Request: METHOD URL, Headers(Auth 마스킹), Body(2KB 제한)
///   - Response: Status, Headers, Body(2KB 제한), 소요시간
///   - Exception: 타입/메시지/Inner chain
///
/// 보안:
///   - Bearer/sk-/AIza- 계열 토큰 자동 마스킹 (앞 8자 + 마지막 4자 노출)
///   - 로그 파일은 사용자 로컬에만 저장됨
/// </summary>
public static class AiRequestLogger
{
    private static readonly string LogDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Aitty", "logs");

    public static readonly string LogPath = Path.Combine(LogDir, "ai_api.log");

    private static readonly object FileLock = new();
    private static bool _initialized;

    private const int MaxBodyPreview = 2048; // 응답 본문 최대 기록 크기

    // Bearer / sk-* / AIza* / UUID 스타일 토큰 마스킹 패턴
    private static readonly Regex TokenPattern = new(
        @"(Bearer\s+)([A-Za-z0-9\-_]{8})[A-Za-z0-9\-_]{4,}([A-Za-z0-9\-_]{4})",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex ApiKeyJsonPattern = new(
        @"""(api[_-]?key|apikey|authorization)""\s*:\s*""([^""]{8})[^""]{4,}([^""]{4})""",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // [C-1] 헤더 값 전체가 키인 경우(x-api-key 등) MaskSensitive 정규식이 매치하지 못해
    //       평문 노출되는 문제를 차단. 이 화이트리스트의 헤더는 무조건 ***REDACTED***로 치환.
    private static readonly HashSet<string> SensitiveHeaderNames =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "x-api-key", "authorization", "api-key", "x-api-token",
            "x-goog-api-key", "anthropic-api-key", "openai-organization"
        };

    // [S-1] URL query string에 키를 싣는 provider(Gemini: ?key=...) 대응.
    //       헤더 화이트리스트(C-1)만으로는 Gemini API 키가 RequestUri에 평문 노출됨.
    //       앞 4자 + **** 형태로 마스킹해 디버깅 식별성은 유지하되 키 전체 노출은 차단.
    private static readonly Regex UrlKeyQueryPattern = new(
        @"([?&](?:key|api[_-]?key|apikey|token|access[_-]?token)=)([^&\s]{4})[^&\s]+",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static string MaskUri(System.Uri? uri) =>
        uri is null
            ? "(null)"
            : UrlKeyQueryPattern.Replace(uri.ToString(),
                m => $"{m.Groups[1].Value}{m.Groups[2].Value}****");

    public static void Initialize()
    {
        if (_initialized) return;
        _initialized = true;
        try
        {
            Directory.CreateDirectory(LogDir);
            if (File.Exists(LogPath)) File.Delete(LogPath);
            DumpEnvironment();
        }
        catch (Exception ex)
        {
            System.Diagnostics.Trace.TraceError($"[AiRequestLogger] Init failed: {ex.Message}");
        }
    }

    private static void DumpEnvironment()
    {
        Append("=== AI Request Logger ===");
        Append($"Log Path: {LogPath}");
        Append($"Start Time: {DateTime.Now:yyyy-MM-dd HH:mm:ss}");
        Append("");
        Append("--- Environment ---");
        Append($"OS: {Environment.OSVersion}");
        Append($"CLR: {Environment.Version}");
        Append($"64-bit Process: {Environment.Is64BitProcess}");
        Append("");
        Append("--- Proxy Environment Variables (사내 PC 프록시 간섭 진단용) ---");
        Append($"HTTP_PROXY:  {Environment.GetEnvironmentVariable("HTTP_PROXY")  ?? "(not set)"}");
        Append($"HTTPS_PROXY: {Environment.GetEnvironmentVariable("HTTPS_PROXY") ?? "(not set)"}");
        Append($"NO_PROXY:    {Environment.GetEnvironmentVariable("NO_PROXY")    ?? "(not set)"}");
        Append($"ALL_PROXY:   {Environment.GetEnvironmentVariable("ALL_PROXY")   ?? "(not set)"}");
        Append(new string('-', 60));
    }

    /// <summary>설정 변경 시(Base URL, SSL, 모델, 프로바이더) 한 번씩 기록.</summary>
    public static void LogSetting(string category, string key, string? value)
    {
        Append($"[SETTING] {category}.{key} = {value ?? "(null)"}");
    }

    /// <summary>HTTP 요청 로그 — Bearer 토큰은 자동 마스킹.</summary>
    public static void LogRequest(HttpRequestMessage request, string? bodyJson = null, string? note = null)
    {
        try
        {
            var sb = new StringBuilder();
            sb.AppendLine(new string('=', 60));
            sb.AppendLine($"[REQUEST {DateTime.Now:HH:mm:ss.fff}] {request.Method} {MaskUri(request.RequestUri)}");
            if (!string.IsNullOrEmpty(note)) sb.AppendLine($"  NOTE: {note}");

            foreach (var h in request.Headers)
            {
                var rendered = SensitiveHeaderNames.Contains(h.Key)
                    ? "***REDACTED***"
                    : MaskSensitive(string.Join(", ", h.Value));
                sb.AppendLine($"  {h.Key}: {rendered}");
            }
            if (request.Content is not null)
            {
                foreach (var h in request.Content.Headers)
                    sb.AppendLine($"  {h.Key}: {string.Join(", ", h.Value)}");
            }

            if (!string.IsNullOrEmpty(bodyJson))
            {
                var masked = MaskSensitive(bodyJson);
                sb.AppendLine("  BODY:");
                sb.AppendLine("    " + Truncate(masked).Replace("\n", "\n    "));
            }
            Append(sb.ToString().TrimEnd());
        }
        catch (Exception ex)
        {
            Append($"[LogRequest 실패] {ex.Message}");
        }
    }

    /// <summary>HTTP 응답 로그. bodyText는 호출자가 미리 읽어서 전달(스트리밍 제외).</summary>
    public static void LogResponse(HttpResponseMessage? response, string? bodyText, long elapsedMs)
    {
        try
        {
            var sb = new StringBuilder();
            if (response is null)
            {
                sb.AppendLine($"[RESPONSE {DateTime.Now:HH:mm:ss.fff}] (response is null) elapsed={elapsedMs}ms");
            }
            else
            {
                sb.AppendLine($"[RESPONSE {DateTime.Now:HH:mm:ss.fff}] {(int)response.StatusCode} {response.StatusCode} elapsed={elapsedMs}ms");
                foreach (var h in response.Headers)
                {
                    var rendered = SensitiveHeaderNames.Contains(h.Key)
                        ? "***REDACTED***"
                        : string.Join(", ", h.Value);
                    sb.AppendLine($"  {h.Key}: {rendered}");
                }
                if (response.Content is not null)
                {
                    foreach (var h in response.Content.Headers)
                        sb.AppendLine($"  {h.Key}: {string.Join(", ", h.Value)}");
                }
                if (!string.IsNullOrEmpty(bodyText))
                {
                    sb.AppendLine("  BODY:");
                    sb.AppendLine("    " + Truncate(MaskSensitive(bodyText)).Replace("\n", "\n    "));
                }
            }
            Append(sb.ToString().TrimEnd());
        }
        catch (Exception ex)
        {
            Append($"[LogResponse 실패] {ex.Message}");
        }
    }

    public static void LogException(string context, Exception ex, long elapsedMs = -1)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"[EXCEPTION {DateTime.Now:HH:mm:ss.fff}] {context}" + (elapsedMs >= 0 ? $" elapsed={elapsedMs}ms" : ""));
        var cur = ex;
        int depth = 0;
        while (cur is not null && depth < 5)
        {
            var prefix = depth == 0 ? "  " : "  " + new string(' ', depth * 2) + "↳ ";
            sb.AppendLine($"{prefix}{cur.GetType().FullName}: {cur.Message}");
            cur = cur.InnerException;
            depth++;
        }
        if (!string.IsNullOrEmpty(ex.StackTrace))
            sb.AppendLine($"  StackTrace: {ex.StackTrace.Split('\n').FirstOrDefault()?.Trim()}");
        Append(sb.ToString().TrimEnd());
    }

    public static void LogInfo(string message) => Append($"[INFO {DateTime.Now:HH:mm:ss.fff}] {message}");

    private static void Append(string line)
    {
        try
        {
            lock (FileLock)
            {
                File.AppendAllText(LogPath, line + Environment.NewLine, Encoding.UTF8);
            }
        }
        catch { /* 로깅 실패가 앱 동작을 막으면 안 됨 */ }
    }

    private static string Truncate(string s) =>
        s.Length > MaxBodyPreview ? s[..MaxBodyPreview] + $"... ({s.Length - MaxBodyPreview} more chars)" : s;

    private static string MaskSensitive(string input)
    {
        if (string.IsNullOrEmpty(input)) return input;
        var s = TokenPattern.Replace(input, m => $"{m.Groups[1].Value}{m.Groups[2].Value}****...****{m.Groups[3].Value}");
        s = ApiKeyJsonPattern.Replace(s, m => $"\"{m.Groups[1].Value}\":\"{m.Groups[2].Value}****...****{m.Groups[3].Value}\"");
        return s;
    }
}
