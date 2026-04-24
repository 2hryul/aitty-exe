using System.Net.Http;

namespace Aitty.Services;

/// <summary>
/// AI 서비스용 HttpClient 팩토리. 전역 SSL 검증 정책을 중앙화.
///
/// AllowInsecureSsl=true 로 생성하면 ServerCertificateCustomValidationCallback이
/// 모든 인증서를 승인 → 내부망 자체서명 인증서 엔드포인트(예: https://100.75.30.53) 연결 가능.
/// 기본값은 false (엄격 검증). 사용자가 AI 설정 UI에서 명시적으로 활성화해야 함.
/// </summary>
public static class HttpClientHelper
{
    public static HttpClient Create(bool allowInsecureSsl = false, TimeSpan? timeout = null)
    {
        var handler = new HttpClientHandler();

        if (allowInsecureSsl)
        {
            // ⚠ MITM 공격 위험. 사용자가 내부망 자체서명 인증서 용도로 명시 활성화한 경우에만 사용.
            handler.ServerCertificateCustomValidationCallback =
                (_, _, _, _) => true;
        }

        return new HttpClient(handler)
        {
            Timeout = timeout ?? TimeSpan.FromMinutes(5)
        };
    }
}
