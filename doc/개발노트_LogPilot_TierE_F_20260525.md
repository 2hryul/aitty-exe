# 개발노트 — LogPilot Tier 1 (Step E) + SSH cwd 추적 (Step F) + AI 빈 응답 진단

**작업 기간:** 2026-05-24 ~ 2026-05-25
**Architect/Owner 협업 세션. Builder/Reviewer 직접 호출.**
**원격 푸시:** `bf99d79..c542a5f` → https://github.com/2hryul2/aitty2.git (master)

---

## 2026-05-24 11:00 작업 내역 — LogPilot 결과 패널 스크롤 fix

**작업 내용:**
- LogPilot 분석 결과가 길어질 때 결과 패널 하단(코드블록/다음 액션/원본 로그)이 잘려 보이고 끝까지 도달 못 하던 결함 진단.
- F12 진단으로 빌드 캐시 의심 식별. Release publish + WPF 재실행으로 새 빌드 반영 확인.
- `.logpilot-tab { overflow:hidden }` + `.logpilot-result { flex:1 1 auto; min-height:240px; max-height:100%; overflow-y:auto; ::-webkit-scrollbar 가시화 }`로 자체 내부 스크롤 + flex chain 안전망.

**변경 파일:**
- `webapp/src/styles/logpilot.css` (스크롤 보강만)

**결정 사항:**
- 입력 영역(자연어 textarea + 시나리오 칩)은 상단 고정, 결과 패널만 자체 스크롤
- `min-height:240px` 안전망으로 flex chain 실패 시에도 최소 영역 보장
- WebView2 dist 캐시 갱신은 항상 dotnet publish 통해서만 (webapp만 빌드는 의미 없음)

**이슈/특이사항:**
- 처음 F12 진단으로 result.ov가 옛 'hidden'인 것 확인 — 새 CSS가 WebView2에 적용 안 된 상태였음
- dotnet publish로 `bin/Release/.../wwwroot` 자동 동기화 확인

---

## 2026-05-24 14:00 작업 내역 — Step E: LogPilot Tier 1 사용자 친화 4종 일괄

**작업 내용 (Builder DE-1 ~ DE-7):**
- **#2 결과 마크다운 내보내기** — 결과 패널 헤더 우측 `📋 복사` / `📥 .md 저장` / `📨 메일(subject only + 본문 클립보드)` 3버튼. `serializeAsMarkdown(parsed, meta?)` 유틸 신규.
- **#3 자연어 textarea placeholder 5초 회전** — `LOGPILOT_PLACEHOLDER_EXAMPLES` 10개 정적 배열 + ▾ 채움 버튼.
- **#5 안전 명령 일괄 실행** — `actionsNow` 섹션 끝 "🟢 안전 N개 일괄 실행" 버튼 (safe≥2). 200ms 간격 순차 invoke + ✅/⏳ 인디케이터. `filterSafeActions` 유틸 신규.
- **#6 청크 분석 진행률 + ETA + 부분 결과 스트리밍** — `logs.analyzeChunked` 통일. `progress: {index, total, bytes, etaSec}` state. 누적 평균 청크 시간 기반 ETA. 백엔드 변경 0(기존 `logs:chunk-progress` 이벤트 활용).

**Reviewer Should-fix 3건 (Architect 직접 픽스):**
- **S-1** `logpilotResponseParser.ts:233` — `extractVerdictBody` 매칭 실패 시 빈 문자열 반환 (라벨 중복 회피)
- **S-2** `LogPilotResultPanel.tsx:138-152` — mailto subject 80자 안전 상한 + ellipsis
- **S-3** `useLogPilot.ts` — `chunkDurationsRef` dead write 5곳 모두 제거

**변경 파일 (Step E 8 + 스크롤 fix 1 + Step C/D 누적분 묶음으로 1커밋 통합 — 24 파일, +4278 / -542):**
- 신규: `LogPilot*.tsx` 6 + `useLogPilot.ts` + `logpilotScenarios.ts` + `logpilotResponseParser.ts(+test)` + `commandRiskLevel.ts(+test)` + `logpilot.css` + `checkReadable.test.ts` + `posixPath`는 Step F
- 수정: `IpcHandler.cs` / `ipcBridge.ts` / `App.tsx` / `AITerminal.tsx` / `IconSidebar.tsx` 등
- 삭제: `LogTab.tsx` (LogPilot으로 대체)

**결정 사항:**
- Step C/D/스크롤fix/E/Should-fix 모두 한 커밋(`4107b18`) 통합 — git 구조상 신규 파일들이 untracked였던 누적 변경이라 step 분리 불가
- 백엔드 변경 0줄 유지 — `_collectingOutput` 회귀 검증은 Step F 이후
- VERSION 미증가 — UX 보강이 주이고 외부 사용자 영향 없음

**미완료/다음 작업:**
- 수동 통합 검증 (WebView2 + 실서버 SSH) — Owner 환경 필요
- Flag DE-D 단일 청크 chunked 시 백엔드 종합 요약 중복 LLM call 실측 — 별도 step

