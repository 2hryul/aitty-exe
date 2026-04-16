import { useState, useCallback, useMemo } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { checkCommandSafety, formatSafetyAlert, type SafetyLevel } from '@utils/commandSafety'

interface CodeBlockProps {
  language: string
  code: string
  sshConnected?: boolean
  onRunCommand?: (command: string) => void
}

const SAFETY_BUTTON_CONFIG: Record<Exclude<SafetyLevel, 'safe'>, { label: string; className: string; badge: string }> = {
  danger:  { label: '🚫 Blocked',   className: 'code-action-danger',  badge: '🔴 위험' },
  caution: { label: '⚠️ 확인 필요', className: 'code-action-caution', badge: '🟠 주의' },
  warning: { label: '⚠ Run',        className: 'code-action-warning', badge: '🟡 경고' },
}

export default function CodeBlock({ language, code, sshConnected, onRunCommand }: CodeBlockProps) {
  const [copied, setCopied]                     = useState(false)
  const [pendingConfirm, setPendingConfirm]     = useState(false)
  const [confirmInput, setConfirmInput]         = useState('')
  const [showWarningBanner, setShowWarningBanner] = useState(false)

  const isShellLang = !language || ['bash', 'sh', 'zsh', 'shell', 'console', 'text',
    'terminal', 'linux', 'cmd', 'command', 'powershell', 'fish'].includes(language.toLowerCase())

  // 주석·공백 제외 첫 번째 실행 가능 줄 — Copy/Run 대상
  const firstLine = useMemo(() =>
    code.split('\n').map(l => l.trim()).find(l => l.length > 0 && !l.startsWith('#'))
    ?? code.split('\n')[0].trim()
  , [code])

  // 전체 코드블록 검사 — 멀티라인 우회 방지 (firstLine만 검사하면 2번째 줄 위험 명령 통과)
  const safety = useMemo(() => isShellLang ? checkCommandSafety(code) : { level: 'safe' as SafetyLevel }, [code, isShellLang])

  const isHardBlocked = safety.level === 'danger'
  const needsConfirm  = safety.level === 'caution'
  const isWarnRun     = safety.level === 'warning'
  const isBlocked     = isHardBlocked  // 버튼 disabled 판단용

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(firstLine)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard not available */ }
  }, [firstLine])

  const handleConfirmSubmit = useCallback(() => {
    if (confirmInput.trim().toLowerCase() === 'yes') {
      setPendingConfirm(false)
      setConfirmInput('')
      onRunCommand?.(firstLine)
    }
  }, [confirmInput, firstLine, onRunCommand])

  const handleConfirmKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleConfirmSubmit()
    if (e.key === 'Escape') { setPendingConfirm(false); setConfirmInput('') }
  }, [handleConfirmSubmit])

  const handleRun = useCallback(() => {
    if (isHardBlocked) return

    if (needsConfirm) {
      setPendingConfirm(true)
      setConfirmInput('')
      return
    }

    if (isWarnRun) {
      setShowWarningBanner(true)
      setTimeout(() => setShowWarningBanner(false), 3000)
      onRunCommand?.(firstLine)
      return
    }

    onRunCommand?.(firstLine)
  }, [firstLine, onRunCommand, isHardBlocked, needsConfirm, isWarnRun])

  const btnConfig = safety.level !== 'safe'
    ? SAFETY_BUTTON_CONFIG[safety.level as Exclude<SafetyLevel, 'safe'>]
    : null

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">
          {language || 'text'}
          {safety.level !== 'safe' && btnConfig && (
            <span className={`code-safety-badge ${safety.level}`}>{btnConfig.badge}</span>
          )}
        </span>
        <div className="code-block-actions">
          <button className="code-action-btn" onClick={handleCopy} title="Copy to clipboard">
            {copied ? '✓ Copied' : '📋 Copy'}
          </button>
          {sshConnected && onRunCommand && (
            <button
              className={`code-action-btn ${btnConfig ? btnConfig.className : 'code-action-run'}`}
              onClick={handleRun}
              disabled={isBlocked}
              title={isHardBlocked ? formatSafetyAlert(safety) : 'Run in SSH Terminal'}
            >
              {btnConfig ? btnConfig.label : '▶ Run'}
            </button>
          )}
        </div>
      </div>

      {/* caution: "yes" 입력 확인창 */}
      {pendingConfirm && (
        <div className="code-confirm-row">
          <span className="code-confirm-label">
            ⚠️ {safety.reason} — 실행하려면 <code>yes</code> 입력:
          </span>
          <input
            autoFocus
            value={confirmInput}
            onChange={e => setConfirmInput(e.target.value)}
            onKeyDown={handleConfirmKey}
            placeholder="yes"
            className="code-confirm-input"
          />
          <button
            className="code-confirm-ok"
            onClick={handleConfirmSubmit}
            disabled={confirmInput.trim().toLowerCase() !== 'yes'}
          >
            실행
          </button>
          <button
            className="code-confirm-cancel"
            onClick={() => { setPendingConfirm(false); setConfirmInput('') }}
          >
            취소
          </button>
        </div>
      )}

      {/* warning: 일시 경고 배너 */}
      {showWarningBanner && (
        <div className="code-warning-banner">
          ⚠️ {safety.reason}
        </div>
      )}

      {safety.level !== 'safe' && safety.alternative && (
        <div className="code-safety-hint">
          💡 안전한 대안: <code>{safety.alternative}</code>
        </div>
      )}

      <SyntaxHighlighter
        language={language || 'text'}
        style={vscDarkPlus}
        customStyle={{
          margin: 0,
          borderRadius: '0 0 6px 6px',
          fontSize: '12px',
          lineHeight: '1.4',
          background: '#012456',
          fontFamily: '"Cascadia Code", "D2Coding", "Consolas", monospace',
        }}
        wrapLongLines
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}
