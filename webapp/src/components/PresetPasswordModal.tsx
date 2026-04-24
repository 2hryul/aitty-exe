import { useCallback, useEffect, useRef, useState } from 'react'

export type PresetPasswordMode = 'save' | 'load'

export interface PresetPasswordModalProps {
  mode: PresetPasswordMode
  presetName: string
  /** 부모가 await으로 결과를 받을 수 있게 Promise 반환. 복호화/저장 실패는 부모가 이 값을 다시 모달에 전달. */
  onConfirm: (password: string) => void | Promise<void>
  onCancel: () => void
  /** 부모에서 온 최근 에러(예: "암호가 일치하지 않습니다"). null이면 에러 표시 없음. */
  errorMessage?: string | null
  isBusy?: boolean
}

/**
 * AI 프리셋 암호 입력 모달.
 * - save 모드: 암호 + 암호 확인 두 필드. 일치 검증, 최소 4자.
 * - load 모드: 암호 한 필드. Enter 키로 확인.
 * - Esc: 취소.
 */
export function PresetPasswordModal({
  mode,
  presetName,
  onConfirm,
  onCancel,
  errorMessage = null,
  isBusy = false,
}: PresetPasswordModalProps) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 부모가 내려준 에러는 localError를 덮어씀
  useEffect(() => { setLocalError(errorMessage) }, [errorMessage])

  useEffect(() => {
    inputRef.current?.focus()
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isBusy) onCancel()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onCancel, isBusy])

  const handleSubmit = useCallback(async () => {
    if (isBusy) return
    if (!password) {
      setLocalError('암호를 입력하세요.')
      return
    }
    if (mode === 'save') {
      if (password.length < 4) {
        setLocalError('암호는 최소 4자 이상이어야 합니다.')
        return
      }
      if (password !== confirmPassword) {
        setLocalError('암호와 확인이 일치하지 않습니다.')
        return
      }
    }
    setLocalError(null)
    await onConfirm(password)
  }, [password, confirmPassword, mode, onConfirm, isBusy])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); handleSubmit() }
  }

  return (
    <div className="log-budget-modal-backdrop" role="dialog" aria-modal="true">
      <div className="log-budget-modal" style={{ width: 'min(420px, 92vw)' }}>
        <header className="log-budget-modal-header">
          <h3>{mode === 'save' ? '🔐 프리셋 저장 — 암호 설정' : '🔓 프리셋 불러오기 — 암호 입력'}</h3>
          <button
            type="button"
            className="log-budget-modal-close"
            onClick={onCancel}
            title="취소"
            disabled={isBusy}
          >
            ×
          </button>
        </header>

        <div className="log-budget-modal-body">
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 4 }}>프리셋 이름</div>
            <div style={{ fontWeight: 600 }}>{presetName}</div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>암호</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                ref={inputRef}
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={e => { setPassword(e.target.value); setLocalError(null) }}
                onKeyDown={onKeyDown}
                autoComplete="new-password"
                disabled={isBusy}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                title={showPw ? '숨기기' : '표시'}
                disabled={isBusy}
                style={{ padding: '4px 8px' }}
              >
                {showPw ? '🙈' : '👁'}
              </button>
            </div>
          </div>

          {mode === 'save' && (
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>암호 확인</label>
              <input
                type={showPw ? 'text' : 'password'}
                value={confirmPassword}
                onChange={e => { setConfirmPassword(e.target.value); setLocalError(null) }}
                onKeyDown={onKeyDown}
                autoComplete="new-password"
                disabled={isBusy}
                style={{ width: '100%' }}
              />
            </div>
          )}

          {localError && (
            <div
              role="alert"
              style={{
                marginTop: 8,
                padding: '8px 10px',
                background: 'rgba(244,67,54,0.12)',
                border: '1px solid #f44336',
                borderRadius: 4,
                color: '#f44336',
                fontSize: 13,
              }}
            >
              {localError}
            </div>
          )}

          <div style={{
            marginTop: 8,
            padding: '8px 10px',
            background: 'rgba(255,193,7,0.08)',
            borderLeft: '3px solid #ffc107',
            fontSize: 12,
            opacity: 0.85,
            lineHeight: 1.4,
          }}>
            {mode === 'save'
              ? 'API 키는 이 암호로 AES-256-GCM 암호화되어 저장됩니다. 암호를 분실하면 복구할 수 없습니다.'
              : '저장 시 사용한 암호를 입력하세요. 암호가 일치해야만 API 키가 복호화됩니다.'}
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button
              type="button"
              className="log-budget-btn"
              onClick={onCancel}
              disabled={isBusy}
            >
              취소
            </button>
            <button
              type="button"
              className="log-budget-btn log-budget-btn-primary"
              onClick={handleSubmit}
              disabled={isBusy}
            >
              {isBusy ? '처리 중...' : (mode === 'save' ? '저장' : '불러오기')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
