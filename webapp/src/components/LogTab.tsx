import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ai, type LogPayload } from '@bridge/ipcBridge'
import { useLogAnalyze } from '@hooks/useLogAnalyze'
import { truncateTailBytes } from '@utils/logBudget'
import { logger } from '@utils/logger'
import {
  buildSummaryRequest,
  buildSearchRequest,
  buildRecentRequest,
  buildRangeRequest,
  buildTopRequest,
  fromDateTimeLocal,
  toDateTimeLocal,
  modeLabel,
} from '@utils/logCheckRequest'
import type { LogCheckMode } from '@bridge/ipcBridge'
import { LogPresetSelect } from './LogPresetSelect'
import { LogBudgetModal } from './LogBudgetModal'
import '@styles/log-tab.css'

interface LogTabProps {
  provider: string
  model: string
  availableModels: string[]
  onModelChanged?: (model: string) => void
}

const MODES: LogCheckMode[] = ['summary', 'search', 'recent', 'range', 'top']

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function nowStamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

function slugify(s: string): string {
  return s.replace(/[/\\:?<>|*"\s]+/g, '_').replace(/_+/g, '_').slice(0, 64) || 'log'
}

export function LogTab({ provider, model, availableModels, onModelChanged }: LogTabProps) {
  const [filePath, setFilePath] = useState('')
  const [activeMode, setActiveMode] = useState<LogCheckMode>('summary')

  // 모드별 입력 상태 — 각 모드 활성화 시 해당 입력만 펼침
  const [pattern, setPattern] = useState('')
  const [ignoreCase, setIgnoreCase] = useState(false)
  const [ctxAfter, setCtxAfter] = useState(0)
  const [ctxBefore, setCtxBefore] = useState(0)
  const [hours, setHours] = useState(1)
  const [rangeFrom, setRangeFrom] = useState<string>(() => toDateTimeLocal(new Date(Date.now() - 60 * 60_000)))
  const [rangeTo, setRangeTo] = useState<string>(() => toDateTimeLocal(new Date()))
  const [topN, setTopN] = useState(10)

  const [question, setQuestion] = useState('')
  const [isBudgetModalOpen, setIsBudgetModalOpen] = useState(false)
  const [currentModel, setCurrentModel] = useState(model)
  const [localError, setLocalError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'done'>('idle')
  // 결과 표시 모드 — runLogCheck 직후 'shell', AI 분석 직후 'ai'. 사용자가 토글 가능.
  const [viewMode, setViewMode] = useState<'shell' | 'ai'>('shell')

  // model prop 변경 시 동기화 (모달 열려있을 땐 사용자 선택 보존)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isBudgetModalOpen && model !== currentModel) {
      setCurrentModel(model)
    }
  }, [model])

  const hook = useLogAnalyze({ provider, model: currentModel })

  // ─── logcheck 실행 ─────────────────────────────────────────────────
  const handleRun = useCallback(async () => {
    setLocalError(null)
    try {
      let req
      switch (activeMode) {
        case 'summary':
          req = buildSummaryRequest(filePath); break
        case 'search':
          req = buildSearchRequest(filePath, { pattern, ignoreCase, ctxAfter, ctxBefore }); break
        case 'recent':
          req = buildRecentRequest(filePath, { hours }); break
        case 'range':
          req = buildRangeRequest(filePath, {
            from: fromDateTimeLocal(rangeFrom),
            to:   fromDateTimeLocal(rangeTo),
          }); break
        case 'top':
          req = buildTopRequest(filePath, { topN }); break
      }
      await hook.runLogCheck(req)
      setViewMode('shell')   // 새 셸 출력 도착 → 셸 출력 화면으로 전환
    } catch (err) {
      const msg = err instanceof Error ? err.message : '입력값 오류'
      setLocalError(msg)
    }
  }, [activeMode, filePath, pattern, ignoreCase, ctxAfter, ctxBefore, hours, rangeFrom, rangeTo, topN, hook])

  // ─── 컨텍스트 크기 모달 처리 ──────────────────────────────────────
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
    setViewMode('ai')
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
      if (hook.payload) hook.setPayload(hook.payload)
    } catch (err) {
      logger.error('[LogTab.handleModelSwitch] 모델 전환 실패', { error: err })
      throw err
    }
  }, [hook, onModelChanged])

  // ─── AI 분석 ────────────────────────────────────────────────────
  const handleAnalyze = useCallback(async () => {
    if (!hook.payload) {
      setLocalError('분석할 logcheck 결과가 없습니다 — 먼저 [실행]을 누르세요')
      return
    }
    if (hook.budgetCheck?.status === 'reject') {
      setIsBudgetModalOpen(true)
      return
    }
    setLocalError(null)
    await hook.analyze(question.trim())
    setViewMode('ai')
  }, [hook, question])

  const handleCancel = useCallback(() => { hook.cancel() }, [hook])

  // ─── 결과 export ────────────────────────────────────────────────
  const buildExportContent = useCallback((): string | null => {
    if (!hook.payload) return null
    const p = hook.payload
    const body = viewMode === 'ai' ? hook.result : p.content
    if (!body) return null
    const q = question.trim() || '(없음)'
    const lines = [
      '---',
      `source: ${p.source}`,
      `host: ${p.host ?? '(unknown)'}`,
      `sizeBytes: ${p.sizeBytes}`,
      `lineCount: ${p.lineCount}`,
      `collectedAt: ${p.collectedAt}`,
      `provider: ${provider}`,
      `model: ${currentModel}`,
      `viewMode: ${viewMode}`,
      `question: ${q.replace(/\n/g, ' ')}`,
      '---',
      '',
      viewMode === 'ai' ? '# AI 분석 결과' : '# logcheck 출력',
      '',
      body,
    ]
    return lines.join('\n')
  }, [hook.payload, hook.result, viewMode, question, provider, currentModel])

  const handleCopyResult = useCallback(async () => {
    const body = buildExportContent()
    if (!body) return
    try {
      await navigator.clipboard.writeText(body)
      setCopyState('done')
      window.setTimeout(() => setCopyState('idle'), 1500)
    } catch (err) {
      logger.error('[LogTab.handleCopyResult] 클립보드 쓰기 실패', { error: err })
      setLocalError('클립보드 쓰기에 실패했습니다 (브라우저 권한 확인)')
    }
  }, [buildExportContent])

  const handleDownloadResult = useCallback(() => {
    const body = buildExportContent()
    if (!body || !hook.payload) return
    const filename = `aitty-log_${slugify(hook.payload.source)}_${nowStamp()}.md`
    const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    try {
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
    } finally {
      URL.revokeObjectURL(url)
    }
  }, [buildExportContent, hook.payload])

  // ─── 마크다운 렌더 컴포넌트 ──────────────────────────────────────
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

  const hasShellOutput = !!hook.payload?.content
  const hasAiOutput = !!hook.result
  const showResultPanel = hasShellOutput || hasAiOutput || hook.isFetching || hook.isStreaming

  return (
    <div className="log-tab">
      {/* ─── 파일 경로 ────────────────────────────────────────── */}
      <div className="log-form">
        <label className="log-section-label">로그 파일 경로</label>
        <div className="log-form-row">
          <input
            type="text"
            className="log-path-input"
            value={filePath}
            onChange={e => setFilePath(e.target.value)}
            placeholder="/var/log/syslog"
          />
          <LogPresetSelect currentPath={filePath} onSelect={setFilePath} />
        </div>
      </div>

      {/* ─── 5개 모드 버튼 ───────────────────────────────────── */}
      <div className="log-form">
        <div className="log-mode-grid">
          {MODES.map(m => (
            <button
              key={m}
              type="button"
              className={`log-mode-tab ${activeMode === m ? 'active' : ''}`}
              onClick={() => setActiveMode(m)}
            >
              {modeLabel(m)}
            </button>
          ))}
        </div>

        {/* 모드별 입력 폼 — 활성 모드만 펼침 */}
        {activeMode === 'search' && (
          <div className="log-mode-inputs">
            <div className="log-form-row">
              <input
                type="text"
                className="log-pattern-input"
                value={pattern}
                onChange={e => setPattern(e.target.value)}
                placeholder='예: "OutOfMemory" 또는 "ERROR|FATAL"'
              />
            </div>
            <div className="log-form-row">
              <label className="log-checkbox-label">
                <input type="checkbox" checked={ignoreCase} onChange={e => setIgnoreCase(e.target.checked)} />
                대소문자 무시
              </label>
              <label className="log-time-label">앞 컨텍스트 (-B):</label>
              <input
                type="number" min={0} max={50} value={ctxBefore}
                onChange={e => setCtxBefore(parseInt(e.target.value, 10) || 0)}
                style={{ width: '4em' }}
              />
              <label className="log-time-label">뒤 컨텍스트 (-A):</label>
              <input
                type="number" min={0} max={50} value={ctxAfter}
                onChange={e => setCtxAfter(parseInt(e.target.value, 10) || 0)}
                style={{ width: '4em' }}
              />
            </div>
          </div>
        )}

        {activeMode === 'recent' && (
          <div className="log-mode-inputs">
            <div className="log-form-row">
              <label className="log-time-label">최근</label>
              <input
                type="number" min={1} max={720} value={hours}
                onChange={e => setHours(parseInt(e.target.value, 10) || 1)}
                style={{ width: '5em' }}
              />
              <span>시간 (1~720, 기본 1)</span>
            </div>
          </div>
        )}

        {activeMode === 'range' && (
          <div className="log-mode-inputs">
            <div className="log-form-row">
              <label className="log-time-label">FROM:</label>
              <input type="datetime-local" value={rangeFrom} onChange={e => setRangeFrom(e.target.value)} />
            </div>
            <div className="log-form-row">
              <label className="log-time-label">TO:</label>
              <input type="datetime-local" value={rangeTo} onChange={e => setRangeTo(e.target.value)} />
            </div>
          </div>
        )}

        {activeMode === 'top' && (
          <div className="log-mode-inputs">
            <div className="log-form-row">
              <label className="log-time-label">상위</label>
              <input
                type="number" min={1} max={100} value={topN}
                onChange={e => setTopN(parseInt(e.target.value, 10) || 10)}
                style={{ width: '5em' }}
              />
              <span>개 (1~100, 기본 10)</span>
            </div>
          </div>
        )}

        <div className="log-action-row">
          <button
            type="button"
            className="log-btn log-btn-primary"
            onClick={handleRun}
            disabled={hook.isFetching || hook.isStreaming || !filePath.trim()}
          >
            {hook.isFetching ? '실행 중...' : '실행'}
          </button>
        </div>
      </div>

      {/* ─── 컨텍스트 크기 배너 ─────────────────────────────── */}
      {budgetCheck && (
        <div className={`log-budget-banner ${budgetBannerClass}`}>
          {budgetCheck.status === 'ok' && (
            <span>
              ✓ 현재 모델: <strong>{provider} / {currentModel}</strong> (컨텍스트 크기 {formatBytes(budgetCheck.budget)})
            </span>
          )}
          {budgetCheck.status === 'warn' && (
            <>
              <span>
                ⚠ <strong>{provider} / {currentModel}</strong> 컨텍스트 크기 {formatBytes(budgetCheck.budget)} — {budgetCheck.ratio.toFixed(1)}배 초과
              </span>
              <button type="button" className="log-link-btn" onClick={handleOpenBudgetModal}>옵션 열기</button>
            </>
          )}
          {budgetCheck.status === 'reject' && (
            <>
              <span>
                ⛔ 컨텍스트 크기 초과 — {budgetCheck.ratio.toFixed(1)}배. 분할 분석 필수
              </span>
              <button type="button" className="log-link-btn" onClick={handleOpenBudgetModal}>옵션 열기</button>
            </>
          )}
        </div>
      )}

      {/* ─── 컨텍스트 모달 ─────────────────────────────────── */}
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

      {/* ─── 에러 배너 ─────────────────────────────────────── */}
      {(localError || hook.error) && (
        <div className="log-error-banner">{localError || hook.error}</div>
      )}

      {/* ─── 질문 + AI 분석 ────────────────────────────────── */}
      <div className="log-question-row">
        <textarea
          className="log-question-input"
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="logcheck 결과를 기반으로 AI에게 물을 질문 (선택)"
          rows={2}
        />
        <div className="log-question-buttons">
          <button
            type="button"
            className="log-btn log-btn-primary"
            onClick={handleAnalyze}
            disabled={!hook.payload || hook.isStreaming || hook.isFetching || budgetCheck?.status === 'reject'}
          >
            {hook.isStreaming ? '분석 중...' : 'AI 분석'}
          </button>
          {(hook.isStreaming || hook.isFetching) && (
            <button type="button" className="log-btn log-btn-cancel" onClick={handleCancel}>취소</button>
          )}
        </div>
      </div>

      {/* ─── 결과 패널 (최하단) ─────────────────────────────── */}
      {showResultPanel && (
        <div className="log-result-panel">
          <div className="log-result-toolbar">
            {hasShellOutput && hasAiOutput && (
              <div className="log-result-tabs">
                <button
                  type="button"
                  className={`log-result-tab ${viewMode === 'shell' ? 'active' : ''}`}
                  onClick={() => setViewMode('shell')}
                >
                  셸 출력
                </button>
                <button
                  type="button"
                  className={`log-result-tab ${viewMode === 'ai' ? 'active' : ''}`}
                  onClick={() => setViewMode('ai')}
                >
                  AI 응답
                </button>
              </div>
            )}
            <div className="log-result-toolbar-spacer" />
            <button
              type="button"
              className="log-btn log-btn-tool"
              onClick={handleCopyResult}
              disabled={!hook.payload || hook.isStreaming || hook.isFetching}
              title="결과를 클립보드로 복사 (메타 헤더 포함)"
            >
              {copyState === 'done' ? '✓ 복사됨' : '📋 복사'}
            </button>
            <button
              type="button"
              className="log-btn log-btn-tool"
              onClick={handleDownloadResult}
              disabled={!hook.payload || hook.isStreaming || hook.isFetching}
              title=".md 파일로 저장 (메타 헤더 포함)"
            >
              💾 .md 저장
            </button>
          </div>

          {hook.chunkProgress && viewMode === 'ai' && (
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
            {viewMode === 'shell' ? (
              hook.payload ? (
                <pre className="log-result-codeblock log-result-shell">{hook.payload.content}</pre>
              ) : (
                <span className="log-result-placeholder">실행 중...</span>
              )
            ) : (
              <>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {hook.result || ' '}
                </ReactMarkdown>
                {hook.isStreaming && <span className="streaming-cursor" />}
              </>
            )}
          </div>

          {hook.payload && viewMode === 'shell' && (
            <div className="log-result-meta">
              {hook.payload.source} · {formatBytes(hook.payload.sizeBytes)} · {hook.payload.lineCount.toLocaleString()} 줄
            </div>
          )}
        </div>
      )}
    </div>
  )
}
