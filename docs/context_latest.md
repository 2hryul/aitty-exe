# Aitty — 마지막 작업 컨텍스트

> 업데이트: 2026-03-25
> 브랜치: master / 최신 커밋: `0f34507` (v0.2.5) + 미커밋 v0.2.6 작업
> 로컬 경로: `D:\SOURCE\aitty_v3`

---

## 프로젝트 기본 정보

| 항목 | 내용 |
|------|------|
| **앱명** | Aitty SSH AI Terminal |
| **버전** | 0.2.6 (미커밋) |
| **경로** | `D:\SOURCE\aitty_v3` |
| **GitHub** | https://github.com/2hryul2/aitty2 |
| **스택** | WPF(.NET 8) + WebView2 + React 19 / TypeScript 5.9 (Vite 7) |

---

## 빌드 방법

```bash
# ⚠️ 중요: SkipReactBuild 사용 시 wwwroot 수동 동기화 필요!
# Step 1: React 빌드
cd webapp && npm run build

# Step 2: wwwroot 동기화 (SkipReactBuild 사용 시 자동 안 됨)
cp -r webapp/dist/* src/Aitty/wwwroot/

# Step 3: C# 빌드 (PublishSingleFile 필수)
dotnet publish src/Aitty/Aitty.csproj -c Release -r win-x64 \
  --self-contained true -p:PublishSingleFile=true \
  -p:SkipReactBuild=true -o dist

# 풀 빌드 (Step 1-3 자동)
dotnet publish src/Aitty/Aitty.csproj -c Release -r win-x64 \
  --self-contained true -p:PublishSingleFile=true -o dist

# 인스톨러
"C:\...\Inno Setup 6\ISCC.exe" "D:\SOURCE\aitty_v3\installer\setup.iss"
```

---

## 버전 히스토리

| 버전 | 날짜 | 커밋 | 주요 변경 |
|------|------|------|----------|
| **v0.2.6** | 2026-03-25 | 미커밋 | 🛡보안점검탭, WebView2복구, UI Freeze수정, 위험명령차단 |
| v0.2.5 | 2026-03-23 | `0f34507` | Chat UI, WPF 블로킹 수정, ThinkingIndicator |
| v0.2.4 | 2026-03-23 | — | P3 항목 (SSH 키 Browse, CSS 통합, 버전 정합성) |
| v0.2.3 | 2026-03-22 | `7a6a370` | 코드 품질 26항목 + PublishSingleFile 수정 |
| v0.2.2 | 2026-03-20 | `596792f` | 세션 저장/복원, SSH 안정성, 회색 화면 수정 |

---

## 핵심 아키텍처

```
WPF MainWindow
  └─ WebView2 → React App (https://app.local/)
       ├─ SSHTerminal (xterm.js)
       └─ AITerminal (💬Chat / 💻CLI / 🛡보안점검)
            └─ IPC Bridge (JSON ↔ IpcHandler.cs)
                 ├─ SshService          (_streamLock, _bufferLock)
                 ├─ AiServiceManager    (Ollama/Claude/OpenAI/Gemini)
                 ├─ SessionService      (조건부 저장 — saveApiLog 연동)
                 ├─ KeyManagerService   (SSH 키 + Browse 다이얼로그)
                 ├─ SecureApiKeyStore   (DPAPI 암호화)
                 └─ SecurityService     (🆕 SCP 업로드 + check/fix 실행)
```

---

## 주요 파일

| 파일 | 역할 |
|------|------|
| `src/Aitty/Ipc/IpcHandler.cs` | IPC 라우팅 — `InvokeAsync(Background)` + `lastChunkOp` 대기 |
| `src/Aitty/MainWindow.xaml.cs` | WebView2 3단계 복구 (`InitializeWebView2Async`) |
| `src/Aitty/Services/SshService.cs` | SSH 클라이언트 (_streamLock + _bufferLock) |
| `src/Aitty/Services/SessionService.cs` | AI 세션 Save(조건부) / LoadAsync() |
| `src/Aitty/Services/AiServiceManager.cs` | 멀티 프로바이더 관리 |
| `src/Aitty/Services/SecureApiKeyStore.cs` | DPAPI 기반 API Key 암호화 |
| `webapp/src/hooks/useAITerminal.ts` | AI 터미널 상태머신 (청크 throttle 80ms) |
| `webapp/src/components/AITerminal.tsx` | 3탭 전환 (Chat/CLI/보안점검) |
| `webapp/src/components/ChatPanel.tsx` | 채팅 (언어 태그 없어도 CodeBlock 렌더링) |
| `webapp/src/components/CodeBlock.tsx` | Copy/Run 첫줄만 + isShellLang 확장 |
| `webapp/src/components/SecurityPanel.tsx` | 🆕 보안점검 탭 UI |
| `webapp/src/components/SSHTerminal.tsx` | SSH 터미널 (적응형 폴링, 포커스 복원) |
| `webapp/src/utils/commandSafety.ts` | 위험 명령어 3단계 판정 (🔴15 / 🟠12 / 🟡5) |
| `webapp/src/bridge/ipcBridge.ts` | IPC 타입 정의 + security IPC 4종 |

---

## 알려진 이슈 / 주의사항

| 항목 | 내용 |
|------|------|
| **UI Freeze** | Background 우선순위 적용 + lastChunkOp 대기 — 완전 해소 관찰 필요 |
| **WebView2 0x8007139F** | 3단계 복구 로직 대응 완료 |
| **wwwroot 동기화** | `SkipReactBuild=true` 시 `cp -r webapp/dist/* src/Aitty/wwwroot/` 필수 |
| **CS0067** | `RelayCommand.CanExecuteChanged` 미사용 경고 — 무해 |
| **번들 사이즈** | JS 1.3MB → lazy import 최적화 가능 |
| **DPAPI** | 앱 재시작 시 API Key 재입력 필요 (per-session Entropy) |
| **xterm-addon-unicode11** | 영구 금지 — WebView2 검은 화면 유발 |
| **ISCC 경로** | `C:\Users\2hryu\AppData\Local\Programs\Inno Setup 6\ISCC.exe` |

---

## 미완료 항목 (v0.2.7 후보)

| 우선순위 | 항목 |
|---------|------|
| 🔴 P1 | 보안점검 탭 완성 — SCP 업로드 + check/fix 실행 + 결과 파싱 |
| 🔴 P1 | "응답 없음" 완전 해소 — C# 청크 배치 전송 최적화 |
| 🟠 P2 | Ready 상태 정확화 (API키 없으면 "Offline") |
| 🟠 P2 | 번들 사이즈 최적화 (1.3MB → lazy import) |
| 🟡 P3 | Chat 내보내기 (Markdown/PDF) |
| 🟡 P3 | CS0067 경고 제거 |

---

## Provider 설정

| ID | 표시명 | Endpoint |
|----|--------|---------|
| `ollama` | API 접속 | 사용자 입력 (localStorage 저장) |
| `gemini` | Google Gemini | https://generativelanguage.googleapis.com |
| `claude` | Anthropic Claude | https://api.anthropic.com |
| `openai` | OpenAI ChatGPT | https://api.openai.com |
