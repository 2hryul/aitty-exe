import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ai, type LogPayload } from '@bridge/ipcBridge'
import { useLogAnalyze, type LogMode } from '@hooks/useLogAnalyze'
import { truncateTailBytes } from '@utils/logBudget'
import { logger } from '@utils/logger'
import { LogPresetSelect } from './LogPresetSelect'
import { LogBudgetModal } from './LogBudgetModal'
import '@styles/log-tab.css'

interface LogTabProps {
  provider: string
  model: string
  availableModels: string[]
  /** 모델 변경 시 AITerminal 측 상태 갱신을 트리거하고 싶을 때 사용 (선택) */
  onModelChanged?: (model: string) => void
}

// 플랜 §1 명령 템플릿 — 사용자 편집 가능(placeholder는 수동 치환)
const COMMAND_TEMPLATES: { label: string; template: string }[] = [
  { label: 'tail -n 200',              template: 'tail -n 200 {path}' },
  { label: 'journalctl 최근 {N}{unit}', template: 'journalctl --since "{N} {unit} ago" --no-pager' },
  { label: 'dmesg (last 500)',         template: 'dmesg -T | tail -n 500' },
  { label: 'grep {keyword}',           template: 'grep -E "{keyword}" {path} | tail -n 500' },
]

// /g 플래그는 .test() 호출 시 lastIndex를 누적 변경하므로 같은 문자열에도 결과가 번갈아 나옴 → boolean 체크 용도엔 /g 제거가 안전
const PLACEHOLDER_PATTERN = /\{(path|N|unit|keyword)\}/

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/**
 * 파일 경로 입력 검증 — 백엔드 왕복 전 UI에서 즉시 거절 (타이포/실수 방지용).
 * 백엔드도 검증하지만 여기서 1차 걸러 IPC 낭비와 로그 오염을 줄인다.
 * @returns 오류 메시지(한글) 또는 null(통과)
 */
function validateFilePath(path: string): string | null {
  const trimmed = path.trim()
  if (!trimmed) return '경로를 입력하세요'
  if (trimmed.includes('..')) return '상대 경로(..)는 허용되지 않습니다'
  if (!trimmed.startsWith('/')) return '절대 경로(/)로 입력하세요'
  return null
}

function formatDate(iso: string | null): string {
  if (!iso) return '-'
  try {
    const d = new Date(iso)
    return d.toLocaleString()
  } catch {
    return iso
  }
}

