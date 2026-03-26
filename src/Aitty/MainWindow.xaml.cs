using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Controls;
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

        // 앱 종료 시 세션 자동 저장 (동기, 소용량)
        Closing += (_, _) =>
        {
            try { _sessionService.Save(_aiManager.GetSessionData()); }
            catch { /* 저장 실패가 종료를 막으면 안 됨 */ }
        };

        var exitBinding = new KeyBinding(new RelayCommand(_ => Close()), new KeyGesture(Key.Q, ModifierKeys.Control));
        InputBindings.Add(exitBinding);

        // [H-2] DevTools 메뉴: Debug 빌드에서만 동적으로 추가
#if DEBUG
        AddDebugMenuItems();
#endif
    }

#if DEBUG
    private void AddDebugMenuItems()
    {
        var devToolsItem = new MenuItem
        {
            Header = "Toggle _DevTools",
            InputGestureText = "F12"
        };
        devToolsItem.Click += MenuDevTools_Click;

        if (viewMenu is not null)
            viewMenu.Items.Add(devToolsItem);
    }

    private void MenuDevTools_Click(object sender, RoutedEventArgs e)
        => webView.CoreWebView2?.OpenDevToolsWindow();
#endif

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        try
        {
            // WebView2 user data → %LOCALAPPDATA%\Aitty\WebView2
            var baseDataFolder = System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Aitty");

            await InitializeWebView2Async(baseDataFolder);

            // ── 이벤트 핸들러 ─────────────────────────────────
            webView.CoreWebView2.NavigationCompleted += (s, args) =>
            {
                if (!args.IsSuccess)
                    Dispatcher.BeginInvoke(() =>
                        MessageBox.Show($"Navigation error: {args.WebErrorStatus}\nURL: {webView.Source}",
                            "Navigation Error", MessageBoxButton.OK, MessageBoxImage.Warning));
            };
            webView.CoreWebView2.ProcessFailed += (s, args) =>
                Dispatcher.BeginInvoke(() =>
                    MessageBox.Show($"WebView2 process failed: {args.ProcessFailedKind}",
                        "Error", MessageBoxButton.OK, MessageBoxImage.Error));

            // ── 세션 복원 (IPC 등록 전) ───────────────────────
            var restoredSession = await _sessionService.LoadAsync();
            if (restoredSession is not null)
                _aiManager.RestoreSessionData(restoredSession);

            // ── IPC 등록 ──────────────────────────────────────
            _ipcHandler = new IpcHandler(webView, _sshService, _configService, _keyManagerService, _aiManager, _sessionService, restoredSession);
            _ipcHandler.Register();

            // ── 네비게이션 ────────────────────────────────────
            if (IsDev)
            {
                webView.CoreWebView2.Navigate("http://localhost:5173");
            }
            else
            {
                var wwwroot = System.IO.Path.Combine(AppContext.BaseDirectory, "wwwroot");

                // 런타임에 crossorigin 속성 제거 (1회성)
                var indexPath = System.IO.Path.Combine(wwwroot, "index.html");
                if (File.Exists(indexPath))
                {
                    var html = await File.ReadAllTextAsync(indexPath, Encoding.UTF8);
                    if (html.Contains(" crossorigin"))
                    {
                        html = html.Replace(" crossorigin", "");
                        await File.WriteAllTextAsync(indexPath, html, Encoding.UTF8);
                    }
                }

                // 가상 호스트 등록 — index.html + JS/CSS 모두 서빙
                webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    "app.local", wwwroot,
                    CoreWebView2HostResourceAccessKind.Allow);

                webView.CoreWebView2.Navigate("https://app.local/index.html");
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show($"WebView2 초기화 실패:\n{ex.Message}\n\n{ex.StackTrace}",
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

    private void MenuExit_Click(object sender, RoutedEventArgs e) => Close();
    private void MenuReload_Click(object sender, RoutedEventArgs e) => webView.CoreWebView2?.Reload();

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
