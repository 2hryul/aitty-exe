using System.IO;
using System.Text.Json;

namespace Aitty.Services;

/// <summary>
/// [L-3] SSH 호스트키 영속화 — TOFU(Trust On First Use) 정책 지원.
///
/// 저장 위치: %LOCALAPPDATA%\Aitty\known_hosts.json
/// 포맷: { "host:port": { "keyType": "ssh-ed25519", "fingerprint": "SHA256:<base64-no-pad>" } }
///
/// 보안:
///   - 호스트키는 공개키이므로 DPAPI 보호 불필요(평문 JSON OK).
///   - 파일 손상 시 빈 store로 fallback + StartupLogger 경고 → 사용자가 SSH 연결 자체를 못 하게 막진 않음.
///     (대신 모든 호스트가 TOFU 첫 연결로 보임 → 즉시 신뢰 갱신 가능).
///   - 동시 접근 보호: 내부 lock — 연결 시점에만 호출되어 빈번하지 않음.
/// </summary>
public class KnownHostsStore
{
    private static readonly string StorePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Aitty", "known_hosts.json");

    private readonly object _lock = new();
    private Dictionary<string, KnownHostEntry>? _cache;

    /// <summary>주어진 host:port에 저장된 호스트키 항목 반환. 없으면 null.</summary>
    public KnownHostEntry? Lookup(string host, int port)
    {
        lock (_lock)
        {
            EnsureLoaded();
            return _cache!.TryGetValue(KeyOf(host, port), out var e) ? e : null;
        }
    }

    /// <summary>호스트키 저장(첫 연결 자동 신뢰 또는 사용자 갱신 승인 시).</summary>
    public void Save(string host, int port, string keyType, string fingerprint)
    {
        lock (_lock)
        {
            EnsureLoaded();
            _cache![KeyOf(host, port)] = new KnownHostEntry
            {
                KeyType = keyType,
                Fingerprint = fingerprint
            };
            Persist();
        }
    }

    /// <summary>특정 host:port 항목 제거(향후 사용자 known_hosts 편집 UI에서 사용).</summary>
    public void Remove(string host, int port)
    {
        lock (_lock)
        {
            EnsureLoaded();
            if (_cache!.Remove(KeyOf(host, port)))
                Persist();
        }
    }

    private static string KeyOf(string host, int port) => $"{host}:{port}";

    private void EnsureLoaded()
    {
        if (_cache is not null) return;
        _cache = Load();
    }

    private static Dictionary<string, KnownHostEntry> Load()
    {
        try
        {
            if (!File.Exists(StorePath)) return new();
            var json = File.ReadAllText(StorePath);
            if (string.IsNullOrWhiteSpace(json)) return new();
            return JsonSerializer.Deserialize<Dictionary<string, KnownHostEntry>>(json) ?? new();
        }
        catch (Exception ex)
        {
            // 파일 손상 — 빈 store로 시작하되 사용자에게 보일 수 있도록 로그.
            // 모든 호스트가 TOFU로 다시 신뢰되는 부작용은 수용(연결 자체는 가능해야 함).
            StartupLogger.Log($"[KnownHostsStore] known_hosts.json 로드 실패 — 빈 store로 fallback: {ex.GetType().Name}: {ex.Message}");
            return new();
        }
    }

    private void Persist()
    {
        try
        {
            var dir = Path.GetDirectoryName(StorePath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            var json = JsonSerializer.Serialize(_cache, new JsonSerializerOptions { WriteIndented = true });
            // [Reviewer S-1] atomic write — 부분 쓰기 후 크래시 시 known_hosts.json 손상으로
            // 다음 부팅에서 전체 TOFU 재발화(사용자 confirm 폭주) 방지. tmp → Move 패턴.
            var tempPath = StorePath + ".tmp";
            File.WriteAllText(tempPath, json);
            File.Move(tempPath, StorePath, overwrite: true);
        }
        catch (Exception ex)
        {
            StartupLogger.Log($"[KnownHostsStore] known_hosts.json 저장 실패 — 다음 연결도 TOFU로 보일 수 있음: {ex.GetType().Name}: {ex.Message}");
        }
    }
}

public class KnownHostEntry
{
    public string KeyType { get; set; } = string.Empty;
    public string Fingerprint { get; set; } = string.Empty;
}
