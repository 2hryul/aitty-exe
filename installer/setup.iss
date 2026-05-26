; =============================================================================
;  Aitty SSH Terminal - Inno Setup Script v0.4.2
;  Compile: ISCC.exe setup.iss
;
;  변경사항 (v0.4.2 — 만료 가드 + WebView2 우클릭 제한):
;    - 프로토타입 만료 가드: 2026-10-25 이후 첫 실행 시 안내 팝업 → 종료
;    - WebView2 컨텍스트 메뉴 제한: 복사/붙여넣기만 허용
;      (뒤로/새로 고침/다른 이름으로 저장/인쇄/기타 도구/검사 모두 제거)
;
;  변경사항 (v0.4.1 — 보안 취약점 일괄 패치 [S1 batch]):
;    - C-1/S-1: AiRequestLogger 민감 헤더 + URL ?key= 쿼리 마스킹
;    - H-1: AllowInsecureSsl 활성화 시 MITM 경고 confirm 다이얼로그
;    - H-2: SecurityRun 화이트리스트(check_u01..u99/fix_u01..u99) 단일화
;    - H-3: SshConnection.Password char[] 전환 + Dispose 0-overwrite
;    - M-1: DeserializePayload null/JsonException → ArgumentException 일관 wrap
;    - M-2: LogFetchFile 경로 sanitize (개행/shell metachar/백슬래시 차단)
;    - S-2: SSH connect 실패 시 conn.Dispose() — char[] Password 누수 차단
;    - 부수: IPC 에러 마스킹 완화(도메인 예외 메시지 전달) + Check Step 2 백엔드 상태 검증
;    - L-1(PBKDF2 100k→150k)은 파일 포맷 호환성 이슈로 deferred
;
;  변경사항 (v0.4.0 — Log 탭 logcheck.sh 기반 전면 개편): 이전 릴리즈 참조
; =============================================================================

#define AppName      "Aitty SSH Terminal"
#define AppVersion   "0.4.2"
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
