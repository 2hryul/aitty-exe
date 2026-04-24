using System.IO;
using System.Text.Json;
using Aitty.Models;

namespace Aitty.Services;

/// <summary>
/// AI 프리셋 CRUD 저장소.
/// 파일: %APPDATA%\ssh-ai-terminal\ai-presets.json
/// API 키는 AesKeyProtector로 AES-256-GCM 암호화된 상태로만 저장됨.
/// </summary>
public class AiPresetStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private readonly string _filePath;
    private readonly SemaphoreSlim _lock = new(1, 1);

    public AiPresetStore()
    {
        var dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "ssh-ai-terminal");
        Directory.CreateDirectory(dir);
        _filePath = Path.Combine(dir, "ai-presets.json");
    }

    /// <summary>전체 프리셋 로드 (암호화 상태 유지).</summary>
    public async Task<List<AiPreset>> LoadAllAsync()
    {
        await _lock.WaitAsync();
        try
        {
            if (!File.Exists(_filePath)) return new List<AiPreset>();
            var json = await File.ReadAllTextAsync(_filePath);
            return JsonSerializer.Deserialize<List<AiPreset>>(json, JsonOptions) ?? new List<AiPreset>();
        }
        catch
        {
            return new List<AiPreset>();
        }
        finally { _lock.Release(); }
    }

    /// <summary>프리셋 저장 (같은 Name이면 덮어씀). plainApiKey는 password로 암호화됨.</summary>
    public async Task SaveAsync(string name, string provider, string? baseUrl, string? model,
        string plainApiKey, string password, bool allowInsecureSsl, string? systemPrompt = null)
    {
        if (string.IsNullOrEmpty(password))
            throw new ArgumentException("프리셋 저장 암호는 필수입니다.", nameof(password));

        var presets = await LoadAllAsync();
        await _lock.WaitAsync();
        try
        {
            var encrypted = string.IsNullOrEmpty(plainApiKey) ? string.Empty : AesKeyProtector.Encrypt(plainApiKey, password);
            var now = DateTime.UtcNow;
            var existing = presets.FindIndex(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase));
            var preset = new AiPreset
            {
                Name = name,
                Provider = provider,
                BaseUrl = baseUrl,
                Model = model,
                EncryptedApiKey = encrypted,
                AllowInsecureSsl = allowInsecureSsl,
                SystemPrompt = systemPrompt,
                SavedAt = existing >= 0 ? presets[existing].SavedAt : now,
                LastUsedAt = now,
            };
            if (existing >= 0) presets[existing] = preset;
            else presets.Add(preset);

            await WriteAllAsync(presets);
        }
        finally { _lock.Release(); }
    }

    /// <summary>
    /// 프리셋 로드 (API 키 복호화) — 호출자가 각 서비스에 적용.
    /// 반환:
    ///   - null: 프리셋 자체가 없음 (이름 오류)
    ///   - (preset, null): 암호 불일치 또는 변조 — 호출자는 세션 변경 없이 에러만 표시해야 함
    ///   - (preset, ""): 원래 API 키 없이 저장된 프리셋 (정상)
    ///   - (preset, plainKey): 정상 복호화
    /// </summary>
    public async Task<(AiPreset Preset, string? PlainApiKey)?> LoadPresetAsync(string name, string password)
    {
        var presets = await LoadAllAsync();
        var preset = presets.FirstOrDefault(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase));
        if (preset is null) return null;

        var plainKey = string.IsNullOrEmpty(preset.EncryptedApiKey)
            ? string.Empty
            : AesKeyProtector.Decrypt(preset.EncryptedApiKey, password);

        // 복호화 실패면 LastUsedAt 갱신 안 함 — 실패 기록을 남기지 않음
        if (plainKey is null) return (preset, null);

        preset.LastUsedAt = DateTime.UtcNow;
        await _lock.WaitAsync();
        try { await WriteAllAsync(presets); }
        finally { _lock.Release(); }
        return (preset, plainKey);
    }

    public async Task DeleteAsync(string name)
    {
        var presets = await LoadAllAsync();
        await _lock.WaitAsync();
        try
        {
            var removed = presets.RemoveAll(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase));
            if (removed > 0) await WriteAllAsync(presets);
        }
        finally { _lock.Release(); }
    }

    private async Task WriteAllAsync(List<AiPreset> presets)
    {
        // LastUsedAt 역순 정렬 — 최근 사용 항목이 위로
        var sorted = presets.OrderByDescending(p => p.LastUsedAt).ToList();
        var json = JsonSerializer.Serialize(sorted, JsonOptions);
        await File.WriteAllTextAsync(_filePath, json);
    }
}
