using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.IO;
using System.Windows;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Web.WebView2.Core;
using Aitty.Models;
using Aitty.Services;

namespace Aitty.Ipc;

public class IpcHandler
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true
    };

    private readonly WebView2 _webView;
    private readonly SshService _sshService;
    private readonly ConfigService _configService;
    private readonly KeyManagerService _keyManagerService;
    private readonly AiServiceManager _aiManager;
    private readonly SessionService _sessionService;
    private readonly AiPresetStore _presetStore = new();
    private readonly LogCollectorService _logCollector;
    private readonly SessionData? _restoredSession;
    private readonly SshConnection? _startupConnection;
    private CancellationTokenSource? _streamingCts;

    // 로그 분석 전용 시스템 프롬프트 — HandleLogsAnalyze* 에서 임시 적용 후 복구
    private const string LogAnalyzeSystem = @"당신은 Linux 서버 로그 분석 전문가입니다. 아래 로그에서
(1) 오류/경고 패턴 (2) 시간순 이상 징후 (3) 가능한 원인 (4) 추가 확인 명령
을 한국어로 간결히 제시하세요.";

    public IpcHandler(
        WebView2 webView,
        SshService sshService,
        ConfigService configService,
        KeyManagerService keyManagerService,
        AiServiceManager aiManager,
        SessionService sessionService,
        SessionData? restoredSession = null,
        SshConnection? startupConnection = null)
    {
        _webView = webView;
        _sshService = sshService;
        _configService = configService;
        _keyManagerService = keyManagerService;
        _aiManager = aiManager;
        _sessionService = sessionService;
        _logCollector = new LogCollectorService(sshService);
        _restoredSession = restoredSession;
        _startupConnection = startupConnection;
    }

    public void Register()
    {
        _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
    }

    // [M-1] IPC 메시지 최대 크기: 1MB
    private const int MaxMessageBytes = 1_048_576;

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        IpcResponse response;

        // [M-1] 메시지 크기 제한 (UTF-8 바이트 단위)
        if (Encoding.UTF8.GetByteCount(e.WebMessageAsJson) > MaxMessageBytes)
        {
            var rejected = new IpcResponse
            {
                Id = TryExtractId(e.WebMessageAsJson),
                Type = "error",
                Error = "Request too large"
            };
            _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(rejected, JsonOptions));
            return;
        }

        try
        {
            var msg = JsonSerializer.Deserialize<IpcMessage>(e.WebMessageAsJson, JsonOptions);
            if (msg is null) return;

            var result = await HandleMessage(msg);
            response = new IpcResponse { Id = msg.Id, Type = $"{msg.Type}:result", Payload = result };
        }
        catch (NotSupportedException) // [M-1] 내부 타입명 노출 방지
        {
            response = new IpcResponse
            {
                Id = TryExtractId(e.WebMessageAsJson),
                Type = "error",
                Error = "Unsupported operation"
            };
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[IPC] Unhandled error: {ex}");
            response = new IpcResponse { Id = TryExtractId(e.WebMessageAsJson), Type = "error", Error = "An internal error occurred" };
        }

        _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(response, JsonOptions));
    }

    private async Task<object?> HandleMessage(IpcMessage msg)
    {
        return msg.Type switch
        {
            "ssh:connect"              => await HandleSshConnect(msg.Payload),
            "ssh:disconnect"           => HandleSshDisconnect(),
            "ssh:exec"                 => await HandleSshExec(msg.Payload),
            "ssh:test"                 => await HandleSshTest(),
            "ssh:state"                => HandleSshState(),
            "ssh:shell:write"          => HandleSshShellWrite(msg.Payload),
            "ssh:shell:read"           => HandleSshShellRead(),
            "ssh:resize"               => HandleSshResize(msg.Payload),

            "config:load"              => await HandleConfigLoad(),
            "config:save"              => await HandleConfigSave(msg.Payload),
            "config:connections:add"   => await HandleConfigAddConnection(msg.Payload),
            "config:connections:remove"=> await HandleConfigRemoveConnection(msg.Payload),

            "keys:list"                => await HandleKeysList(),
            "keys:validate"            => await HandleKeysValidate(msg.Payload),
            "keys:browse"              => await HandleKeysBrowse(),
            "keys:ssh-config"          => await HandleKeysSshConfig(),

            // ── AI 공통 ──────────────────────────────────── //
            "ai:send"                  => await HandleAiSend(msg.Payload),
            "ai:stream"                => await HandleAiStream(msg),
            "ai:stream:cancel"         => HandleAiStreamCancel(),
            "ai:configure"             => HandleAiConfigure(msg.Payload),
            "ai:set-model"             => HandleAiSetModel(msg.Payload),
            "ai:set-system"            => HandleAiSetSystem(msg.Payload),
            "ai:state"                 => await HandleAiState(),
            "ai:history"               => HandleAiHistory(),
            "ai:clear"                 => HandleAiClear(),
            "ai:models"                => await HandleAiModels(),
            "ai:api-log:save"          => await HandleAiApiLogSave(msg.Payload),

            // ── AI 제공자 관리 ────────────────────────────── //
            "ai:providers"             => HandleAiProviders(),
            "ai:set-provider"          => HandleAiSetProvider(msg.Payload),
            "ai:set-apikey"            => HandleAiSetApiKey(msg.Payload),

            // ── Ollama 전용 ──────────────────────────────── //
            "ai:set-endpoint"          => HandleAiSetEndpoint(msg.Payload),
            "ai:set-insecure-ssl"      => await HandleAiSetInsecureSsl(msg.Payload),

            // ── AI 프리셋 (AES-256 암호화 저장) ────────── //
            "ai:preset:list"           => await HandleAiPresetList(),
            "ai:preset:save"           => await HandleAiPresetSave(msg.Payload),
            "ai:preset:load"           => await HandleAiPresetLoad(msg.Payload),
            "ai:preset:delete"         => await HandleAiPresetDelete(msg.Payload),
            "ai:openwebui:diagnose"    => await HandleAiOpenWebUiDiagnose(msg.Payload),

            // ── SSH 분석 ─────────────────────────────────── //
            "ai:ssh:analyze"           => await HandleAiAnalyzeSsh(msg),
            "ai:ssh:suggest-command"   => await HandleAiSuggestCommand(msg),

            // ── 보안취약점 ─────────────────────────────────────── //
            "security:browse-scripts"  => await HandleSecurityBrowseScripts(),
            "security:deploy"          => await HandleSecurityDeploy(msg.Payload),
            "security:run"             => await HandleSecurityRun(msg),

            // ── 로그 수집 · AI 분석 ─────────────────────────────── //
            "logs:stat-file"           => await HandleLogsStatFile(msg.Payload),
            "logs:fetch-file"          => await HandleLogsFetchFile(msg.Payload),
            "logs:fetch-exec"          => await HandleLogsFetchExec(msg.Payload),
            "logs:evaluate"            => HandleLogsEvaluate(msg.Payload),
            "logs:analyze"             => await HandleLogsAnalyze(msg),
            "logs:analyze-chunked"     => await HandleLogsAnalyzeChunked(msg),

            // ── 세션 ─────────────────────────────────────────── //
            "session:get-restored"     => HandleSessionGetRestored(),
            "session:set-save-enabled" => HandleSessionSetSaveEnabled(msg.Payload),

            // ── CLI 자동접속 (HiWare/PuTTY 호환) ──────────── //
            "cli:get-connection"       => HandleCliGetConnection(),
            "cli:auto-connect"         => await HandleCliAutoConnect(),

            "app:version"              => GetAppVersion(),
            "app:open-log-folder"      => HandleOpenLogFolder(),
            "app:window-minimize"      => HandleWindowMinimize(),
            "app:window-maximize"      => HandleWindowMaximize(),
            "app:window-close"         => HandleWindowClose(),
            _                          => throw new NotSupportedException($"Unknown IPC type: {msg.Type}")
        };
    }

    // ── SSH ────────────────────────────────────────────────── //

    private async Task<object> HandleSshConnect(object? payload)
    {
        // [M-2] 입력 전용 DTO로 역직렬화 → SshConnection.Password의 [JsonIgnore]가
        //       역직렬화까지 차단하는 문제 방지 (직렬화 차단은 SshConnection에서 유지)
        var req = DeserializePayload<SshConnectRequest>(payload);
        var conn = new SshConnection
        {
            Host       = req.Host,
            Port       = req.Port,
            Username   = req.Username,
            PrivateKey = req.PrivateKey,
            Password   = req.Password,
            Passphrase = req.Passphrase,
        };
        var success = await _sshService.ConnectAsync(conn);

        // [M-3] 접속 감사 로그
        _ = SshAuditLogger.LogConnectAsync(
            conn.Host, conn.Port, conn.Username,
            success, _sshService.State.Error);

        return new { success, error = _sshService.State.Error };
    }

    private object HandleSshDisconnect() { _sshService.Disconnect(); return new { success = true }; }

    private async Task<object> HandleSshExec(object? payload)
    {
        var data = DeserializePayload<CommandPayload>(payload);

        // [M-0] 빈 명령 가드 — NRE 대신 사용자 친화 에러로 전환
        if (string.IsNullOrWhiteSpace(data.Command))
            throw new ArgumentException("Command is empty");

        // [M-1] 커맨드 길이 제한 (8KB)
        if (data.Command.Length > 8192)
            throw new ArgumentException("Command too long (max 8192 chars)");

        // [M-2] 백엔드 방어 계층 — 치명적 명령 차단
        if (CommandSafetyService.IsDangerous(data.Command))
            throw new InvalidOperationException("Command blocked by safety policy");

        var sw = Stopwatch.StartNew();
        string output;
        bool success;
        try
        {
            output = await _sshService.ExecuteAsync(data.Command);
            success = true;
        }
        catch
        {
            sw.Stop();
            var conn2 = _sshService.State.Connection;
            _ = SshAuditLogger.LogExecAsync(
                conn2?.Host ?? "unknown", conn2?.Port ?? 22, conn2?.Username ?? "unknown",
                data.Command, string.Empty, false, sw.ElapsedMilliseconds);
            throw;
        }

        sw.Stop();

        // [M-3] 명령 실행 감사 로그 (fire-and-forget)
        var conn = _sshService.State.Connection;
        _ = SshAuditLogger.LogExecAsync(
            conn?.Host ?? "unknown", conn?.Port ?? 22, conn?.Username ?? "unknown",
            data.Command, output, success, sw.ElapsedMilliseconds);

        return new { output };
    }

    private async Task<object> HandleSshTest() => new { success = await _sshService.TestAsync() };

    private object HandleSshState()
    {
        // exit 후 빠른 감지를 위해 즉시 KeepAlive 전송
        var alive = _sshService.IsConnected ? _sshService.PingAlive() : false;
        var state = _sshService.State;
        return new { isConnected = alive, isConnecting = state.IsConnecting, error = state.Error, host = state.Connection?.Host, connectionTime = state.ConnectionTime?.ToString("o") };
    }

    private object HandleSshShellWrite(object? payload)
    {
        var text = DeserializePayload<ShellWritePayload>(payload).Data;

        // 백엔드 방어 계층 — 코드블록 Run 등 전체 명령이 한 번에 전송될 때 캐치
        if (text.Contains('\n') || text.Contains('\r'))
        {
            var lines = text.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries);
            foreach (var line in lines)
            {
                if (CommandSafetyService.IsDangerous(line.Trim()))
                    throw new InvalidOperationException("Command blocked by safety policy");
            }
        }

        _sshService.WriteToShell(text);
        return new { success = true };
    }
    private object HandleSshShellRead() => new { data = _sshService.ReadFromShell() };
    private object HandleSshResize(object? payload) { var data = DeserializePayload<ResizePayload>(payload); _sshService.ResizeTerminal(data.Cols, data.Rows); return new { success = true }; }

    // ── Config / Keys ──────────────────────────────────────── //

    private async Task<object> HandleConfigLoad() => await _configService.LoadAsync();
    private async Task<object> HandleConfigSave(object? payload) { await _configService.SaveAsync(DeserializePayload<AppConfig>(payload)); return new { success = true }; }
    private async Task<object> HandleConfigAddConnection(object? payload) { await _configService.AddConnectionAsync(DeserializePayload<SshConnection>(payload)); return new { success = true }; }
    private async Task<object> HandleConfigRemoveConnection(object? payload) { await _configService.RemoveConnectionAsync(DeserializePayload<HostPayload>(payload).Host); return new { success = true }; }

    private async Task<object> HandleKeysList() { var keys = await _keyManagerService.FindKeysAsync(); return new { keys, directory = _keyManagerService.GetKeyDirectory() }; }
    private async Task<object> HandleKeysValidate(object? payload) { var valid = await _keyManagerService.IsValidKeyFileAsync(DeserializePayload<KeyPathPayload>(payload).Path); return new { valid }; }

    private async Task<object> HandleKeysBrowse()
    {
        var result = await _webView.Dispatcher.InvokeAsync(() =>
        {
            var dialog = new Microsoft.Win32.OpenFileDialog
            {
                Title = "Select SSH Private Key",
                Filter = "All Files (*.*)|*.*|PEM Files (*.pem)|*.pem|PPK Files (*.ppk)|*.ppk",
                InitialDirectory = _keyManagerService.GetKeyDirectory(),
            };
            return dialog.ShowDialog() == true ? dialog.FileName : null;
        });

        if (result is null)
            return new { selected = false, path = (string?)null, valid = false };

        var valid = await _keyManagerService.IsValidKeyFileAsync(result);
        return new { selected = true, path = result, valid };
    }

    private async Task<object> HandleKeysSshConfig() => await _keyManagerService.ReadSshConfigAsync();

    // ── AI 공통 ────────────────────────────────────────────── //

    private async Task<object> HandleAiSend(object? payload)
    {
        var data = DeserializePayload<AiChatRequest>(payload);
        var response = await _aiManager.Active.SendMessageAsync(data.Message);
        return new { content = response.Content, model = response.Model, inputTokens = 0, outputTokens = 0 };
    }

    private async Task<object> HandleAiStream(IpcMessage msg)
    {
        var data = DeserializePayload<AiChatRequest>(msg.Payload);
        _streamingCts?.Dispose();
        _streamingCts = new CancellationTokenSource();

        // 마지막 청크 dispatch를 추적 — 최종 결과 반환 전 완료 대기용
        System.Windows.Threading.DispatcherOperation? lastChunkOp = null;

        var response = await _aiManager.Active.SendStreamingAsync(data.Message, chunk =>
        {
            var chunkResponse = new IpcResponse { Id = msg.Id, Type = "ai:stream:chunk", Payload = new { chunk } };
            var json = JsonSerializer.Serialize(chunkResponse, JsonOptions);
            lastChunkOp = _webView.Dispatcher.InvokeAsync(
                () => _webView.CoreWebView2.PostWebMessageAsJson(json),
                System.Windows.Threading.DispatcherPriority.Background);
        }, _streamingCts.Token);

        // Background 큐는 FIFO — 마지막 청크가 전달되면 이전 청크도 모두 전달 완료
        if (lastChunkOp is not null)
            try { await lastChunkOp.Task.ConfigureAwait(false); } catch { /* 취소/중단 — 무시 */ }

        // Level 3 자동 로그 (fire-and-forget — 로그 실패가 주 기능에 영향 X)
        _ = AiChatLogger.AppendAsync(_aiManager.ActiveProvider, response.Model, null, data.Message, response);

        return new { content = response.Content, done = true };
    }

    private object HandleAiStreamCancel() { _streamingCts?.Cancel(); return new { success = true }; }

    private object HandleAiConfigure(object? payload)
    {
        var cfg = DeserializePayload<AiConfig>(payload);
        if (!string.IsNullOrWhiteSpace(cfg.Model)) _aiManager.Active.SetModel(cfg.Model);
        if (!string.IsNullOrWhiteSpace(cfg.SystemPrompt)) _aiManager.Active.SetSystemPrompt(cfg.SystemPrompt);
        return new { success = true };
    }

    private object HandleAiSetModel(object? payload)
    {
        var model = DeserializePayload<ModelPayload>(payload).Model;
        _aiManager.Active.SetModel(model);
        return new { success = true, model };
    }

    private object HandleAiSetSystem(object? payload)
    {
        _aiManager.Active.SetSystemPrompt(DeserializePayload<SystemPromptPayload>(payload).SystemPrompt);
        return new { success = true };
    }

    private async Task<object> HandleAiState()
    {
        var svc = _aiManager.Active;
        var isConfigured = await svc.IsEngineAvailableAsync();
        // OpenAI(호환 게이트웨이)도 baseUrl 반환하여 UI에서 현재 엔드포인트 표시
        var baseUrl = svc switch
        {
            LocalLlmService ollama => ollama.CurrentBaseUrl,
            OpenAiService openai => openai.CurrentBaseUrl,
            _ => string.Empty,
        };
        return new
        {
            isConfigured,
            model = svc.CurrentModel,
            historyCount = svc.History.Count,
            engine = svc.ProviderName,
            provider = _aiManager.ActiveProvider,
            baseUrl
        };
    }

    private object HandleAiHistory() => new { messages = _aiManager.Active.History.Select(m => new { m.Role, m.Content }).ToList() };

    private object HandleAiClear() { _aiManager.Active.ClearHistory(); return new { success = true }; }

    private async Task<object> HandleAiModels()
    {
        var models = await _aiManager.Active.ListModelsAsync();
        return new { models };
    }

    private async Task<object> HandleAiApiLogSave(object? payload)
    {
        var data = DeserializePayload<ApiLogPayload>(payload);
        var content = data.Content ?? string.Empty;

        var logDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "ssh-ai-terminal",
            "logs");
        Directory.CreateDirectory(logDir);

        // 일별 단일 파일에 append (연결 트레이스 + 대화 로그 통합)
        var filePath = Path.Combine(logDir, $"api_{DateTime.Now:yyyyMMdd}.log");
        await File.AppendAllTextAsync(filePath, content + Environment.NewLine);

        return new { success = true, path = filePath };
    }

    // ── AI 제공자 관리 ──────────────────────────────────────── //

    private object HandleAiProviders() => new { providers = _aiManager.GetProviders(), active = _aiManager.ActiveProvider };

    private object HandleAiSetProvider(object? payload)
    {
        var data = DeserializePayload<ProviderPayload>(payload);
        _aiManager.SwitchProvider(data.Provider);
        return new { success = true, provider = _aiManager.ActiveProvider };
    }

    private object HandleAiSetApiKey(object? payload)
    {
        var data = DeserializePayload<ApiKeyPayload>(payload);
        _aiManager.SetApiKey(data.Provider, data.ApiKey);
        return new { success = true, provider = data.Provider, hasKey = _aiManager.HasApiKey(data.Provider) };
    }

    // ── Endpoint 설정 (Ollama / OpenAI 호환) ─────────────────── //

    private object HandleAiSetEndpoint(object? payload)
    {
        var url = DeserializePayload<EndpointPayload>(payload).Url;
        if (_aiManager.ActiveProvider == "openai")
        {
            _aiManager.OpenAi.SetBaseUrl(url);
            _ = _configService.SaveOpenAiBaseUrlAsync(_aiManager.OpenAi.CurrentBaseUrl);
            return new { success = true, url = _aiManager.OpenAi.CurrentBaseUrl };
        }
        _aiManager.Ollama.SetBaseUrl(url);
        return new { success = true, url = _aiManager.Ollama.CurrentBaseUrl };
    }

    /// <summary>
    /// SSL 검증 정책 토글 — 내부망 자체서명 인증서 엔드포인트 지원.
    /// 모든 AI 서비스(Ollama/OpenAI/Claude/Gemini)에 일괄 적용 + config.json 영속화.
    /// </summary>
    private async Task<object> HandleAiSetInsecureSsl(object? payload)
    {
        var enabled = DeserializePayload<InsecureSslPayload>(payload).Enabled;
        _aiManager.SetAllowInsecureSsl(enabled);
        try
        {
            var cfg = await _configService.LoadAsync();
            cfg.AllowInsecureSsl = enabled;
            await _configService.SaveAsync(cfg);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Trace.TraceWarning($"[IpcHandler] AllowInsecureSsl 저장 실패: {ex.Message}");
        }
        return new { success = true, enabled };
    }

    // ── AI 프리셋 (AES-256-GCM 암호화 저장) ────────────────── //

    /// <summary>저장된 프리셋 목록 반환. API 키는 복호화되지 않은 상태(UI용 메타데이터만).</summary>
    private async Task<object> HandleAiPresetList()
    {
        var presets = await _presetStore.LoadAllAsync();
        // API 키는 프론트로 전달하지 않음 — 저장 여부만 표시
        return new
        {
            presets = presets.Select(p => new
            {
                name = p.Name,
                provider = p.Provider,
                baseUrl = p.BaseUrl,
                model = p.Model,
                allowInsecureSsl = p.AllowInsecureSsl,
                hasApiKey = !string.IsNullOrEmpty(p.EncryptedApiKey),
                savedAt = p.SavedAt,
                lastUsedAt = p.LastUsedAt,
            }).ToList()
        };
    }

    /// <summary>
    /// 현재 AI 설정을 프리셋으로 저장. 평문 API 키가 전달되면 AES-256-GCM 암호화 후 디스크에.
    /// 서버에서 현재 활성 provider의 상태를 참조해 provider/baseUrl/model 채움.
    /// </summary>
    private async Task<object> HandleAiPresetSave(object? payload)
    {
        var req = DeserializePayload<PresetSavePayload>(payload);
        if (string.IsNullOrWhiteSpace(req.Name))
            return new { success = false, error = "프리셋 이름이 비어있습니다." };
        if (string.IsNullOrEmpty(req.Password) || req.Password.Length < 4)
            return new { success = false, error = "프리셋 암호는 최소 4자 이상이어야 합니다." };

        var provider = _aiManager.ActiveProvider;
        var baseUrl  = provider switch
        {
            "openai" => _aiManager.OpenAi.CurrentBaseUrl,
            "ollama" => _aiManager.Ollama.CurrentBaseUrl,
            _ => null,
        };
        var model = _aiManager.Active.CurrentModel;
        var systemPrompt = _aiManager.Active.SystemPrompt;

        try
        {
            var cfg = await _configService.LoadAsync();
            await _presetStore.SaveAsync(
                name: req.Name.Trim(),
                provider: provider,
                baseUrl: baseUrl,
                model: model,
                plainApiKey: req.ApiKey ?? string.Empty,
                password: req.Password,
                allowInsecureSsl: cfg.AllowInsecureSsl,
                systemPrompt: systemPrompt);
            return new { success = true, name = req.Name.Trim() };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.Message };
        }
    }

    /// <summary>프리셋을 현재 세션에 적용 — provider 전환 + BaseUrl/API키/모델/SSL 일괄 설정.</summary>
    private async Task<object> HandleAiPresetLoad(object? payload)
    {
        var req = DeserializePayload<PresetLoadPayload>(payload);
        if (string.IsNullOrWhiteSpace(req.Name))
            return new { success = false, error = "프리셋 이름이 비어있습니다." };
        if (string.IsNullOrEmpty(req.Password))
            return new { success = false, error = "프리셋 암호를 입력하세요." };

        var result = await _presetStore.LoadPresetAsync(req.Name.Trim(), req.Password);
        if (result is null)
            return new { success = false, error = "프리셋을 찾을 수 없습니다." };

        var (preset, plainKey) = result.Value;
        // 복호화 실패(null) — 세션은 건드리지 않고 암호 불일치 안내만
        if (plainKey is null)
            return new { success = false, error = "암호가 일치하지 않거나 프리셋 파일이 손상되었습니다." };

        try
        {
            // SSL 검증 정책 (config에도 반영)
            _aiManager.SetAllowInsecureSsl(preset.AllowInsecureSsl);
            var cfg = await _configService.LoadAsync();
            cfg.AllowInsecureSsl = preset.AllowInsecureSsl;

            // Provider 전환
            _aiManager.SwitchProvider(preset.Provider);

            // Base URL 적용
            if (preset.Provider == "openai" && !string.IsNullOrWhiteSpace(preset.BaseUrl))
            {
                _aiManager.OpenAi.SetBaseUrl(preset.BaseUrl);
                cfg.OpenAiBaseUrl = _aiManager.OpenAi.CurrentBaseUrl;
            }
            else if (preset.Provider == "ollama" && !string.IsNullOrWhiteSpace(preset.BaseUrl))
            {
                _aiManager.Ollama.SetBaseUrl(preset.BaseUrl);
            }
            await _configService.SaveAsync(cfg);

            // API 키 + 모델 + 시스템 프롬프트
            if (!string.IsNullOrEmpty(plainKey))
                _aiManager.SetApiKey(preset.Provider, plainKey);
            if (!string.IsNullOrWhiteSpace(preset.Model))
                _aiManager.Active.SetModel(preset.Model);
            if (preset.SystemPrompt is not null)
                _aiManager.Active.SetSystemPrompt(preset.SystemPrompt);

            return new
            {
                success = true,
                name = preset.Name,
                provider = preset.Provider,
                baseUrl = preset.BaseUrl,
                model = preset.Model,
                allowInsecureSsl = preset.AllowInsecureSsl,
                hasApiKey = !string.IsNullOrEmpty(plainKey),
            };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.Message };
        }
    }

    private async Task<object> HandleAiPresetDelete(object? payload)
    {
        var req = DeserializePayload<PresetNamePayload>(payload);
        if (string.IsNullOrWhiteSpace(req.Name))
            return new { success = false, error = "프리셋 이름이 비어있습니다." };
        await _presetStore.DeleteAsync(req.Name.Trim());
        return new { success = true };
    }

    private async Task<object> HandleAiOpenWebUiDiagnose(object? payload)
    {
        string? endpoint = null;
        if (payload is not null)
        {
            var data = DeserializePayload<EndpointPayload>(payload);
            if (!string.IsNullOrWhiteSpace(data.Url))
                endpoint = data.Url;
        }

        return await _aiManager.Ollama.DiagnoseOpenWebUiAsync(endpoint);
    }

    // ── SSH 분석 ────────────────────────────────────────────── //

    private async Task<object> HandleAiAnalyzeSsh(IpcMessage msg)
    {
        var lastOutput = _sshService.GetLastCommandOutput();
        if (string.IsNullOrWhiteSpace(lastOutput))
            return new { content = string.Empty };

        var prompt = $"SSH last command output:\n{lastOutput}\n\nAnalyze the output, explain issues if any, and suggest the next safe action.";

        System.Windows.Threading.DispatcherOperation? lastAnalyzeOp = null;
        var response = await _aiManager.Active.SendStreamingAsync(prompt, chunk =>
        {
            var chunkResponse = new IpcResponse { Id = msg.Id, Type = "ai:ssh:analyze:chunk", Payload = new { chunk } };
            var json = JsonSerializer.Serialize(chunkResponse, JsonOptions);
            lastAnalyzeOp = _webView.Dispatcher.InvokeAsync(
                () => _webView.CoreWebView2.PostWebMessageAsJson(json),
                System.Windows.Threading.DispatcherPriority.Background);
        });

        if (lastAnalyzeOp is not null)
            try { await lastAnalyzeOp.Task.ConfigureAwait(false); } catch { }

        _ = AiChatLogger.AppendAsync(_aiManager.ActiveProvider, response.Model, null, prompt, response);
        return new { content = response.Content };
    }

    private async Task<object> HandleAiSuggestCommand(IpcMessage msg)
    {
        var recentOutput = _sshService.GetRecentOutput();
        if (string.IsNullOrWhiteSpace(recentOutput))
            return new { content = string.Empty };

        var prompt = $"Recent SSH output:\n{recentOutput}\n\nSuggest one safe next shell command only, followed by a short reason.";

        System.Windows.Threading.DispatcherOperation? lastSuggestOp = null;
        var response = await _aiManager.Active.SendStreamingAsync(prompt, chunk =>
        {
            var chunkResponse = new IpcResponse { Id = msg.Id, Type = "ai:ssh:suggest:chunk", Payload = new { chunk } };
            var json = JsonSerializer.Serialize(chunkResponse, JsonOptions);
            lastSuggestOp = _webView.Dispatcher.InvokeAsync(
                () => _webView.CoreWebView2.PostWebMessageAsJson(json),
                System.Windows.Threading.DispatcherPriority.Background);
        });

        if (lastSuggestOp is not null)
            try { await lastSuggestOp.Task.ConfigureAwait(false); } catch { }

        _ = AiChatLogger.AppendAsync(_aiManager.ActiveProvider, response.Model, null, prompt, response);
        return new { content = response.Content };
    }

    private static object GetAppVersion()
    {
        var version = System.Reflection.Assembly.GetExecutingAssembly().GetName().Version;
        return new { version = version?.ToString() ?? "0.2.0" };
    }

    /// <summary>진단 로그 폴더를 탐색기로 열기 (ai_api.log, latest.log 등 사용자 전달용).</summary>
    private static object HandleOpenLogFolder()
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = $"/select,\"{AiRequestLogger.LogPath}\"",
                UseShellExecute = true,
            });
            return new { success = true, path = AiRequestLogger.LogPath };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.Message };
        }
    }

    // ── CLI 자동접속 (HiWare/PuTTY 호환) ──────────────────────── //

    /// <summary>CLI 인자로 전달된 접속 정보 반환 (비밀번호 제외).</summary>
    private object? HandleCliGetConnection()
    {
        if (_startupConnection is null) return null;
        return new
        {
            host = _startupConnection.Host,
            port = _startupConnection.Port,
            username = _startupConnection.Username,
            hasPassword = !string.IsNullOrEmpty(_startupConnection.Password),
            hasPrivateKey = !string.IsNullOrEmpty(_startupConnection.PrivateKey),
        };
    }

    /// <summary>CLI 인자의 접속 정보로 즉시 SSH 연결. 비밀번호가 IPC를 넘지 않음.</summary>
    private async Task<object> HandleCliAutoConnect()
    {
        if (_startupConnection is null)
            return new { success = false, error = "CLI 접속 정보 없음" };

        var success = await _sshService.ConnectAsync(_startupConnection);

        _ = SshAuditLogger.LogConnectAsync(
            _startupConnection.Host, _startupConnection.Port,
            _startupConnection.Username,
            success, _sshService.State.Error);

        return new { success, error = _sshService.State.Error };
    }

    // ── Window Control ────────────────────────────────────────── //

    private object? HandleWindowMinimize()
    {
        _webView.Dispatcher.Invoke(() =>
        {
            var window = Window.GetWindow(_webView);
            if (window != null) window.WindowState = WindowState.Minimized;
        });
        return new { success = true };
    }

    private object? HandleWindowMaximize()
    {
        _webView.Dispatcher.Invoke(() =>
        {
            var window = Window.GetWindow(_webView);
            if (window != null)
                window.WindowState = window.WindowState == WindowState.Maximized
                    ? WindowState.Normal
                    : WindowState.Maximized;
        });
        return new { success = true };
    }

    private object? HandleWindowClose()
    {
        _webView.Dispatcher.Invoke(() =>
        {
            var window = Window.GetWindow(_webView);
            window?.Close();
        });
        return new { success = true };
    }

    // ── 세션 ──────────────────────────────────────────────── //

    private object? HandleSessionGetRestored()
    {
        if (_restoredSession is null) return null;
        return new
        {
            savedAt      = _restoredSession.SavedAt.ToString("o"),
            model        = _restoredSession.Model,
            engine       = _restoredSession.Engine,
            provider     = _restoredSession.Provider,
            systemPrompt = _restoredSession.SystemPrompt,
            messageCount = _restoredSession.Messages.Count
        };
    }

    private record SetSaveEnabledPayload(bool Enabled);

    private object HandleSessionSetSaveEnabled(object? payload)
    {
        var data = DeserializePayload<SetSaveEnabledPayload>(payload);
        _sessionService.SaveEnabled = data.Enabled;
        return new { success = true, saveEnabled = data.Enabled };
    }

    // ── Security (보안취약점) ──────────────────────────────── //

    /// <summary>파일 탐색기 다이얼로그 — .sh 파일 다중 선택</summary>
    private async Task<object> HandleSecurityBrowseScripts()
    {
        var result = await _webView.Dispatcher.InvokeAsync(() =>
        {
            var dialog = new Microsoft.Win32.OpenFileDialog
            {
                Title = "보안 점검 스크립트 선택 (common.sh, check.sh, fix.sh)",
                Filter = "Shell Scripts (*.sh)|*.sh|All Files (*.*)|*.*",
                Multiselect = true,
                InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            };
            return dialog.ShowDialog() == true ? dialog.FileNames : null;
        });

        if (result is null || result.Length == 0)
            return new { selected = false, files = Array.Empty<string>() };

        var files = result.Select(f => new { name = System.IO.Path.GetFileName(f), path = f, size = new FileInfo(f).Length }).ToArray();
        return new { selected = true, files };
    }

    /// <summary>SFTP로 스크립트를 원격 서버 ~/aitty_sec/ 에 업로드</summary>
    private async Task<object> HandleSecurityDeploy(object? payload)
    {
        var data = DeserializePayload<SecurityDeployPayload>(payload);
        if (data.Files is null || data.Files.Length == 0)
            throw new ArgumentException("No files to deploy");

        if (_sshService.State.Connection is null || !_sshService.IsConnected)
            throw new InvalidOperationException("SSH not connected");

        var conn = _sshService.State.Connection;
        return await Task.Run(() =>
        {
            // SSH.NET SftpClient — 패스워드 또는 키 인증
            Renci.SshNet.SftpClient sftp;
            Renci.SshNet.SshClient  tempSsh;

            if (!string.IsNullOrEmpty(conn.Password))
            {
                sftp    = new Renci.SshNet.SftpClient(conn.Host, conn.Port, conn.Username, conn.Password);
                tempSsh = new Renci.SshNet.SshClient(conn.Host, conn.Port, conn.Username, conn.Password);
            }
            else
            {
                var keyFile = CreatePrivateKeyFile(conn);
                sftp    = new Renci.SshNet.SftpClient(conn.Host, conn.Port, conn.Username, keyFile);
                tempSsh = new Renci.SshNet.SshClient(conn.Host, conn.Port, conn.Username, keyFile);
            }

            using (sftp)
            {
                sftp.Connect();

                // ~/aitty_sec/ 디렉터리 생성
                const string remoteDir = "aitty_sec";
                if (!sftp.Exists(remoteDir))
                    sftp.CreateDirectory(remoteDir);

                var uploaded = new List<string>();
                foreach (var localPath in data.Files)
                {
                    if (!System.IO.File.Exists(localPath)) continue;
                    var fileName = System.IO.Path.GetFileName(localPath);
                    var remotePath = $"{remoteDir}/{fileName}";
                    using var fs = System.IO.File.OpenRead(localPath);
                    sftp.UploadFile(fs, remotePath, true);
                    uploaded.Add(fileName);
                }

                sftp.Disconnect();

                // chmod +x
                using (tempSsh)
                {
                    tempSsh.Connect();
                    tempSsh.RunCommand($"chmod +x ~/{remoteDir}/*.sh");
                    tempSsh.Disconnect();
                }

                return new { success = true, files = uploaded.ToArray(), remoteDir = $"~/{remoteDir}" };
            }
        });
    }

    /// <summary>보안 점검/조치 함수를 SSH에서 비대화형으로 실행</summary>
    private async Task<object> HandleSecurityRun(IpcMessage msg)
    {
        var data = DeserializePayload<SecurityRunPayload>(msg.Payload);
        if (string.IsNullOrEmpty(data.Function))
            throw new ArgumentException("Function name required");

        // 허용된 함수명만 통과 (check_u03, fix_u07 등)
        if (!System.Text.RegularExpressions.Regex.IsMatch(data.Function, @"^(check|fix)_u\d{2}$"))
            throw new ArgumentException($"Invalid function: {data.Function}");

        var scriptFile = data.Function.StartsWith("check") ? "check.sh" : "fix.sh";
        var sudoPrefix = data.Function.StartsWith("fix") && data.UseSudo ? "sudo " : "";

        // 비대화형 실행: source common.sh → source 스크립트(main_menu 제외) → 함수 호출
        var command = $"{sudoPrefix}bash -c 'cd ~/aitty_sec && " +
                      $"source common.sh && " +
                      $"source <(grep -v \"^main_menu$\" {scriptFile} | grep -v \"^# Start\\|^# 스크립트\") && " +
                      $"{data.Function}'";

        // SSH 터미널에 명령 주입 → 출력이 SSH Terminal에 직접 표시
        _sshService.WriteToShell(command + "\r");

        // 실행 완료 대기 (출력 수집용) — 최대 30초
        await Task.Delay(2000); // 실행 시작 대기
        var timeout = TimeSpan.FromSeconds(30);
        var sw = Stopwatch.StartNew();
        string lastOutput;

        do
        {
            await Task.Delay(500);
            lastOutput = _sshService.GetLastCommandOutput();
        }
        while (sw.Elapsed < timeout &&
               !lastOutput.Contains("[양호]") &&
               !lastOutput.Contains("[취약]") &&
               !lastOutput.Contains("[해당없음]") &&
               !lastOutput.Contains("[조치완료]") &&
               !lastOutput.Contains("[오류]"));

        // 결과 파싱
        var status = "unknown";
        var reason = "";
        if (lastOutput.Contains("[양호]")) { status = "pass"; reason = ExtractAfter(lastOutput, "[양호]"); }
        else if (lastOutput.Contains("[취약]")) { status = "fail"; reason = ExtractAfter(lastOutput, "[취약]"); }
        else if (lastOutput.Contains("[해당없음]")) { status = "na"; reason = ExtractAfter(lastOutput, "[해당없음]"); }
        else if (lastOutput.Contains("[조치완료]")) { status = "fixed"; reason = ExtractAfter(lastOutput, "[조치완료]"); }
        else if (lastOutput.Contains("[오류]")) { status = "error"; reason = ExtractAfter(lastOutput, "[오류]"); }

        return new
        {
            function = data.Function,
            status,
            reason = reason.Trim(),
            output = lastOutput
        };
    }

    // ── 로그 수집 · AI 분석 ────────────────────────────────── //

    private async Task<object> HandleLogsStatFile(object? payload)
    {
        var data = DeserializePayload<LogPathPayload>(payload);
        var info = await _logCollector.StatFileAsync(data.Path);
        return new
        {
            exists       = info.Exists,
            size         = info.Size,
            lastWriteUtc = info.LastWriteUtc.ToString("o")
        };
    }

    private async Task<object> HandleLogsFetchFile(object? payload)
    {
        var data = DeserializePayload<LogFetchFilePayload>(payload);
        var result = await _logCollector.FetchFileAsync(data.Path, data.TailBytes, data.FullFile);

        // 감사 로그 (fire-and-forget)
        _ = SshAuditLogger.LogFetchAsync(result.Source, result.SizeBytes);

        return ToWireLogPayload(result);
    }

    private async Task<object> HandleLogsFetchExec(object? payload)
    {
        var data = DeserializePayload<CommandPayload>(payload);

        // 빈 명령 가드 — NRE 대신 사용자 친화 에러로 전환
        if (string.IsNullOrWhiteSpace(data.Command))
            throw new ArgumentException("Command is empty");

        // 길이 제한 — ssh:exec와 동일
        if (data.Command.Length > 8192)
            throw new ArgumentException("Command too long (max 8192 chars)");

        var result = await _logCollector.FetchExecAsync(data.Command);
        _ = SshAuditLogger.LogFetchAsync(result.Source, result.SizeBytes);

        return ToWireLogPayload(result);
    }

    private object HandleLogsEvaluate(object? payload)
    {
        var data = DeserializePayload<LogEvaluatePayload>(payload);
        var provider = string.IsNullOrWhiteSpace(data.Provider) ? _aiManager.ActiveProvider : data.Provider;
        var model    = string.IsNullOrWhiteSpace(data.Model) ? _aiManager.Active.CurrentModel : data.Model;

        var check = AiBudget.Evaluate(data.SizeBytes, provider, model);
        return new
        {
            status           = check.Status,
            budget           = check.Budget,
            sizeBytes        = check.SizeBytes,
            ratio            = check.Ratio,
            suggestedChunks  = check.SuggestedChunks,
            provider,
            model
        };
    }

    /// <summary>단일 로그(예산 이내)를 1회 분석 — HandleAiAnalyzeSsh 스트리밍 패턴 복제.</summary>
    private async Task<object> HandleLogsAnalyze(IpcMessage msg)
    {
        var data = DeserializePayload<LogAnalyzePayload>(msg.Payload);
        if (string.IsNullOrEmpty(data.Content))
            return new { content = string.Empty };

        // ai:stream:cancel 과 동일한 CTS를 공유 — 사용자가 Chat과 Log 분석 중 어느 쪽이든 취소 버튼 하나로 중단
        _streamingCts?.Dispose();
        _streamingCts = new CancellationTokenSource();

        var prompt = $"{data.Source ?? "log"}:\n{data.Content}";

        var response = await RunLogAnalysisAsync(msg.Id, "logs:analyze:chunk", prompt, LogAnalyzeSystem, _streamingCts.Token);

        _ = SshAuditLogger.LogAnalyzeAsync(
            _aiManager.ActiveProvider, response.Model, 1,
            Encoding.UTF8.GetByteCount(data.Content));
        _ = AiChatLogger.AppendAsync(_aiManager.ActiveProvider, response.Model, null, prompt, response);

        return new { content = response.Content };
    }

    /// <summary>
    /// 예산 초과 로그를 청크 단위로 연쇄 분석 후 종합 요약.
    /// 각 청크 시작 시 logs:chunk-progress 이벤트 발송.
    /// 이전 청크 결과의 앞 budget*0.1 바이트를 다음 시스템 프롬프트 부록으로 연결.
    /// </summary>
    private async Task<object> HandleLogsAnalyzeChunked(IpcMessage msg)
    {
        var data = DeserializePayload<LogAnalyzePayload>(msg.Payload);
        if (string.IsNullOrEmpty(data.Content))
            return new { content = string.Empty };

        // ai:stream:cancel 과 동일한 CTS — 청크 간격에서 취소 감지 후 루프 조기 종료
        _streamingCts?.Dispose();
        _streamingCts = new CancellationTokenSource();
        var ct = _streamingCts.Token;

        var provider = _aiManager.ActiveProvider;
        var model    = _aiManager.Active.CurrentModel;
        var budget   = AiBudget.For(provider, model);
        var chunkBytes = Math.Max(1, (int)(budget * 0.8));
        var summaryBytes = Math.Max(1, (int)(budget * 0.1));

        var chunks = AiBudget.Split(data.Content, chunkBytes).ToList();
        var totalBytes = Encoding.UTF8.GetByteCount(data.Content);
        var partResults = new List<string>();

        foreach (var chunk in chunks)
        {
            // 청크 시작 전 취소 확인 — 사용자가 중단하면 누적된 부분 요약까지는 버리고 즉시 반환
            if (ct.IsCancellationRequested)
                return new { content = string.Join("\n---\n", partResults), chunks = partResults.Count, cancelled = true };
            // 진행률 이벤트 (fire-and-forget)
            var progressResponse = new IpcResponse
            {
                Id = msg.Id,
                Type = "logs:chunk-progress",
                Payload = new { index = chunk.Index, total = chunk.Total, bytes = chunk.EndByte - chunk.StartByte }
            };
            var progressJson = JsonSerializer.Serialize(progressResponse, JsonOptions);
            // fire-and-forget: 진행률 이벤트는 순서보장만 Dispatcher가 하면 충분
            _ = _webView.Dispatcher.InvokeAsync(
                () => _webView.CoreWebView2.PostWebMessageAsJson(progressJson),
                System.Windows.Threading.DispatcherPriority.Background);

            // 이전 청크 요약 부록
            var appendix = partResults.Count == 0
                ? string.Empty
                : "\n\n[이전 청크 요약]\n" + TakeBytes(string.Join("\n---\n", partResults), summaryBytes);

            var system = LogAnalyzeSystem + appendix;
            var prompt = $"{data.Source ?? "log"} [chunk {chunk.Index + 1}/{chunk.Total}, lines {chunk.StartLine}-{chunk.EndLine}]:\n{chunk.Content}";

            var response = await RunLogAnalysisAsync(msg.Id, "logs:analyze:chunk", prompt, system, ct);
            partResults.Add(response.Content);
        }

        // 종합 요약 전 마지막 취소 체크 — 청크는 다 돌았지만 취소되었으면 최종 호출 생략
        if (ct.IsCancellationRequested)
            return new { content = string.Join("\n---\n", partResults), chunks = partResults.Count, cancelled = true };

        // 종합 요약 1회
        var finalSystem = "지금까지 받은 청크 요약을 종합해 최종 분석을 작성하세요.";
        var finalPrompt = "청크별 분석 결과:\n" + string.Join("\n---\n", partResults);
        var finalResp = await RunLogAnalysisAsync(msg.Id, "logs:analyze:chunk", finalPrompt, finalSystem, ct);

        _ = SshAuditLogger.LogAnalyzeAsync(provider, finalResp.Model, chunks.Count, totalBytes);
        _ = AiChatLogger.AppendAsync(provider, finalResp.Model, null, finalPrompt, finalResp);

        return new { content = finalResp.Content, chunks = chunks.Count };
    }

    /// <summary>
    /// 로그 분석용 스트리밍 호출 — 시스템 프롬프트를 임시 주입하고 완료 후 원래 값으로 복구.
    /// IAiService 인터페이스 변경 없이 로컬 변수로 저장/복구.
    /// </summary>
    private async Task<Models.AiChatResponse> RunLogAnalysisAsync(string msgId, string chunkType, string prompt, string system, CancellationToken ct = default)
    {
        var svc = _aiManager.Active;
        var original = svc.SystemPrompt;
        svc.SetSystemPrompt(system);

        try
        {
            System.Windows.Threading.DispatcherOperation? lastOp = null;
            var response = await svc.SendStreamingAsync(prompt, chunk =>
            {
                var chunkResponse = new IpcResponse { Id = msgId, Type = chunkType, Payload = new { chunk } };
                var json = JsonSerializer.Serialize(chunkResponse, JsonOptions);
                lastOp = _webView.Dispatcher.InvokeAsync(
                    () => _webView.CoreWebView2.PostWebMessageAsJson(json),
                    System.Windows.Threading.DispatcherPriority.Background);
            }, ct);

            if (lastOp is not null)
                try { await lastOp.Task.ConfigureAwait(false); } catch { }

            return response;
        }
        finally
        {
            svc.SetSystemPrompt(original);
        }
    }

    /// <summary>UTF-8 바이트 기준으로 문자열 앞부분을 최대 maxBytes까지 잘라 반환.</summary>
    private static string TakeBytes(string s, int maxBytes)
    {
        if (string.IsNullOrEmpty(s) || maxBytes <= 0) return string.Empty;
        var bytes = Encoding.UTF8.GetBytes(s);
        if (bytes.Length <= maxBytes) return s;

        // UTF-8 멀티바이트 문자 중간에서 자르지 않도록 '\n' 기준 역방향 탐색
        int cut = maxBytes;
        for (int i = maxBytes - 1; i > 0; i--)
        {
            if (bytes[i] == (byte)'\n') { cut = i; break; }
        }
        // '\n'을 못 찾은 폴백: cut이 UTF-8 continuation(0x80~0xBF) 중간이면
        // 시작 바이트까지 당겨서 깨진 문자 방지
        while (cut > 0 && (bytes[cut] & 0xC0) == 0x80) cut--;
        var slice = new byte[cut];
        Buffer.BlockCopy(bytes, 0, slice, 0, cut);
        return Encoding.UTF8.GetString(slice);
    }

    /// <summary>LogPayload를 IPC 응답용 익명 객체로 변환(Images는 미래용이므로 포함하지 않음).</summary>
    private static object ToWireLogPayload(LogPayload p) => new
    {
        source      = p.Source,
        host        = p.Host,
        sizeBytes   = p.SizeBytes,
        lineCount   = p.LineCount,
        content     = p.Content,
        collectedAt = p.CollectedAt.ToString("o")
    };

    private static string ExtractAfter(string text, string marker)
    {
        var idx = text.IndexOf(marker);
        if (idx < 0) return "";
        var lineEnd = text.IndexOf('\n', idx);
        return lineEnd < 0 ? text[(idx + marker.Length)..] : text[(idx + marker.Length)..lineEnd];
    }

    private static Renci.SshNet.PrivateKeyFile CreatePrivateKeyFile(SshConnection conn)
    {
        var keyPath = conn.PrivateKey ?? "";
        if (string.IsNullOrEmpty(keyPath))
            throw new InvalidOperationException("No authentication method available (key required)");

        return string.IsNullOrEmpty(conn.Passphrase)
            ? new Renci.SshNet.PrivateKeyFile(keyPath)
            : new Renci.SshNet.PrivateKeyFile(keyPath, conn.Passphrase);
    }

    private static T DeserializePayload<T>(object? payload) where T : class
    {
        if (payload is JsonElement element)
            return JsonSerializer.Deserialize<T>(element.GetRawText(), JsonOptions) ?? throw new ArgumentException($"Failed to deserialize {typeof(T).Name}");

        var json = JsonSerializer.Serialize(payload, JsonOptions);
        return JsonSerializer.Deserialize<T>(json, JsonOptions) ?? throw new ArgumentException($"Failed to deserialize {typeof(T).Name}");
    }

    private static string TryExtractId(string json)
    {
        try { return JsonNode.Parse(json)?["id"]?.GetValue<string>() ?? "unknown"; }
        catch { return "unknown"; }
    }
}

