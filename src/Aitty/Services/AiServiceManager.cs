namespace Aitty.Services;

/// <summary>
/// AI 서비스 제공자를 관리하고 전환하는 매니저.
/// 현재 지원: ollama, gemini, claude, openai
/// [H-1] API 키는 SecureApiKeyStore (DPAPI)로 암호화 저장.
/// </summary>
public class AiServiceManager : IDisposable
{
    private readonly LocalLlmService _ollamaService;
    private readonly GeminiService _geminiService;
    private readonly ClaudeApiService _claudeService;
    private readonly OpenAiService _openAiService;

    // [H-1] 평문 Dictionary → DPAPI 암호화 저장소로 교체
    private readonly SecureApiKeyStore _keyStore = new();

    private string _activeProvider = "ollama";

    public AiServiceManager()
    {
        _ollamaService  = new LocalLlmService();
        _geminiService  = new GeminiService();
        _claudeService  = new ClaudeApiService();
        _openAiService  = new OpenAiService();
    }

    /// <summary>현재 활성 제공자 이름</summary>
    public string ActiveProvider => _activeProvider;

    /// <summary>현재 활성 서비스 인스턴스</summary>
    public IAiService Active => _activeProvider switch
    {
        "gemini" => _geminiService,
        "claude" => _claudeService,
        "openai" => _openAiService,
        _ => _ollamaService
    };

    /// <summary>Ollama 전용 속성 접근 (endpoint 변경 등)</summary>
    public LocalLlmService Ollama => _ollamaService;

    /// <summary>OpenAI 전용 속성 접근 (호환 게이트웨이용 Base URL 변경 등)</summary>
    public OpenAiService OpenAi => _openAiService;

    /// <summary>
    /// SSL 검증 정책을 모든 AI 서비스(ollama/openai/claude/gemini)에 일괄 적용.
    /// 내부망 자체서명 인증서 엔드포인트 연결 시 true로 설정.
    /// </summary>
    public void SetAllowInsecureSsl(bool allow)
    {
        _ollamaService.SetAllowInsecureSsl(allow);
        _openAiService.SetAllowInsecureSsl(allow);
        _claudeService.SetAllowInsecureSsl(allow);
        _geminiService.SetAllowInsecureSsl(allow);
    }

    // ── 제공자 전환 ───────────────────────────────────────── //

    /// <summary>제공자 전환. 지원값: "ollama" | "gemini" | "claude" | "openai"</summary>
    public void SwitchProvider(string provider)
    {
        var normalized = provider.ToLowerInvariant();
        _activeProvider = normalized switch
        {
            "gemini" => "gemini",
            "claude" => "claude",
            "openai" => "openai",
            _ => "ollama"
        };
    }

    // ── API 키 관리 ───────────────────────────────────────── //

    /// <summary>
    /// API 키 설정. SecureApiKeyStore에 암호화 저장 후 해당 서비스에 즉시 반영.
    /// 서비스 레벨은 HTTP 요청을 위해 평문이 필요하지만, 매니저 레벨 중복 저장은 제거.
    /// </summary>
    public void SetApiKey(string provider, string apiKey)
    {
        var normalized = provider.ToLowerInvariant();

        // [H-1] 암호화 저장소에 저장 (평문 Dictionary 제거)
        _keyStore.Set(normalized, apiKey);

        // 서비스에 즉시 반영 (서비스 레벨은 HTTP 헤더에 필요)
        switch (normalized)
        {
            case "ollama": _ollamaService.SetApiKey(apiKey); break;
            case "gemini": _geminiService.SetApiKey(apiKey); break;
            case "claude": _claudeService.SetApiKey(apiKey); break;
            case "openai": _openAiService.SetApiKey(apiKey); break;
        }
    }

    /// <summary>API 키 보유 여부 (암호화 저장소 기준)</summary>
    public bool HasApiKey(string provider)
        => _keyStore.Has(provider.ToLowerInvariant());

    /// <summary>제공자 상태 반환</summary>
    public string GetProviderStatus(string provider) => provider.ToLowerInvariant() switch
    {
        "gemini" => HasApiKey("gemini") ? "configured" : "no-api-key",
        "claude" => HasApiKey("claude") ? "configured" : "no-api-key",
        "openai" => HasApiKey("openai") ? "configured" : "no-api-key",
        "ollama" => "local",
        _ => "unknown"
    };

    /// <summary>
    /// 지원 제공자 목록과 상태. 모든 provider에 endpoint/defaultModel/defaultSystemPrompt 포함 (디폴트값 SoT).
    /// 프론트엔드는 이 응답으로 초기 모델/시스템 프롬프트/엔드포인트를 채움.
    /// </summary>
    public object[] GetProviders() =>
    [
        new {
            id = "ollama", name = "API 접속", status = GetProviderStatus("ollama"), requiresApiKey = false,
            endpoint = _ollamaService.BaseUrl,
            defaultModel = _ollamaService.DefaultModel,
            defaultSystemPrompt = _ollamaService.DefaultSystemPrompt,
        },
        new {
            id = "gemini", name = "Google Gemini", status = GetProviderStatus("gemini"), requiresApiKey = true,
            endpoint = _geminiService.BaseUrl,
            defaultModel = _geminiService.DefaultModel,
            defaultSystemPrompt = _geminiService.DefaultSystemPrompt,
        },
        new {
            id = "claude", name = "Anthropic Claude", status = GetProviderStatus("claude"), requiresApiKey = true,
            endpoint = _claudeService.BaseUrl,
            defaultModel = _claudeService.DefaultModel,
            defaultSystemPrompt = _claudeService.DefaultSystemPrompt,
        },
        new {
            id = "openai", name = "OpenAI", status = GetProviderStatus("openai"), requiresApiKey = true,
            endpoint = _openAiService.BaseUrl,
            defaultModel = _openAiService.DefaultModel,
            defaultSystemPrompt = _openAiService.DefaultSystemPrompt,
        },
    ];

    // ── 세션 저장/복원 ──────────────────────────────────────── //

    /// <summary>현재 활성 서비스의 세션 스냅샷을 반환.</summary>
    public Aitty.Models.SessionData GetSessionData() => new()
    {
        SavedAt      = DateTime.UtcNow,
        Engine       = _activeProvider,
        Provider     = _activeProvider,
        Model        = Active.CurrentModel,
        SystemPrompt = Active.SystemPrompt,
        Messages     = [.. Active.History]
    };

    /// <summary>저장된 세션을 복원. 제공자 전환 → 모델/프롬프트/히스토리 적용.</summary>
    public void RestoreSessionData(Aitty.Models.SessionData data)
    {
        SwitchProvider(data.Provider);
        if (!string.IsNullOrWhiteSpace(data.Model))
            Active.SetModel(data.Model);
        Active.SetSystemPrompt(data.SystemPrompt);
        if (data.Messages.Count > 0)
            Active.SetHistory(data.Messages);
    }

    public void Dispose()
    {
        _ollamaService.Dispose();
        _geminiService.Dispose();
        _claudeService.Dispose();
        _openAiService.Dispose();
        _keyStore.Dispose(); // [H-1] 암호화 키 메모리 소거
    }
}
