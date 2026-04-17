import { useCallback, useState } from 'react'
import type { BudgetCheck } from '@utils/logBudget'

interface LogBudgetModalProps {
  budgetCheck: BudgetCheck
  currentProvider: string
  currentModel: string
  availableModels: string[]
  onSelectSplit: () => void
  onSelectTruncate: () => void
  onSelectModelSwitch: (newModel: string) => Promise<void>
  onDismiss: () => void
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function LogBudgetModal({
  budgetCheck,
  currentProvider,
  currentModel,
  availableModels,
  onSelectSplit,
  onSelectTruncate,
  onSelectModelSwitch,
  onDismiss,
}: LogBudgetModalProps) {
  const [selectedModel, setSelectedModel] = useState<string>(currentModel)
  const [isSwitching, setIsSwitching] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)

  const isReject = budgetCheck.status === 'reject'
  const canDismiss = budgetCheck.status === 'warn'

  const handleSwitch = useCallback(async () => {
    if (!selectedModel || selectedModel === currentModel) return
    setIsSwitching(true)
    setSwitchError(null)
    try {
      await onSelectModelSwitch(selectedModel)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setSwitchError(`모델 전환 실패 — ${msg}`)
    } finally {
      setIsSwitching(false)
    }
  }, [selectedModel, currentModel, onSelectModelSwitch])

  return (
    <div className="log-budget-modal-backdrop" role="dialog" aria-modal="true">
      <div className="log-budget-modal">
        <header className="log-budget-modal-header">
          <h3>{isReject ? '⛔ 예산 초과 (분할 필수)' : '⚠ 예산 경고'}</h3>
          {canDismiss && (
            <button
              type="button"
              className="log-budget-modal-close"
              onClick={onDismiss}
              title="닫기"
            >
              ×
            </button>
          )}
        </header>

        <div className="log-budget-modal-body">
          <div className="log-budget-summary">
            <div>
              <strong>현재 모델</strong>: {currentProvider} / {currentModel}
            </div>
            <div>
              <strong>예산</strong>: {formatBytes(budgetCheck.budget)}
              &nbsp;|&nbsp;
              <strong>로그 크기</strong>: {formatBytes(budgetCheck.sizeBytes)}
              &nbsp;|&nbsp;
              <strong>비율</strong>: {budgetCheck.ratio.toFixed(2)}배
            </div>
            <div>
              <strong>제안 청크 수</strong>: {budgetCheck.suggestedChunks}개
            </div>
          </div>

          <section className="log-budget-options">
            <div className="log-budget-option">
              <h4>1. 분할 분석</h4>
              <p>로그를 {budgetCheck.suggestedChunks}개로 쪼개 순차 분석 후 종합합니다. (시간 오래 걸림)</p>
              <button
                type="button"
                className="log-budget-btn log-budget-btn-primary"
                onClick={onSelectSplit}
              >
                분할 분석 시작
              </button>
            </div>

            <div className="log-budget-option">
              <h4>2. 뒤쪽만 자르기</h4>
              <p>최신 {formatBytes(budgetCheck.budget)} 만 남기고 앞부분은 버립니다. 즉시 분석 가능.</p>
              <button
                type="button"
                className="log-budget-btn"
                onClick={onSelectTruncate}
              >
                자르고 분석
              </button>
            </div>

            <div className="log-budget-option">
              <h4>3. 모델 전환</h4>
              <p>더 큰 컨텍스트 모델로 전환 후 재평가합니다.</p>
              <div className="log-budget-switch-row">
                <select
                  value={selectedModel}
                  onChange={e => setSelectedModel(e.target.value)}
                  disabled={isSwitching}
                >
                  {availableModels.length === 0 && (
                    <option value="">(가용 모델 없음)</option>
                  )}
                  {availableModels.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="log-budget-btn"
                  onClick={handleSwitch}
                  disabled={isSwitching || selectedModel === currentModel}
                >
                  {isSwitching ? '전환 중...' : '전환'}
                </button>
              </div>
              {switchError && <div className="log-budget-error">{switchError}</div>}
            </div>
          </section>

          {isReject && (
            <p className="log-budget-notice">
              현재 모델로는 직접 분석이 불가합니다. 위 3개 옵션 중 하나를 선택하세요.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
