using System.IO;
using System.Text;

namespace Aitty.Services;

/// <summary>
/// 앱 실행 시점 진단용 로거. 흰 화면, WebView2 오류 등 재현 환경에서 사용자가 로그 파일을
/// 쉽게 전달할 수 있도록 고정 경로에 기록.
///
/// 저장 위치:
///   - 최신: %LOCALAPPDATA%\Aitty\logs\latest.log (매 실행마다 덮어씀)
///   - 이력: %LOCALAPPDATA%\Aitty\logs\startup_YYYYMMDD_HHMMSS.log (타임스탬프별 보관)
/// </summary>
public static class StartupLogger
{
    private static readonly string LogDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Aitty", "logs");

    public static readonly string LatestLogPath = Path.Combine(LogDir, "latest.log");
    public static readonly string TimestampedLogPath = Path.Combine(LogDir, $"startup_{DateTime.Now:yyyyMMdd_HHmmss}.log");

    private static readonly object FileLock = new();
    private static bool _initialized;

    public static void Initialize()
    {
        if (_initialized) return;
        _initialized = true;
        try
        {
            Directory.CreateDirectory(LogDir);
            // latest.log는 매 실행마다 초기화
            if (File.Exists(LatestLogPath))
                File.Delete(LatestLogPath);
            Log("=== Aitty Startup Log ===");
            Log($"Log file: {LatestLogPath}");
            Log($"Timestamped copy: {TimestampedLogPath}");
            Log($"Aitty Version: {System.Reflection.Assembly.GetExecutingAssembly().GetName().Version}");
            Log($"OS Version: {Environment.OSVersion}");
            Log($"64-bit Process: {Environment.Is64BitProcess}");
            Log($"CLR Version: {Environment.Version}");
            Log($"BaseDirectory: {AppContext.BaseDirectory}");
            Log($"ProcessPath: {Environment.ProcessPath}");
            Log($"CommandLine: {Environment.CommandLine}");
            Log($"UserName: {Environment.UserName}");
            Log($"MachineName: {Environment.MachineName}");
            Log(new string('-', 60));
        }
        catch (Exception ex)
        {
            System.Diagnostics.Trace.TraceError($"[StartupLogger] Init failed: {ex.Message}");
        }
    }

    public static void Log(string message)
    {
        var line = $"[{DateTime.Now:HH:mm:ss.fff}] {message}";
        try
        {
            lock (FileLock)
            {
                File.AppendAllText(LatestLogPath, line + Environment.NewLine, Encoding.UTF8);
                File.AppendAllText(TimestampedLogPath, line + Environment.NewLine, Encoding.UTF8);
            }
        }
        catch { /* 로깅 실패로 앱을 막지 않음 */ }
        System.Diagnostics.Trace.WriteLine(line);
    }

    public static void LogException(string context, Exception ex)
    {
        Log($"[EXCEPTION] {context}: {ex.GetType().Name}: {ex.Message}");
        if (!string.IsNullOrEmpty(ex.StackTrace))
            Log($"  StackTrace: {ex.StackTrace}");
        if (ex.InnerException is not null)
            LogException($"{context} [Inner]", ex.InnerException);
    }

    /// <summary>외부(탐색기, 메시지박스 등)에 전달할 수 있는 로그 경로.</summary>
    public static string GetUserFriendlyPath() => LatestLogPath;
}
