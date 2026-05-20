using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;

namespace Aitty.Services;

/// <summary>
/// logcheck.sh를 원격 서버에서 실행하는 서비스.
///
/// 동작:
/// 1) 어셈블리에 임베드된 logcheck.sh 본문을 base64로 인코딩
/// 2) `echo BASE64 | base64 -d | bash -s -- &lt;path&gt; [args]` 형태로 단일 SSH 명령 조립
/// 3) <see cref="SshService.ExecuteAsync"/>로 실행, stdout을 <see cref="LogPayload"/>로 래핑
///
/// 원격 서버에 logcheck.sh 사전 설치 불필요 — 매 호출마다 stdin으로 전달.
/// CommandSafetyService는 우회: 페이로드 검증 + 신뢰된 스크립트 본문이라 안전.
/// </summary>
public class LogCheckService
{
    private readonly SshService _ssh;
    private static readonly string Script = LoadEmbeddedScript();
    private static readonly string ScriptB64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(Script));

    public LogCheckService(SshService ssh) { _ssh = ssh; }

    public static readonly string[] AllowedModes = ["summary", "search", "recent", "range", "top"];
    private static readonly Regex DateTimeRegex = new(@"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$", RegexOptions.Compiled);

    /// <summary>logcheck 실행 후 LogPayload 반환. 검증 실패 시 InvalidOperationException.</summary>
    public async Task<LogPayload> CheckAsync(LogCheckPayload p, CancellationToken ct)
    {
        Validate(p);
        var cmd = BuildCommand(p);
        var output = await _ssh.ExecuteAsync(cmd, ct);

        var content = output ?? string.Empty;
        var sizeBytes = Encoding.UTF8.GetByteCount(content);
        var lineCount = CountLines(content);
        var host = _ssh.State.Connection?.Host;

        return new LogPayload(
            Source:      $"logcheck:{p.Mode} {p.Path}",
            Host:        host,
            SizeBytes:   sizeBytes,
            LineCount:   lineCount,
            Content:     content,
            CollectedAt: DateTimeOffset.UtcNow
        );
    }

    /// <summary>모드별 필수 필드 + 범위 검증. 실패 시 한국어 메시지로 throw.</summary>
    public static void Validate(LogCheckPayload p)
    {
        if (string.IsNullOrWhiteSpace(p.Path))
            throw new InvalidOperationException("[LogCheck] 로그 파일 경로가 비어 있습니다");
        if (p.Path.Length > 4096)
            throw new InvalidOperationException("[LogCheck] 경로가 너무 깁니다(최대 4096)");
        if (p.Path.Contains('\0'))
            throw new InvalidOperationException("[LogCheck] 경로에 NUL 문자가 포함되어 있습니다");
        if (!p.Path.StartsWith('/'))
            throw new InvalidOperationException("[LogCheck] 절대 경로(/ 시작)만 허용됩니다");
        if (p.Path.Contains(".."))
            throw new InvalidOperationException("[LogCheck] 상대 경로(..)는 허용되지 않습니다");

        if (Array.IndexOf(AllowedModes, p.Mode) < 0)
            throw new InvalidOperationException($"[LogCheck] 알 수 없는 모드: {p.Mode}");

        switch (p.Mode)
        {
            case "search":
                if (string.IsNullOrEmpty(p.Pattern))
                    throw new InvalidOperationException("[LogCheck] 패턴 검색 모드에는 pattern이 필요합니다");
                if (p.Pattern!.Length > 1024)
                    throw new InvalidOperationException("[LogCheck] 패턴이 너무 깁니다(최대 1024)");
                if (p.CtxAfter is int a && (a < 0 || a > 50))
                    throw new InvalidOperationException("[LogCheck] -A 컨텍스트는 0~50 범위만 허용됩니다");
                if (p.CtxBefore is int b && (b < 0 || b > 50))
                    throw new InvalidOperationException("[LogCheck] -B 컨텍스트는 0~50 범위만 허용됩니다");
                break;

            case "recent":
                if (p.Hours is not int h || h < 1 || h > 720)
                    throw new InvalidOperationException("[LogCheck] hours는 1~720 범위에서 지정하세요");
                break;

            case "range":
                if (string.IsNullOrEmpty(p.From) || string.IsNullOrEmpty(p.To))
                    throw new InvalidOperationException("[LogCheck] 기간 모드에는 from/to가 모두 필요합니다");
                if (!DateTimeRegex.IsMatch(p.From!) || !DateTimeRegex.IsMatch(p.To!))
                    throw new InvalidOperationException("[LogCheck] from/to 형식: YYYY-MM-DD HH:MM:SS");
                if (string.CompareOrdinal(p.From, p.To) > 0)
                    throw new InvalidOperationException("[LogCheck] from은 to보다 이후일 수 없습니다");
                break;

            case "top":
                var n = p.TopN ?? 10;
                if (n < 1 || n > 100)
                    throw new InvalidOperationException("[LogCheck] topN은 1~100 범위에서 지정하세요");
                break;
        }
    }

    /// <summary>최종 SSH 명령 문자열 조립.</summary>
    public static string BuildCommand(LogCheckPayload p)
    {
        var argv = BuildArgv(p);
        // echo의 줄바꿈/이스케이프 영향을 피하려고 base64는 단일 토큰. printf %s 대신 echo 사용은 base64 표준 알파벳 안전.
        return $"echo {ScriptB64} | base64 -d | bash -s -- {argv}";
    }

    /// <summary>logcheck.sh에 전달할 인자 문자열 (path + 모드 옵션). 모든 동적 값은 단일따옴표 + '\\''로 이스케이프.</summary>
    public static string BuildArgv(LogCheckPayload p)
    {
        var sb = new StringBuilder();
        sb.Append(Esc(p.Path));
        switch (p.Mode)
        {
            case "summary":
                break;
            case "search":
                sb.Append(" -p ").Append(Esc(p.Pattern!));
                if (p.IgnoreCase) sb.Append(" -i");
                if (p.CtxAfter  is int a && a > 0) sb.Append(" -A ").Append(a);
                if (p.CtxBefore is int b && b > 0) sb.Append(" -B ").Append(b);
                break;
            case "recent":
                sb.Append(" -t ").Append(Esc($"{p.Hours}h"));
                break;
            case "range":
                sb.Append(" -t ").Append(Esc($"{p.From},{p.To}"));
                break;
            case "top":
                sb.Append(" -T ").Append(p.TopN ?? 10);
                break;
        }
        return sb.ToString();
    }

    /// <summary>단일따옴표 wrap + 내부 ' 이스케이프 (POSIX shell quoting).</summary>
    private static string Esc(string v) => "'" + v.Replace("'", "'\\''") + "'";

    private static string LoadEmbeddedScript()
    {
        var asm = Assembly.GetExecutingAssembly();
        const string resource = "Aitty.Resources.logcheck.sh";
        using var stream = asm.GetManifestResourceStream(resource)
            ?? throw new InvalidOperationException($"[LogCheck] 임베디드 리소스 누락: {resource}");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static int CountLines(string content)
    {
        if (string.IsNullOrEmpty(content)) return 0;
        var count = 1;
        foreach (var ch in content)
            if (ch == '\n') count++;
        if (content[^1] == '\n') count--;
        return count;
    }
}

/// <summary>logs:check IPC 페이로드.</summary>
public class LogCheckPayload
{
    public string  Path        { get; set; } = string.Empty;
    public string  Mode        { get; set; } = string.Empty;   // summary | search | recent | range | top
    public string? Pattern     { get; set; }
    public bool    IgnoreCase  { get; set; }
    public int?    CtxAfter    { get; set; }
    public int?    CtxBefore   { get; set; }
    public int?    Hours       { get; set; }
    public string? From        { get; set; }   // "YYYY-MM-DD HH:MM:SS"
    public string? To          { get; set; }
    public int?    TopN        { get; set; }
}
