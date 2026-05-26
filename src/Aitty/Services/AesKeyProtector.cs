using System.Buffers.Binary;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;

namespace Aitty.Services;

/// <summary>
/// AES-256-GCM 기반 API 키 암호화 유틸 (사용자 암호 파생).
///
/// 키 파생:
///   PBKDF2(SHA256, iterations는 데이터 헤더에서 읽음 — v2는 600k, v1 legacy는 100k)
///   Input: 사용자 입력 password + 앱 고정 salt + 파일 salt
///   → 32바이트 AES 키
///
/// 데이터 포맷 (Base64):
///   v2 (신규, 항상 v2로 작성):
///     [1 byte version=0x02][4 bytes iterations BE-uint32][16 bytes file salt][12 bytes nonce][16 bytes tag][ciphertext]
///   v1 (legacy, 복호화만 지원 — 자동 v2 마이그레이션):
///     [16 bytes file salt][12 bytes nonce][16 bytes tag][ciphertext]
///
/// 특성:
///   - AES-256-GCM: 인증된 암호화 (무결성 + 기밀성)
///   - 암호 기반: 사용자가 입력한 password를 알아야 복호화 가능 → PC 간 이동 가능
///   - 파일별 고유 salt: 같은 password + API 키도 저장할 때마다 다른 암호문 (결정론적 노출 방지)
///   - 인증 태그 검증 실패 시 Decrypt가 null 반환 → 호출자가 암호 불일치로 판단
///   - 다운그레이드/DoS 방어: iterations 헤더값을 [50k, 10M] 범위로 강제 검증
/// </summary>
public static class AesKeyProtector
{
    // 앱 전역 고정 salt — 키 파생 시 password와 함께 HMAC 입력
    private static readonly byte[] AppSalt = Encoding.UTF8.GetBytes("Aitty.SSH.AI.Terminal.v1.AiPreset");

    private const int SaltSize  = 16;
    private const int NonceSize = 12;   // GCM 권장
    private const int TagSize   = 16;
    private const int KeySize   = 32;   // AES-256

    // 포맷 식별 + iteration 메타데이터
    private const byte VersionV2 = 0x02;
    private const int Pbkdf2IterationsV1 = 100_000;   // legacy 호환 (복호화 전용)
    private const int Pbkdf2IterationsV2 = 600_000;   // OWASP 2023 권고 (신규 작성 기본값)
    private const uint MinIterations = 50_000;        // 합리적 하한 — 다운그레이드 공격 방어
    private const uint MaxIterations = 10_000_000;    // 합리적 상한 — DoS 방어

    private const int V2HeaderSize = 1 + 4; // version byte + iterations BE-uint32

    /// <summary>평문 API 키 → Base64 인코딩된 v2 암호화 문자열. password는 필수.</summary>
    public static string Encrypt(string plainText, string password)
    {
        if (string.IsNullOrEmpty(plainText)) return string.Empty;
        if (string.IsNullOrEmpty(password))
            throw new ArgumentException("password는 비어 있을 수 없습니다.", nameof(password));

        var fileSalt = RandomNumberGenerator.GetBytes(SaltSize);
        var nonce    = RandomNumberGenerator.GetBytes(NonceSize);
        var key      = DeriveKey(fileSalt, password, Pbkdf2IterationsV2);

        var plainBytes = Encoding.UTF8.GetBytes(plainText);
        var cipherBytes = new byte[plainBytes.Length];
        var tag = new byte[TagSize];

        // [Reviewer S-1] try/finally로 키 zeroize — AesGcm.Encrypt 도중 예외 시에도 키 잔존 방지
        // (TryDecryptV1/V2와 패턴 일관성 + defense-in-depth)
        try
        {
            using var aes = new AesGcm(key, TagSize);
            aes.Encrypt(nonce, plainBytes, cipherBytes, tag);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
        }

        // 조합: [version][iterations BE-uint32][salt][nonce][tag][ciphertext]
        var output = new byte[V2HeaderSize + SaltSize + NonceSize + TagSize + cipherBytes.Length];
        output[0] = VersionV2;
        BinaryPrimitives.WriteUInt32BigEndian(output.AsSpan(1, 4), (uint)Pbkdf2IterationsV2);
        Buffer.BlockCopy(fileSalt,    0, output, V2HeaderSize,                              SaltSize);
        Buffer.BlockCopy(nonce,       0, output, V2HeaderSize + SaltSize,                   NonceSize);
        Buffer.BlockCopy(tag,         0, output, V2HeaderSize + SaltSize + NonceSize,       TagSize);
        Buffer.BlockCopy(cipherBytes, 0, output, V2HeaderSize + SaltSize + NonceSize + TagSize, cipherBytes.Length);

        return Convert.ToBase64String(output);
    }

