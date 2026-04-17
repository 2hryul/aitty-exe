using System.Text;
using System.Text.RegularExpressions;

namespace Aitty.Services;

/// <summary>
/// 제공자/모델 별 입력 바이트 예산과 청크 분할 유틸.
/// 상태 없음(static). 모델이 늘어나면 BudgetTable만 추가한다.
/// </summary>
public static class AiBudget
{
    // 상태 코드 (문자열 상수로 통일해 프론트와 매칭)
    public const string StatusOk     = "Ok";
    public const string StatusWarn   = "Warn";
    public const string StatusReject = "Reject";

    // 폴백 예산 — 미지의 모델에 적용
    private const int FallbackBudget = 50_000;

    /// <summary>모델 매칭 테이블 — 위에서부터 순서대로 첫 매치가 적용된다.</summary>
    private static readonly (string Provider, Regex ModelPattern, int Budget)[] BudgetTable =
    [
        // Claude
        ("claude", new Regex(@"claude-(opus|sonnet)-4", RegexOptions.IgnoreCase | RegexOptions.Compiled), 600_000),
        ("claude", new Regex(@"claude-haiku-4\.5", RegexOptions.IgnoreCase | RegexOptions.Compiled), 400_000),

        // OpenAI — gpt-4o-mini 먼저(더 구체적), 그 다음 gpt-4o
        ("openai", new Regex(@"gpt-4o-mini|gpt-3\.5", RegexOptions.IgnoreCase | RegexOptions.Compiled), 200_000),
        ("openai", new Regex(@"gpt-4o", RegexOptions.IgnoreCase | RegexOptions.Compiled), 350_000),

        // Gemini
        ("gemini", new Regex(@"gemini-1\.5-pro", RegexOptions.IgnoreCase | RegexOptions.Compiled), 1_000_000),
        ("gemini", new Regex(@"gemini-1\.5-flash", RegexOptions.IgnoreCase | RegexOptions.Compiled), 800_000),
        ("gemini", new Regex(@"gemini-2\.0-flash", RegexOptions.IgnoreCase | RegexOptions.Compiled), 800_000),

        // Ollama — 32K variant 우선(더 구체적), 그 다음 기본
        ("ollama", new Regex(@"32k|qwen2\.5", RegexOptions.IgnoreCase | RegexOptions.Compiled), 90_000),
        ("ollama", new Regex(@".*", RegexOptions.IgnoreCase | RegexOptions.Compiled), 24_000),
    ];

    /// <summary>provider+model에 맞는 입력 바이트 상한을 반환. 미지의 조합은 폴백.</summary>
    public static int For(string provider, string model)
    {
        if (string.IsNullOrWhiteSpace(provider) || string.IsNullOrWhiteSpace(model))
            return FallbackBudget;

        var p = provider.ToLowerInvariant();
        foreach (var row in BudgetTable)
        {
            if (row.Provider != p) continue;
            if (row.ModelPattern.IsMatch(model))
                return row.Budget;
        }
        return FallbackBudget;
    }

    /// <summary>입력 크기 대 예산 비율로 Ok/Warn/Reject 판정.</summary>
    public static BudgetCheck Evaluate(int sizeBytes, string provider, string model)
    {
        var budget = For(provider, model);
        var ratio = budget > 0 ? (double)sizeBytes / budget : 0.0;

        string status;
        if (sizeBytes <= budget)
            status = StatusOk;
        else if (sizeBytes <= budget * 5)
            status = StatusWarn;
        else
            status = StatusReject;

        // 청크 크기는 budget의 80% 기준 — 안전 여유
        var chunkSize = Math.Max(1, (int)(budget * 0.8));
        var suggested = (int)Math.Ceiling((double)sizeBytes / chunkSize);
        if (suggested < 1) suggested = 1;

        return new BudgetCheck(status, budget, sizeBytes, ratio, suggested);
    }

    /// <summary>
    /// UTF-8 바이트 기준 청크 분할. 각 청크는 `chunkBytes`에 가장 가까운 `\n` 경계에서 자른다.
    /// char 기반 Substring은 사용하지 않는다 — 멀티바이트 문자 손실 방지.
    /// </summary>
    public static IEnumerable<LogChunk> Split(string content, int chunkBytes)
    {
        if (chunkBytes <= 0)
            throw new ArgumentException("[AiBudget.Split] chunkBytes 0 이하 - " + chunkBytes);

        if (string.IsNullOrEmpty(content))
            yield break;

        var bytes = Encoding.UTF8.GetBytes(content);

        // 1차: 바이트 경계 계산 (청크 시작/끝)
        var boundaries = ComputeChunkBoundaries(bytes, chunkBytes);

        // 2차: 각 경계에서 실제 청크 생성 (문자열 복원 + 라인 번호)
        int curLine = 1;
        int idx = 0;
        int totalChunks = boundaries.Count;
        foreach (var (start, end) in boundaries)
        {
            var slice = new byte[end - start];
            Buffer.BlockCopy(bytes, start, slice, 0, slice.Length);
            var chunkText = Encoding.UTF8.GetString(slice);

            var startLine = curLine;
            var endLine = startLine + CountNewlines(chunkText) - 1;
            if (endLine < startLine) endLine = startLine;
            curLine = endLine + 1;

            yield return new LogChunk(
                Index: idx,
                Total: totalChunks,
                StartByte: start,
                EndByte: end,
                StartLine: startLine,
                EndLine: endLine,
                Content: chunkText);
            idx++;
        }
    }

    /// <summary>
    /// 각 청크의 (startByte, endByte-exclusive) 목록 생성.
    /// `chunkBytes` 지점에서 가장 가까운(역방향 우선) '\n' 다음 위치를 경계로 삼는다.
    /// </summary>
    private static List<(int Start, int End)> ComputeChunkBoundaries(byte[] bytes, int chunkBytes)
    {
        var result = new List<(int, int)>();
        int pos = 0;
        int len = bytes.Length;

        while (pos < len)
        {
            int tentativeEnd = Math.Min(pos + chunkBytes, len);
            if (tentativeEnd >= len)
            {
                result.Add((pos, len));
                break;
            }

            // 역방향으로 '\n' 찾기 — 줄 중간 자르기 방지
            int cut = -1;
            for (int i = tentativeEnd - 1; i > pos; i--)
            {
                if (bytes[i] == (byte)'\n')
                {
                    cut = i + 1; // '\n' 포함, 다음 바이트부터 새 청크
                    break;
                }
            }

            // 청크 내에 '\n'이 전혀 없으면 강제로 tentativeEnd에서 자른다
            if (cut < 0) cut = tentativeEnd;

            result.Add((pos, cut));
            pos = cut;
        }

        return result;
    }

    private static int CountNewlines(string s)
    {
        if (string.IsNullOrEmpty(s)) return 0;
        int count = 0;
        foreach (var ch in s)
            if (ch == '\n') count++;
        return count;
    }
}

/// <summary>예산 판정 결과.</summary>
public record BudgetCheck(string Status, int Budget, int SizeBytes, double Ratio, int SuggestedChunks);

/// <summary>로그 청크(분할 분석용).</summary>
public record LogChunk(int Index, int Total, int StartByte, int EndByte, int StartLine, int EndLine, string Content);
