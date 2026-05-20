using System.IO;
using System.Text.RegularExpressions;
using Renci.SshNet;
using Aitty.Models;

namespace Aitty.Services;

public class SshService : IDisposable
{
    private const int MaxRecentLines = 200;
    private const int MaxLastOutputLines = 100;

    // ANSI 이스케이프 코드 제거용 정규식
    private static readonly Regex AnsiRegex = new(@"\x1B\[[0-9;?]*[A-Za-z]|\x1B[()][A-Z0-9]", RegexOptions.Compiled);

    private SshClient? _client;
    private ShellStream? _shellStream;
    private readonly object _streamLock = new();  // ShellStream 동시 Read/Write 보호
    private readonly object _bufferLock = new(); // _recentLines, _lastOutputBuffer, _collectingOutput 보호
    private readonly SshConnectionState _state = new();
    private readonly Queue<string> _recentLines = new();

    // 마지막 명령어 이후 출력만 수집하는 버퍼
    private readonly List<string> _lastOutputBuffer = new();
    private bool _collectingOutput = false;

    public SshConnectionState State => _state;
    public bool IsConnected =>
        _state.IsConnected &&
        _client?.IsConnected == true &&
        (_shellStream == null || _shellStream.CanRead);

    /// <summary>
    /// 다층 연결 상태 확인 — exit 명령 후 빠른 감지.
    /// Layer 3: 셸 스트림 쓰기 프로브 + Layer 4: SSH KeepAlive
    /// </summary>
    public bool PingAlive()
    {
        if (_client is null || !_client.IsConnected) return false;

        // _state.IsConnected가 이미 false면 (Layer 1/2에서 감지됨) 즉시 반환
        if (!_state.IsConnected) return false;

        // [Layer 3] 셸 채널 활성 여부 — 쓰기 시도로 확인
        // exit 후 채널이 닫히면 WriteByte가 예외 발생
        if (_shellStream != null)
        {
            try
            {
                lock (_streamLock)
                {
                    _shellStream.Flush();
                }
            }
            catch
            {
                _state.IsConnected = false;
                return false;
            }
        }

        // [Layer 4] SSH 전송 계층 KeepAlive — TCP 끊김 백업 감지
        try
        {
#pragma warning disable CS0618
            _client.SendKeepAlive();
#pragma warning restore CS0618
            return _client.IsConnected;
        }
        catch
        {
            _state.IsConnected = false;
            return false;
        }
    }

    public async Task<bool> ConnectAsync(SshConnection connection)
    {
        try
        {
            // P1-5: 기존 연결이 있으면 먼저 정리
            if (_client?.IsConnected == true || _shellStream != null)
                Disconnect();

            _state.IsConnecting = true;
            _state.Error = null;

            await Task.Run(() =>
            {
                var authMethods = new List<AuthenticationMethod>();

                if (!string.IsNullOrEmpty(connection.PrivateKey))
                {
                    var keyPath = ResolvePath(connection.PrivateKey);
                    var keyFile = string.IsNullOrEmpty(connection.Passphrase)
                        ? new PrivateKeyFile(keyPath)
                        : new PrivateKeyFile(keyPath, connection.Passphrase);
                    authMethods.Add(new PrivateKeyAuthenticationMethod(connection.Username, keyFile));
                }

                if (!string.IsNullOrEmpty(connection.Password))
                {
                    authMethods.Add(new PasswordAuthenticationMethod(connection.Username, connection.Password));
                }

                var connInfo = new ConnectionInfo(connection.Host, connection.Port, connection.Username, authMethods.ToArray())
                {
                    Timeout = TimeSpan.FromSeconds(30)
                };

                _client = new SshClient(connInfo);
                _client.KeepAliveInterval = TimeSpan.FromSeconds(15);
                // 원격 측 연결 종료 즉시 감지
                _client.ErrorOccurred += (_, _) => { _state.IsConnected = false; };
                _client.Connect();
                _shellStream = _client.CreateShellStream("xterm", 120, 40, 800, 600, 4096);
                // 셸 스트림 에러(exit 등) 즉시 감지
                _shellStream.ErrorOccurred += (_, _) => { _state.IsConnected = false; };
            });

            lock (_bufferLock)
            {
                _recentLines.Clear();
                _lastOutputBuffer.Clear();
                _collectingOutput = false;
            }
            _state.IsConnected = true;
            _state.IsConnecting = false;
            _state.Connection = connection;
            _state.ConnectionTime = DateTime.UtcNow;
            return true;
        }
        catch (Exception ex)
        {
            _state.IsConnected = false;
            _state.IsConnecting = false;
            _state.Error = ex.Message;
            return false;
        }
    }

    public void ResizeTerminal(uint columns, uint rows)
    {
        _shellStream?.ChangeWindowSize(columns, rows, 0, 0);
    }

    public void Disconnect()
    {
        _shellStream?.Dispose();
        _shellStream = null;

        if (_client?.IsConnected == true)
            _client.Disconnect();

        _client?.Dispose();
        _client = null;

        // [M-2] 민감 필드(Password, Passphrase) 명시적 참조 해제
        _state.Connection?.Dispose();
        _state.Connection = null;
        _state.IsConnected = false;
    }

