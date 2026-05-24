/**
 * LogPilotResultPanel — 신호등 + 4섹션 결과 패널.
 *
 * 구성:
 *  1) 신호등(🔴/🟡/🟢/⚪) + verdictText (UI 헤더)
 *  2) 헤더 우측 공유 3버튼 (📋 복사 / 📥 .md / 📨 메일) — Step E DE-2
 *  3) 📌 결론 / 🧭 원인 / 🚨 지금 할 일 (LogPilotCommandBlock 리스트) / 🗓 나중에
 *  4) actionsNow 끝 "🟢 안전 N개 일괄 실행" 버튼 — Step E DE-5 (safe ≥ 2일 때만)
 *  5) 다음 액션 칩 (시나리오별 정적 3개)
 *  6) 셸 원본 로그 (`<details>` 접힘 — 검증용)
 *
 * parseFallback=true인 경우 conclusion에 원본 그대로 표시.
 */

import { useCallback, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  serializeAsMarkdown,
  type ParsedLogPilotResult,
} from '@utils/logpilotResponseParser'
import type { LogPilotScenario } from '@utils/logpilotScenarios'
import { filterSafeActions } from '@utils/commandRiskLevel'
import { LogPilotCommandBlock } from './LogPilotCommandBlock'

interface LogPilotResultPanelProps {
  parsed: ParsedLogPilotResult
  rawShellLog: string | null
  shellSource?: string
  shellLineCount?: number
  shellSizeBytes?: number
  isStreaming: boolean
  scenario: LogPilotScenario | null
  sshConnected: boolean
  onRunCommand: (command: string) => void
  /** 다음 액션 칩 클릭 — 사용자에게 채워줄 후속 행동(현 step에서는 채팅에 복사 등). */
  onNextActionClick: (text: string) => void
}

const VERDICT_META: Record<ParsedLogPilotResult['verdict'], { icon: string; label: string; cls: string }> = {
  red:     { icon: '✕', label: '위험', cls: 'red' },
  yellow:  { icon: '⚠', label: '주의', cls: 'yellow' },
  green:   { icon: '✓', label: '정상', cls: 'green' },
  unknown: { icon: '?', label: '판정 보류', cls: 'unknown' },
}

