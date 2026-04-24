; =============================================================================
;  Aitty SSH Terminal - Inno Setup Script v0.3.0
;  Compile: ISCC.exe setup.iss
;
;  변경사항 (v0.3.0):
;    - WebView2 Runtime 전체 번들 (오프라인 설치 지원, 186MB)
;    - 구형 WebView2 Runtime(v117 미만) 자동 업그레이드
;    - WebView2 InvalidCastException 내성 (MainWindow.xaml.cs)
;    - PuTTY 호환 CLI 인자 지원 (HiWare 연동)
;    - OpenAI 호환 커스텀 엔드포인트 (Shinhan Hands API Gateway)
; =============================================================================

#define AppName      "Aitty SSH Terminal"
#define AppVersion   "0.3.0"
#define AppPublisher "Shinhan DS AX"
#define AppExeName   "Aitty.exe"
#define AppId        "{{8A3F2E1B-4C5D-4E6F-9A0B-1C2D3E4F5A6B}"
#define SourceDir    "..\dist\publish"
#define RedistDir    "redist"
; WebView2 최소 필요 버전 (IsNonClientRegionSupportEnabled 등 최신 API 지원)
#define WebView2MinMajor "117"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL=https://github.com/2hryul2/aitty2
AppSupportURL=https://github.com/2hryul2/aitty2/issues
AppUpdatesURL=https://github.com/2hryul2/aitty2/releases

; ── 설치 경로: 사용자 선택 가능 ──
DefaultDirName={autopf}\Aitty
DisableDirPage=no
UsePreviousAppDir=yes

; ── 권한: 관리자/일반 사용자 선택 ──
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\dist\setup
OutputBaseFilename=Aitty_Setup_v{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
WizardSizePercent=120
ShowLanguageDialog=no
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}
VersionInfoVersion={#AppVersion}
VersionInfoDescription={#AppName} Installer
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
CloseApplications=yes
CloseApplicationsFilter=*Aitty*
RestartApplications=no

; 최소 OS: Windows 10 1903 (18362)
MinVersion=10.0.18362

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; ── 앱 파일 ──
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "install.ps1,uninstall.ps1,README.txt,*.pdb,*.xml"

; ── WebView2 Runtime (전체 번들, 오프라인 설치 가능, 186MB) ──
Source: "{#RedistDir}\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; DestDir: "{tmp}"; Flags: ignoreversion deleteafterinstall

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName}";  Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; WebView2 Runtime 설치/업그레이드 (미설치 또는 v117 미만 구형 버전)
Filename: "{tmp}\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; Parameters: "/silent /install"; StatusMsg: "Microsoft WebView2 Runtime 설치/업그레이드 중... (약 1~2분 소요)"; Check: NeedWebView2; Flags: waituntilterminated

; 설치 완료 후 앱 실행 (선택)
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(AppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent shellexec

[UninstallRun]
; 제거 전 프로세스 종료
Filename: "taskkill.exe"; Parameters: "/F /IM Aitty.exe"; Flags: runhidden; RunOnceId: "KillAitty"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
// ── WebView2 Runtime 체크 ──────────────────────────────────────────────────
const
  WV2_GUID = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function GetWebView2Version: string;
var
  version: string;
begin
  Result := '';
  // Machine-wide (64-bit)
  if RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + WV2_GUID, 'pv', version) then
    if (version <> '') and (version <> '0.0.0.0') then begin Result := version; Exit; end;
  // Machine-wide (32-bit)
  if RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WV2_GUID, 'pv', version) then
    if (version <> '') and (version <> '0.0.0.0') then begin Result := version; Exit; end;
  // Per-user
  if RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WV2_GUID, 'pv', version) then
    if (version <> '') and (version <> '0.0.0.0') then begin Result := version; Exit; end;
end;

// 버전 문자열의 첫 숫자 추출 (예: "117.0.2045.47" → 117)
function GetMajorVersion(ver: string): Integer;
var
  dotPos: Integer;
  majorStr: string;
begin
  Result := 0;
  if ver = '' then Exit;
  dotPos := Pos('.', ver);
  if dotPos > 0 then
    majorStr := Copy(ver, 1, dotPos - 1)
  else
    majorStr := ver;
  try
    Result := StrToInt(majorStr);
  except
    Result := 0;
  end;
end;

// WebView2 Runtime 재설치 필요 여부: 미설치 또는 WebView2MinMajor 미만
function NeedWebView2: Boolean;
var
  ver: string;
  major: Integer;
begin
  ver := GetWebView2Version;
  if ver = '' then begin
    Result := True;  // 미설치 → 설치 필요
    Exit;
  end;
  major := GetMajorVersion(ver);
  // 구형 버전(v117 미만)이면 업그레이드 설치
  Result := major < {#WebView2MinMajor};
end;

// ── 설치 전 체크 ───────────────────────────────────────────────────────────
function InitializeSetup: Boolean;
begin
  Result := True;

  // Windows 버전 체크 (18362 = Win10 1903)
  if not (GetWindowsVersion >= $0A002E22) then begin
    MsgBox('Windows 10 버전 1903 이상이 필요합니다.' + #13#10 + '현재 Windows를 업데이트해 주세요.', mbError, MB_OK);
    Result := False;
    Exit;
  end;
end;

// ── 설치 완료 메시지 ──────────────────────────────────────────────────────
procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then begin
    WizardForm.FinishedLabel.Caption :=
      '{#AppName}' + ' v{#AppVersion}' + ' 설치가 완료되었습니다!' + #13#10 + #13#10 +
      '설치 경로: ' + ExpandConstant('{app}') + #13#10 + #13#10 +
      '아래 체크박스를 선택하여 지금 바로 실행할 수 있습니다.';
  end;
end;
