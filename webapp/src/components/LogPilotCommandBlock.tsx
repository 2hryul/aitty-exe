/**
 * LogPilotCommandBlock — AI 응답의 "지금 할 일" 명령 코드블록.
 *
 * 차이점 vs CodeBlock:
 *  - dry-run 설명("이 명령은: …")을 상단에 별도 라벨로 노출 (AI 응답에서 추출).
 *  - 위험도 뱃지 3단계 (safe/caution/danger) — LogPilot 단순화 매핑 사용.
 *  - danger → Run 비활성화 + "차단됨" 표시
 *  - caution → Run 시 인라인 확인 ("실행할까요?" + yes 확인)
 *  - safe → 즉시 실행
 */

import { useCallback, useState } from 'react'
import type { ParsedAction } from '@utils/logpilotResponseParser'

interface LogPilotCommandBlockProps {
  action: ParsedAction
  sshConnected: boolean
  onRun: (command: string) => void
}

const BADGES: Record<ParsedAction['riskLevel'], { label: string; cls: string }> = {
  safe:    { label: '🟢 안전',  cls: 'safe' },
  caution: { label: '🟡 주의',  cls: 'caution' },
  danger:  { label: '🔴 차단',  cls: 'danger' },
}

export function LogPilotCommandBlock({ action, sshConnected, onRun }: LogPilotCommandBlockProps) {
  const [copied, setCopied] = useState(false)
  const [pendingConfirm, setPendingConfirm] = useState(false)

  const badge = BADGES[action.riskLevel]
  const isBlocked = action.riskLevel === 'danger'
  const needsConfirm = action.riskLevel === 'caution'

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(action.command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // 클립보드 권한 없음 — 폴백 없이 무시 (사용자가 수동 복사 가능)
    }
  }, [action.command])

  const handleRun = useCallback(() => {
    if (isBlocked) return
    if (needsConfirm && !pendingConfirm) {
      setPendingConfirm(true)
      return
    }
    setPendingConfirm(false)
    onRun(action.command)
  }, [isBlocked, needsConfirm, pendingConfirm, action.command, onRun])

  return (
    <div className={`logpilot-cmd-block logpilot-cmd-${badge.cls}`}>
      <div className="logpilot-cmd-header">
        <span className={`logpilot-cmd-badge logpilot-cmd-badge-${badge.cls}`}>{badge.label}</span>
        <div className="logpilot-cmd-actions">
          <button
            type="button"
            className="logpilot-btn logpilot-btn-tool"
            onClick={handleCopy}
            title="명령 복사"
          >
            {copied ? '✓ 복사됨' : '📋 복사'}
          </button>
          {sshConnected && (
            <button
              type="button"
              className={`logpilot-btn ${
                isBlocked ? 'logpilot-btn-blocked' :
                needsConfirm ? 'logpilot-btn-caution' :
                'logpilot-btn-run'
              }`}
              onClick={handleRun}
              disabled={isBlocked}
              title={isBlocked ? '안전 정책으로 차단된 명령입니다' : 'SSH 터미널에서 실행'}
            >
              {isBlocked ? '🚫 차단됨' : (pendingConfirm ? '한 번 더 클릭 = 실행' : '▶ 실행')}
            </button>
          )}
        </div>
      </div>

      {action.description && (
        <div className="logpilot-cmd-desc">
          <strong>💡 이 명령은:</strong> {action.description}
        </div>
      )}

      <pre className="logpilot-cmd-code mono">{action.command}</pre>

      {pendingConfirm && needsConfirm && (
        <div className="logpilot-cmd-confirm">
          ⚠ 이 명령은 시스템에 영향을 줄 수 있습니다. <strong>다시 ▶ 실행을 누르면 진행</strong>됩니다.
          <button
            type="button"
            className="logpilot-link-btn"
            onClick={() => setPendingConfirm(false)}
          >
            취소
          </button>
        </div>
      )}
    </div>
  )
}
