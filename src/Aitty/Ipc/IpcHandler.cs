using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.IO;
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
    private readonly SessionData? _restoredSession;
    private CancellationTokenSource? _streamingCts;

    public IpcHandler(
        WebView2 webView,
        SshService sshService,
        ConfigService configService,
        KeyManagerService keyManagerService,
        AiServiceManager aiManager,
        SessionService sessionService,
        SessionData? restoredSession = null)
    {
        _webView = webView;
        _sshService = sshService;
        _configService = configService;
        _keyManagerService = keyManagerService;
        _aiManager = aiManager;
        _sessionService = sessionService;
        _restoredSession = restoredSession;
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
            "ai:openwebui:diagnose"    => await HandleAiOpenWebUiDiagnose(msg.Payload),

            // ── SSH 분석 ─────────────────────────────────── //
            "ai:ssh:analyze"           => await HandleAiAnalyzeSsh(msg),
            "ai:ssh:suggest-command"   => await HandleAiSuggestCommand(msg),

            // ── 보안취약점 ─────────────────────────────────────── //
            "security:browse-scripts"  => await HandleSecurityBrowseScripts(),
            "security:deploy"          => await HandleSecurityDeploy(msg.Payload),
            "security:run"             => await HandleSecurityRun(msg),

            // ── 세션 ─────────────────────────────────────────── //
            "session:get-restored"     => HandleSessionGetRestored(),
            "session:set-save-enabled" => HandleSessionSetSaveEnabled(msg.Payload),

            "app:version"              => GetAppVersion(),
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

        // [M-1] 커맨드 길이 제한 (8KB)
        if (data.Command.Length > 8192)
            throw new ArgumentException("Command too long (max 8192 chars)");

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
        var state = _sshService.State;
        return new { isConnected = _sshService.IsConnected, isConnecting = state.IsConnecting, error = state.Error, host = state.Connection?.Host, connectionTime = state.ConnectionTime?.ToString("o") };
    }

    private object HandleSshShellWrite(object? payload) { _sshService.WriteToShell(DeserializePayload<ShellWritePayload>(payload).Data); return new { success = true }; }
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
        var baseUrl = svc is LocalLlmService ollama ? ollama.CurrentBaseUrl : string.Empty;
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

    // ── Ollama 전용 ────────────────────────────────────────── //

    private object HandleAiSetEndpoint(object? payload)
    {
        _aiManager.Ollama.SetBaseUrl(DeserializePayload<EndpointPayload>(payload).Url);
        return new { success = true, url = _aiManager.Ollama.CurrentBaseUrl };
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
