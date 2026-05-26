using System.IO;
using System.Text.Json;
using Aitty.Models;

namespace Aitty.Services;

public class ConfigService
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private readonly string _configDir;
    private readonly string _configPath;

    public ConfigService()
    {
        _configDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "ssh-ai-terminal");
        _configPath = Path.Combine(_configDir, "config.json");
    }

    public async Task<AppConfig> LoadAsync()
    {
        try
        {
            if (!File.Exists(_configPath))
            {
                var defaultConfig = CreateDefault();
                await SaveAsync(defaultConfig);
                return defaultConfig;
            }

            var json = await File.ReadAllTextAsync(_configPath);
            var loaded = JsonSerializer.Deserialize<AppConfig>(json, JsonOptions) ?? CreateDefault();
            var sanitized = SanitizeConfig(loaded, out var changed);
            if (changed)
                await SaveAsync(sanitized);
            return sanitized;
        }
        catch
        {
            return CreateDefault();
        }
    }

    public async Task SaveAsync(AppConfig config)
    {
        Directory.CreateDirectory(_configDir);
        var sanitized = SanitizeConfig(config, out _);
        var json = JsonSerializer.Serialize(sanitized, JsonOptions);
        await File.WriteAllTextAsync(_configPath, json);
    }

    public async Task AddConnectionAsync(SshConnection connection)
    {
        var config = await LoadAsync();
        config.SshConnections.Add(SanitizeConnection(connection));
        await SaveAsync(config);
    }

    public async Task RemoveConnectionAsync(string host)
    {
        var config = await LoadAsync();
        config.SshConnections.RemoveAll(c => c.Host == host);
        await SaveAsync(config);
    }

    public async Task UpdateConnectionAsync(string host, SshConnection updated)
    {
        var config = await LoadAsync();
        var index = config.SshConnections.FindIndex(c => c.Host == host);
        if (index >= 0)
        {
            config.SshConnections[index] = SanitizeConnection(updated);
            await SaveAsync(config);
        }
    }

    /// <summary>OpenAI 호환 Base URL 저장 (Shinhan Hands 등 커스텀 게이트웨이용).</summary>
    public async Task SaveOpenAiBaseUrlAsync(string? baseUrl)
    {
        try
        {
            var config = await LoadAsync();
            config.OpenAiBaseUrl = baseUrl;
            await SaveAsync(config);
        }
        catch { /* 저장 실패가 앱 동작을 막으면 안 됨 */ }
    }

    private static AppConfig CreateDefault() => new()
    {
        Theme = "dark",
        FontSize = 12,
        FontFamily = "Consolas, \"Courier New\"",
        SshConnections = new List<SshConnection>()
    };

    private static AppConfig SanitizeConfig(AppConfig config, out bool changed)
    {
        changed = false;
        var sourceConnections = config.SshConnections ?? [];
        var sanitizedConnections = new List<SshConnection>(sourceConnections.Count);
        foreach (var conn in sourceConnections)
        {
            var sanitized = SanitizeConnection(conn);
            // [H-3/M-A] Password/Passphrase 모두 char[] — Length 기반 검사.
            if (conn.Password is { Length: > 0 } || conn.Passphrase is { Length: > 0 })
                changed = true;
            sanitizedConnections.Add(sanitized);
        }

        return new AppConfig
        {
            Theme = config.Theme,
            FontSize = config.FontSize,
            FontFamily = config.FontFamily,
            LastConnection = config.LastConnection,
            SshConnections = sanitizedConnections,
            OpenAiBaseUrl = config.OpenAiBaseUrl,
            AllowInsecureSsl = config.AllowInsecureSsl
        };
    }

    private static SshConnection SanitizeConnection(SshConnection connection) => new()
    {
        Host = connection.Host,
        Port = connection.Port,
        Username = connection.Username,
        PrivateKey = connection.PrivateKey,
        Password = null,
        Passphrase = null
    };
}
