import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'
import { useTerminalResize } from '@hooks/useTerminalResize'
import { useAITerminal, charDisplayWidth, isWebView2 } from '@hooks/useAITerminal'
import { ai, ssh } from '@bridge/ipcBridge'
import { logger } from '@utils/logger'
import { SettingsDrawer } from '@components/SettingsDrawer'
import ChatPanel from '@components/ChatPanel'
import SecurityPanel from '@components/SecurityPanel'
import { LogPilotTab } from '@components/LogPilotTab'
import { PresetPasswordModal, type PresetPasswordMode } from '@components/PresetPasswordModal'
import '@styles/chat.css'
import '@styles/log-tab.css'

interface AITerminalProps {
  sshConnected?: boolean
  activeTab: 'chat' | 'cli' | 'security' | 'logpilot'
  isSettingsOpen: boolean
  onCloseSettings: () => void
  onStatusChange?: (status: { model: string; configured: boolean; provider: string }) => void
}

export function AITerminal({ sshConnected, activeTab, isSettingsOpen, onCloseSettings, onStatusChange }: AITerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const chatInputRef = useRef<HTMLTextAreaElement>(null)
  const hook = useAITerminal()
  const {
    termRef,
    inputBufferRef,
    isProcessingRef,
    sendMessageRef,
    handleBuiltinCommandRef,
    writePromptRef,

    isConfigured,
    currentModel,
    isStreaming,
    engineName,
    availableModels,
    isSystemPromptOpen,
    systemPrompt,
    endpointUrl,
    isBusy,
    isDirty,
    isApplySuccess,
    activeProvider,
    apiKey,
    providers,
    saveApiLog,
    allowInsecureSsl,
    presets,
    chatMessages,

    setIsSystemPromptOpen,
    setSystemPrompt,
    setApiKey,
    setSaveApiLog,
    setAllowInsecureSsl,
    setIsDirty,
    setIsApplySuccess,

    handleEndpointChange,
    handleProviderChange,
    handleModelChange,
    handleCheck,
    handleApplySettings,
    handleSavePreset,
    handleLoadPreset,
    handleDeletePreset,
    handleAnalyzeClick,
    handleCancel,
    handleClear,
    sendMessage,

    initializeOnMount,
  } = hook

  const resizeRef = useTerminalResize(() => {
    if (fitAddonRef.current && termRef.current) {
      fitAddonRef.current.fit()
    }
  })

  // 프리셋 암호 입력 모달 상태 — 저장/로드 모두 이 모달로 처리
  const [passwordModal, setPasswordModal] = useState<{
    mode: PresetPasswordMode
    name: string
    error: string | null
    busy: boolean
  } | null>(null)

  const requestSavePreset = useCallback((name: string) => {
    setPasswordModal({ mode: 'save', name, error: null, busy: false })
  }, [])

  const requestLoadPreset = useCallback((name: string) => {
    setPasswordModal({ mode: 'load', name, error: null, busy: false })
  }, [])

  const handlePasswordConfirm = useCallback(async (password: string) => {
    if (!passwordModal) return
    setPasswordModal(m => m ? { ...m, busy: true, error: null } : m)
    const result = passwordModal.mode === 'save'
      ? await handleSavePreset(passwordModal.name, password)
      : await handleLoadPreset(passwordModal.name, password)
    if (result.success) {
      setPasswordModal(null)
    } else {
      // 실패 — 모달 유지하고 에러 표시 (암호 재입력 유도)
      setPasswordModal(m => m ? { ...m, busy: false, error: result.error ?? '처리 실패' } : m)
    }
  }, [passwordModal, handleSavePreset, handleLoadPreset])

  const handlePasswordCancel = useCallback(() => setPasswordModal(null), [])

  // xterm initialization
  useEffect(() => {
    if (!terminalRef.current) return

    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'Consolas, "Courier New", monospace',
      lineHeight: 1.2,
      theme: {
        background: '#1a1a1a',
        foreground: '#e0e0e0',
        cursor: '#00ff00',
        cyan: '#00bcd4',
        yellow: '#ffc107',
        green: '#4caf50',
        red: '#f44336',
      },
      cols: 100,
      rows: 30,
      convertEol: true,
      cursorBlink: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(terminalRef.current)
    fitAddon.fit()

    fitAddonRef.current = fitAddon

    initializeOnMount(term)

    term.onData((data: string) => {
      if (isProcessingRef.current) {
        if (data === '\x03') {
          ai.cancelStream().catch(() => {})
          isProcessingRef.current = false
          term.writeln('\r\n\x1b[33m^C Cancelled\x1b[0m')
          writePromptRef.current()
        }
        return
      }

      if (data === '\r') {
        const command = inputBufferRef.current.trim()
        inputBufferRef.current = ''
        if (!command) { writePromptRef.current(); return }

        handleBuiltinCommandRef.current(command).then(handled => {
          if (handled) {
            writePromptRef.current()
          } else {
            sendMessageRef.current(command).then(() => writePromptRef.current())
          }
        })
      } else if (data === '\u007f' || data === '\b') {
        const chars = [...inputBufferRef.current]
        if (chars.length > 0) {
          const lastChar = chars.pop()!
          inputBufferRef.current = chars.join('')
          const w = charDisplayWidth(lastChar)
          const curX = term.buffer.active.cursorX
          if (curX >= w) {
            term.write(`\x1b[${w}D\x1b[${w}X`)
          } else {
            const targetCol = term.cols - w
            term.write(`\x1b[A\x1b[${targetCol + 1}G\x1b[${w}X`)
          }
        }
      } else if (data === '\x03') {
        inputBufferRef.current = ''
        term.writeln('^C')
        writePromptRef.current()
      } else if (data === '\x0c') {
        term.clear()
        writePromptRef.current()
      } else if (data.charCodeAt(0) >= 32) {
        inputBufferRef.current += data
        term.write(data)
      }
    })

    // drag selection -> clipboard copy
    term.onSelectionChange(() => {
      const selected = term.getSelection()
      if (selected) {
        navigator.clipboard.writeText(selected).catch(() => {})
      }
    })

    // right-click paste
    const containerEl = terminalRef.current
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      if (isProcessingRef.current) return
      navigator.clipboard.readText()
        .then(text => {
          if (text) {
            term.write(text)
            inputBufferRef.current += text
          }
        })
        .catch(() => {
          term.writeln('\r\n\x1b[33m⚠ 클립보드 권한 없음. Ctrl+V를 사용하세요.\x1b[0m')
          writePromptRef.current()
        })
    }
    containerEl?.addEventListener('contextmenu', handleContextMenu)

    logger.info('LLM Terminal initialized')

    return () => {
      containerEl?.removeEventListener('contextmenu', handleContextMenu)
      term.dispose()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Refit xterm when switching to CLI tab
  useEffect(() => {
    if (activeTab === 'cli' && fitAddonRef.current) {
      setTimeout(() => fitAddonRef.current?.fit(), 50)
    }
  }, [activeTab])

  const currentProviderInfo = providers.find(p => p.id === activeProvider)
  const requiresApiKey = currentProviderInfo?.requiresApiKey ?? false
  const providerDisplayName = currentProviderInfo?.name ?? activeProvider

  useEffect(() => {
    onStatusChange?.({
      model: currentModel,
      configured: isConfigured && !(requiresApiKey && !apiKey),
      provider: activeProvider,
    })
  }, [currentModel, isConfigured, requiresApiKey, apiKey, activeProvider, onStatusChange])

  const handleMarkDirty = useCallback(() => {
    setIsDirty(true)
    setIsApplySuccess(false)
  }, [setIsDirty, setIsApplySuccess])

  // Chat tab: send message from input bar
  const handleChatSend = useCallback(() => {
    const textarea = chatInputRef.current
    if (!textarea) return
    const message = textarea.value.trim()
    if (!message || isStreaming || isBusy) return
    textarea.value = ''
    textarea.style.height = '36px'
    sendMessage(message)
  }, [sendMessage, isStreaming, isBusy])

  // Chat tab: Enter to send, Shift+Enter for newline
  const handleChatKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleChatSend()
    }
  }, [handleChatSend])

  // Chat tab: auto-grow textarea
  const handleChatInput = useCallback(() => {
    const textarea = chatInputRef.current
    if (!textarea) return
    textarea.style.height = '36px'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 96)}px`
  }, [])

  // Run command from code block in SSH terminal
  const handleRunCommand = useCallback((command: string) => {
    if (!sshConnected) return
    ssh.shellWrite(command + '\n').catch(() => {})
  }, [sshConnected])

  return (
    <div className="ai-terminal local-llm-terminal">
      <div className="chat-header">
        <div className="chat-header-left">
          <svg className="chat-header-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <span className="chat-header-title">AI Chat</span>
        </div>
        <div className="chat-header-right">
          <span className="chat-header-model">{currentModel}</span>
          <button
            className="chat-header-analyze"
            onClick={handleAnalyzeClick}
            disabled={isBusy}
          >
            AI Analyze
          </button>
        </div>
      </div>

      {/* Tab Content */}
      <div className="tab-content" ref={resizeRef}>
        {/* Chat Tab */}
        <div className={`tab-pane ${activeTab !== 'chat' ? 'hidden' : ''}`}>
          <ChatPanel
            messages={chatMessages}
            isStreaming={isStreaming}
            sshConnected={sshConnected}
            onRunCommand={handleRunCommand}
          />
        </div>

        {/* CLI Tab */}
        <div className={`tab-pane ${activeTab !== 'cli' ? 'hidden' : ''}`}>
          <div className="terminal-container" style={{ flex: 1 }}>
            <div ref={terminalRef} className="terminal-content" />
          </div>
        </div>

        {/* Security Tab */}
        <div className={`tab-pane ${activeTab !== 'security' ? 'hidden' : ''}`}>
          <SecurityPanel sshConnected={sshConnected} />
        </div>

        {/* LogPilot Tab — 초보 운영자용 로그 분석 (Log 탭 대체, Step C) */}
        <div className={`tab-pane ${activeTab !== 'logpilot' ? 'hidden' : ''}`}>
          <LogPilotTab
            provider={activeProvider}
            model={currentModel}
            availableModels={availableModels}
            sshConnected={!!sshConnected}
          />
        </div>
      </div>

      {/* Chat Input Bar (Chat tab only) */}
      {activeTab === 'chat' && (
        <div className="chat-input-bar">
          <textarea
            ref={chatInputRef}
            placeholder="메시지를 입력하세요... (Enter: 전송, Shift+Enter: 줄바꿈)"
            onKeyDown={handleChatKeyDown}
            onInput={handleChatInput}
            disabled={isStreaming || isBusy}
            rows={1}
          />
          <button
            className="chat-input-btn"
            onClick={handleChatSend}
            disabled={isStreaming || isBusy}
          >
            전송
          </button>
          <button
            className="chat-input-btn analyze-btn"
            onClick={handleAnalyzeClick}
            disabled={isBusy}
          >
            AI분석
          </button>
          {isStreaming && (
            <button className="chat-input-btn cancel-btn" onClick={handleCancel}>
              Cancel
            </button>
          )}
        </div>
      )}

      <SettingsDrawer
        isOpen={isSettingsOpen}
        onClose={onCloseSettings}
        activeProvider={activeProvider}
        providers={providers}
        endpointUrl={endpointUrl}
        apiKey={apiKey}
        currentModel={currentModel}
        availableModels={availableModels}
        systemPrompt={systemPrompt}
        saveApiLog={saveApiLog}
        allowInsecureSsl={allowInsecureSsl}
        isBusy={isBusy}
        isDirty={isDirty}
        isApplySuccess={isApplySuccess}
        isSystemPromptOpen={isSystemPromptOpen}
        requiresApiKey={requiresApiKey}
        providerDisplayName={providerDisplayName}
        onProviderChange={handleProviderChange}
        onEndpointChange={handleEndpointChange}
        onApiKeyChange={setApiKey}
        onModelChange={handleModelChange}
        onSystemPromptChange={setSystemPrompt}
        onSaveApiLogChange={setSaveApiLog}
        onAllowInsecureSslChange={setAllowInsecureSsl}
        presets={presets}
        onRequestSavePreset={requestSavePreset}
        onRequestLoadPreset={requestLoadPreset}
        onDeletePreset={handleDeletePreset}
        onCheck={handleCheck}
        onApply={handleApplySettings}
        onToggleSystemPrompt={() => setIsSystemPromptOpen(prev => !prev)}
        onMarkDirty={handleMarkDirty}
      />

      {passwordModal && (
        <PresetPasswordModal
          mode={passwordModal.mode}
          presetName={passwordModal.name}
          errorMessage={passwordModal.error}
          isBusy={passwordModal.busy}
          onConfirm={handlePasswordConfirm}
          onCancel={handlePasswordCancel}
        />
      )}
    </div>
  )
}
