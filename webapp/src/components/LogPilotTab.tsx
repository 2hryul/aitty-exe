/**
 * LogPilotTab — 초보 운영자용 로그 분석 메인 탭.
 *
 * 흐름 (확정된 결정 #1, #2, #3 반영):
 *  1) 진입 시 sshConnected → ssh.pwd 호출, 결과를 "📍 현재 SSH 경로" 버튼에 노출
 *  2) 사용자가 파일 경로 입력 또는 프리셋 선택 또는 📍 버튼 클릭으로 채움
 *  3) 시나리오 카드 6개 중 1개 선택 → 안내 바 갱신
 *  4) "▶ 분석 시작" 클릭 → ssh.checkReadable로 권한 사전 체크
 *     - 통과: 시나리오별 logcheck 실행 → AI 분석 (4섹션 + 신호등)
 *     - 실패: 권한 모달 노출 (3옵션 + 그래도 시도)
 *  5) 결과 패널 — 신호등 + 4섹션 + Run 가능한 명령 코드블록 + 다음 액션 칩 + 원본 로그
 *
 * Scope Lock 준수:
 *  - 분석 결과 영속화/다중 로그 상관/청크 의미요약 모두 별도 step
 *  - 시스템 프롬프트는 백엔드 const + 시나리오 컨텍스트(merge)로 합성 — 외부 JSON SoT는 다음 step
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ssh } from '@bridge/ipcBridge'
import { useLogPilot } from '@hooks/useLogPilot'
import { LOGPILOT_PLACEHOLDER_EXAMPLES } from '@utils/logpilotScenarios'
import { LogPilotScenarioGrid } from './LogPilotScenarioGrid'
import { LogPilotPresetPanel } from './LogPilotPresetPanel'
import { LogPilotPermModal } from './LogPilotPermModal'
import { LogPilotResultPanel } from './LogPilotResultPanel'
import '@styles/logpilot.css'

/** ETA 초를 한국어 표현으로 — 60초 미만이면 "X초", 그 이상이면 "X분 Y초". */
function formatEtaSeconds(sec: number): string {
  if (sec < 60) return `약 ${sec}초 남음`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s === 0 ? `약 ${m}분 남음` : `약 ${m}분 ${s}초 남음`
}

interface LogPilotTabProps {
  provider: string
  model: string
  availableModels: string[]
  sshConnected: boolean
  /**
   * Step F — App.tsx의 useSshCwd 훅에서 내려오는 cwd 값(단일 source).
   * null이면 "(미연결 또는 확인 불가)" 표시.
   */
  sshCwd: string | null
  isSshCwdLoading: boolean
  onRefreshSshCwd: () => Promise<void>
}

