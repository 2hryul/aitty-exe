# =============================================================================
#  Aitty SSH Terminal — Windows Installer v0.2.5
#  사용법: 탐색기에서 우클릭 → "PowerShell로 실행"
#         또는: powershell -ExecutionPolicy Bypass -File install.ps1
#
#  설치 경로: %LocalAppData%\Aitty  (관리자 권한 불필요)
#  바로가기:  바탕화면 + 시작 메뉴
# =============================================================================

$ErrorActionPreference = "Stop"

$AppName     = "Aitty SSH Terminal"
$AppVersion  = "0.2.5"
$InstallDir  = Join-Path $env:LOCALAPPDATA "Aitty"
$SourceDir   = $PSScriptRoot
$ExeName     = "Aitty.exe"
$ExePath     = Join-Path $InstallDir $ExeName
$ShortcutLnk = "$AppName.lnk"

# WebView2 Runtime GUID
$WV2Guid     = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
$WV2Url      = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
$WV2Tmp      = Join-Path $env:TEMP "MicrosoftEdgeWebview2Setup.exe"

# ── 헬퍼 함수 ──────────────────────────────────────────────────────────────
function Header($msg) {
    Write-Host ""
    Write-Host "  $msg" -ForegroundColor Cyan
    Write-Host "  $('─' * $msg.Length)" -ForegroundColor DarkCyan
}
function OK($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function INFO($msg) { Write-Host "  [..] $msg" -ForegroundColor Yellow }
function FAIL($msg) { Write-Host "  [!!] $msg" -ForegroundColor Red; Read-Host "`n  Enter를 누르면 종료합니다"; exit 1 }

# ── 배너 ───────────────────────────────────────────────────────────────────
Clear-Host
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor Magenta
Write-Host "  ║    Aitty SSH Terminal  v$AppVersion         ║" -ForegroundColor Magenta
Write-Host "  ║    Windows Installer                     ║" -ForegroundColor Magenta
Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor Magenta
Write-Host ""
Write-Host "  설치 경로: $InstallDir" -ForegroundColor Gray
Write-Host ""

# ── 0. 소스 확인 ───────────────────────────────────────────────────────────
Header "0/4  설치 파일 확인"

if (-not (Test-Path (Join-Path $SourceDir $ExeName))) {
    FAIL "$ExeName 을 찾을 수 없습니다.`n  install.ps1이 Aitty.exe와 같은 폴더에 있어야 합니다."
}
OK "$ExeName 확인"

$wwwroot = Join-Path $SourceDir "wwwroot"
if (-not (Test-Path $wwwroot)) {
    FAIL "wwwroot 폴더를 찾을 수 없습니다."
}
OK "wwwroot 확인"

# ── 1. WebView2 Runtime 확인 ───────────────────────────────────────────────
Header "1/4  WebView2 Runtime 확인"

function Get-WebView2Version {
    $keys = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$WV2Guid",
        "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$WV2Guid",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$WV2Guid"
    )
    foreach ($key in $keys) {
        $val = (Get-ItemProperty $key -ErrorAction SilentlyContinue)?.pv
        if ($val -and $val -ne "0.0.0.0") { return $val }
    }
    return $null
}

$wv2Ver = Get-WebView2Version
if ($wv2Ver) {
    OK "WebView2 Runtime 설치 확인 (버전: $wv2Ver)"
}
else {
    INFO "WebView2 Runtime이 설치되어 있지 않습니다."
    INFO "지금 자동으로 다운로드 및 설치합니다..."
    Write-Host ""

    # 로컬 bootstrapper가 있으면 사용 (오프라인 배포용)
    $localBootstrapper = Join-Path $SourceDir "setup\MicrosoftEdgeWebview2Setup.exe"
    if (Test-Path $localBootstrapper) {
        INFO "로컬 bootstrapper 사용: $localBootstrapper"
        $installer = $localBootstrapper
    }
    else {
        INFO "다운로드 중: $WV2Url"
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $WV2Url -OutFile $WV2Tmp -UseBasicParsing
            $installer = $WV2Tmp
        }
        catch {
            FAIL "WebView2 Runtime 다운로드 실패.`n  수동 설치 링크: $WV2Url`n  설치 후 다시 실행해 주세요.`n  오류: $_"
        }
    }

    INFO "WebView2 Runtime 설치 중..."
    try {
        $proc = Start-Process $installer -ArgumentList "/silent /install" -Wait -PassThru
        if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
            FAIL "WebView2 설치 실패 (ExitCode: $($proc.ExitCode))`n  수동 설치 링크: $WV2Url"
        }
    }
    catch {
        FAIL "WebView2 설치 중 오류 발생: $_`n  수동 설치: $WV2Url"
    }

    # 재확인
    $wv2Ver = Get-WebView2Version
    if ($wv2Ver) {
        OK "WebView2 Runtime 설치 완료 (버전: $wv2Ver)"
    }
    else {
        FAIL "WebView2 설치 후에도 인식되지 않습니다.`n  재부팅 후 다시 시도하거나, 수동 설치: $WV2Url"
    }

    # 임시 파일 정리
    if (Test-Path $WV2Tmp) { Remove-Item $WV2Tmp -Force }
}

