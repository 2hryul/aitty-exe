using System.Text.Json.Serialization;

namespace Aitty.Models;

public class SshConnection : IDisposable
{
    public string Host { get; set; } = string.Empty;
    public int Port { get; set; } = 22;
    public string Username { get; set; } = string.Empty;
    public string? PrivateKey { get; set; }

    // [M-2] Password/Passphrase: 직렬화·영속화 완전 제외
    // ConfigService.SanitizeConnection()에서도 null 처리하지만 모델 레벨에서도 명시.
    // [H-3] Password는 char[]로 보관해 사용 직후 0 으로 덮어쓸 수 있게 한다.
    //       Passphrase는 이번 batch 제외(범위 축소) — 기존 string 유지.
    //       주의: SSH.NET 내부가 string 카피본을 만들기 때문에 라이브러리 측 메모리는
    //       .NET 한계로 정리 불가. char[] 측만 정리하는 best-effort 전략.
    [JsonIgnore]
    public char[]? Password { get; set; }

    [JsonIgnore]
    public string? Passphrase { get; set; }

    /// <summary>[M-2/H-3] 민감 필드 참조 해제 + Password 바이트 0으로 덮어쓰기. Disconnect 시 호출.</summary>
    public void Dispose()
    {
        if (Password is not null)
        {
            Array.Clear(Password, 0, Password.Length);
            Password = null;
        }
        // Passphrase는 이번 batch 제외 — 기존 동작(참조만 해제) 유지
        Passphrase = null;
        GC.SuppressFinalize(this);
    }
}

public class SshConnectionState
{
    public bool IsConnected { get; set; }
    public bool IsConnecting { get; set; }
    public string? Error { get; set; }
    public SshConnection? Connection { get; set; }
    public DateTime? ConnectionTime { get; set; }
}
