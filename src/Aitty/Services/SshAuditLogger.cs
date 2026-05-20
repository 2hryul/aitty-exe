using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Aitty.Services;

/// <summary>
/// [M-3] SSH 명령 실행 감사 로그.
/// - 경로: %AppData%\ssh-ai-terminal\logs\audit_YYYYMMDD.log
/// - 포맷: NDJSON (한 줄 한 건)
/// - 민감 패턴(password=, token= 등) 자동 마스킹
/// - fire-and-forget: 로그 실패가 주 기능에 영향 없음
/// </summary>
public static class SshAuditLogger
{
    private static readonly string LogDir = System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "ssh-ai-terminal", "logs");

    // 민감 패턴: password=, apikey=, token=, secret=, passphrase= 등 (key=value 형식)
    private static readonly Regex SensitivePattern = new(
        @"(password|passwd|apikey|api_key|token|secret|passphrase|authorization)\s*[=:'""\s]\s*\S+",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // PII 추가 패턴 — 한국 실무 환경 대응
    // 주의: 이 마스킹은 감사 로그/UI 미리보기에만 적용. AI 분석 페이로드에는 절대 적용 금지(분석 정확도 훼손).
    private static readonly Regex PiiRrn    = new(@"\b\d{6}-?[1-4]\d{6}\b", RegexOptions.Compiled);
    private static readonly Regex PiiCard   = new(@"\b(?:\d{4}[- ]?){3}\d{4}\b", RegexOptions.Compiled);
    private static readonly Regex PiiJwt    = new(@"\beyJ[\w-]+\.[\w-]+\.[\w-]+\b", RegexOptions.Compiled);
    private static readonly Regex PiiEmail  = new(@"\b[\w.+-]+@[\w-]+\.[\w.-]+\b", RegexOptions.Compiled);
    private static readonly Regex PiiIpv4   = new(
        @"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b",
        RegexOptions.Compiled);
    // \b는 ASCII 워드 경계라 한글 매칭 불가 → 한글 키는 별도 패턴
    private static readonly Regex PiiEmpKey   = new(
        @"\b(emp(?:loyee)?_?id)\s*[=:]\s*\S+",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex PiiEmpKeyKr = new(
        @"(사번)\s*[=:]\s*\S+",
        RegexOptions.Compiled);

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    /// <summary>
    /// SSH 명령 실행 이벤트를 감사 로그에 기록.
    /// </summary>
    public static async Task LogExecAsync(
        string remoteHost,
        int port,
        string remoteUser,
        string command,
        string outputPreview,
        bool success,
        long durationMs,
        CancellationToken ct = default)
    {
        try
        {
            Directory.CreateDirectory(LogDir);

            var entry = new AuditEntry
            {
                Timestamp    = DateTime.UtcNow.ToString("o"),
                Event        = "ssh:exec",
                LocalUser    = Environment.UserName,
                RemoteUser   = remoteUser,
                RemoteHost   = remoteHost,
                Port         = port,
                Command      = MaskPii(command),
                ExitStatus   = success ? "success" : "failure",
                OutputPreview = MaskPii(
                    outputPreview.Length > 500
                        ? outputPreview[..500] + "…"
                        : outputPreview),
                DurationMs   = durationMs
            };

            var line = JsonSerializer.Serialize(entry, JsonOpts) + Environment.NewLine;
            var path = System.IO.Path.Combine(LogDir, $"audit_{DateTime.Now:yyyyMMdd}.log");
            await File.AppendAllTextAsync(path, line, Encoding.UTF8, ct);
        }
        catch
        {
            // 감사 로그 실패가 SSH 기능에 영향을 주지 않도록 무시
        }
    }

    /// <summary>로그 수집(파일/exec) 이벤트 기록.</summary>
    public static async Task LogFetchAsync(
        string source,
        int sizeBytes,
        CancellationToken ct = default)
    {
        try
        {
            Directory.CreateDirectory(LogDir);

            var entry = new
            {
                timestamp = DateTime.UtcNow.ToString("o"),
                @event    = "logs:fetch",
                localUser = Environment.UserName,
                source    = MaskPii(source),
                sizeBytes
            };

            var line = JsonSerializer.Serialize(entry, JsonOpts) + Environment.NewLine;
            var path = System.IO.Path.Combine(LogDir, $"audit_{DateTime.Now:yyyyMMdd}.log");
            await File.AppendAllTextAsync(path, line, Encoding.UTF8, ct);
        }
        catch { /* 로그 실패 무시 */ }
    }

    /// <summary>로그 AI 분석 이벤트 기록.</summary>
    public static async Task LogAnalyzeAsync(
        string provider,
        string model,
        int chunks,
        int totalBytes,
        CancellationToken ct = default)
    {
        try
        {
            Directory.CreateDirectory(LogDir);

            var entry = new
            {
                timestamp = DateTime.UtcNow.ToString("o"),
                @event    = "logs:analyze",
                localUser = Environment.UserName,
                provider,
                model,
                chunks,
                totalBytes
            };

            var line = JsonSerializer.Serialize(entry, JsonOpts) + Environment.NewLine;
            var path = System.IO.Path.Combine(LogDir, $"audit_{DateTime.Now:yyyyMMdd}.log");
            await File.AppendAllTextAsync(path, line, Encoding.UTF8, ct);
        }
        catch { /* 로그 실패 무시 */ }
    }

    /// <summary>SSH 접속 이벤트 기록.</summary>
    public static async Task LogConnectAsync(
        string remoteHost,
        int port,
        string remoteUser,
        bool success,
        string? error = null,
        CancellationToken ct = default)
    {
        try
        {
            Directory.CreateDirectory(LogDir);

            var entry = new
            {
                timestamp  = DateTime.UtcNow.ToString("o"),
                @event     = "ssh:connect",
                localUser  = Environment.UserName,
                remoteUser,
                remoteHost,
                port,
                exitStatus = success ? "success" : "failure",
                error      = error ?? string.Empty
            };

            var line = JsonSerializer.Serialize(entry, JsonOpts) + Environment.NewLine;
            var path = System.IO.Path.Combine(LogDir, $"audit_{DateTime.Now:yyyyMMdd}.log");
            await File.AppendAllTextAsync(path, line, Encoding.UTF8, ct);
        }
        catch { /* 로그 실패 무시 */ }
    }

    /// <summary>
    /// 키-값 시크릿 + PII(주민/카드/JWT/이메일/IPv4/사번 키) 일괄 마스킹.
    /// 감사 로그 및 UI 미리보기 전용 — AI 분석 페이로드에는 절대 적용하지 말 것.
    /// </summary>
    private static string MaskPii(string s)
    {
        if (string.IsNullOrEmpty(s)) return s;
        s = SensitivePattern.Replace(s, m => m.Groups[1].Value + "=***");
        s = PiiRrn.Replace(s, "***-*******");
        s = PiiCard.Replace(s, "****-****-****-****");
        s = PiiJwt.Replace(s, "eyJ***");
        s = PiiEmail.Replace(s, m => MaskEmail(m.Value));
        s = PiiIpv4.Replace(s, m => MaskIpv4(m.Value));
        s = PiiEmpKey.Replace(s, m => m.Groups[1].Value + "=***");
        s = PiiEmpKeyKr.Replace(s, m => m.Groups[1].Value + "=***");
        return s;
    }

    private static string MaskEmail(string e)
    {
        var i = e.IndexOf('@');
        if (i <= 0) return "***";
        if (i == 1) return e[..1] + "***" + e[i..];
        return e[..1] + "***" + e[i..];
    }

    private static string MaskIpv4(string ip)
    {
        var p = ip.Split('.');
        return p.Length == 4 ? $"{p[0]}.{p[1]}.*.*" : ip;
    }

    private class AuditEntry
    {
        public string Timestamp    { get; set; } = string.Empty;
        public string Event        { get; set; } = string.Empty;
        public string LocalUser    { get; set; } = string.Empty;
        public string RemoteUser   { get; set; } = string.Empty;
        public string RemoteHost   { get; set; } = string.Empty;
        public int    Port         { get; set; }
        public string Command      { get; set; } = string.Empty;
        public string ExitStatus   { get; set; } = string.Empty;
        public string OutputPreview{ get; set; } = string.Empty;
        public long   DurationMs   { get; set; }
    }
}
