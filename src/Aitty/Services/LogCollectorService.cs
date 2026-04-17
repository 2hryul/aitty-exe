using System.IO;
using System.Text;
using Renci.SshNet;

namespace Aitty.Services;

/// <summary>
/// SSH 원격 서버에서 로그 파일/명령 결과를 수집.
/// SFTP로 파일 메타·본문을 가져오거나, 안전 명령 실행 결과를 LogPayload로 반환.
/// SshService의 기존 연결 정보를 재사용하되 SftpClient는 매 호출마다 신규 생성 → using 정리.
/// </summary>
public class LogCollectorService
{
    // fullFile=true일 때만 적용되는 본문 최대 크기 (2MB)
    private const long FullFileMaxBytes = 2 * 1024 * 1024;

    private readonly SshService _sshService;

    public LogCollectorService(SshService sshService)
    {
        _sshService = sshService;
    }

    /// <summary>원격 파일 존재/크기/수정시각 조회.</summary>
    public async Task<LogFileInfo> StatFileAsync(string path, CancellationToken ct = default)
    {
        ValidateRemotePath(path, nameof(StatFileAsync));
        var conn = RequireConnection(nameof(StatFileAsync));

        return await Task.Run(() =>
        {
            using var sftp = CreateSftpClient(conn);
            sftp.Connect();
            try
            {
                if (!sftp.Exists(path))
                    return new LogFileInfo(false, 0, DateTime.MinValue);

                var attrs = sftp.GetAttributes(path);
                return new LogFileInfo(true, attrs.Size, attrs.LastWriteTimeUtc);
            }
            finally
            {
                sftp.Disconnect();
            }
        }, ct);
    }

    /// <summary>
    /// 원격 파일 본문 수집.
    /// - fullFile=true: 전체 읽기 (2MB 초과 시 거절)
    /// - fullFile=false: 끝에서 tailBytes 만큼만 읽고, 첫 '\n' 이후부터 사용(중간 줄 끊김 보정)
    /// </summary>
    public async Task<LogPayload> FetchFileAsync(string path, int tailBytes, bool fullFile, CancellationToken ct = default)
    {
        ValidateRemotePath(path, nameof(FetchFileAsync));
        var conn = RequireConnection(nameof(FetchFileAsync));

        return await Task.Run(() =>
        {
            using var sftp = CreateSftpClient(conn);
            sftp.Connect();
            try
            {
                if (!sftp.Exists(path))
                    throw new InvalidOperationException($"[FetchFileAsync] SFTP 파일 없음 - {path}");

                // SFTP 스트림의 Length 미지원 대응 — GetAttributes로 파일 길이 선계산
                var attrs = sftp.GetAttributes(path);
                var fileLen = attrs.Size;

                if (fullFile && fileLen > FullFileMaxBytes)
                    throw new InvalidOperationException(
                        $"[FetchFileAsync] 파일이 2MB를 초과합니다. tail 바이트를 지정하세요. - {path} ({fileLen} bytes)");

                string content = ReadRemoteContent(sftp, path, fileLen, tailBytes, fullFile);
                return BuildPayload($"file: {path}", content);
            }
            finally
            {
                sftp.Disconnect();
            }
        }, ct);
    }

    /// <summary>
    /// 안전 명령 실행 결과를 로그 페이로드로 수집.
    /// CommandSafetyService 차단 시 즉시 거절 (IPC ssh:exec 의 메시지 포맷과 동일).
    /// </summary>
    public async Task<LogPayload> FetchExecAsync(string command, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(command))
            throw new ArgumentException("[FetchExecAsync] 빈 명령 - command is null/empty");

        if (CommandSafetyService.IsDangerous(command))
            throw new InvalidOperationException($"Command blocked by safety policy: {command}");

