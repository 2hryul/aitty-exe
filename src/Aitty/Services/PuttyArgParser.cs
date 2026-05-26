using System.Diagnostics;
using Aitty.Models;

namespace Aitty.Services;

/// <summary>
/// PuTTY 호환 CLI 인자를 SshConnection으로 변환.
/// HiWare 등 외부 접근통제 솔루션이 PuTTY 대신 Aitty를 호출할 수 있도록 지원.
///
/// 지원 인자:
///   [user@]host          위치 인자 — Host, Username 추출
///   -ssh                 SSH 프로토콜 강제 (Aitty는 항상 SSH이므로 무시)
///   -P port              포트 (대문자 P — PuTTY 규칙)
///   -l username          사용자명 (user@host보다 우선)
///   -pw password         비밀번호 (⚠ 프로세스 커맨드라인 노출 위험)
///   -i keyfile           개인키 경로 (.ppk, OpenSSH 모두 지원)
/// </summary>
public static class PuttyArgParser
{
    /// <summary>
    /// PuTTY 스타일 CLI 인자를 파싱하여 SshConnection 반환.
    /// Host가 없으면 null 반환 → 일반 GUI 모드로 진입.
    /// </summary>
    public static SshConnection? Parse(string[] args)
    {
        if (args.Length == 0) return null;

        string? host = null;
        string? username = null;
        string? password = null;
        string? privateKey = null;
        int port = 22;

        for (int i = 0; i < args.Length; i++)
        {
            var arg = args[i];

            switch (arg)
            {
                case "-ssh":
                    // Aitty는 항상 SSH — 플래그만 소비
                    break;

                case "-P" when HasNext(args, i):
                    if (int.TryParse(args[++i], out var p) && p is >= 1 and <= 65535)
                        port = p;
                    else
                        Trace.TraceWarning($"[PuttyArgParser] 유효하지 않은 포트: {args[i]}");
                    break;

                case "-l" when HasNext(args, i):
                    username = args[++i];
                    break;

                // ⚠ -pw: 프로세스 커맨드라인에 비밀번호 노출 — HiWare 등 PSM 연동 시 불가피
                case "-pw" when HasNext(args, i):
                    password = args[++i];
                    break;

                case "-i" when HasNext(args, i):
                    privateKey = args[++i];
                    break;

                default:
                    // 인식 못한 플래그는 무시, '-'로 시작하지 않으면 위치 인자(host)로 처리
                    if (!arg.StartsWith('-') && host is null)
                    {
                        // user@host 형태 지원
                        var atIdx = arg.IndexOf('@');
                        if (atIdx > 0)
                        {
                            username ??= arg[..atIdx];
                            host = arg[(atIdx + 1)..];
                        }
                        else
                        {
                            host = arg;
                        }

                        // host:port 형태 지원
                        var colonIdx = host.LastIndexOf(':');
                        if (colonIdx > 0 && int.TryParse(host[(colonIdx + 1)..], out var hp) && hp is >= 1 and <= 65535)
                        {
                            port = hp;
                            host = host[..colonIdx];
                        }
                    }
                    break;
            }
        }

        if (string.IsNullOrWhiteSpace(host))
            return null;

        // -l 옵션이 user@host의 username보다 우선 (PuTTY 동작과 동일)
        Trace.TraceInformation($"[PuttyArgParser] host={host}, port={port}, user={username ?? "(none)"}, " +
                               $"hasPassword={password is not null}, hasKey={privateKey is not null}");

        return new SshConnection
        {
            Host = host,
            Port = port,
            Username = username ?? string.Empty,
            // [H-3] Password는 char[]로 보관 — 사용 후 SshService에서 0으로 덮어쓴다
            Password = string.IsNullOrEmpty(password) ? null : password.ToCharArray(),
            PrivateKey = privateKey,
        };
    }

    private static bool HasNext(string[] args, int i) => i + 1 < args.Length;
}
