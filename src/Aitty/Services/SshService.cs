using System.IO;
using System.Text.RegularExpressions;
using System.Windows;
using Renci.SshNet;
using Renci.SshNet.Common;
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
    private readonly object _bufferLock = new(); // _recentLines, _lastOutputBuffer 보호
    private readonly SshConnectionState _state = new();
    private readonly Queue<string> _recentLines = new();

    // [L-3] 호스트키 영속화 — SshService 단일 인스턴스 패턴이라 인스턴스 필드로 충분.
    private readonly KnownHostsStore _knownHosts = new();

    // SSH 셸 출력 누적 버퍼 — AI "마지막 출력 분석"용. MaxLastOutputLines 한도로 자연 슬라이딩 윈도우.
    // 2026-05-25: 이전 `_collectingOutput` 게이트는 사용자 Enter 외 케이스(자동 명령/IPC 타이밍)에서
    // 누적이 안 되는 결함이 있어 제거 — 항상 누적.
    private readonly List<string> _lastOutputBuffer = new();

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
                    // [M-A] Passphrase는 char[] — 사용 시점에만 string 카피본 생성.
                    // SSH.NET PrivateKeyFile은 string만 받기 때문에 라이브러리 측 메모리는 .NET 한계로 정리 불가.
                    // char[] 본체는 SshConnection.Dispose()에서 Array.Clear로 0 덮어쓰기.
                    PrivateKeyFile keyFile;
                    if (connection.Passphrase is { Length: > 0 } pp)
                    {
                        var ppStr = new string(pp);
                        keyFile = new PrivateKeyFile(keyPath, ppStr);
                    }
                    else
                    {
                        keyFile = new PrivateKeyFile(keyPath);
                    }
                    authMethods.Add(new PrivateKeyAuthenticationMethod(connection.Username, keyFile));
                }

                // [H-3] Password는 char[]로 보관 — 사용 시점에만 string 카피본 생성.
                // SSH.NET이 PasswordAuthenticationMethod 내부에서 string 사본을 또 만들기 때문에
                // 라이브러리 측 메모리는 .NET 한계로 정리 불가(known limitation).
                // char[] 본체는 SshConnection.Dispose()에서 Array.Clear로 0 덮어쓰기.
                if (connection.Password is { Length: > 0 } pw)
                {
                    var pwStr = new string(pw);
                    authMethods.Add(new PasswordAuthenticationMethod(connection.Username, pwStr));
                }

                var connInfo = new ConnectionInfo(connection.Host, connection.Port, connection.Username, authMethods.ToArray())
                {
                    Timeout = TimeSpan.FromSeconds(30)
                };

                _client = new SshClient(connInfo);
                _client.KeepAliveInterval = TimeSpan.FromSeconds(15);
                // 원격 측 연결 종료 즉시 감지
                _client.ErrorOccurred += (_, _) => { _state.IsConnected = false; };

                // [L-3] 호스트키 검증 (TOFU + 변경 감지) — Connect() 호출 전 핸들러 등록 필수.
                _client.HostKeyReceived += (_, e) => VerifyHostKey(connection, e);

                _client.Connect();
                _shellStream = _client.CreateShellStream("xterm", 120, 40, 800, 600, 4096);
                // 셸 스트림 에러(exit 등) 즉시 감지
                _shellStream.ErrorOccurred += (_, _) => { _state.IsConnected = false; };
            });

            lock (_bufferLock)
            {
                _recentLines.Clear();
                _lastOutputBuffer.Clear();
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
        // Enter 키(\r) 감지 → 새 명령어 시작: 마지막 출력 버퍼 초기화.
        // (이전 `_collectingOutput=true` 게이트는 제거 — 항상 누적이므로 클리어만 수행.)
        if (data.Contains('\r'))
        {
            lock (_bufferLock)
            {
                _lastOutputBuffer.Clear();
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

        // 명령어 실행 후 출력을 마지막 출력 버퍼에 수집 (ANSI 코드 제거).
        // 2026-05-25 fix: `_collectingOutput` 게이트가 사용자 Enter 직후가 아니면 false로 유지되어
        // 자동 실행된 명령(로그인 스크립트, attach 직후 출력 등) 또는 IPC 타이밍 어긋남 시
        // AI 분석이 빈 응답을 받던 문제를 해결. 항상 누적하되 MaxLastOutputLines로 안전 상한.
        // (Clear는 WriteToShell의 Enter 시 그대로 유지 — "마지막 명령 출력" 의미 보존)
        lock (_bufferLock)
        {
            if (!string.IsNullOrEmpty(output))
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

    /// <summary>
    /// [L-3] HostKeyReceived 콜백 — TOFU + 변경 감지.
    ///   첫 연결 → 자동 신뢰 + 저장
    ///   동일 키 → 자동 통과
    ///   변경 감지 → 사용자 confirm (MITM 가능성 경고)
    /// SSH.NET 2025.1.0의 FingerPrintSHA256은 OpenSSH 표준 형식(base64, no padding, no prefix).
    /// </summary>
    private void VerifyHostKey(SshConnection connection, HostKeyEventArgs e)
    {
        try
        {
            var fp = e.FingerPrintSHA256 ?? string.Empty;
            var keyType = e.HostKeyName ?? string.Empty;
            var existing = _knownHosts.Lookup(connection.Host, connection.Port);

            if (existing is null)
            {
                _knownHosts.Save(connection.Host, connection.Port, keyType, fp);
                e.CanTrust = true;
                StartupLogger.Log($"[SSH] 신규 호스트키 신뢰(TOFU): {connection.Host}:{connection.Port} ({keyType}, SHA256:{Preview(fp)})");
                return;
            }

            if (existing.Fingerprint == fp && existing.KeyType == keyType)
            {
                e.CanTrust = true;
                return;
            }

            var trusted = PromptHostKeyChange(connection.Host, connection.Port, existing, keyType, fp);
            if (trusted)
            {
                _knownHosts.Save(connection.Host, connection.Port, keyType, fp);
                e.CanTrust = true;
                StartupLogger.Log($"[SSH] 호스트키 변경 수락: {connection.Host}:{connection.Port}");
            }
            else
            {
                e.CanTrust = false;
                StartupLogger.Log($"[SSH] 호스트키 변경 거부 — MITM 가능성: {connection.Host}:{connection.Port}");
            }
        }
        catch (Exception ex)
        {
            // 검증 로직 자체가 실패하면 안전한 쪽(차단)으로 fallback.
            e.CanTrust = false;
            StartupLogger.Log($"[SSH] 호스트키 검증 실패 — 안전상 연결 차단: {ex.GetType().Name}: {ex.Message}");
        }
    }

    /// <summary>
    /// [L-3] 호스트키 변경 시 사용자 confirm 다이얼로그.
    /// HostKeyReceived는 ConnectAsync 내부 Task.Run의 백그라운드 스레드에서 발화 →
    /// MessageBox는 UI thread 필요. ConnectAsync는 await Task.Run(...)으로 호출되어
    /// UI 스레드를 점유하지 않으므로 Dispatcher.Invoke 동기 호출에 데드락 위험 없음.
    /// </summary>
    private static bool PromptHostKeyChange(string host, int port, KnownHostEntry old, string newType, string newFp)
    {
        var app = Application.Current;
        if (app is null)
        {
            // 콘솔/테스트 환경 등 UI 없음 → 안전상 거부.
            StartupLogger.Log($"[SSH] UI 미가용 — 호스트키 변경 자동 거부: {host}:{port}");
            return false;
        }

        return app.Dispatcher.Invoke(() =>
        {
            var msg =
                $"SSH 호스트키가 변경됐습니다 — MITM(중간자 공격) 가능성\n\n" +
                $"호스트: {host}:{port}\n" +
                $"기존: {old.KeyType} SHA256:{Preview(old.Fingerprint)}\n" +
                $"신규: {newType} SHA256:{Preview(newFp)}\n\n" +
                $"확인된 변경(서버 재설치/키 교체)일 때만 [예] 선택.\n" +
                $"의심스러우면 [아니오] → 관리자 확인 후 known_hosts 수동 삭제.";

            return MessageBox.Show(msg, "SSH 호스트키 변경 감지",
                MessageBoxButton.YesNo, MessageBoxImage.Warning,
                MessageBoxResult.No) == MessageBoxResult.Yes;
        });
    }

    /// <summary>fingerprint 일부만 표시 — 전체는 known_hosts.json에서 확인 가능.</summary>
    private static string Preview(string fingerprint) =>
        string.IsNullOrEmpty(fingerprint) ? "(empty)" :
        fingerprint.Length <= 16 ? fingerprint : fingerprint[..16] + "...";
}