export function LogPilotTab({
  provider,
  model,
  sshConnected,
  sshCwd,
  isSshCwdLoading,
  onRefreshSshCwd,
}: LogPilotTabProps) {
  const [filePath, setFilePath] = useState('')
  const [presetOpen, setPresetOpen] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  // 자연어 입력 (Step D) — 빈 문자열이면 "물어보기" 버튼 비활성화
  const [freeTextQuestion, setFreeTextQuestion] = useState('')

  const pilot = useLogPilot({ provider, model, sshConnected })

  // placeholder 회전 — 5초마다 다음 예시. 사용자 입력 중에도 placeholder만 회전.
  const [placeholderIdx, setPlaceholderIdx] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => {
      setPlaceholderIdx(i => (i + 1) % LOGPILOT_PLACEHOLDER_EXAMPLES.length)
    }, 5000)
    return () => window.clearInterval(id)
  }, [])

  const currentPlaceholder = useMemo(
    () => LOGPILOT_PLACEHOLDER_EXAMPLES[placeholderIdx],
    [placeholderIdx],
  )

  /** ▾ 클릭 — 현재 placeholder를 textarea 값으로 채움. */
  const handleFillPlaceholder = useCallback(() => {
    setFreeTextQuestion(currentPlaceholder)
  }, [currentPlaceholder])

  // 권한 모달 표시 조건 — 권한 체크가 끝났고(loading=false) 결과가 readable=false인 경우
  const permModalOpen =
    !!pilot.permissionCheck &&
    !pilot.permissionCheck.loading &&
    pilot.permissionCheck.result !== null &&
    !pilot.permissionCheck.result.readable

  // SSH 미연결 시 분석 시작 차단
  const canStart = sshConnected && !!filePath.trim() && !!pilot.selectedScenario && !pilot.isFetching && !pilot.isStreaming

  // 자연어 "물어보기" 버튼 활성화 조건 (Step D, Flag DD-C):
  //  - SSH 연결 + filePath + 질문 비어있지 않음 + 분석 진행 중 아님
  const canAskFreeText =
    sshConnected &&
    !!filePath.trim() &&
    !!freeTextQuestion.trim() &&
    !pilot.isFetching &&
    !pilot.isStreaming

  const handleStart = useCallback(async () => {
    if (!pilot.selectedScenario) {
      setLocalError('먼저 시나리오 카드를 선택하세요')
      return
    }
    if (!filePath.trim()) {
      setLocalError('로그 파일 경로를 입력하세요')
      return
    }
    setLocalError(null)
    await pilot.runWithPermCheck(filePath.trim(), pilot.selectedScenario)
  }, [pilot, filePath])

  /**
   * 자연어 "물어보기" 핸들러 (Step D, Flag DD-D).
   * - filePath 검증 → runWithFreeText(path, question) 호출
   * - 칩 클릭은 별도 흐름(handleStart) — 자연어 입력은 무시됨 (decision)
   */
  const handleFreeTextSubmit = useCallback(async () => {
    const q = freeTextQuestion.trim()
    if (!q) {
      setLocalError('질문을 입력하세요')
      return
    }
    if (!filePath.trim()) {
      setLocalError('로그 파일 경로를 입력하세요')
      return
    }
    setLocalError(null)
    await pilot.runWithFreeText(filePath.trim(), q)
  }, [pilot, filePath, freeTextQuestion])

  const handleForceProceed = useCallback(async () => {
    if (!pilot.selectedScenario) return
    pilot.clearPermissionCheck()
    await pilot.runWithPermCheck(filePath.trim(), pilot.selectedScenario, true)
  }, [pilot, filePath])

  const handlePickAnother = useCallback(() => {
    pilot.clearPermissionCheck()
    setPresetOpen(true)
  }, [pilot])

  /**
   * 디렉토리/sudo 안내 모달의 "이 명령으로 분석" 버튼 — Fix 3.
   * 1) filePath 입력란을 명령으로 교체 (사용자가 이후 다시 실행하기 쉽게)
   * 2) 권한 모달 닫기
   * 3) 현재 선택된 시나리오로 즉시 분석 시작 (선택 없으면 checkup으로 자연어 흐름)
   */
  const handleSwitchPathAndRun = useCallback(async (cmd: string) => {
    setFilePath(cmd)
    pilot.clearPermissionCheck()
    setLocalError(null)
    // 시나리오가 이미 선택돼 있으면 그것을 사용, 아니면 자연어(checkup) 흐름 + 빈 질문
    if (pilot.selectedScenario) {
      await pilot.runWithPermCheck(cmd, pilot.selectedScenario)
    } else {
      // 자연어 질문이 없으면 빈 문자열로 — 시스템 프롬프트가 분석 수행
      await pilot.runWithFreeText(cmd, freeTextQuestion.trim() || '')
    }
  }, [pilot, freeTextQuestion])

  const handleRunCommand = useCallback((cmd: string) => {
    if (!sshConnected) return
    ssh.shellWrite(cmd + '\n').catch(() => {
      // 사용자 친화 안내 — 셸 쓰기 실패는 silently swallow하지 않고 inline error
      setLocalError('SSH 터미널로 명령을 전송하지 못했습니다 — 연결 상태를 확인하세요')
    })
  }, [sshConnected])

  const handleNextActionClick = useCallback((text: string) => {
    // 1차 — 클립보드로 복사 (사용자가 채팅 영역 등에 paste). 향후 v2에서 자동 채팅 입력.
    navigator.clipboard.writeText(text).catch(() => {})
  }, [])

  // SSH 끊김 시 결과 초기화 — 컨텍스트가 무의미해짐
  useEffect(() => {
    if (!sshConnected) {
      pilot.reset()
      setFilePath('')
      setFreeTextQuestion('')
    }
    // pilot.reset 의존성 회피 — 무한 루프 방지 (reset은 useCallback이지만 안전성)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sshConnected])

  return (
    <div className="logpilot-tab">
      {!sshConnected && (
        <div className="logpilot-banner-warn">
          ⚠ SSH가 연결되지 않았습니다. 좌측 사이드바에서 서버에 접속한 뒤 사용하세요.
        </div>
      )}

      {/* 로그 파일 경로 + 현재 SSH 경로 + 프리셋 */}
      <section className="logpilot-card">
        <div className="logpilot-card-header">
          <label className="logpilot-label">📁 분석할 로그 파일</label>
          {/* Step F + 후속 정리 — App.tsx의 useSshCwd 훅이 단일 source.
              IIFE 폴백 제거 — prop만 사용 (deprecated path 정리). */}
          <div className="logpilot-cwd-row">
            <span className="logpilot-cwd-label">SSH 현재 경로:</span>
            {isSshCwdLoading ? (
              <span className="logpilot-cwd-loading">확인 중...</span>
            ) : sshCwd ? (
              <button
                type="button"
                className="logpilot-cwd-btn mono"
                title="클릭하면 입력란에 채워집니다"
                onClick={() => setFilePath(sshCwd)}
              >
                📍 {sshCwd}
              </button>
            ) : (
              <span className="logpilot-cwd-empty">— (미연결 또는 확인 불가)</span>
            )}
            <button
              type="button"
              className="logpilot-icon-btn"
              onClick={() => onRefreshSshCwd()}
              title="다시 가져오기 (ssh.pwd로 강제 재동기화 — OSC 7 미감지 환경 대비)"
              disabled={!sshConnected || isSshCwdLoading}
            >
              🔄
            </button>
            {/* Step F DF-7 + S2 — <button>으로 변경하여 키보드 사용자도 tooltip 접근 가능.
                title 속성은 키보드 focus 시에도 일부 OS/브라우저에서 표시(WebView2/Chromium 지원).
                type="button"으로 form submit 방지. CSS reset(.logpilot-cwd-info)으로 시각 동일. */}
            <button
                  type="button"
                  className="logpilot-cwd-info"
                  title={
                    '추적 한계: 방향키로 편집한 cd, history recall된 cd, 셸 함수/alias cd는 추적되지 않습니다 — 🔄로 강제 동기화하세요.\n\n' +
                    '더 정확한 cwd 추적을 원하시면 서버 셸에 OSC 7을 활성화하세요:\n' +
                    'bash: export PROMPT_COMMAND=\'printf "\\e]7;file://%s%s\\e\\\\" "$(hostname)" "$PWD"\'\n' +
                    'zsh:  chpwd_functions+=(_osc7); _osc7() { printf "\\e]7;file://%s%s\\e\\\\" "$HOST" "$PWD" }'
                  }
              aria-label="cwd 추적 한계 + OSC 7 활성화 가이드"
            >
              ⓘ
            </button>
          </div>
        </div>
        <div className="logpilot-path-row">
          <input
            type="text"
            className="logpilot-path-input mono"
            value={filePath}
            onChange={e => setFilePath(e.target.value)}
            placeholder="/var/log/syslog"
          />
          <button
            type="button"
            className="logpilot-btn logpilot-btn-secondary"
            onClick={() => setPresetOpen(v => !v)}
          >
            🔎 자주 쓰는 로그 {presetOpen ? '▴' : '▾'}
          </button>
        </div>

        <LogPilotPresetPanel
          isOpen={presetOpen}
          onSelect={setFilePath}
          onClose={() => setPresetOpen(false)}
        />
      </section>

      {/* 자연어 입력 + 시나리오 칩 (Step D — 자연어 메인, 칩 보조)
          헤더 행에 제목 좌측 + "물어보기" 버튼 우측 (사용자 요청 — 수직 공간 절약) */}
      <section className="logpilot-card logpilot-freetext-card">
        <div className="logpilot-section-header">
          <h2 className="logpilot-section-title">⚡ 무엇이 궁금하세요?</h2>
          <button
            type="button"
            className="logpilot-btn logpilot-btn-primary logpilot-freetext-submit"
            onClick={handleFreeTextSubmit}
            disabled={!canAskFreeText}
            title={!sshConnected ? 'SSH 연결 필요' : !filePath.trim() ? '로그 파일 경로를 먼저 입력하세요' : ''}
          >
            {pilot.isFetching ? '수집 중...' : pilot.isStreaming ? '분석 중...' : '💬 물어보기'}
          </button>
        </div>
        <div className="logpilot-freetext-row">
          <textarea
            className="logpilot-freetext-input"
            value={freeTextQuestion}
            onChange={e => setFreeTextQuestion(e.target.value)}
            placeholder={`서버에 대해 자유롭게 물어보세요 — 예: '${currentPlaceholder}'`}
            rows={3}
            disabled={pilot.isFetching || pilot.isStreaming}
          />
          <button
            type="button"
            className="logpilot-freetext-fill-btn"
            onClick={handleFillPlaceholder}
            disabled={pilot.isFetching || pilot.isStreaming}
            title="현재 예시를 입력란에 채우기"
          >
            ▾
          </button>
        </div>

        <div className="logpilot-freetext-divider">
          <span>빠른 시작</span>
        </div>

        <LogPilotScenarioGrid
          selectedKey={pilot.selectedScenario?.key ?? null}
          onPick={pilot.pickScenario}
        />
      </section>

      {/* 선택된 시나리오 안내 + 실행 버튼 */}
      {pilot.selectedScenario && (
        <section className="logpilot-picked-bar">
          <span className="logpilot-picked-icon">{pilot.selectedScenario.icon}</span>
          <div className="logpilot-picked-text">
            <span className="logpilot-picked-title">{pilot.selectedScenario.title}</span>
            <span className="logpilot-picked-detail"> · {pilot.selectedScenario.detail}</span>
          </div>
          <button
            type="button"
            className="logpilot-btn logpilot-btn-primary"
            onClick={handleStart}
            disabled={!canStart}
          >
            {pilot.isFetching ? '수집 중...' : pilot.isStreaming ? '분석 중...' : '▶ 분석 시작'}
          </button>
          {(pilot.isFetching || pilot.isStreaming) && (
            <button
              type="button"
              className="logpilot-btn logpilot-btn-cancel"
              onClick={pilot.cancel}
            >
              취소
            </button>
          )}
        </section>
      )}

      {/* 에러 배너 */}
      {(localError || pilot.error) && (
        <div className="logpilot-error-banner">
          {localError || pilot.error}
        </div>
      )}

      {/* 청크 분석 진행률 바 (Step E DE-7) — analyzeChunked progress 이벤트 수신 시 */}
      {pilot.progress && pilot.isStreaming && (
        <div className="logpilot-progress">
          <div className="logpilot-progress-bar">
            <div
              className="logpilot-progress-fill"
              style={{
                width: `${Math.min(100, Math.round((pilot.progress.index / Math.max(pilot.progress.total, 1)) * 100))}%`,
              }}
            />
          </div>
          <div className="logpilot-progress-text">
            <span className="logpilot-progress-count">
              {pilot.progress.index}/{pilot.progress.total} 청크
            </span>
            <span className="logpilot-progress-sep"> · </span>
            <span className="logpilot-progress-eta">
              {pilot.progress.etaSec === null
                ? '예상 시간 계산 중...'
                : formatEtaSeconds(pilot.progress.etaSec)}
            </span>
            <span className="logpilot-progress-sep"> · </span>
            <span className="logpilot-progress-hint">부분 결과 보기 중</span>
          </div>
        </div>
      )}

      {/* 결과 패널 */}
      {pilot.parsed && (
        <LogPilotResultPanel
          parsed={pilot.parsed}
          rawShellLog={pilot.payload?.content ?? null}
          shellSource={pilot.payload?.source}
          shellLineCount={pilot.payload?.lineCount}
          shellSizeBytes={pilot.payload?.sizeBytes}
          isStreaming={pilot.isStreaming}
          scenario={pilot.selectedScenario}
          sshConnected={sshConnected}
          onRunCommand={handleRunCommand}
          onNextActionClick={handleNextActionClick}
        />
      )}

      {/* 권한 모달 */}
      {permModalOpen && pilot.permissionCheck && (
        <LogPilotPermModal
          targetPath={pilot.permissionCheck.path}
          check={pilot.permissionCheck.result}
          loading={pilot.permissionCheck.loading}
          onPickAnother={handlePickAnother}
          onForceProceed={handleForceProceed}
          onCancel={pilot.clearPermissionCheck}
          onRunCommand={handleRunCommand}
          onSwitchPathAndRun={handleSwitchPathAndRun}
          sshConnected={sshConnected}
        />
      )}
    </div>
  )
}