# ── 2. 기존 앱 종료 ────────────────────────────────────────────────────────
Header "2/4  기존 설치 처리"

$running = Get-Process -Name "Aitty" -ErrorAction SilentlyContinue
if ($running) {
    INFO "실행 중인 Aitty를 종료합니다..."
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 1500
    OK "Aitty 프로세스 종료"
}
else {
    OK "실행 중인 프로세스 없음"
}

# 기존 설치 폴더 처리
if (Test-Path $InstallDir) {
    INFO "기존 설치 파일 제거 중..."
    # WebView2 사용자 데이터는 보존 (캐시, 설정)
    Get-ChildItem $InstallDir -Exclude "WebView2" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    OK "기존 파일 정리 완료 (WebView2 캐시 보존)"
}
else {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    OK "설치 디렉토리 생성: $InstallDir"
}

# ── 3. 파일 복사 ───────────────────────────────────────────────────────────
Header "3/4  파일 설치"

# 복사할 항목 (install/uninstall 스크립트 제외)
$excludeItems = @("install.ps1", "uninstall.ps1", "setup")

INFO "파일 복사 중..."
Get-ChildItem $SourceDir | Where-Object { $_.Name -notin $excludeItems } | ForEach-Object {
    $dest = Join-Path $InstallDir $_.Name
    if ($_.PSIsContainer) {
        Copy-Item $_.FullName $dest -Recurse -Force
    }
    else {
        Copy-Item $_.FullName $dest -Force
    }
}

# uninstall.ps1도 설치 폴더에 복사 (제거용)
Copy-Item (Join-Path $SourceDir "uninstall.ps1") (Join-Path $InstallDir "uninstall.ps1") -Force

$fileCount = (Get-ChildItem $InstallDir -Recurse -File).Count
$sizeMB    = [math]::Round((Get-ChildItem $InstallDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
OK "파일 설치 완료 ($fileCount 개, $sizeMB MB)"

# ── 4. 바로가기 생성 ──────────────────────────────────────────────────────
Header "4/4  바로가기 생성"

$WshShell = New-Object -ComObject WScript.Shell

# 바탕화면 바로가기
$Desktop  = $WshShell.SpecialFolders("Desktop")
$Lnk      = $WshShell.CreateShortcut("$Desktop\$ShortcutLnk")
$Lnk.TargetPath       = $ExePath
$Lnk.WorkingDirectory = $InstallDir
$Lnk.IconLocation     = "$ExePath,0"
$Lnk.Description      = "$AppName v$AppVersion"
$Lnk.Save()
OK "바탕화면 바로가기 생성"

# 시작 메뉴 바로가기
$StartMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Aitty"
New-Item -ItemType Directory -Force -Path $StartMenu | Out-Null

$Lnk2 = $WshShell.CreateShortcut("$StartMenu\$ShortcutLnk")
$Lnk2.TargetPath       = $ExePath
$Lnk2.WorkingDirectory = $InstallDir
$Lnk2.IconLocation     = "$ExePath,0"
$Lnk2.Description      = "$AppName v$AppVersion"
$Lnk2.Save()
OK "시작 메뉴 바로가기 생성"

# 제어판 앱 목록 등록 (Add/Remove Programs)
$RegPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Aitty"
New-Item -Path $RegPath -Force | Out-Null
Set-ItemProperty $RegPath "DisplayName"      -Value $AppName
Set-ItemProperty $RegPath "DisplayVersion"   -Value $AppVersion
Set-ItemProperty $RegPath "Publisher"        -Value "Shinhan DS AX"
Set-ItemProperty $RegPath "InstallLocation"  -Value $InstallDir
Set-ItemProperty $RegPath "UninstallString"  -Value "powershell.exe -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`""
Set-ItemProperty $RegPath "DisplayIcon"      -Value "$ExePath,0"
Set-ItemProperty $RegPath "NoModify"         -Value 1 -Type DWord
Set-ItemProperty $RegPath "NoRepair"         -Value 1 -Type DWord
OK "제어판 앱 목록 등록"

# ── 완료 ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║       설치가 완료되었습니다!              ║" -ForegroundColor Green
Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  실행 위치: $ExePath" -ForegroundColor White
Write-Host "  바탕화면 바로가기: $AppName" -ForegroundColor White
Write-Host ""

$launch = Read-Host "  지금 바로 실행하시겠습니까? (Y/N)"
if ($launch -match "^[Yy]") {
    Start-Process $ExePath -WorkingDirectory $InstallDir
}

Write-Host ""
