import { useEffect, useState, useCallback, useRef } from 'react'
import { config as configBridge, app as appBridge, cli as cliBridge, type CliConnectionInfo } from '@bridge/ipcBridge'
import { logger } from '@utils/logger'
import { SSHTerminal } from '@components/SSHTerminal'
import { AITerminal } from '@components/AITerminal'
import { TitleBar } from '@components/TitleBar'
import { IconSidebar } from '@components/IconSidebar'
import type { AppConfig } from '@app-types/config'
import type { SSHConnection } from '@app-types/ssh'
import './App.css'

const DEFAULT_CONFIG: AppConfig = {
  theme: 'dark',
  fontSize: 12,
  fontFamily: 'Consolas, "Courier New"',
  sshConnections: [],
}

const SPLIT_MIN = 20  // 최소 패널 너비 %
const SPLIT_MAX = 80  // 최대 패널 너비 %

function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [appVersion, setAppVersion] = useState<string>('')
  const [sshConnection, setSshConnection] = useState<SSHConnection | undefined>()
  const [sshConnected, setSshConnected] = useState(false)
  const [splitRatio, setSplitRatio] = useState(50)  // SSH 패널 너비 %
  const [activeTab, setActiveTab] = useState<'chat' | 'cli' | 'security'>('chat')
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [aiStatus, setAiStatus] = useState<{ model: string; configured: boolean; provider: string }>({ model: '', configured: false, provider: '' })
  const [cliAutoConnect, setCliAutoConnect] = useState(false)

  const layoutRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)

  useEffect(() => {
    const initializeApp = async () => {
      try {
        const [loaded, versionResult] = await Promise.allSettled([
          configBridge.load(),
          appBridge.version(),
        ])
        setConfig(loaded.status === 'fulfilled' ? loaded.value : DEFAULT_CONFIG)
        setAppVersion(versionResult.status === 'fulfilled' ? versionResult.value.version : '')
        logger.info('App initialized', { source: loaded.status === 'fulfilled' ? 'ipc' : 'default' })

        // CLI 인자로 전달된 접속 정보 확인 (HiWare/PuTTY 호환)
        try {
          const cliConn = await cliBridge.getConnection()
          if (cliConn) {
            setSshConnection({ host: cliConn.host, port: cliConn.port, username: cliConn.username })
            setCliAutoConnect(true)
            logger.info('CLI auto-connect mode', { host: cliConn.host, port: cliConn.port })
          }
        } catch {
          // CLI 접속 정보 없음 → 일반 GUI 모드
        }
      } catch (error) {
        logger.error('Failed to initialize app', { error })
        setConfig(DEFAULT_CONFIG)
      } finally {
        setIsLoading(false)
      }
    }
    initializeApp()
  }, [])

  // Drag resize handlers
  const handleResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingRef.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !layoutRef.current) return

      const rect = layoutRef.current.getBoundingClientRect()
      const offsetX = e.clientX - rect.left
      const ratio = (offsetX / rect.width) * 100

      setSplitRatio(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio)))
    }

    const onMouseUp = () => {
      if (!isDraggingRef.current) return
      isDraggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  const handleSshConnect = useCallback((conn: SSHConnection) => {
    setSshConnection(conn)
  }, [])

  const handleConnected = useCallback(() => setSshConnected(true), [])
  const handleDisconnected = useCallback(() => setSshConnected(false), [])

  if (isLoading) {
    return (
      <div className="app loading">
        <h1>SSH AI Terminal</h1>
        <p>Initializing...</p>
      </div>
    )
  }

  return (
    <div className="app">
      <TitleBar
        appVersion={appVersion}
        sshConnected={sshConnected}
        sshHost={sshConnection?.host}
        aiModel={aiStatus.model}
        aiConfigured={aiStatus.configured}
      />

      <div className="app-layout" ref={layoutRef}>
        <div className="terminal-panel ssh-panel" style={{ width: `${splitRatio}%` }}>
          <SSHTerminal
            connection={sshConnection}
            cliAutoConnect={cliAutoConnect}
            onRequestConnect={handleSshConnect}
            onConnect={handleConnected}
            onDisconnect={handleDisconnected}
          />
        </div>

        <div
          className="panel-resizer"
          onMouseDown={handleResizerMouseDown}
          title="Drag to resize"
        >
          <div className="resizer-dots">
            <span className="resizer-dot" />
            <span className="resizer-dot" />
            <span className="resizer-dot" />
          </div>
        </div>

        <div className="terminal-panel ai-panel" style={{ flex: 1 }}>
          <IconSidebar
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onSettingsClick={() => setIsSettingsOpen(prev => !prev)}
          />
          <div className="ai-content-area">
            <AITerminal
              sshConnected={sshConnected}
              activeTab={activeTab}
              isSettingsOpen={isSettingsOpen}
              onCloseSettings={() => setIsSettingsOpen(false)}
              onStatusChange={setAiStatus}
            />
          </div>
        </div>
      </div>

      <footer className="status-bar">
        <div className="status-bar-left">
          <span>{sshConnected ? `SSH: ${sshConnection?.host || ''}` : 'SSH: Disconnected'}</span>
          <span className="status-separator">|</span>
          <span>{sshConnection?.username || '\u2014'}</span>
        </div>
        <div className="status-bar-right">
          <span>UTF-8</span>
          <span className="status-separator">|</span>
          <span>&copy; 2026 Aitty</span>
        </div>
      </footer>
    </div>
  )
}

export default App
