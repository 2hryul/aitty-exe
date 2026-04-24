using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Input;
using Microsoft.Web.WebView2.Core;
using Aitty.Ipc;
using Aitty.Services;

namespace Aitty;

public partial class MainWindow : Window
{
    private readonly SshService _sshService;
    private readonly ConfigService _configService;
    private readonly KeyManagerService _keyManagerService;
    private readonly AiServiceManager _aiManager;
    private readonly SessionService _sessionService;
    private IpcHandler? _ipcHandler;

    // 구형 WebView2 런타임(v117 미만) → CSS app-region 미지원 → WPF 수준 폴백 드래그 사용
    private bool _useWpfDragFallback = false;
    private const double FallbackTitleBarHeight = 36;   // React titlebar와 동일
    private const double FallbackButtonZoneWidth = 140; // 우측 최소/최대/닫기 버튼 공간

    // (removed: _indexHtmlCache — now using direct file + virtual host mapping)

    // [H-3] Release 빌드에서 AITTY_DEV 환경변수 우회 완전 차단
    private static bool IsDev =>
#if DEBUG
        true;
#else
        false;
#endif

    public MainWindow()
    {
        InitializeComponent();

        _sshService = new SshService();
        _configService = new ConfigService();
        _keyManagerService = new KeyManagerService();
        _aiManager = new AiServiceManager();
        _sessionService = new SessionService();

        Loaded += MainWindow_Loaded;

        // 최대화 시 WebView2 마진 제거, 복원 시 리사이즈 마진 복원
        StateChanged += (_, _) =>
        {
            webView.Margin = WindowState == WindowState.Maximized
                ? new Thickness(0)
                : new Thickness(4);
        };

        // 앱 종료 시 세션 자동 저장 (동기, 소용량)
        Closing += (_, _) =>
        {
            try { _sessionService.Save(_aiManager.GetSessionData()); }
            catch { /* 저장 실패가 종료를 막으면 안 됨 */ }
        };

        var exitBinding = new KeyBinding(new RelayCommand(_ => Close()), new KeyGesture(Key.Q, ModifierKeys.Control));
        InputBindings.Add(exitBinding);

        var reloadBinding = new KeyBinding(new RelayCommand(_ => webView.CoreWebView2?.Reload()), new KeyGesture(Key.R, ModifierKeys.Control));
        InputBindings.Add(reloadBinding);

        // F12 → DevTools (DEBUG + Release 모두 활성화 — 빈 화면 등 진단용)
        var devToolsBinding = new KeyBinding(new RelayCommand(_ => webView.CoreWebView2?.OpenDevToolsWindow()), new KeyGesture(Key.F12));
        InputBindings.Add(devToolsBinding);

        // Ctrl+L → 로그 폴더 열기 (사용자가 로그 파일 쉽게 찾도록)
        var logBinding = new KeyBinding(new RelayCommand(_ => {
            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = "explorer.exe",
                    Arguments = $"/select,\"{StartupLogger.LatestLogPath}\"",
                    UseShellExecute = true,
                });
            }
            catch (Exception ex) { StartupLogger.LogException("OpenLogFolder", ex); }
        }), new KeyGesture(Key.L, ModifierKeys.Control));
        InputBindings.Add(logBinding);

        // WPF 폴백 드래그 — 구형 WebView2 런타임에서도 타이틀바 영역 클릭 시 창 이동 가능
        // PreviewMouseLeftButtonDown이 WebView2 기본 처리보다 먼저 실행됨
        PreviewMouseLeftButtonDown += OnWindowPreviewMouseDown;
    }

    /// <summary>
    /// 구형 WebView2 환경 폴백: 타이틀바 영역(top 36px, 우측 버튼 구역 제외) 클릭 시 창 드래그.
    /// 최신 런타임에서는 CSS app-region이 처리하므로 이 핸들러는 비활성화됨 (_useWpfDragFallback=false).
    /// </summary>
    private void OnWindowPreviewMouseDown(object sender, MouseButtonEventArgs e)
    {
        if (!_useWpfDragFallback) return;
        if (e.ClickCount >= 2)
        {
            // 더블클릭 → 최대화/복원 토글
            var p = e.GetPosition(this);
            if (p.Y <= FallbackTitleBarHeight && p.X <= ActualWidth - FallbackButtonZoneWidth)
            {
                WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
                e.Handled = true;
            }
            return;
        }
        try
        {
            var pos = e.GetPosition(this);
            // 상단 36px & 우측 버튼 구역(140px) 제외 영역만 드래그 가능
            if (pos.Y <= FallbackTitleBarHeight && pos.X <= ActualWidth - FallbackButtonZoneWidth)
            {
                DragMove();
                e.Handled = true;
            }
        }
        catch (InvalidOperationException)
        {
            // DragMove는 마우스 버튼이 이미 released된 경우 등 일부 상황에서 throw — 무시
        }
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        try
        {
            StartupLogger.Log("[MainWindow_Loaded] 시작");

            // WebView2 user data → %LOCALAPPDATA%\Aitty\WebView2
            var baseDataFolder = System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Aitty");
            StartupLogger.Log($"[MainWindow_Loaded] WebView2 dataFolder: {baseDataFolder}");

            await InitializeWebView2Async(baseDataFolder);
            StartupLogger.Log("[MainWindow_Loaded] InitializeWebView2Async 완료");

            // IsNonClientRegionSupportEnabled는 WebView2 Runtime v117+의 ICoreWebView2Settings9 필요.
            // 구형 런타임에서는 InvalidCastException 발생 → WPF 수준 폴백 드래그 활성화.
            try
            {
                webView.CoreWebView2.Settings.IsNonClientRegionSupportEnabled = true;
                _useWpfDragFallback = false;
                StartupLogger.Log("[WebView2] IsNonClientRegionSupportEnabled=true (CSS app-region 드래그 사용)");
            }
            catch (InvalidCastException)
            {
                _useWpfDragFallback = true;
                StartupLogger.Log("[WebView2] 구형 런타임 감지 — WPF 폴백 드래그 활성화 (top 36px, 버튼 영역 제외)");
                System.Diagnostics.Trace.TraceWarning(
                    "[WebView2] IsNonClientRegionSupportEnabled 미지원 — WPF 폴백 드래그 사용");
            }
            catch (Exception ex)
            {
                _useWpfDragFallback = true;
                StartupLogger.LogException("[WebView2] NonClientRegion 설정 실패 — 폴백 활성화", ex);
            }

            // ── 이벤트 핸들러 (진단 로그 포함) ─────────────────
            webView.CoreWebView2.NavigationStarting += (s, args) =>
                StartupLogger.Log($"[WebView2] NavigationStarting: {args.Uri}");

            webView.CoreWebView2.NavigationCompleted += (s, args) =>
            {
                StartupLogger.Log($"[WebView2] NavigationCompleted: success={args.IsSuccess}, status={args.WebErrorStatus}, httpStatus={args.HttpStatusCode}");
                if (!args.IsSuccess)
                    Dispatcher.BeginInvoke(() =>
                        MessageBox.Show($"Navigation error: {args.WebErrorStatus}\nURL: {webView.Source}\n\n로그: {StartupLogger.LatestLogPath}",
                            "Navigation Error", MessageBoxButton.OK, MessageBoxImage.Warning));
            };

            webView.CoreWebView2.DOMContentLoaded += (s, args) =>
                StartupLogger.Log($"[WebView2] DOMContentLoaded: navigationId={args.NavigationId}");

            webView.CoreWebView2.ProcessFailed += (s, args) =>
            {
                StartupLogger.Log($"[WebView2] ProcessFailed: kind={args.ProcessFailedKind}, reason={args.Reason}, exitCode={args.ExitCode}");
                Dispatcher.BeginInvoke(() =>
                    MessageBox.Show($"WebView2 process failed: {args.ProcessFailedKind}\n\n로그: {StartupLogger.LatestLogPath}",
                        "Error", MessageBoxButton.OK, MessageBoxImage.Error));
            };

            // HTTP 404/5xx 등 리소스 오류 감지 (흰 화면 원인 진단용)
            webView.CoreWebView2.WebResourceResponseReceived += (s, args) =>
            {
                try
                {
                    var status = args.Response?.StatusCode ?? 0;
                    if (status >= 400)
                        StartupLogger.Log($"[WebView2] WebResource ERROR {status}: {args.Request?.Uri}");
                }
                catch { }
            };

            // JS 콘솔/예외 캡처 (DevTools Protocol) — 흰 화면 원인 중 React 런타임 오류 진단
            try
            {
                await webView.CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.enable", "{}");
                webView.CoreWebView2.GetDevToolsProtocolEventReceiver("Runtime.consoleAPICalled")
                    .DevToolsProtocolEventReceived += (s, args) =>
                        StartupLogger.Log($"[JS Console] {args.ParameterObjectAsJson}");
                webView.CoreWebView2.GetDevToolsProtocolEventReceiver("Runtime.exceptionThrown")
                    .DevToolsProtocolEventReceived += (s, args) =>
                        StartupLogger.Log($"[JS Exception] {args.ParameterObjectAsJson}");
                StartupLogger.Log("[WebView2] DevTools Protocol Runtime 핸들러 등록 완료");
            }
            catch (Exception ex)
            {
                StartupLogger.LogException("DevTools Protocol setup", ex);
            }

            // ── 세션 복원 (IPC 등록 전) ───────────────────────
            var restoredSession = await _sessionService.LoadAsync();
            if (restoredSession is not null)
                _aiManager.RestoreSessionData(restoredSession);

            // ── AI 관련 설정 복원 (OpenAI Base URL + SSL 검증 정책) ──
            try
            {
                var cfg = await _configService.LoadAsync();
                AiRequestLogger.LogSetting("config", "OpenAiBaseUrl", cfg.OpenAiBaseUrl);
                AiRequestLogger.LogSetting("config", "AllowInsecureSsl", cfg.AllowInsecureSsl.ToString());
                if (!string.IsNullOrWhiteSpace(cfg.OpenAiBaseUrl))
                    _aiManager.OpenAi.SetBaseUrl(cfg.OpenAiBaseUrl);
                if (cfg.AllowInsecureSsl)
                {
                    _aiManager.SetAllowInsecureSsl(true);
                    StartupLogger.Log("[Config] AllowInsecureSsl=true — 내부망 자체서명 인증서 허용 모드");
                    AiRequestLogger.LogInfo("[Config] AllowInsecureSsl=true 적용됨 — SSL 검증 비활성화");
                }
            }
            catch (Exception ex)
            {
                StartupLogger.LogException("Config 복원", ex);
                AiRequestLogger.LogException("Config 복원", ex);
            }

            // ── IPC 등록 ──────────────────────────────────────
            _ipcHandler = new IpcHandler(webView, _sshService, _configService, _keyManagerService, _aiManager, _sessionService, restoredSession, App.StartupConnection);
            _ipcHandler.Register();

            // ── 네비게이션 ────────────────────────────────────
            if (IsDev)
            {
                StartupLogger.Log("[Navigation] DEV 모드 → http://localhost:5173");
                webView.CoreWebView2.Navigate("http://localhost:5173");
            }
            else
            {
                var wwwroot = System.IO.Path.Combine(AppContext.BaseDirectory, "wwwroot");
                StartupLogger.Log($"[Navigation] RELEASE 모드, wwwroot={wwwroot}");
                StartupLogger.Log($"[Navigation] wwwroot 존재: {Directory.Exists(wwwroot)}");
                if (Directory.Exists(wwwroot))
                {
                    try
                    {
                        var files = Directory.GetFiles(wwwroot, "*", SearchOption.AllDirectories);
                        StartupLogger.Log($"[Navigation] wwwroot 파일 수: {files.Length}");
                        foreach (var f in files.Take(20))
                            StartupLogger.Log($"  - {f.Replace(wwwroot, "")}");
                    }
                    catch (Exception ex) { StartupLogger.LogException("wwwroot 목록", ex); }
                }

                // 런타임 crossorigin 제거 (1회성) — 빌드 시 이미 제거되지만 구버전 호환용 안전망.
                // Program Files 등 읽기 전용 위치면 write 실패하므로 조용히 무시.
                var indexPath = System.IO.Path.Combine(wwwroot, "index.html");
                if (File.Exists(indexPath))
                {
                    try
                    {
                        var html = await File.ReadAllTextAsync(indexPath, Encoding.UTF8);
                        if (html.Contains(" crossorigin"))
                        {
                            html = html.Replace(" crossorigin", "");
                            await File.WriteAllTextAsync(indexPath, html, Encoding.UTF8);
                        }
                    }
                    catch (UnauthorizedAccessException)
                    {
                        // 읽기 전용 설치 경로 — 빌드 시점 제거 처리로 동작해야 함
                        System.Diagnostics.Trace.TraceWarning(
                            "[WebView2] index.html 쓰기 권한 없음 — 빌드 시점에 crossorigin이 제거되었는지 확인 필요");
                    }
                    catch (Exception ex)
                    {
                        System.Diagnostics.Trace.TraceWarning($"[WebView2] index.html 수정 실패 (무시): {ex.Message}");
                    }
                }

                // 가상 호스트 등록 — index.html + JS/CSS 모두 서빙
                StartupLogger.Log("[Navigation] Virtual host 'app.local' 매핑");
                webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    "app.local", wwwroot,
                    CoreWebView2HostResourceAccessKind.Allow);

                StartupLogger.Log("[Navigation] Navigate → https://app.local/index.html");
                webView.CoreWebView2.Navigate("https://app.local/index.html");
            }
        }
        catch (Exception ex)
        {
            StartupLogger.LogException("MainWindow_Loaded", ex);
            MessageBox.Show($"WebView2 초기화 실패:\n{ex.Message}\n\n진단 로그:\n{StartupLogger.LatestLogPath}\n\n{ex.StackTrace}",
                "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    /// <summary>
    /// WebView2 초기화 — 0x8007139F 대응: 잠금 파일 정리 → 재시도 → 새 폴더 폴백
    /// </summary>
    private async Task InitializeWebView2Async(string baseDataFolder)
    {
        var userDataFolder = System.IO.Path.Combine(baseDataFolder, "WebView2");

        for (int attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                Directory.CreateDirectory(userDataFolder);
                var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
                await webView.EnsureCoreWebView2Async(env);
                return; // 성공
            }
            catch (System.Runtime.InteropServices.COMException ex) when (attempt < 2)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"WebView2 init attempt {attempt + 1} failed: {ex.HResult:X8} — {ex.Message}");

                if (attempt == 0)
                {
                    // 1차 실패: 잠금 파일 정리 후 재시도
                    CleanWebView2LockFiles(userDataFolder);
                    await Task.Delay(1500);
                }
                else
                {
                    // 2차 실패: 새 폴더로 폴백
                    userDataFolder = System.IO.Path.Combine(baseDataFolder, $"WebView2_{DateTime.Now:yyyyMMdd_HHmmss}");
                }
            }
        }

        // 3차 시도 — 예외 발생 시 상위에서 catch
        Directory.CreateDirectory(userDataFolder);
        var finalEnv = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
        await webView.EnsureCoreWebView2Async(finalEnv);
    }

    private static void CleanWebView2LockFiles(string folder)
    {
        try
        {
            var ebWebView = System.IO.Path.Combine(folder, "EBWebView");
            if (!Directory.Exists(ebWebView)) return;

            // SingletonLock, lockfile 등 WebView2 잠금 파일 제거
            foreach (var lockFile in Directory.GetFiles(ebWebView, "*lock*", SearchOption.TopDirectoryOnly))
            {
                try { File.Delete(lockFile); }
                catch { /* 잠금 해제 실패 — 무시 */ }
            }
            foreach (var lockFile in Directory.GetFiles(ebWebView, "*.tmp", SearchOption.TopDirectoryOnly))
            {
                try { File.Delete(lockFile); }
                catch { /* 무시 */ }
            }
        }
        catch { /* 폴더 접근 실패 — 무시 */ }
    }

    protected override void OnClosed(EventArgs e)
    {
        _sshService.Dispose();
        _aiManager.Dispose();
        webView.Dispose();
        base.OnClosed(e);
    }
}

public class RelayCommand : ICommand
{
    private readonly Action<object?> _execute;
    public RelayCommand(Action<object?> execute) => _execute = execute;
    public event EventHandler? CanExecuteChanged;
    public bool CanExecute(object? parameter) => true;
    public void Execute(object? parameter) => _execute(parameter);
}
