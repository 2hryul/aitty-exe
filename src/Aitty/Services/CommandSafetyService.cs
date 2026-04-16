using System.Text.RegularExpressions;

namespace Aitty.Services;

/// <summary>
/// 백엔드 방어 계층 — 치명적 명령 패턴만 이중 검증.
/// 프론트엔드(commandSafety.ts) 우회 시 최후 방어선.
/// </summary>
public static class CommandSafetyService
{
    private static readonly Regex[] DangerPatterns =
    [
        // rm -rf / 계열
        new(@"\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+/\s*$", RegexOptions.Compiled | RegexOptions.Multiline),
        new(@"\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+/\*", RegexOptions.Compiled),
        new(@"\brm\s+.*--no-preserve-root", RegexOptions.Compiled),

        // 디스크 포맷/덮어쓰기
        new(@"\bmkfs(\.\w+)?\s+/dev/", RegexOptions.Compiled),
        new(@"\bdd\s+.*if=/dev/(zero|random|urandom)\s+.*of=/dev/sd", RegexOptions.Compiled),

        // Fork bomb
        new(@":\(\)\s*\{[^}]*:\s*\|\s*:", RegexOptions.Compiled),

        // chmod 777 -R /
        new(@"\bchmod\s+(777\s+(-[a-zA-Z]*R)|(-[a-zA-Z]*R)\s+777)\s+/\s*$", RegexOptions.Compiled | RegexOptions.Multiline),
    ];

    /// <summary>
    /// 치명적 명령 패턴 매칭 — true면 차단 대상
    /// </summary>
    public static bool IsDangerous(string command)
    {
        if (string.IsNullOrWhiteSpace(command)) return false;

        foreach (var pattern in DangerPatterns)
        {
            if (pattern.IsMatch(command))
                return true;
        }
        return false;
    }
}