        // SshService.ExecuteAsync 내부에서 연결 검증 + Task.Run 수행
        var output = await _sshService.ExecuteAsync(command);
        return BuildPayload($"exec: {command}", output);
    }

    // ── 내부 헬퍼 ─────────────────────────────────────────── //

    /// <summary>SFTP 스트림에서 tail/전체 본문을 문자열로 추출.</summary>
    private static string ReadRemoteContent(SftpClient sftp, string path, long fileLen, int tailBytes, bool fullFile)
    {
        using var stream = sftp.OpenRead(path);

        long startPos = 0;
        if (!fullFile && tailBytes > 0 && fileLen > tailBytes)
            startPos = fileLen - tailBytes;

        if (startPos > 0)
            stream.Seek(startPos, SeekOrigin.Begin);

        using var reader = new StreamReader(stream, Encoding.UTF8);
        var raw = reader.ReadToEnd();

        // tail 모드에서 중간 줄이 잘렸을 수 있으므로 첫 '\n' 이후부터 사용.
        // 파일 시작(startPos=0)이거나 줄바꿈이 없으면 원문 유지.
        if (startPos > 0)
        {
            var nl = raw.IndexOf('\n');
            if (nl >= 0 && nl + 1 < raw.Length)
                raw = raw[(nl + 1)..];
        }
        return raw;
    }

    /// <summary>LogPayload를 생성. Host는 현재 SSH 연결 호스트를 채움(연결 없으면 null).</summary>
    private LogPayload BuildPayload(string source, string content)
    {
        var sizeBytes = Encoding.UTF8.GetByteCount(content);
        var lineCount = CountLines(content);
        var host = _sshService.State.Connection?.Host;

        return new LogPayload(
            Source: source,
            Host: host,
            SizeBytes: sizeBytes,
            LineCount: lineCount,
            Content: content,
            CollectedAt: DateTimeOffset.UtcNow
        );
    }

    private static int CountLines(string content)
    {
        if (string.IsNullOrEmpty(content)) return 0;
        var count = 1;
        foreach (var ch in content)
            if (ch == '\n') count++;
        // 파일이 '\n'으로 끝나면 마지막 빈 줄은 실제 라인이 아님
        if (content[^1] == '\n') count--;
        return count;
    }

    /// <summary>원격 경로 허용 규칙: 절대경로(`/` 시작) + `..` 포함 금지.</summary>
    private static void ValidateRemotePath(string path, string method)
    {
        if (string.IsNullOrWhiteSpace(path))
            throw new ArgumentException($"[{method}] 경로 비어있음 - path is null/empty");
        if (!path.StartsWith('/'))
            throw new ArgumentException($"[{method}] 절대경로 아님 - {path}");
        if (path.Contains(".."))
            throw new ArgumentException($"[{method}] 상위 경로 이동 금지 - {path}");
    }

    /// <summary>현재 SshService 연결에서 자격증명을 추출(SFTP 신규 클라이언트용).</summary>
    private Models.SshConnection RequireConnection(string method)
    {
        var conn = _sshService.State.Connection;
        if (conn is null || !_sshService.IsConnected)
            throw new InvalidOperationException($"[{method}] SSH 미연결 - 먼저 ssh:connect 수행 필요");
        return conn;
    }

    /// <summary>
    /// SftpClient 신규 생성 — 패스워드 우선, 없으면 개인키 사용.
    /// HandleSecurityDeploy의 패턴을 그대로 따른다.
    /// </summary>
    private static SftpClient CreateSftpClient(Models.SshConnection conn)
    {
        if (!string.IsNullOrEmpty(conn.Password))
            return new SftpClient(conn.Host, conn.Port, conn.Username, conn.Password);

        var keyFile = CreatePrivateKeyFile(conn);
        return new SftpClient(conn.Host, conn.Port, conn.Username, keyFile);
    }

    private static PrivateKeyFile CreatePrivateKeyFile(Models.SshConnection conn)
    {
        var keyPath = conn.PrivateKey ?? string.Empty;
        if (string.IsNullOrEmpty(keyPath))
            throw new InvalidOperationException("[LogCollectorService] 인증 수단 없음 - key 또는 password 필요");

        return string.IsNullOrEmpty(conn.Passphrase)
            ? new PrivateKeyFile(keyPath)
            : new PrivateKeyFile(keyPath, conn.Passphrase);
    }
}

// ── DTOs ──────────────────────────────────────────────────── //

/// <summary>원격 파일 메타 정보.</summary>
public record LogFileInfo(bool Exists, long Size, DateTime LastWriteUtc);

/// <summary>
/// AI 분석 입력용 로그 페이로드.
/// Images는 향후 멀티모달 확장을 위한 필드로, 이번 Step에서는 채우지 않는다.
/// </summary>
public record LogPayload(
    string Source,
    string? Host,
    int SizeBytes,
    int LineCount,
    string Content,
    DateTimeOffset CollectedAt,
    string[]? Images = null);