export function LogTab({ provider, model, availableModels, onModelChanged }: LogTabProps) {
  const [mode, setMode] = useState<LogMode>('file')
  const [filePath, setFilePath] = useState('')
  const [tailBytes, setTailBytes] = useState(256 * 1024) // 256KB
  const [fullFile, setFullFile] = useState(false)
  const [command, setCommand] = useState('')
  const [question, setQuestion] = useState('')
  const [isBudgetModalOpen, setIsBudgetModalOpen] = useState(false)
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const [currentModel, setCurrentModel] = useState(model)
  // UI-local validation error — 백엔드 왕복 전에 입력 오류 즉시 표시 (타이포 등)
  const [localError, setLocalError] = useState<string | null>(null)

  // model prop 갱신 시 내부 상태 동기화 (모달 열려있을 땐 사용자 선택 보존)
  // 모달 열린 동안 사용자의 모델 전환 선택을 보존하기 위해 currentModel/isBudgetModalOpen은 의도적으로 deps에서 제외
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isBudgetModalOpen && model !== currentModel) {
      setCurrentModel(model)
    }
  }, [model])

  const hook = useLogAnalyze({ provider, model: currentModel })

  const handleCheckFile = useCallback(() => {
    const err = validateFilePath(filePath)
    if (err) { setLocalError(err); return }
    setLocalError(null)
    hook.checkFile(filePath.trim())
  }, [filePath, hook])

  const handleFetch = useCallback(async () => {
    if (mode === 'file') {
      const err = validateFilePath(filePath)
      if (err) { setLocalError(err); return }
      setLocalError(null)
      await hook.fetchFile(filePath.trim(), tailBytes, fullFile)
    } else {
      if (!command.trim()) return
      // placeholder 남아있으면 경고
      if (PLACEHOLDER_PATTERN.test(command)) {
        window.alert('명령에 {path}/{N}/{unit}/{keyword} placeholder가 남아있습니다. 실제 값으로 바꾼 뒤 실행하세요.')
        return
      }
      setLocalError(null)
      await hook.fetchExec(command.trim())
    }
    // 수집 후 예산 경고 자동 모달
    // (상태 업데이트 후 다음 렌더에서 체크)
    setIsBudgetModalOpen(false) // 재수집 시 일단 닫기
  }, [mode, filePath, tailBytes, fullFile, command, hook])

  // budgetCheck 경고/거부 발생 시 모달 자동 오픈 (수집 직후 1회)
  const { budgetCheck } = hook
  useEffect(() => {
    if (budgetCheck && (budgetCheck.status === 'warn' || budgetCheck.status === 'reject')) {
      setIsBudgetModalOpen(true)
    }
  }, [budgetCheck])

  const handleOpenBudgetModal = useCallback(() => setIsBudgetModalOpen(true), [])
  const handleCloseBudgetModal = useCallback(() => setIsBudgetModalOpen(false), [])

  const handleSplit = useCallback(async () => {
    setIsBudgetModalOpen(false)
    await hook.analyzeChunked(question.trim())
  }, [hook, question])

  const handleTruncate = useCallback(() => {
    if (!hook.payload || !hook.budgetCheck) return
    const truncated = truncateTailBytes(hook.payload.content, hook.budgetCheck.budget)
    const newPayload: LogPayload = {
      ...hook.payload,
      content: truncated,
      sizeBytes: new TextEncoder().encode(truncated).byteLength,
      lineCount: truncated.split('\n').length,
    }
    hook.setPayload(newPayload)
    setIsBudgetModalOpen(false)
  }, [hook])

  const handleModelSwitch = useCallback(async (newModel: string) => {
    try {
      await ai.setModel(newModel)
      setCurrentModel(newModel)
      onModelChanged?.(newModel)
      // 기존 payload가 있으면 재평가 (hook 내부 recheckBudget 트리거)
      if (hook.payload) hook.setPayload(hook.payload)
    } catch (err) {
      logger.error('[LogTab.handleModelSwitch] 모델 전환 실패', { error: err })
      throw err
    }
  }, [hook, onModelChanged])

  const handleAnalyze = useCallback(async () => {
    if (!hook.payload) return
    if (hook.budgetCheck?.status === 'reject') {
      setIsBudgetModalOpen(true)
      return
    }
    await hook.analyze(question.trim())
  }, [hook, question])

  const handleCancel = useCallback(() => {
    hook.cancel()
  }, [hook])

  const handleTemplateSelect = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const idx = parseInt(e.target.value, 10)
    if (Number.isNaN(idx) || idx < 0 || idx >= COMMAND_TEMPLATES.length) return
    setCommand(COMMAND_TEMPLATES[idx].template)
    e.target.value = ''
  }, [])

  const previewText = useMemo(() => {
    if (!hook.payload) return ''
    return hook.payload.content.slice(0, 2048)
  }, [hook.payload])

  const markdownComponents = useMemo(() => ({
    code({ className, children, ...props }: { className?: string; children?: React.ReactNode; [key: string]: unknown }) {
      const match = /language-(\w+)/.exec(className || '')
      const codeStr = String(children).replace(/\n$/, '')
      const isBlock = match !== null || codeStr.includes('\n')
      if (isBlock) {
        return (
          <pre className="log-result-codeblock">
            <code className={className}>{codeStr}</code>
          </pre>
        )
      }
      return <code className="inline-code" {...props}>{children}</code>
    },
  }), [])

  const budgetBannerClass =
    budgetCheck?.status === 'ok' ? 'log-budget-banner-ok'
    : budgetCheck?.status === 'warn' ? 'log-budget-banner-warn'
    : budgetCheck?.status === 'reject' ? 'log-budget-banner-reject'
    : ''

  return (
    <div className="log-tab">
      {/* 모드 선택 */}
      <div className="log-mode-selector">
        <button
          type="button"
          className={`log-mode-btn ${mode === 'file' ? 'active' : ''}`}
          onClick={() => setMode('file')}
        >
          파일 경로
        </button>
        <button
          type="button"
          className={`log-mode-btn ${mode === 'command' ? 'active' : ''}`}
          onClick={() => setMode('command')}
        >
          명령 실행
        </button>
      </div>

      {/* 파일 모드 폼 */}
      {mode === 'file' && (
        <div className="log-form log-form-file">
          <div className="log-form-row">
            <input
              type="text"
              className="log-path-input"
              value={filePath}
              onChange={e => setFilePath(e.target.value)}
              placeholder="/var/log/syslog"
            />
            <LogPresetSelect currentPath={filePath} onSelect={setFilePath} />
            <button
              type="button"
              className="log-btn"
              onClick={handleCheckFile}
              disabled={!filePath.trim()}
            >
              파일 확인
            </button>
          </div>

          {hook.statInfo && (
            <div className="log-stat-info">
              {hook.statInfo.exists ? (
                <>
                  크기: <strong>{formatBytes(hook.statInfo.size)}</strong>
                  &nbsp;|&nbsp; 수정: {formatDate(hook.statInfo.lastWriteUtc)}
                </>
              ) : (
                <span className="log-error-inline">파일 없음</span>
              )}
            </div>
          )}

          <div className="log-form-row">
            <label className="log-slider-label">
              tail 크기: <strong>{formatBytes(tailBytes)}</strong>
            </label>
            <input
              type="range"
              min={64 * 1024}
              max={2 * 1024 * 1024}
              step={64 * 1024}
              value={tailBytes}
              onChange={e => setTailBytes(parseInt(e.target.value, 10))}
              disabled={fullFile}
            />
            <label className="log-checkbox-label">
              <input
                type="checkbox"
                checked={fullFile}
                onChange={e => setFullFile(e.target.checked)}
              />
              전체 읽기
            </label>
          </div>
        </div>
      )}

      {/* 명령 모드 폼 */}
      {mode === 'command' && (
        <div className="log-form log-form-command">
          <div className="log-form-row">
            <select
              className="log-template-select"
              onChange={handleTemplateSelect}
              defaultValue=""
            >
              <option value="" disabled>템플릿 선택...</option>
              {COMMAND_TEMPLATES.map((t, i) => (
                <option key={t.label} value={i}>{t.label}</option>
              ))}
            </select>
          </div>
          <textarea
            className="log-command-input"
            value={command}
            onChange={e => setCommand(e.target.value)}
            placeholder="tail -n 200 /var/log/syslog"
            rows={3}
          />
          {PLACEHOLDER_PATTERN.test(command) && (
            <div className="log-warning-inline">
              ⚠ placeholder({'{path}, {N}, {unit}, {keyword}'})를 실제 값으로 바꾸세요.
            </div>
          )}
        </div>
      )}

      {/* 수집 버튼 */}
      <div className="log-action-row">
        <button
          type="button"
          className="log-btn log-btn-primary"
          onClick={handleFetch}
          disabled={hook.isFetching || (mode === 'file' ? !filePath.trim() : !command.trim())}
        >
          {hook.isFetching ? '수집 중...' : '로그 수집'}
        </button>
      </div>

      {/* 수집 결과 배너 */}
      {hook.payload && (
        <div className="log-collected-banner">
          <div className="log-collected-summary">
            수집: <strong>{hook.payload.source}</strong>
            &nbsp;|&nbsp; {formatBytes(hook.payload.sizeBytes)}
            &nbsp;|&nbsp; {hook.payload.lineCount.toLocaleString()} 줄
            &nbsp;
            <button
              type="button"
              className="log-link-btn"
              onClick={() => setIsPreviewOpen(v => !v)}
            >
              {isPreviewOpen ? '미리보기 닫기' : '미리보기 펼치기'}
            </button>
          </div>
          {isPreviewOpen && (
            <pre className="log-preview">{previewText}
{hook.payload.content.length > previewText.length && '\n... (이하 생략)'}
            </pre>
          )}
        </div>
      )}

      {/* 예산 배너 */}
      {budgetCheck && (
        <div className={`log-budget-banner ${budgetBannerClass}`}>
          {budgetCheck.status === 'ok' && (
            <span>
              ✓ 현재 모델: <strong>{provider} / {currentModel}</strong> (예산 {formatBytes(budgetCheck.budget)})
            </span>
          )}
          {budgetCheck.status === 'warn' && (
            <>
              <span>
                ⚠ <strong>{provider} / {currentModel}</strong> 예산 {formatBytes(budgetCheck.budget)} — {budgetCheck.ratio.toFixed(1)}배 초과
              </span>
              <button type="button" className="log-link-btn" onClick={handleOpenBudgetModal}>옵션 열기</button>
            </>
          )}
          {budgetCheck.status === 'reject' && (
            <>
              <span>
                ⛔ 너무 큽니다. 분할 필수 — {budgetCheck.ratio.toFixed(1)}배 초과
              </span>
              <button type="button" className="log-link-btn" onClick={handleOpenBudgetModal}>옵션 열기</button>
            </>
          )}
        </div>
      )}

      {/* 예산 모달 */}
      {isBudgetModalOpen && budgetCheck && (
        <LogBudgetModal
          budgetCheck={budgetCheck}
          currentProvider={provider}
          currentModel={currentModel}
          availableModels={availableModels}
          onSelectSplit={handleSplit}
          onSelectTruncate={handleTruncate}
          onSelectModelSwitch={handleModelSwitch}
          onDismiss={handleCloseBudgetModal}
        />
      )}

      {/* 에러 배너 — UI-local 검증 오류 우선, 없으면 훅에서 올라온 오류 */}
      {(localError || hook.error) && (
        <div className="log-error-banner">
          {localError || hook.error}
        </div>
      )}

      {/* 질문 입력 + 분석 버튼 */}
      <div className="log-question-row">
        <textarea
          className="log-question-input"
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="무엇을 확인하고 싶으세요? (예: 최근 에러의 공통 원인, 특정 서비스 실패 여부)"
          rows={2}
        />
        <div className="log-question-buttons">
          <button
            type="button"
            className="log-btn log-btn-primary"
            onClick={handleAnalyze}
            disabled={
              !hook.payload ||
              hook.isStreaming ||
              budgetCheck?.status === 'reject'
            }
          >
            {hook.isStreaming ? '분석 중...' : 'AI 분석'}
          </button>
          {hook.isStreaming && (
            <button
              type="button"
              className="log-btn log-btn-cancel"
              onClick={handleCancel}
            >
              취소
            </button>
          )}
        </div>
      </div>

      {/* 결과 패널 */}
      {(hook.result || hook.isStreaming) && (
        <div className="log-result-panel">
          {hook.chunkProgress && (
            <div className="log-progress">
              <strong>Part {hook.chunkProgress.index + 1}/{hook.chunkProgress.total}</strong>
              &nbsp;({formatBytes(hook.chunkProgress.bytes)})
              <div className="log-progress-bar">
                <div
                  className="log-progress-bar-fill"
                  style={{ width: `${Math.round(((hook.chunkProgress.index + 1) / hook.chunkProgress.total) * 100)}%` }}
                />
              </div>
            </div>
          )}
          <div className="log-result-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {hook.result || ' '}
            </ReactMarkdown>
            {hook.isStreaming && <span className="streaming-cursor" />}
          </div>
        </div>
      )}
    </div>
  )
}
