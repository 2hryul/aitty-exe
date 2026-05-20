using Aitty.Models;

namespace Aitty.Services;

/// <summary>
/// 모든 AI 서비스 제공자(Ollama, Gemini 등)의 공통 인터페이스.
/// 새 제공자 추가 시 이 인터페이스만 구현하면 됨.
/// </summary>
public interface IAiService : IDisposable
{
    string ProviderName  { get; }
    string CurrentModel  { get; }
    string? SystemPrompt { get; }  // 세션 저장을 위해 현재 시스템 프롬프트 노출
    bool IsConfigured    { get; }
    IReadOnlyList<AiChatMessage> History { get; }

    // ── 디폴트값 Single Source of Truth (프론트엔드는 IPC로만 조회) ── //
    /// <summary>각 서비스의 권장 기본 모델명.</summary>
    string DefaultModel { get; }
    /// <summary>권장 기본 시스템 프롬프트. null이면 시스템 프롬프트 미사용 권장.</summary>
    string? DefaultSystemPrompt { get; }
    /// <summary>현재 base URL (claude/gemini는 공식 URL 고정 반환).</summary>
    string BaseUrl { get; }

    void SetModel(string model);
    void SetSystemPrompt(string? systemPrompt);
    void SetHistory(IEnumerable<AiChatMessage> messages);  // 세션 복원
    void ClearHistory();

    Task<bool> IsEngineAvailableAsync(CancellationToken ct = default);
    Task<List<string>> ListModelsAsync(CancellationToken ct = default);
    Task<AiChatResponse> SendMessageAsync(string userMessage, CancellationToken ct = default);
    Task<AiChatResponse> SendStreamingAsync(string userMessage, Action<string> onChunk, CancellationToken ct = default);
}