**이슈/특이사항:**
- vitest 161/161 (Step E 신규 7 + S-1 회귀 방지 1 추가)
- Builder가 brief 기대치 169 → 실제 174로 분해 (8 카테고리 → 13 atomic `it()`)

---

## 2026-05-25 09:00 작업 내역 — Step F: SSH 셸 cwd 추적 (A+B 하이브리드)

**작업 내용:**
- LogPilot "SSH 현재 경로" 표시가 사용자의 인터랙티브 `cd`를 반영 못하던 결함 진단 — `ssh.pwd()`가 exec 채널이라 인터랙티브 shell cwd 무관.
- **A (Primary):** xterm `onData` 키스트로크 라인 buffer로 `cd` 명령 가로채기. 패턴 5종 매칭 (없음/-/~/절대/상대). `[$\`]` 포함은 추적 무시.
- **B (Optional):** xterm OSC 7 시퀀스 핸들러 등록. 서버 PROMPT_COMMAND 활성 시 100% 정확.
- **Fallback:** 추적 실패 시 기존 `ssh:pwd` (수동 🔄 + 초기 시드).

**Reviewer Must-fix 1건 (Architect 직접 픽스):**
- **M1** `useSshCwd.ts:222` — Ctrl+W(`\x17`) bash readline 마지막 단어 삭제 처리 추가 (SSHTerminal:387 패턴 미러). `cd /etc<Ctrl+W>/var<Enter>` false-positive 회피.

**Reviewer S3 (Architect 픽스):**
- LogPilotTab tooltip 문구에 "방향키/history recall된 cd, 셸 함수/alias cd는 추적 안 됨 — 🔄로 강제 동기화" 한 줄 추가

**변경 파일 (9 파일, +581 / -31):**
- 신규: `posixPath.ts(+test)`, `useSshCwd.ts`
- 수정: `App.tsx`, `SSHTerminal.tsx`, `AITerminal.tsx`, `LogPilotTab.tsx`, `useLogPilot.ts(deprecation 주석)`, `logpilot.css`

**결정 사항 (E1 deviation 채택):**
- 브리프는 `useAITerminal`이 cwd state 관리 — 실제로는 SSHTerminal이 sibling 컴포넌트라 onData 가로채기 불가
- **App.tsx 리프트** 방식 채택 — `useSshCwd` 신규 훅을 App.tsx에서 단일 인스턴스화 → SSHTerminal(어태치) + AITerminal/LogPilotTab(표시)에 분배
- brief spirit(프론트 단일 source, 백엔드 0, IPC 0) 보존. Reviewer 합리적 판단.

**Flag 처리:**
- DF-A: cd 인자 따옴표 양끝 제거 (`s.replace(/^["']|["']$/g, '')`)
- DF-B: 초기 시드 실패 시 cwd state=null. 사용자 cd 첫 입력 후 추적 시작
- DF-D: OSC 7 콜백 항상 `true` 반환 (단일 핸들러)
- DF-E: 라인 buffer 4096자 상한
- DF-F: Backspace/Ctrl+U/Ctrl+C/ESC 모두 처리

**이슈/특이사항:**
- vitest 174/174 (Step E 161 + posixPath 13 atomic)
- 셸 함수/alias/$VAR/pushd 추적 불가 (Known limitation) — OSC 7 가이드로 우회

---

## 2026-05-25 10:00 작업 내역 — Step F 후속 정리 (S2 + N1~N3 + deprecated 제거)

**작업 내용 (Architect 직접 — Builder 호출 안 함):**
- **S2 접근성:** LogPilotTab ⓘ `<span>` → `<button type="button">` + CSS `:focus-visible` outline. 키보드 사용자도 OSC 7 가이드 접근 가능.
- **N1 IME:** useSshCwd 멀티바이트 입력 처리 명시 주석 (safe degradation 보존, 코드 변경 없음).
- **N2 posixPath.join:** base가 절대 경로 아닐 때 `import.meta.env.DEV` 모드 `console.warn`로 호출자 계약 위반 표면화.
- **N3 OSC 7 host:** `parseOsc7Path`가 host 캡처 + dev `console.debug`. 다중 SSH 세션 디버깅 보조 (보안 영향 0).
- **Deprecated 제거:** `useLogPilot.sshCwd/refreshCwd/isCwdLoading` state + useEffect(seed) + return 필드 모두 제거. `useEffect` import 정리. LogPilotTab IIFE 폴백 제거 → `sshCwd/isSshCwdLoading/onRefreshSshCwd` 필수 prop으로 승격. **Reviewer S1(중복 ssh.pwd round-trip) 자연 해소.**

**변경 파일 (5 파일, +83 / -101):**
- `LogPilotTab.tsx`, `logpilot.css`, `posixPath.ts`, `useSshCwd.ts`, `useLogPilot.ts`

