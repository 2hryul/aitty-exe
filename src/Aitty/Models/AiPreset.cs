namespace Aitty.Models;

/// <summary>
/// 접속에 성공한 AI 설정 스냅샷 — API 키는 AES-256-GCM 암호화 상태로 저장.
/// 저장 위치: %APPDATA%\ssh-ai-terminal\ai-presets.json
/// </summary>
public class AiPreset
{
    /// <summary>사용자 지정 식별 이름 (예: "Shinhan Hands Dev", "My OpenAI").</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>ollama | openai | claude | gemini</summary>
    public string Provider { get; set; } = string.Empty;

    /// <summary>OpenAI 호환 게이트웨이의 Base URL (Ollama도 공유).</summary>
    public string? BaseUrl { get; set; }

    /// <summary>사용 모델 이름.</summary>
    public string? Model { get; set; }

    /// <summary>AES-256-GCM 암호화된 API 키 (Base64). 평문은 절대 저장 안 함.</summary>
    public string EncryptedApiKey { get; set; } = string.Empty;

    /// <summary>SSL 검증 정책 (내부망 자체서명 인증서 허용 여부).</summary>
    public bool AllowInsecureSsl { get; set; }

    /// <summary>시스템 프롬프트(선택).</summary>
    public string? SystemPrompt { get; set; }

    public DateTime SavedAt    { get; set; } = DateTime.UtcNow;
    public DateTime LastUsedAt { get; set; } = DateTime.UtcNow;
}
