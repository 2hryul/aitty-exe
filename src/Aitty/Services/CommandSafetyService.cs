using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Aitty.Services;

/// <summary>
/// 백엔드 방어 계층 — 치명적 명령 패턴만 이중 검증.
/// 프론트엔드(commandSafety.ts) 우회 시 최후 방어선.
///
/// 정책 SoT: webapp/policies/command-safety.json (임베디드 리소스)
/// 백엔드는 danger 카테고리만 차단 (caution/warning은 프론트 경고용 — 백엔드 강제 차단 시 SSH 명령이 광범위하게 막힐 위험).
/// </summary>
public static class CommandSafetyService
{
    /// <summary>
    /// JSON 정책의 단일 패턴 항목 (camelCase 키 매핑)
    /// </summary>
    private sealed record PatternEntry(
        string Pattern,
        string? Flags,
        string Reason,
        string Alternative
    );

    /// <summary>
    /// 위험명령 정책 전체 스키마 (version + 3 카테고리)
    /// </summary>
    private sealed record CommandSafetyPolicy(
        string Version,
        List<PatternEntry> Danger,
        List<PatternEntry> Caution,
        List<PatternEntry> Warning
    );

    // Lazy<T>로 첫 호출 시 1회만 JSON 파싱/Regex 컴파일 → 부팅 속도 영향 없음
    private static readonly Lazy<List<Regex>> _dangerRegexes = new(LoadPatterns);

    private static List<Regex> LoadPatterns()
    {
        var asm = typeof(CommandSafetyService).Assembly;
        const string resourceName = "Aitty.Resources.command-safety.json";

        using var stream = asm.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException(
                $"[CommandSafetyService] 임베디드 리소스 누락: {resourceName}");
        using var reader = new StreamReader(stream);
        var json = reader.ReadToEnd();

        // JSON 키는 camelCase("pattern", "danger" 등) ↔ C# record는 PascalCase
        var options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        };

        var policy = JsonSerializer.Deserialize<CommandSafetyPolicy>(json, options)
            ?? throw new InvalidOperationException(
                "[CommandSafetyService] command-safety.json 파싱 결과가 null");

        // 백엔드는 danger 카테고리만 차단 (caution/warning은 프론트 경고 전용)
        return policy.Danger
            .Select(entry => new Regex(
                entry.Pattern,
                ParseFlags(entry.Flags) | RegexOptions.Compiled))
            .ToList();
    }

    /// <summary>
    /// JSON flags 문자열("m", "i", "" 등)을 .NET RegexOptions로 변환.
    /// JS regex 플래그 ↔ .NET Regex 옵션 매핑.
    /// </summary>
    private static RegexOptions ParseFlags(string? flags)
    {
        var opts = RegexOptions.None;
        if (string.IsNullOrEmpty(flags)) return opts;
        if (flags.Contains('m')) opts |= RegexOptions.Multiline;
        if (flags.Contains('i')) opts |= RegexOptions.IgnoreCase;
        return opts;
    }

    /// <summary>
    /// 치명적 명령 패턴 매칭 — true면 차단 대상
    /// </summary>
    public static bool IsDangerous(string command)
    {
        if (string.IsNullOrWhiteSpace(command)) return false;

        foreach (var pattern in _dangerRegexes.Value)
        {
            if (pattern.IsMatch(command))
                return true;
        }
        return false;
    }
}
