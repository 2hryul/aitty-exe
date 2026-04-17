; =============================================================================
;  Aitty SSH Terminal - Inno Setup Script v0.2.9
;  Compile: ISCC.exe setup.iss
;
;  변경사항 (v0.2.9):
;    - Log 탭 신설: SSH 로그 파일/명령 수집 → AI 분석
;    - 프로바이더별 컨텍스트 예산 자동 검증 + 분할 분석 모달
;    - 위험명령어 프론트 경로 검증 + 에러 메시지 sanitize
;    - IPC 취소 신호가 로그 분석 루프에 전파
; =============================================================================

#define AppName      "Aitty SSH Terminal"
#define AppVersion   "0.2.9"
#define AppPublisher "Shinhan DS AX"
#define AppExeName   "Aitty.exe"
#define AppId        "{{8A3F2E1B-4C5D-4E6F-9A0B-1C2D3E4F5A6B}"
#define SourceDir    "..\dist\publish"
#define RedistDir    "redist"

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

; ── WebView2 Bootstrapper (번들) ──
Source: "{#RedistDir}\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: ignoreversion deleteafterinstall

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName}";  Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; WebView2 Runtime 설치 (미설치 시에만)
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Microsoft WebView2 Runtime 설치 중..."; Check: NeedWebView2; Flags: waituntilterminated

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

function NeedWebView2: Boolean;
begin
  Result := GetWebView2Version = '';
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