    /// <summary>
    /// Base64 암호화 문자열 → 평문 API 키. wasLegacy out으로 v1 복호화 여부를 알려준다.
    /// 호출자는 wasLegacy=true인 경우 즉시 Encrypt로 재작성하여 v2 자동 마이그레이션 수행.
    /// 반환값:
    ///   - 평문 문자열: 복호화 성공
    ///   - 빈 문자열(""): 입력이 빈 암호문(원래 API 키 없이 저장됨)
    ///   - null: 암호 불일치 또는 데이터 변조/손상
    /// </summary>
    public static string? TryDecrypt(string encoded, string password, out bool wasLegacy)
    {
        wasLegacy = false;
        if (string.IsNullOrEmpty(encoded)) return string.Empty;
        if (string.IsNullOrEmpty(password)) return null;
        try
        {
            var all = Convert.FromBase64String(encoded);

            // v2 시도 — 헤더 길이 충분 + version 일치 + iterations 범위 유효
            if (all.Length >= V2HeaderSize + SaltSize + NonceSize + TagSize
                && all[0] == VersionV2)
            {
                var iterations = BinaryPrimitives.ReadUInt32BigEndian(all.AsSpan(1, 4));
                if (iterations is >= MinIterations and <= MaxIterations)
                {
                    var v2Result = TryDecryptV2(all, password, (int)iterations);
                    if (v2Result is not null) return v2Result;
                    // v2 인증 실패 → v1 fallback (우연히 v1 salt 첫 바이트가 0x02일 1/256 케이스 대비)
                }
            }

            // v1 fallback — 성공하면 호출자에게 마이그레이션 신호 전달
            var v1Result = TryDecryptV1(all, password);
            if (v1Result is not null) wasLegacy = true;
            return v1Result;
        }
        catch
        {
            // Base64 디코드 실패 등 입력 자체가 깨진 경우
            return null;
        }
    }

    /// <summary>기존 호출자 호환용 thin wrapper — wasLegacy 신호가 필요 없는 경우 사용.</summary>
    public static string? Decrypt(string encoded, string password)
        => TryDecrypt(encoded, password, out _);

    // v2 포맷 복호화 — 헤더 다음부터 salt/nonce/tag/cipher 추출. 인증 실패 시 null.
    private static string? TryDecryptV2(byte[] all, string password, int iterations)
    {
        try
        {
            var cipherLen = all.Length - V2HeaderSize - SaltSize - NonceSize - TagSize;
            if (cipherLen < 0) return null;

            var fileSalt = new byte[SaltSize];
            var nonce    = new byte[NonceSize];
            var tag      = new byte[TagSize];
            var cipher   = new byte[cipherLen];

            Buffer.BlockCopy(all, V2HeaderSize,                              fileSalt, 0, SaltSize);
            Buffer.BlockCopy(all, V2HeaderSize + SaltSize,                   nonce,    0, NonceSize);
            Buffer.BlockCopy(all, V2HeaderSize + SaltSize + NonceSize,       tag,      0, TagSize);
            Buffer.BlockCopy(all, V2HeaderSize + SaltSize + NonceSize + TagSize, cipher, 0, cipherLen);

            var key = DeriveKey(fileSalt, password, iterations);
            var plain = new byte[cipher.Length];
            try
            {
                using var aes = new AesGcm(key, TagSize);
                aes.Decrypt(nonce, cipher, tag, plain);  // 인증 실패 시 CryptographicException
            }
            finally
            {
                CryptographicOperations.ZeroMemory(key);
            }
            return Encoding.UTF8.GetString(plain);
        }
        catch
        {
            return null;
        }
    }

    // v1 포맷 복호화 — 헤더 없이 raw layout. 인증 실패 시 null.
    private static string? TryDecryptV1(byte[] all, string password)
    {
        try
        {
            if (all.Length < SaltSize + NonceSize + TagSize) return null;

            var fileSalt = new byte[SaltSize];
            var nonce    = new byte[NonceSize];
            var tag      = new byte[TagSize];
            var cipher   = new byte[all.Length - SaltSize - NonceSize - TagSize];

            Buffer.BlockCopy(all, 0,                              fileSalt, 0, SaltSize);
            Buffer.BlockCopy(all, SaltSize,                       nonce,    0, NonceSize);
            Buffer.BlockCopy(all, SaltSize + NonceSize,           tag,      0, TagSize);
            Buffer.BlockCopy(all, SaltSize + NonceSize + TagSize, cipher,   0, cipher.Length);

            var key = DeriveKey(fileSalt, password, Pbkdf2IterationsV1);
            var plain = new byte[cipher.Length];
            try
            {
                using var aes = new AesGcm(key, TagSize);
                aes.Decrypt(nonce, cipher, tag, plain);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(key);
            }
            return Encoding.UTF8.GetString(plain);
        }
        catch
        {
            return null;
        }
    }

