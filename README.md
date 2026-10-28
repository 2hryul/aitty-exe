# Aitty — SSH + AI Terminal (Windows)

사내 시스템 엔지니어용 SSH + AI 통합 터미널입니다. PuTTY 호환 CLI, 4-Provider AI(Ollama / OpenAI / Claude / Gemini), 대용량 로그 자동 분할 분석, 위험 명령 자동 차단을 한 화면에서 제공합니다.

이 저장소는 **실행파일(Windows 설치 프로그램) 배포 전용**입니다. 소스 코드는 포함되어 있지 않습니다.

## 다운로드

최신 버전: **[Releases → Latest](https://github.com/2hryul/aitty-exe/releases/latest)**

| 파일 | 용도 | WebView2 Runtime 처리 |
| --- | --- | --- |
| `Aitty_Setup_vX.Y.Z_online.exe` | 인터넷이 되는 PC (일반 사무망) | 설치 중 Microsoft CDN에서 자동 다운로드 (약 190 MB) |
| `Aitty_Setup_vX.Y.Z_offline.exe` | 격리망 / USB 배포 / 신규 PC 일괄 셋업 | 전체 런타임 동봉 — 인터넷 불필요 |
| `checksums.txt` | SHA-256 무결성 검증 | — |

잘 모르겠으면 **offline** 버전을 받으세요. 어디서든 설치됩니다.

## 설치

1. 위 표에서 환경에 맞는 설치 파일을 내려받습니다.
2. (선택) 해시를 확인합니다.
   ```powershell
   Get-FileHash .\Aitty_Setup_vX.Y.Z_offline.exe -Algorithm SHA256
   ```
3. 실행 후 안내에 따라 설치합니다. 설치 경로와 관리자/일반 사용자 설치를 선택할 수 있습니다.
4. 코드 서명이 없어 Windows SmartScreen 경고가 뜰 수 있습니다. **추가 정보 → 실행**을 누르세요.

### 시스템 요구사항

- Windows 10 1903 (빌드 18362) 이상, x64
- 디스크 여유 공간 약 300 MB
- .NET 런타임 별도 설치 불필요 (self-contained)

### Online 설치 중 WebView2 자동 설치가 실패할 때

방화벽/프록시로 다운로드가 막히면 다른 PC에서 [WebView2 Evergreen Standalone Installer (x64)](https://developer.microsoft.com/microsoft-edge/webview2/#download)를 받아 대상 PC에서 관리자 권한으로 실행한 뒤 Aitty를 다시 실행하세요. 또는 offline 설치 파일을 사용하세요.

## 베타 안내

- 베타 빌드이며 **만료일이 지나면 앱과 설치 프로그램이 실행되지 않습니다.** 만료일은 각 릴리스 노트에 적혀 있습니다. 만료 후에는 최신 릴리스를 다시 설치하세요.
- 운영 환경 사용은 자체 책임입니다.

## 문의 · 버그 신고

[Issues](https://github.com/2hryul/aitty-exe/issues)에 버전, Windows 빌드, 설치 종류(online/offline), 재현 절차를 적어 주세요.

## 라이선스

사내 전용 (외부 배포 제한).
