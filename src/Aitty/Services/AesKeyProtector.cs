using System.Security.Cryptography;
using System.Text;

namespace Aitty.Services;

/// <summary>
/// AES-256-GCM 기반 API 키 암호화 유틸 (사용자 암호 파생).
///
/// 키 파생:
///   PBKDF2(SHA256, 100k iterations)
///   Input: 사용자 입력 password + 앱 고정 salt + 파일 salt
///   → 32바이트 AES 키
///
/// 데이터 포맷 (Base64):
///   [16 bytes file salt][12 bytes nonce][16 bytes tag][ciphertext]
///
/// 특성:
///   - AES-256-GCM: 인증된 암호화 (무결성 + 기밀성)
///   - 암호 기반: 사용자가 입력한 password를 알아야 복호화 가능 → PC 간 이동 가능
///   - 파일별 고유 salt: 같은 password + API 키도 저장할 때마다 다른 암호문 (결정론적 노출 방지)
///   - 인증 태그 검증 실패 시 Decrypt가 null 반환 → 호출자가 암호 불일치로 판단
/// </summary>
public static class AesKeyProtector
{
    // 앱 전역 고정 salt — 키 파생 시 password와 함께 HMAC 입력
    private static readonly byte[] AppSalt = Encoding.UTF8.GetBytes("Aitty.SSH.AI.Terminal.v1.AiPreset");

    private const int SaltSize  = 16;
    private const int NonceSize = 12;   // GCM 권장
    private const int TagSize   = 16;
    private const int KeySize   = 32;   // AES-256
    private const int Pbkdf2Iterations = 100_000;

    /// <summary>평문 API 키 → Base64 인코딩된 암호화 문자열. password는 필수.</summary>
    public static string Encrypt(string plainText, string password)
    {
        if (string.IsNullOrEmpty(plainText)) return string.Empty;
        if (string.IsNullOrEmpty(password))
            throw new ArgumentException("password는 비어 있을 수 없습니다.", nameof(password));

        var fileSalt = RandomNumberGenerator.GetBytes(SaltSize);
        var nonce    = RandomNumberGenerator.GetBytes(NonceSize);
        var key      = DeriveKey(fileSalt, password);

        var plainBytes = Encoding.UTF8.GetBytes(plainText);
        var cipherBytes = new byte[plainBytes.Length];
        var tag = new byte[TagSize];

        using (var aes = new AesGcm(key, TagSize))
        {
            aes.Encrypt(nonce, plainBytes, cipherBytes, tag);
        }
        CryptographicOperations.ZeroMemory(key);

        // 조합: [salt][nonce][tag][ciphertext]
        var output = new byte[SaltSize + NonceSize + TagSize + cipherBytes.Length];
        Buffer.BlockCopy(fileSalt,    0, output, 0,                              SaltSize);
        Buffer.BlockCopy(nonce,       0, output, SaltSize,                       NonceSize);
        Buffer.BlockCopy(tag,         0, output, SaltSize + NonceSize,           TagSize);
        Buffer.BlockCopy(cipherBytes, 0, output, SaltSize + NonceSize + TagSize, cipherBytes.Length);

        return Convert.ToBase64String(output);
    }

    /// <summary>
    /// Base64 암호화 문자열 → 평문 API 키.
    /// 반환값:
    ///   - 평문 문자열: 복호화 성공
    ///   - 빈 문자열(""): 입력이 빈 암호문(원래 API 키 없이 저장됨)
    ///   - null: 암호 불일치 또는 데이터 변조/손상
    /// </summary>
    public static string? Decrypt(string encoded, string password)
    {
        if (string.IsNullOrEmpty(encoded)) return string.Empty;
        if (string.IsNullOrEmpty(password)) return null;
        try
        {
            var all = Convert.FromBase64String(encoded);
            if (all.Length < SaltSize + NonceSize + TagSize) return null;

            var fileSalt = new byte[SaltSize];
            var nonce    = new byte[NonceSize];
            var tag      = new byte[TagSize];
            var cipher   = new byte[all.Length - SaltSize - NonceSize - TagSize];

            Buffer.BlockCopy(all, 0,                              fileSalt, 0, SaltSize);
            Buffer.BlockCopy(all, SaltSize,                       nonce,    0, NonceSize);
            Buffer.BlockCopy(all, SaltSize + NonceSize,           tag,      0, TagSize);
            Buffer.BlockCopy(all, SaltSize + NonceSize + TagSize, cipher,   0, cipher.Length);

            var key = DeriveKey(fileSalt, password);
            var plain = new byte[cipher.Length];
            using (var aes = new AesGcm(key, TagSize))
            {
                aes.Decrypt(nonce, cipher, tag, plain);  // 인증 실패 시 CryptographicException
            }
            CryptographicOperations.ZeroMemory(key);

            return Encoding.UTF8.GetString(plain);
        }
        catch
        {
            // GCM 태그 검증 실패(암호 불일치) 또는 변조된 데이터
            return null;
        }
    }

    private static byte[] DeriveKey(byte[] fileSalt, string password)
    {
        var pwBytes = Encoding.UTF8.GetBytes(password);
        // 사용자 암호 + 앱별 salt — 파일 salt는 PBKDF2 salt 인자로 전달
        var material = new byte[pwBytes.Length + AppSalt.Length];
        Buffer.BlockCopy(pwBytes, 0, material, 0,                pwBytes.Length);
        Buffer.BlockCopy(AppSalt, 0, material, pwBytes.Length,   AppSalt.Length);

        using var pbkdf2 = new Rfc2898DeriveBytes(material, fileSalt, Pbkdf2Iterations, HashAlgorithmName.SHA256);
        var key = pbkdf2.GetBytes(KeySize);
        CryptographicOperations.ZeroMemory(material);
        CryptographicOperations.ZeroMemory(pwBytes);
        return key;
    }
}
