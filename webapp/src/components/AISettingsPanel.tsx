import { useState } from 'react'
import type { AiProvider, AiPresetInfo } from '@bridge/ipcBridge'
import { app as appBridge } from '@bridge/ipcBridge'
import { DEFAULT_ENDPOINT } from '@hooks/useAITerminal'

export interface AISettingsPanelProps {
  activeProvider: string
  providers: AiProvider[]
  endpointUrl: string
  apiKey: string
  currentModel: string
  availableModels: string[]
  systemPrompt: string
  saveApiLog: boolean
  allowInsecureSsl: boolean
  isBusy: boolean
  isDirty: boolean
  /** null = 미시도, true = 성공, false = 실패 */
  isApplySuccess: boolean | null
  isSystemPromptOpen: boolean
  requiresApiKey: boolean
  providerDisplayName: string

  onProviderChange: (provider: string) => void
  onEndpointChange: (value: string) => void
  onApiKeyChange: (value: string) => void
  onModelChange: (model: string) => void
  onSystemPromptChange: (value: string) => void
  onSaveApiLogChange: (value: boolean) => void
  onAllowInsecureSslChange: (value: boolean) => void
  onCheck: () => void
  onApply: () => void
  onToggleSystemPrompt: () => void
  onMarkDirty: () => void

  // AI 프리셋 (AES-256-GCM + 사용자 암호 기반)
  presets: AiPresetInfo[]
  /** 저장 요청 — 부모가 암호 입력 모달을 띄워 최종 저장 처리. */
  onRequestSavePreset: (name: string) => void
  /** 로드 요청 — 부모가 암호 입력 모달을 띄워 최종 복호화 적용. */
  onRequestLoadPreset: (name: string) => void
  onDeletePreset: (name: string) => Promise<boolean>
}

