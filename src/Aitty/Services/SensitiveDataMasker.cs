using System.Text.RegularExpressions;

namespace Aitty.Services;

/// <summary>
/// [M-B] 공용 민감 데이터 마스킹 유틸.
///
/// AiRequestLogger에 흩어져 있던 마스킹 패턴(Bearer/sk-/AIza, URL ?key=, 헤더 화이트리스트)을
/// 한 곳에 모아 다른 로거(StartupLogger의 JS Console 캡처 등)에서도 재사용할 수 있게 분리.
///
/// 정책:
///   - 마스킹은 표시용. 비교/저장에 사용하지 않는다.
///   - 패턴 매치 실패 시 입력 원문을 그대로 반환(과도한 redact로 디버깅 가독성 손실 방지).
///   - 외부 라이브러리(xterm, React DevTools 등)가 console에 흘리는 토큰/키를
///     latest.log에 평문 저장하는 경로를 막는다.
/// </summary>
public static class SensitiveDataMasker
{
    // Bearer / sk-* 등 헤더 안의 긴 토큰 (앞 8 + 뒤 4만 노출)
    private static readonly Regex TokenPattern = new(
        @"(Bearer\s+)([A-Za-z0-9\-_]{8})[A-Za-z0-9\-_]{4,}([A-Za-z0-9\-_]{4})",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // JSON 본문 내 api_key / apikey / authorization 필드
    private static readonly Regex ApiKeyJsonPattern = new(
        @"""(api[_-]?key|apikey|authorization)""\s*:\s*""([^""]{8})[^""]{4,}([^""]{4})""",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // URL query string의 키 파라미터 (Gemini ?key=... 등)
    private static readonly Regex UrlKeyQueryPattern = new(
        @"([?&](?:key|api[_-]?key|apikey|token|access[_-]?token)=)([^&\s]{4})[^&\s]+",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // sk-*, AIza* 등 토큰 전체 형태 (JSON 키 없이 본문에 평문으로 노출되는 케이스)
    // 예: "sk-proj-aBcD1234..." → "sk-proj-****...****wXyZ"
    private static readonly Regex BareTokenPattern = new(
        @"\b(sk-[A-Za-z0-9\-_]{4}|AIza[A-Za-z0-9\-_]{4}|sk-ant-[A-Za-z0-9\-_]{4})[A-Za-z0-9\-_]{8,}([A-Za-z0-9\-_]{4})\b",
        RegexOptions.Compiled);

    // 헤더명 화이트리스트 — 값 전체가 키인 헤더는 정규식이 매치하지 못해 평문 노출 위험.
    private static readonly HashSet<string> SensitiveHeaders =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "x-api-key", "authorization", "api-key", "x-api-token",
            "x-goog-api-key", "anthropic-api-key", "openai-organization"
        };

    /// <summary>
    /// 입력 문자열에서 알려진 민감 토큰을 마스킹한다.
    /// 패턴 비매치 시 원문 그대로 반환 → 외부 라이브러리 정상 로그의 가독성 보존.
    /// </summary>
    public static string Mask(string? input)
    {
        if (string.IsNullOrEmpty(input)) return input ?? string.Empty;
        var s = TokenPattern.Replace(input, m => $"{m.Groups[1].Value}{m.Groups[2].Value}****...****{m.Groups[3].Value}");
        s = ApiKeyJsonPattern.Replace(s, m => $"\"{m.Groups[1].Value}\":\"{m.Groups[2].Value}****...****{m.Groups[3].Value}\"");
        s = BareTokenPattern.Replace(s, m => $"{m.Groups[1].Value}****...****{m.Groups[2].Value}");
        s = UrlKeyQueryPattern.Replace(s, m => $"{m.Groups[1].Value}{m.Groups[2].Value}****");
        return s;
    }

    /// <summary>URL의 query 키만 마스킹 (헤더/본문 마스킹이 필요 없는 호출자용).</summary>
    public static string MaskUrl(string? url)
    {
        if (string.IsNullOrEmpty(url)) return url ?? string.Empty;
        return UrlKeyQueryPattern.Replace(url, m => $"{m.Groups[1].Value}{m.Groups[2].Value}****");
    }

    /// <summary>화이트리스트에 있는 헤더명인지 — 값 전체를 ***REDACTED***로 치환할지 결정.</summary>
    public static bool IsSensitiveHeader(string headerName) =>
        !string.IsNullOrEmpty(headerName) && SensitiveHeaders.Contains(headerName);
}
