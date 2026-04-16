using System.Diagnostics;
using System.Windows;
using Aitty.Models;
using Aitty.Services;

namespace Aitty;

/// <summary>
/// Interaction logic for App.xaml
/// </summary>
public partial class App : Application
{
    /// <summary>
    /// PuTTY 호환 CLI 인자로 전달된 SSH 접속 정보.
    /// HiWare 등 외부 솔루션이 Aitty.exe를 PuTTY 대체로 호출할 때 사용.
    /// null이면 일반 GUI 모드.
    /// </summary>
    internal static SshConnection? StartupConnection { get; private set; }

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        if (e.Args.Length > 0)
        {
            StartupConnection = PuttyArgParser.Parse(e.Args);

            if (StartupConnection is not null)
                Trace.TraceInformation(
                    $"[App] CLI 자동접속 모드: {StartupConnection.Host}:{StartupConnection.Port} " +
                    $"user={StartupConnection.Username}");
            else
                Trace.TraceWarning("[App] CLI 인자가 있으나 호스트를 파싱할 수 없음 → GUI 모드");
        }
    }
}