function formatBytes(n: number | undefined): string {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** YYYYMMDD-HHmm 로컬 시각 파일명 suffix. */
function timestampForFilename(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}${mm}${dd}-${hh}${mi}`
}

/**
 * 일괄 실행 인디케이터 상태 — 각 명령별 진행 상태.
 * pending → running → done.
 */
type BulkRunStatus = 'pending' | 'running' | 'done'

export function LogPilotResultPanel({
  parsed,
  rawShellLog,
  shellSource,
  shellLineCount,
  shellSizeBytes,
  isStreaming,
  scenario,
  sshConnected,
  onRunCommand,
  onNextActionClick,
}: LogPilotResultPanelProps) {
  const meta = VERDICT_META[parsed.verdict]

  // 헤더 3버튼 토스트 메시지 (자동 사라짐)
  const [toast, setToast] = useState<string | null>(null)
  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2200)
  }, [])

  /** 현재 parsed + meta로 마크다운을 만든다 — 3버튼 공통 사용. */
  const buildMarkdown = useCallback((): string => {
    return serializeAsMarkdown(parsed, {
      scenario: scenario?.title,
      source: shellSource,
      lineCount: shellLineCount,
      timestamp: new Date().toISOString(),
    })
  }, [parsed, scenario, shellSource, shellLineCount])

  const handleCopyMarkdown = useCallback(async () => {
    const md = buildMarkdown()
    try {
      await navigator.clipboard.writeText(md)
      showToast('📋 마크다운 복사됨')
    } catch {
      showToast('복사 실패 — 브라우저 권한을 확인하세요')
    }
  }, [buildMarkdown, showToast])

  const handleSaveMarkdown = useCallback(() => {
    try {
      const md = buildMarkdown()
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const name = scenario?.key ?? 'analysis'
      a.href = url
      a.download = `logpilot-${name}-${timestampForFilename()}.md`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // 즉시 revoke하면 일부 브라우저에서 다운로드 실패 → 1초 후 정리
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      showToast('📥 .md 다운로드 시작')
    } catch {
      showToast('파일 저장 실패')
    }
  }, [buildMarkdown, scenario, showToast])

  /**
   * 메일 핸들러 — Flag DE-C 적용.
   * body는 mailto URL 길이 한계로 잘리므로 클립보드로 복사 + subject만 mailto.
   */
  const handleMailMarkdown = useCallback(async () => {
    const md = buildMarkdown()
    const verdictLabel = parsed.verdictText || `${meta.label} 결과`
    // S-2: mailto subject 길이 무방어 회피 — verdictText가 매우 길거나 이모지가 많으면
    // encodeURIComponent 후 Outlook Classic 등 일부 클라이언트의 핸들러 한도(약 2KB)를 넘김.
    // 80자 + ellipsis로 안전 상한 적용. 본문 마크다운은 이미 클립보드로 복사되어 정보 손실 없음.
    const safeLabel = verdictLabel.length > 80
      ? verdictLabel.slice(0, 78) + '…'
      : verdictLabel
    const subject = `[LogPilot] ${safeLabel}`
    try {
      await navigator.clipboard.writeText(md)
    } catch {
      // 클립보드 실패해도 mailto는 시도 — 사용자가 수동 복사 가능
    }
    const mailUrl = `mailto:?subject=${encodeURIComponent(subject)}`
    // WebView2 환경에서 mailto는 OS 기본 메일 앱으로 위임됨
    window.location.href = mailUrl
    showToast('📨 본문 자동 복사됨 — 메일에 붙여넣기')
  }, [buildMarkdown, parsed.verdictText, meta.label, showToast])

  // ── 일괄 실행 (Step E DE-5) ─────────────────────────
  const safeActions = filterSafeActions(parsed.actionsNow)
  const bulkEnabled = sshConnected && safeActions.length >= 2 && !isStreaming
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkStatus, setBulkStatus] = useState<Record<number, BulkRunStatus>>({})

  /**
   * 안전 명령 순차 실행 — Flag DE-B에 따라 200ms 간격 고정.
   * actionsNow 배열에서 safe 명령의 원본 인덱스를 키로 인디케이터 상태를 관리.
   */
  const handleBulkRun = useCallback(async () => {
    if (!bulkEnabled) return
    setBulkRunning(true)

    // safe 명령의 원본 actionsNow 인덱스 매핑 — 인디케이터 위치 일치용
    const safeIndices: number[] = []
    parsed.actionsNow.forEach((a, idx) => {
      if (a.riskLevel === 'safe') safeIndices.push(idx)
    })

    const initial: Record<number, BulkRunStatus> = {}
    safeIndices.forEach(i => { initial[i] = 'pending' })
    setBulkStatus(initial)

    for (let i = 0; i < safeIndices.length; i++) {
      const origIdx = safeIndices[i]
      setBulkStatus(prev => ({ ...prev, [origIdx]: 'running' }))
      try {
        onRunCommand(parsed.actionsNow[origIdx].command)
      } catch {
        // onRunCommand 자체 실패 — 인디케이터는 done으로 표시하되 토스트로 알림
        showToast(`명령 전송 실패 — ${i + 1}/${safeIndices.length}`)
      }
      setBulkStatus(prev => ({ ...prev, [origIdx]: 'done' }))
      // 다음 명령까지 200ms 대기 — 셸 출력 안정화 (Flag DE-B)
      if (i < safeIndices.length - 1) {
        await new Promise(resolve => window.setTimeout(resolve, 200))
      }
    }

    setBulkRunning(false)
    showToast(`✅ ${safeIndices.length}개 명령 전송 완료`)
  }, [bulkEnabled, parsed.actionsNow, onRunCommand, showToast])

  return (
    <section className={`logpilot-result logpilot-result-${meta.cls}`}>
      {/* 신호등 헤더 + 우측 공유 3버튼 */}
      <div className="logpilot-result-header">
        <div className={`logpilot-result-traffic logpilot-result-traffic-${meta.cls}`}>
          <span className="logpilot-result-traffic-icon">{meta.icon}</span>
        </div>
        <div className="logpilot-result-header-text">
          <div className="logpilot-result-badge-row">
            <span className={`logpilot-result-badge logpilot-result-badge-${meta.cls}`}>
              {meta.label}
            </span>
            {shellSource && (
              <span className="logpilot-result-meta">
                {shellSource} · {formatBytes(shellSizeBytes)} · {shellLineCount?.toLocaleString() ?? 0} 줄
              </span>
            )}
          </div>
          <h3 className="logpilot-result-verdict-text">{parsed.verdictText || '응답 분석 중...'}</h3>
        </div>

        {/* 공유 3버튼 — 스트리밍 중에는 비활성화 */}
        <div className="logpilot-result-share">
          <button
            type="button"
            className="logpilot-share-btn"
            onClick={handleCopyMarkdown}
            disabled={isStreaming}
            title="마크다운으로 클립보드에 복사"
          >
            📋
          </button>
          <button
            type="button"
            className="logpilot-share-btn"
            onClick={handleSaveMarkdown}
            disabled={isStreaming}
            title=".md 파일로 다운로드"
          >
            📥
          </button>
          <button
            type="button"
            className="logpilot-share-btn"
            onClick={handleMailMarkdown}
            disabled={isStreaming}
            title="메일로 공유 (본문 자동 복사)"
          >
            📨
          </button>
        </div>
      </div>

      {/* 토스트 */}
      {toast && <div className="logpilot-result-toast">{toast}</div>}

      {/* 폴백 표시 — 4섹션 미충족 */}
      {parsed.parseFallback && parsed.conclusion && (
        <div className="logpilot-result-section">
          <div className="logpilot-result-fallback-note">
            ℹ️ AI 응답이 표준 형식을 따르지 않아 원문 그대로 표시합니다.
          </div>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{parsed.conclusion}</ReactMarkdown>
        </div>
      )}

      {/* 4섹션 — 정상 파싱 */}
      {!parsed.parseFallback && (
        <>
          {parsed.conclusion && (
            <div className="logpilot-result-section">
              <h4 className="logpilot-result-section-title">📌 결론</h4>
              <div className="logpilot-result-section-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{parsed.conclusion}</ReactMarkdown>
              </div>
            </div>
          )}

          {parsed.cause && (
            <div className="logpilot-result-section">
              <h4 className="logpilot-result-section-title">🧭 원인</h4>
              <div className="logpilot-result-section-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{parsed.cause}</ReactMarkdown>
              </div>
            </div>
          )}

          {parsed.actionsNow.length > 0 && (
            <div className="logpilot-result-section">
              <h4 className="logpilot-result-section-title">🚨 지금 할 일</h4>
              <div className="logpilot-result-section-body">
                {parsed.actionsNow.map((action, idx) => {
                  const status = bulkStatus[idx]
                  // 인디케이터 — safe 명령이며 일괄 실행 중일 때만 노출
                  const indicator =
                    status === 'running' ? '⏳' :
                    status === 'done'    ? '✅' :
                    null
                  return (
                    <div key={idx} className="logpilot-cmd-wrap">
                      {indicator && (
                        <div className="logpilot-bulk-indicator" aria-hidden>
                          {indicator}
                        </div>
                      )}
                      <LogPilotCommandBlock
                        action={action}
                        sshConnected={sshConnected}
                        onRun={onRunCommand}
                      />
                    </div>
                  )
                })}

                {/* 일괄 실행 버튼 — safe ≥ 2일 때만 노출 (Step E DE-5) */}
                {safeActions.length >= 2 && (
                  <div className="logpilot-bulk-bar">
                    <button
                      type="button"
                      className="logpilot-bulk-btn"
                      onClick={handleBulkRun}
                      disabled={!bulkEnabled || bulkRunning}
                      title={
                        !sshConnected ? 'SSH 연결 필요' :
                        bulkRunning ? '실행 중...' :
                        `안전 ${safeActions.length}개 명령을 200ms 간격으로 순차 실행`
                      }
                    >
                      {bulkRunning
                        ? `⏳ 실행 중... (${Object.values(bulkStatus).filter(s => s === 'done').length}/${safeActions.length})`
                        : `🟢 안전 ${safeActions.length}개 일괄 실행`}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {parsed.actionsLater && (
            <div className="logpilot-result-section">
              <h4 className="logpilot-result-section-title">🗓 나중에 검토할 일</h4>
              <div className="logpilot-result-section-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{parsed.actionsLater}</ReactMarkdown>
              </div>
            </div>
          )}
        </>
      )}

      {/* 스트리밍 커서 */}
      {isStreaming && <span className="logpilot-streaming-cursor" />}

      {/* 다음 액션 칩 */}
      {scenario && !isStreaming && (
        <div className="logpilot-next-actions">
          <div className="logpilot-next-actions-label">이어서 살펴보면 좋은 것</div>
          <div className="logpilot-next-actions-chips">
            {scenario.nextActionChips.map((chip, idx) => (
              <button
                key={idx}
                type="button"
                className="logpilot-chip"
                onClick={() => onNextActionClick(chip)}
              >
                {chip}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 원본 셸 로그 접힘 */}
      {rawShellLog && (
        <details className="logpilot-raw-log">
          <summary>🔍 원본 셸 로그 보기 ({rawShellLog.split('\n').length.toLocaleString()} 줄)</summary>
          <pre className="logpilot-raw-log-content mono">{rawShellLog}</pre>
        </details>
      )}

      <div className="logpilot-disclaimer">
        ※ AI는 정확하지 않은 정보를 제공할 수 있습니다. 중요한 결정 전 원본 로그를 확인하세요.
      </div>
    </section>
  )
}
