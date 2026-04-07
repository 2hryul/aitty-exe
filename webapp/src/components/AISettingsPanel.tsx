import type { AiProvider } from '@bridge/ipcBridge'
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
  isBusy: boolean
  isDirty: boolean
  isApplySuccess: boolean
  isSystemPromptOpen: boolean
  requiresApiKey: boolean
  providerDisplayName: string

  onProviderChange: (provider: string) => void
  onEndpointChange: (value: string) => void
  onApiKeyChange: (value: string) => void
  onModelChange: (model: string) => void
  onSystemPromptChange: (value: string) => void
  onSaveApiLogChange: (value: boolean) => void
  onCheck: () => void
  onApply: () => void
  onToggleSystemPrompt: () => void
  onMarkDirty: () => void
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
  onCheck,
  onApply,
  onToggleSystemPrompt,
  onMarkDirty,
}: AISettingsPanelProps) {
  const currentProviderInfo = providers.find(p => p.id === activeProvider)

  return (
    <div className="llm-settings-panel">
      <div className="settings-grid">

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
        <div className="form-group" style={{ opacity: requiresApiKey ? 0.45 : 1 }}>
          <label>Engine Endpoint</label>
          <input
            type="text"
            value={requiresApiKey ? (currentProviderInfo?.endpoint ?? '') : endpointUrl}
            onChange={(e) => { if (!requiresApiKey) onEndpointChange(e.target.value) }}
            placeholder={DEFAULT_ENDPOINT}
            disabled={requiresApiKey || isBusy}
            readOnly={requiresApiKey}
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
            style={isDirty
              ? { color: '#ffc107', borderColor: '#ffc107' }
              : isApplySuccess
                ? { color: '#4caf50', borderColor: '#4caf50' }
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

      {/* 옵션 행: 시스템 프롬프트 / 로그저장 */}
      <div className="settings-option-row">
        <button
          type="button"
          onClick={onToggleSystemPrompt}
          className="settings-btn-sysprompt"
        >
          시스템 프롬프트
        </button>
        <label className="settings-log-label">
          <input
            type="checkbox"
            checked={saveApiLog}
            onChange={(e) => onSaveApiLogChange(e.target.checked)}
          />
          로그저장
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
