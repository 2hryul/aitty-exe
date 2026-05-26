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

    /// <summary>
    /// 프로토타입 유효기간 — 이 날짜를 넘으면 첫 실행 시점에 안내 팝업 후 종료.
    /// 사내 검증용 빌드의 운영 가이드 — 시스템 시계 조작 우회는 의도된 한계(보안 기능 아님).
    /// </summary>
    private static readonly DateTime PrototypeExpiry =
        new(2026, 10, 25, 23, 59, 59, DateTimeKind.Local);

    protected override void OnStartup(StartupEventArgs e)
    {
        // [Expiry-Guard] base.OnStartup 전에 처리 — StartupUri 기반 MainWindow 생성 자체 차단
        if (DateTime.Now > PrototypeExpiry)
        {
            MessageBox.Show(
                "AItty 프로토타입으로 업데이트 서버 연결이 필요합니다.",
                "AItty",
                MessageBoxButton.OK,
                MessageBoxImage.Information);
            Shutdown();
            return;
        }

        base.OnStartup(e);

        // 진단 로그 초기화 (WebView2 문제, 흰 화면 등 재현 시 사용자가 로그 전달용)
        StartupLogger.Initialize();
        // AI API 호출 전용 로그 — base_url 정규화, Bearer 토큰(마스킹), 요청/응답 기록
        AiRequestLogger.Initialize();
        StartupLogger.Log($"[App.OnStartup] args.Length={e.Args.Length}");
        StartupLogger.Log($"[App.OnStartup] AI API 로그: {AiRequestLogger.LogPath}");

        if (e.Args.Length > 0)
        {
            StartupConnection = PuttyArgParser.Parse(e.Args);

            if (StartupConnection is not null)
            {
                var msg = $"[App] CLI 자동접속 모드: {StartupConnection.Host}:{StartupConnection.Port} user={StartupConnection.Username}";
                Trace.TraceInformation(msg);
                StartupLogger.Log(msg);
            }
            else
            {
                Trace.TraceWarning("[App] CLI 인자가 있으나 호스트를 파싱할 수 없음 → GUI 모드");
                StartupLogger.Log("[App] CLI 인자 파싱 실패 → GUI 모드");
            }
        }

        // 전역 예외 처리기 → 로그 기록 후 사용자 안내
        DispatcherUnhandledException += (s, args) =>
        {
            StartupLogger.LogException("DispatcherUnhandledException", args.Exception);
        };
        AppDomain.CurrentDomain.UnhandledException += (s, args) =>
        {
            if (args.ExceptionObject is Exception ex)
                StartupLogger.LogException("AppDomain.UnhandledException", ex);
        };
    }
}

