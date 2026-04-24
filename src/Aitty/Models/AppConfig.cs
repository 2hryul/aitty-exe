namespace Aitty.Models;

public class AppConfig
{
    public string Theme { get; set; } = "dark";
    public int FontSize { get; set; } = 12;
    public string FontFamily { get; set; } = "Consolas, \"Courier New\"";
    public List<SshConnection> SshConnections { get; set; } = new();
    public string? LastConnection { get; set; }

    /// <summary>
    /// OpenAI 호환 Base URL. 비어있으면 공식 OpenAI(api.openai.com) 사용.
    /// Shinhan Hands API Gateway, Azure OpenAI, vLLM 등 호환 게이트웨이 사용 시 설정.
    /// </summary>
    public string? OpenAiBaseUrl { get; set; }

    /// <summary>
    /// SSL 인증서 검증 건너뛰기. 내부망 자체서명 인증서 엔드포인트 사용 시 활성화.
    /// 보안상 주의 필요 — 사용자가 UI에서 명시 활성화해야만 적용됨.
    /// </summary>
    public bool AllowInsecureSsl { get; set; } = false;
}