export function AISettingsPanel({
  activeProvider,
  providers,
  endpointUrl,
  apiKey,
  currentModel,
  availableModels,
  systemPrompt,
  saveApiLog,
  allowInsecureSsl,
  isBusy,
  isDirty,
  isApplySuccess,
  isSystemPromptOpen,
  requiresApiKey,
  providerDisplayName,
  onProviderChange,
  onEndpointChange,
  onApiKeyChange,
  onModelChange,
  onSystemPromptChange,
  onSaveApiLogChange,
  onAllowInsecureSslChange,
  onCheck,
  onApply,
  onToggleSystemPrompt,
  onMarkDirty,
  presets,
  onRequestSavePreset,
  onRequestLoadPreset,
  onDeletePreset,
}: AISettingsPanelProps) {
  const [selectedPreset, setSelectedPreset] = useState<string>('')
  const currentProviderInfo = providers.find(p => p.id === activeProvider)
  // OpenAI는 호환 게이트웨이(Shinhan Hands, Azure OpenAI 등)를 위해 endpoint 편집 허용
  const allowEndpointEdit = !requiresApiKey || activeProvider === 'openai'

  const canSavePreset = isApplySuccess === true  // 접속 성공 상태에서만 저장 허용

  const handleSaveClick = () => {
    const name = window.prompt(
      '프리셋 이름을 입력하세요',
      `${activeProvider}-${new Date().toISOString().substring(0, 10)}`
    )
    if (!name?.trim()) return
    onRequestSavePreset(name.trim())
  }

  const handleLoadClick = () => {
    if (!selectedPreset) return
    onRequestLoadPreset(selectedPreset)
  }

  const handleDeleteClick = async () => {
    if (!selectedPreset) return
    if (!window.confirm(`프리셋 '${selectedPreset}'을(를) 삭제하시겠습니까?`)) return
    await onDeletePreset(selectedPreset)
    setSelectedPreset('')
  }

  return (
    <div className="llm-settings-panel">
      <div className="settings-grid">

        {/* AI 프리셋 — 드롭다운 + 로드/삭제/저장 통합 (AES-256-GCM + 사용자 암호) */}
        <div className="form-group" style={{ gridColumn: '1 / -1' }}>
          <label title="AES-256-GCM + 사용자 암호 기반으로 저장되는 AI 설정">🔐 AI 프리셋</label>
          <div className="preset-row" style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <select
              className="preset-select"
              value={selectedPreset}
              onChange={e => setSelectedPreset(e.target.value)}
              disabled={isBusy || presets.length === 0}
              style={{ flex: 1 }}
            >
              <option value="">
                {presets.length === 0 ? '-- 저장된 프리셋 없음 --' : '-- 프리셋 선택 --'}
              </option>
              {presets.map(p => (
                <option key={p.name} value={p.name}>
                  {p.name} ({p.provider}{p.model ? ` / ${p.model}` : ''})
                </option>
              ))}
            </select>
            <button
              type="button"
              className="preset-btn"
              onClick={handleLoadClick}
              disabled={!selectedPreset || isBusy}
              title="선택한 프리셋을 현재 세션에 적용 (암호 필요)"
            >
              📂 로드
            </button>
            <button
              type="button"
              className="preset-btn"
              onClick={handleDeleteClick}
              disabled={!selectedPreset || isBusy}
              title="선택한 프리셋 삭제"
              style={{ color: '#f44336' }}
            >
              🗑
            </button>
            <button
              type="button"
              className="preset-btn"
              onClick={handleSaveClick}
              disabled={!canSavePreset || isBusy}
              title={canSavePreset
                ? '현재 AI 설정을 암호로 암호화하여 저장 (API 키 포함)'
                : 'Apply로 접속 성공 후 저장할 수 있습니다'}
              style={{ opacity: canSavePreset ? 1 : 0.45 }}
            >
              💾 저장
            </button>
          </div>
        </div>

        {/* Provider 선택 */}
        <div className="form-group">
          <label>AI Provider</label>
          <select
            value={activeProvider}
            onChange={(e) => onProviderChange(e.target.value)}
            disabled={isBusy}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {/* Engine Endpoint */}
        <div className="form-group" style={{ opacity: allowEndpointEdit ? 1 : 0.45 }}>
          <label>Engine Endpoint</label>
          <input
            type="text"
            value={allowEndpointEdit ? endpointUrl : (currentProviderInfo?.endpoint ?? '')}
            onChange={(e) => { if (allowEndpointEdit) onEndpointChange(e.target.value) }}
            placeholder={activeProvider === 'openai' ? 'https://api.openai.com' : DEFAULT_ENDPOINT}
            disabled={!allowEndpointEdit || isBusy}
            readOnly={!allowEndpointEdit}
          />
        </div>

        {/* API Key */}
        <div className="form-group">
          <label>{providerDisplayName} API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => { onApiKeyChange(e.target.value); onMarkDirty() }}
            placeholder={
              activeProvider === 'gemini' ? 'AIza...' :
              activeProvider === 'openai' ? 'sk-...' :
              activeProvider === 'claude' ? 'sk-ant-...' : '—'
            }
            autoComplete="off"
            disabled={isBusy}
          />
        </div>

      </div>

      {/* 버튼 행: Check / Apply / Model */}
      <div className="settings-button-row">
        <div className="settings-btn-left">
          <button type="button" onClick={onCheck} disabled={isBusy}>
            Check
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={isBusy}
            title={
              isDirty ? '변경사항을 적용하려면 클릭' :
              isApplySuccess === true ? '✓ 적용 성공' :
              isApplySuccess === false ? '✗ 적용 실패 — 설정을 확인하세요' :
              'Apply'
            }
            style={isDirty
              ? { color: '#ffc107', borderColor: '#ffc107' }
              : isApplySuccess === true
                ? { color: '#4caf50', borderColor: '#4caf50' }
                : isApplySuccess === false
                  ? { color: '#f44336', borderColor: '#f44336' }
                  : {}
            }
          >
            Apply
          </button>
        </div>
        <div className="settings-btn-right">
          <select
            value={currentModel}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={isBusy}
          >
            {!availableModels.includes(currentModel) && (
              <option value={currentModel}>{currentModel}</option>
            )}
            {availableModels.map((model) => (
              <option key={model} value={model}>{model}</option>
            ))}
          </select>
        </div>
      </div>

      {/* 옵션 버튼 행: 시스템 프롬프트 / 로그 폴더 */}
      <div className="settings-option-row">
        <button
          type="button"
          onClick={onToggleSystemPrompt}
          className="settings-btn-sysprompt"
        >
          시스템 프롬프트
        </button>
        <button
          type="button"
          className="settings-btn-sysprompt"
          title="진단 로그 폴더 열기 — ai_api.log 파일을 AI 담당자에게 전달하세요."
          onClick={() => { appBridge.openLogFolder().catch(() => {}) }}
          style={{ marginLeft: 'auto' }}
        >
          📋 로그
        </button>
      </div>

      {/* 체크박스 1행: 로그저장 */}
      <div className="settings-option-row">
        <label className="settings-log-label">
          <input
            type="checkbox"
            checked={saveApiLog}
            onChange={(e) => onSaveApiLogChange(e.target.checked)}
          />
          로그저장
        </label>
      </div>

      {/* 체크박스 2행: SSL 검증 건너뛰기 */}
      <div className="settings-option-row">
        <label
          className="settings-log-label"
          title="내부망 자체서명 인증서 허용. 일반 인터넷 사용 시 비활성화 권장."
        >
          <input
            type="checkbox"
            checked={allowInsecureSsl}
            onChange={(e) => onAllowInsecureSslChange(e.target.checked)}
          />
          SSL 검증 건너뛰기
        </label>
      </div>

      {isSystemPromptOpen && (
        <div className="form-group prompt-group">
          <label>System Prompt</label>
          <textarea
            value={systemPrompt}
            onChange={(e) => { onSystemPromptChange(e.target.value); onMarkDirty() }}
            rows={3}
          />
        </div>
      )}
    </div>
  )
}