    private static byte[] DeriveKey(byte[] fileSalt, string password, int iterations)
    {
        var pwBytes = Encoding.UTF8.GetBytes(password);
        // 사용자 암호 + 앱별 salt — 파일 salt는 PBKDF2 salt 인자로 전달
        var material = new byte[pwBytes.Length + AppSalt.Length];
        Buffer.BlockCopy(pwBytes, 0, material, 0,                pwBytes.Length);
        Buffer.BlockCopy(AppSalt, 0, material, pwBytes.Length,   AppSalt.Length);

        using var pbkdf2 = new Rfc2898DeriveBytes(material, fileSalt, iterations, HashAlgorithmName.SHA256);
        var key = pbkdf2.GetBytes(KeySize);
        CryptographicOperations.ZeroMemory(material);
        CryptographicOperations.ZeroMemory(pwBytes);
        return key;
    }

#if DEBUG
    /// <summary>
    /// Debug 빌드 전용 자가 검증 — 단위 테스트 프로젝트 도입 비용 회피.
    /// App.xaml.cs:OnStartup에서 한 번 호출되어 v2 roundtrip / 잘못된 암호 거부 /
    /// v1 복호화 + 마이그레이션 신호 / 손상 헤더 거부 4가지 invariant를 확인한다.
    /// Release 빌드에선 미컴파일 → 부팅 영향 0.
    /// </summary>
    internal static void SelfTest()
    {
        // Test 1: v2 roundtrip — wasLegacy=false
        var enc1 = Encrypt("hello-world", "pw1234");
        var dec1 = TryDecrypt(enc1, "pw1234", out var wasLegacy1);
        Debug.Assert(dec1 == "hello-world" && !wasLegacy1, "v2 roundtrip 실패");

        // Test 2: wrong password → null (oracle leak 없이 거부)
        var dec2 = TryDecrypt(enc1, "wrong", out _);
        Debug.Assert(dec2 is null, "wrong password 거부 실패");

        // Test 3: v1 데이터(수동 생성) 복호화 + wasLegacy=true (마이그레이션 신호)
        var v1Encoded = BuildV1ForTest("legacy-key", "pw5678");
        var dec3 = TryDecrypt(v1Encoded, "pw5678", out var wasLegacy3);
        Debug.Assert(dec3 == "legacy-key" && wasLegacy3, "v1 복호화/마이그레이션 신호 실패");

        // Test 4: 손상된 v2 헤더 (version=0x02 + iterations 범위 밖) → v1 fallback도 실패 → null
        var corrupt = new byte[] { 0x02, 0xFF, 0xFF, 0xFF, 0xFF }
            .Concat(RandomNumberGenerator.GetBytes(50)).ToArray();
        var dec4 = TryDecrypt(Convert.ToBase64String(corrupt), "pw", out _);
        Debug.Assert(dec4 is null, "손상 헤더 거부 실패");

        StartupLogger.Log("[AesKeyProtector] SelfTest 통과");
    }

    // 테스트 보조 — v1 포맷 수동 생성 (테스트 전용, Debug 빌드에서만 컴파일)
    private static string BuildV1ForTest(string plain, string password)
    {
        var fileSalt = RandomNumberGenerator.GetBytes(SaltSize);
        var nonce    = RandomNumberGenerator.GetBytes(NonceSize);
        var key      = DeriveKey(fileSalt, password, Pbkdf2IterationsV1);
        var plainB   = Encoding.UTF8.GetBytes(plain);
        var cipher   = new byte[plainB.Length];
        var tag      = new byte[TagSize];
        using (var aes = new AesGcm(key, TagSize)) aes.Encrypt(nonce, plainB, cipher, tag);
        CryptographicOperations.ZeroMemory(key);
        var output = new byte[SaltSize + NonceSize + TagSize + cipher.Length];
        Buffer.BlockCopy(fileSalt, 0, output, 0,                              SaltSize);
        Buffer.BlockCopy(nonce,    0, output, SaltSize,                       NonceSize);
        Buffer.BlockCopy(tag,      0, output, SaltSize + NonceSize,           TagSize);
        Buffer.BlockCopy(cipher,   0, output, SaltSize + NonceSize + TagSize, cipher.Length);
        return Convert.ToBase64String(output);
    }
#endif
}