// ── Payload DTOs ──────────────────────────────────────────── //
// [M-1] CommandPayload: 길이 제한은 HandleSshExec에서 명시적으로 검증
// [M-2] SSH 접속 입력 전용 DTO: Password/Passphrase 역직렬화 허용 (SshConnection은 [JsonIgnore] 유지)
internal class SshConnectRequest
{
    public string  Host       { get; set; } = string.Empty;
    public int     Port       { get; set; } = 22;
    public string  Username   { get; set; } = string.Empty;
    public string? PrivateKey { get; set; }
    public string? Password   { get; set; }
    public string? Passphrase { get; set; }
}
internal class CommandPayload      { public string Command    { get; set; } = string.Empty; }
internal class ShellWritePayload   { public string Data       { get; set; } = string.Empty; }
internal class HostPayload         { public string Host       { get; set; } = string.Empty; }
internal class KeyPathPayload      { public string Path       { get; set; } = string.Empty; }
internal class ModelPayload        { public string Model      { get; set; } = string.Empty; }
internal class SystemPromptPayload { public string? SystemPrompt { get; set; } }
internal class EndpointPayload     { public string Url        { get; set; } = string.Empty; }
internal class InsecureSslPayload  { public bool Enabled      { get; set; } }
internal class PresetSavePayload   { public string Name { get; set; } = string.Empty; public string? ApiKey { get; set; } public string Password { get; set; } = string.Empty; }
internal class PresetNamePayload   { public string Name { get; set; } = string.Empty; }
internal class PresetLoadPayload   { public string Name { get; set; } = string.Empty; public string Password { get; set; } = string.Empty; }
internal class ProviderPayload     { public string Provider   { get; set; } = string.Empty; }
internal class ApiKeyPayload       { public string Provider   { get; set; } = string.Empty; public string ApiKey { get; set; } = string.Empty; }
internal class ApiLogPayload       { public string Content    { get; set; } = string.Empty; }
internal class ResizePayload       { public uint   Cols       { get; set; } = 120; public uint Rows { get; set; } = 40; }

// ── Security DTOs ──────────────────────────────────────────── //
internal class SecurityDeployPayload { public string[] Files { get; set; } = Array.Empty<string>(); }
internal class SecurityRunPayload
{
    public string Function { get; set; } = string.Empty;
    public bool   UseSudo  { get; set; } = false;
}

// ── Log Tab DTOs ───────────────────────────────────────────── //
internal class LogPathPayload { public string Path { get; set; } = string.Empty; }
internal class LogFetchFilePayload
{
    public string Path      { get; set; } = string.Empty;
    public int    TailBytes { get; set; } = 64 * 1024;
    public bool   FullFile  { get; set; } = false;
}
internal class LogEvaluatePayload
{
    public int    SizeBytes { get; set; }
    public string Provider  { get; set; } = string.Empty;
    public string Model     { get; set; } = string.Empty;
}
internal class LogAnalyzePayload
{
    public string? Source   { get; set; }
    public string  Content  { get; set; } = string.Empty;
}