    public Task<string> ExecuteAsync(string command) => ExecuteAsync(command, default);

    /// <summary>
    /// 명령 실행 + CancellationToken 지원.
    /// CT 발화 시 SshCommand.CancelAsync로 원격 명령 중단 시도 (SSH.NET 2025+).
    /// </summary>
    public async Task<string> ExecuteAsync(string command, CancellationToken ct)
    {
        if (_client is not { IsConnected: true })
            throw new InvalidOperationException("SSH not connected");

        return await Task.Run(() =>
        {
            using var cmd = _client.CreateCommand(command);
            cmd.CommandTimeout = TimeSpan.FromSeconds(60);
            // CT 발화 → SshCommand 비동기 취소 시도. 예외 흡수 — Disconnect 등 강한 부수효과 금지.
            // SSH.NET 2025.x의 SshCommand.CancelAsync()는 Task가 아닌 void 반환 — 할당 금지
            using var reg = ct.Register(() => { try { cmd.CancelAsync(); } catch { } });
            ct.ThrowIfCancellationRequested();
            var result = cmd.Execute();
            ct.ThrowIfCancellationRequested();
            var output = !string.IsNullOrEmpty(cmd.Error) ? result + "\n" + cmd.Error : result;
            Remember(command);
            Remember(output);
            return output;
        }, ct);
    }

    public async Task<bool> TestAsync()
    {
        try
        {
            var result = await ExecuteAsync("echo \"SSH connection test\"");
            return result.Contains("connection test");
        }
        catch
        {
            return false;
        }
    }

    public void WriteToShell(string data)
    {
        // 네트워크 I/O만 lock — ShellStream은 thread-safe하지 않으므로 Read와 동시 접근 방지
        lock (_streamLock)
        {
            _shellStream?.Write(data);
            _shellStream?.Flush();
        }
        if (!string.IsNullOrWhiteSpace(data) && data != "\r")
            Remember(data.Replace("\r", string.Empty));
        // Enter 키(\r) 감지 → 새 명령어 시작: 마지막 출력 버퍼 초기화 후 수집 시작
        if (data.Contains('\r'))
        {
            lock (_bufferLock)
            {
                _lastOutputBuffer.Clear();
                _collectingOutput = true;
            }
        }
    }

    public string? ReadFromShell()
    {
        string? output;
        // 네트워크 I/O만 lock — WriteToShell과 동시 접근 방지
        lock (_streamLock)
        {
            if (_shellStream is null || !_shellStream.CanRead) return null;
            if (!_shellStream.DataAvailable) return null;
            try { output = _shellStream.Read(); }
            catch
            {
                // [Layer 2] 채널 닫힘 → 즉시 상태 업데이트
                _state.IsConnected = false;
                return null;
            }
        }

        Remember(output);

        // [Layer 1] logout/exit 출력 패턴 감지 → 셸 종료 즉시 반영
        if (!string.IsNullOrEmpty(output))
        {
            var stripped = AnsiRegex.Replace(output, "").Trim();
            if (stripped.Equals("logout", StringComparison.OrdinalIgnoreCase) ||
                (stripped.StartsWith("Connection to ", StringComparison.OrdinalIgnoreCase) &&
                 stripped.Contains("closed", StringComparison.OrdinalIgnoreCase)))
            {
                _state.IsConnected = false;
            }
        }

        // 명령어 실행 후 출력을 마지막 출력 버퍼에 수집 (ANSI 코드 제거)
        lock (_bufferLock)
        {
            if (_collectingOutput && !string.IsNullOrEmpty(output))
            {
                var clean = AnsiRegex.Replace(output, string.Empty);
                foreach (var line in clean.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n'))
                {
                    var trimmed = line.Trim();
                    if (!string.IsNullOrWhiteSpace(trimmed))
                    {
                        _lastOutputBuffer.Add(trimmed);
                        if (_lastOutputBuffer.Count > MaxLastOutputLines)
                            _lastOutputBuffer.RemoveAt(0);
                    }
                }
            }
        }

        return output;
    }

    /// <summary>마지막 명령어 실행 이후 SSH 터미널에 출력된 내용만 반환</summary>
    public string GetLastCommandOutput()
    {
        lock (_bufferLock)
            return string.Join("\n", _lastOutputBuffer);
    }

    public string GetRecentOutput(int lineCount = 80)
    {
        lock (_bufferLock)
            return string.Join("\n", _recentLines.TakeLast(lineCount));
    }

    public void Dispose()
    {
        Disconnect();
        GC.SuppressFinalize(this);
    }

    private void Remember(string? text)
    {
        if (string.IsNullOrEmpty(text))
            return;

        lock (_bufferLock)
        {
            foreach (var line in text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n'))
            {
                _recentLines.Enqueue(line);
                while (_recentLines.Count > MaxRecentLines)
                    _recentLines.Dequeue();
            }
        }
    }

    private static string ResolvePath(string path)
    {
        if (path.StartsWith('~'))
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Path.Combine(home, path[2..]);
        }
        return Path.GetFullPath(path);
    }
}