**결정 사항:**
- Tier 2(#1 히스토리, #7 가이드 투어) 진입 vs 정리 우선 — **정리 우선** 선택. 누적 dead code 0으로 다음 step 진입 부담 ↓

**이슈/특이사항:**
- vitest 174/174 유지 (회귀 0)
- net -18 줄 (cleanup이라 감소)

---

## 2026-05-25 10:50 작업 내역 — AI 분석 빈 응답 진단 + 에러 표시 + buffer 견고화

**작업 내용:**
- 사용자 보고: AI Analyze 클릭 시 빈 카드만 표시. 두 번 시도 모두 빈 응답.
- 단계별 진단:
  1. SSH `ls -la` 정상 동작 확인 (셸 입출력 정상)
  2. `_collectingOutput` 게이트 의심 → 게이트 제거 후 검증 — 여전히 빈 응답
  3. ClaudeApiService.SendStreamingAsync에 AiRequestLogger.LogRequest/LogResponse/LogInfo 임시 추가
  4. ai_api.log 분석 → **결정적 발견**: 400 BadRequest `"Your credit balance is too low to access the Anthropic API"`

**Root cause:** Anthropic 계정 크레딧 잔액 부족. 코드는 모두 정상.

**변경 파일 (3 파일, +41 / -19 — 커밋 `c542a5f`):**
- `IpcHandler.cs HandleAiAnalyzeSsh`: try/catch 추가. AI 호출 실패 시 사용자 카드에 `⚠ AI 호출 실패: <원인>` chunk로 표시 (빈 응답 silent failure 회피)
- `ClaudeApiService.SendStreamingAsync`: AiRequestLogger.LogRequest/LogResponse 표준화 (IsEngineAvailable/ListModels와 동일 패턴). 향후 동일 증상 즉시 ai_api.log로 진단 가능
- `SshService._collectingOutput` 게이트 제거: 필드 자체 삭제. Enter 시 `_lastOutputBuffer.Clear()`는 유지 (마지막 명령 출력 의미 보존). 자동 명령/IPC 타이밍 어긋남 케이스에서도 always-on 누적

**결정 사항:**
- 임시 진단 prompt(HandleAiAnalyzeSsh) 제거 — 원래 빈 가드 복원하되 try/catch로 명확한 에러 메시지 추가
- ClaudeApiService 로깅은 **운영 영구화** — 임시 진단이 아닌 표준화. 향후 어떤 사용자 빈 응답 호소도 ai_api.log로 즉시 진단 가능
- buffer 게이트 제거 fix는 root cause와 무관하지만 **합리적 견고화**라 유지

**미완료/다음 작업:**
- Anthropic 크레딧 충전 후 AI 분석 실제 동작 검증 — Owner 환경 액션
- 다른 Provider(OpenAI/Gemini/Ollama) 전환 옵션도 가능

**이슈/특이사항:**
- ai_api.log에 GET /v1/models만 가득하고 POST /v1/messages 흔적 0개여서 처음엔 IPC mismatch 의심 → SendStreamingAsync에 로깅 추가 후 POST 호출은 정상 발생, 단 400 거부 확인
- `claude-haiku-4-5-20251001` 모델 자체는 실존 (KnownModels에 등록). 단순 크레딧 부족
- error 메시지가 사용자 카드에 안 표시되던 결함도 같이 해결 — 향후 어떤 API 에러도 명확히 노출

---

## 세션 종료 — 2026-05-25 11:30

**원격 푸시 완료** (master `bf99d79..c542a5f`)

| Commit | 요약 | 분량 |
|--------|------|------|
| `4107b18` | LogPilot 탭 신설 + Tier 1 (스크롤 fix 포함) | 24 파일 / +4278 -542 |
| `67e9f48` | SSH cwd 추적 A+B 하이브리드 | 9 파일 / +581 -31 |
| `665f473` | Step F 후속 정리 | 5 파일 / +83 -101 |
| `c542a5f` | AI 빈 응답 진단 + 에러 표시 + buffer 견고화 | 3 파일 / +41 -19 |
| **합계** | **41 파일 / +4983 -693** | |

**Known Gaps (다음 세션 후보):**
- Tier 2 진입 — #1 분석 히스토리 패널 + #7 첫 사용 가이드 투어
- Flag DE-D 단일 청크 chunked 시 백엔드 종합 요약 중복 실측
- 백엔드 cwd 추적 옵션 C (SshService shell channel) — 별도 step
- 다중 셸 세션(분할 터미널) 지원 — useSshCwd 인스턴스 다중화
- Anthropic 크레딧 충전 후 AI 분석 실제 동작 회귀 확인

**보안 점검 (push 전):**
- 시크릿 패턴(API key/password/token 하드코딩) 0건
- 큰 바이너리 0건
- handoff/ 폴더 .gitignore 등록됨 (로컬 전용)
- bin/obj/dist 빌드 산출물 .gitignore 등록됨

**Architect 종료 신호.**
