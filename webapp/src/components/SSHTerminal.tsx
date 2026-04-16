import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'
import { useSSHConnection } from '@hooks/useSSHConnection'
import { useTerminalResize } from '@hooks/useTerminalResize'
import { SSHConnection } from '@app-types/ssh'
import { logger } from '@utils/logger'
import { checkCommandSafety, type SafetyResult } from '@utils/commandSafety'
import { ssh as sshBridge, keys as keysBridge, cli as cliBridge } from '@bridge/ipcBridge'
import '../styles/terminal.css'

export interface SSHTerminalProps {
  connection?: SSHConnection
  cliAutoConnect?: boolean
  onRequestConnect?: (conn: SSHConnection) => void
  onConnect?: () => void
  onDisconnect?: () => void
  autoConnect?: boolean
}

const POLL_INTERVAL_MIN = 50      // ms — data present
const POLL_INTERVAL_MAX = 200     // ms — idle ceiling (500→200: 키입력 지연 축소)
const POLL_INTERVAL_STEP = 30     // ms — backoff increment per empty read
const HEALTH_CHECK_INTERVAL = 3_000  // ms — exit 후 빠른 disconnect 감지
const DEFAULT_SSH_HOST = import.meta.env.VITE_DEFAULT_SSH_HOST || ''
const DEFAULT_SSH_PORT = import.meta.env.VITE_DEFAULT_SSH_PORT || '22'
const DEFAULT_SSH_USERNAME = import.meta.env.VITE_DEFAULT_SSH_USERNAME || ''

export function SSHTerminal({ connection, cliAutoConnect = false, onRequestConnect, onConnect, onDisconnect, autoConnect = false }: SSHTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollIntervalRef = useRef(POLL_INTERVAL_MIN)
  const pollFnRef = useRef<(() => void) | null>(null)        // poll 함수 참조
  const acceleratePollRef = useRef<(() => void) | null>(null) // 키입력 시 폴링 가속
  const healthCheckTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isPollingRef = useRef(false)

  // ── 위험 명령어 통제: 입력 버퍼 + 확인 모드 ──
  const lineBufferRef = useRef('')
  const pendingCommandRef = useRef('')
  const pendingConfirmRef = useRef(false)
  const pendingConfirmBufferRef = useRef('')

  const { state: sshState, connect, disconnect, shellWrite, shellRead } = useSSHConnection()
  const shellWriteRef = useRef(shellWrite)
  const [showConnectForm, setShowConnectForm] = useState(true)
  const [availableKeys, setAvailableKeys] = useState<string[]>([])
  const [formData, setFormData] = useState({
    host: DEFAULT_SSH_HOST,
    port: DEFAULT_SSH_PORT,
    username: DEFAULT_SSH_USERNAME,
    password: '',
    privateKey: '',
  })

  // Fetch available SSH keys on mount
  useEffect(() => {
    keysBridge.list().then(result => {
      if (result.keys?.length) setAvailableKeys(result.keys)
    }).catch(() => { /* key listing not critical */ })
  }, [])

  // Keep ref in sync with latest shellWrite (avoids stale closure in onData)
  useEffect(() => {
    shellWriteRef.current = shellWrite
  }, [shellWrite])

  const resizeRef = useTerminalResize(() => {
    if (fitAddonRef.current && termRef.current) {
      fitAddonRef.current.fit()
    }
  })

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
    isPollingRef.current = false
  }, [])

  // Shell output polling (adaptive: fast when data present, slow when idle)
  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return
    pollIntervalRef.current = POLL_INTERVAL_MIN

    const poll = async () => {
      if (isPollingRef.current) {
        pollTimerRef.current = setTimeout(poll, pollIntervalRef.current)
        return
      }
      isPollingRef.current = true

      try {
        const data = await shellRead()
        if (data && termRef.current) {
          termRef.current.write(data)
          pollIntervalRef.current = POLL_INTERVAL_MIN // data received — fast
        } else {
          // no data — gradually back off
          pollIntervalRef.current = Math.min(
            pollIntervalRef.current + POLL_INTERVAL_STEP,
            POLL_INTERVAL_MAX,
          )
        }
      } catch {
        // IPC 일시 에러 → 폴링 중단 대신 백오프 후 재시도
        pollIntervalRef.current = POLL_INTERVAL_MAX
      } finally {
        isPollingRef.current = false
      }

      // schedule next poll only if not stopped
      if (pollTimerRef.current !== null) {
        pollTimerRef.current = setTimeout(poll, pollIntervalRef.current)
      }
    }

    pollFnRef.current = poll

    // sentinel value to indicate "running" before first setTimeout fires
    pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MIN)
  }, [shellRead, stopPolling])

  // 키 입력 시 폴링 즉시 가속 — 유휴 백오프 상태에서 첫 글자 지연 제거
  const acceleratePolling = useCallback(() => {
    pollIntervalRef.current = POLL_INTERVAL_MIN
    if (pollTimerRef.current && pollFnRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = setTimeout(pollFnRef.current, POLL_INTERVAL_MIN)
    }
  }, [])

  // ref 동기화
  useEffect(() => {
    acceleratePollRef.current = acceleratePolling
  }, [acceleratePolling])

  // ── 10초 SSH 헬스체크 ────────────────────────────────────────
  const stopHealthCheck = useCallback(() => {
    if (healthCheckTimerRef.current) {
      clearInterval(healthCheckTimerRef.current)
      healthCheckTimerRef.current = null
    }
  }, [])

  const startHealthCheck = useCallback((showBannerFn: (t: Terminal) => void) => {
    if (healthCheckTimerRef.current) return
    healthCheckTimerRef.current = setInterval(async () => {
      try {
        const { isConnected } = await sshBridge.state()
        if (!isConnected) {
          stopHealthCheck()
          stopPolling()
          await disconnect()  // sshState.isConnected → false → 배지 즉시 업데이트
          const term = termRef.current
          if (term) {
            term.writeln('\r\n\x1b[31m⚠ SSH 연결이 끊어졌습니다.\x1b[0m')
            setTimeout(() => { term.clear(); showBannerFn(term) }, 2000)
          }
          setShowConnectForm(true)
          onDisconnect?.()
        }
      } catch { /* IPC error - skip */ }
    }, HEALTH_CHECK_INTERVAL)
  }, [stopHealthCheck, stopPolling, disconnect, onDisconnect])

  // Cleanup on unmount
  useEffect(() => {
    return () => { stopPolling(); stopHealthCheck() }
  }, [stopPolling, stopHealthCheck])

  const showBanner = (term: Terminal) => {
    const C = '\x1b[36m'   // cyan
    const D = '\x1b[2;36m' // dim cyan
    const G = '\x1b[32m'   // green
    const Y = '\x1b[33m'   // yellow
    const R = '\x1b[0m'    // reset

    // ASCII 아트 (pyfiglet standard font, 각 줄 57자)
    const art = [
      ' ____  _   _ ___ _   _ _   _    _    _   _   ____  ____',
      '/ ___|| | | |_ _| \\ | | | | |  / \\  | \\ | | |  _ \\/ ___|',
      '\\___ \\| |_| || ||  \\| | |_| | / _ \\ |  \\| | | | | \\___ \\',
      ' ___) |  _  || || |\\  |  _  |/ ___ \\| |\\  | | |_| |___) |',
      '|____/|_| |_|___|_| \\_|_| |_/_/   \\_\\_| \\_| |____/|____/',
    ]
    const separator = '──────────────────────────────────────────────────────────────'
    const tagline = 'SSH AI Terminal  │  Powered by Arti'
    const org = '신한DS AX본부'
    const hint = 'Enter connection details above and press Connect.'

    // 터미널 너비 기준 중앙 정렬 헬퍼
    const cols = term.cols || 120
    const pad = (text: string) => {
      const visible = text.replace(/\x1b\[[0-9;]*m/g, '')  // ANSI 제거 후 길이
      const left = Math.max(0, Math.floor((cols - visible.length) / 2))
      return ' '.repeat(left) + text
    }

    term.writeln('')
    art.forEach(line => term.writeln(pad(`${C}${line}${R}`)))
    term.writeln('')
    term.writeln(pad(`${D}${separator}${R}`))
    term.writeln(pad(`${G}${tagline}${R}`))
    term.writeln(pad(`${Y}${org}${R}`))
    term.writeln(pad(`${D}${separator}${R}`))
    term.writeln('')
    term.writeln(pad(`${D}${hint}${R}`))
    term.writeln('')
  }

  // Initialize xterm.js
  useEffect(() => {
    if (!terminalRef.current) return

    const term = new Terminal({
      fontSize: 13,
      fontFamily: '"Cascadia Code", "D2Coding", "Consolas", monospace',
      lineHeight: 1.2,
      theme: {
        background: '#012456',
        foreground: '#CCCCCC',
        cursor: '#CCCCCC',
        black: '#0C0C0C',
        red: '#C50F1F',
        green: '#16C60C',
        yellow: '#C19C00',
        blue: '#3B78FF',
        magenta: '#881798',
        cyan: '#3A96DD',
        white: '#CCCCCC',
        brightBlack: '#767676',
        brightRed: '#E74856',
        brightGreen: '#16C60C',
        brightYellow: '#F9F1A5',
        brightBlue: '#3B78FF',
        brightMagenta: '#B4009E',
        brightCyan: '#61D6D6',
        brightWhite: '#F2F2F2',
      },
      cols: 120,
      rows: 40,
      cursorBlink: true,
      scrollback: 5000,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(terminalRef.current)
    fitAddon.fit()

    termRef.current = term
    fitAddonRef.current = fitAddon

    showBanner(term)

    // ── 위험 명령어 통제: 터미널 ANSI 경고 출력 ──
    const writeSafetyBlock = (t: Terminal, safety: SafetyResult) => {
      t.write('\r\n')
      t.writeln('\x1b[31m\u{1F6D1} BLOCKED: ' + (safety.reason || 'Dangerous command') + '\x1b[0m')
      if (safety.alternative) {
        t.writeln('\x1b[33m\u{1F4A1} 안전한 대안: ' + safety.alternative + '\x1b[0m')
      }
      t.write('\r\n')
    }

    const writeSafetyCaution = (t: Terminal, safety: SafetyResult) => {
      t.write('\r\n')
      t.writeln('\x1b[33m\u{1F7E0} WARNING: ' + (safety.reason || 'Potentially dangerous') + '\x1b[0m')
      t.writeln('\x1b[33m"yes" + Enter 로 실행, 다른 키로 취소\x1b[0m')
    }

    const writeSafetyWarning = (t: Terminal, safety: SafetyResult) => {
      t.write('\r\n')
      t.writeln('\x1b[33m\u{1F7E1} ' + (safety.reason || 'Exercise caution') + '\x1b[0m')
    }

    // ── 위험 명령어 통제: caution 확인 입력 처리 ──
    const handleConfirmInput = (data: string, t: Terminal) => {
      if (data === '\r') {
        const answer = pendingConfirmBufferRef.current.trim().toLowerCase()
        if (answer === 'yes') {
          pendingConfirmRef.current = false
          const cmd = pendingCommandRef.current
          pendingCommandRef.current = ''
          pendingConfirmBufferRef.current = ''
          // 원본 명령 재전송
          shellWriteRef.current(cmd + '\r').catch(() => {})
          acceleratePollRef.current?.()
        } else {
          pendingConfirmRef.current = false
          pendingCommandRef.current = ''
          pendingConfirmBufferRef.current = ''
          t.writeln('\r\n\x1b[32m\u2713 Cancelled.\x1b[0m')
          shellWriteRef.current('\x03').catch(() => {})
        }
        return
      }
      if (data === '\u007f' || data === '\b') {
        if (pendingConfirmBufferRef.current.length > 0) {
          pendingConfirmBufferRef.current = pendingConfirmBufferRef.current.slice(0, -1)
          t.write('\b \b')
        }
        return
      }
      if (data === '\x03') {
        pendingConfirmRef.current = false
        pendingCommandRef.current = ''
        pendingConfirmBufferRef.current = ''
        t.writeln('\r\n\x1b[32m\u2713 Cancelled.\x1b[0m')
        shellWriteRef.current('\x03').catch(() => {})
        return
      }
      if (data.length === 1 && data >= ' ') {
        pendingConfirmBufferRef.current += data
        t.write(data)
      }
    }

    // Forward keystrokes with safety interception
    term.onData((data: string) => {
      // caution 확인 모드 진입 중이면 별도 처리
      if (pendingConfirmRef.current) {
        handleConfirmInput(data, term)
        return
      }

      // Enter 키: 안전 검사 실행
      if (data === '\r') {
        const command = lineBufferRef.current.trim()
        lineBufferRef.current = ''

        if (command.length > 0) {
          const safety = checkCommandSafety(command)

          if (safety.level === 'danger') {
            writeSafetyBlock(term, safety)
            shellWriteRef.current('\x03').catch(() => {})
            return
          }

          if (safety.level === 'caution') {
            writeSafetyCaution(term, safety)
            pendingCommandRef.current = command
            pendingConfirmRef.current = true
            pendingConfirmBufferRef.current = ''
            return
          }

          if (safety.level === 'warning') {
            writeSafetyWarning(term, safety)
          }
        }

        // safe 또는 warning-통과: Enter 전달
        shellWriteRef.current(data).catch(err => {
          logger.error('Shell write error', { error: err })
        })
        acceleratePollRef.current?.()
        return
      }

      // 버퍼 추적: 키 종류별 처리
      if (data === '\u007f' || data === '\b') {
        lineBufferRef.current = lineBufferRef.current.slice(0, -1)
      } else if (data === '\x03' || data === '\x15') {
        // Ctrl+C, Ctrl+U: 버퍼 초기화
        lineBufferRef.current = ''
      } else if (data === '\x17') {
        // Ctrl+W: 마지막 단어 삭제
        lineBufferRef.current = lineBufferRef.current.replace(/\S+\s*$/, '')
      } else if (data.startsWith('\x1b')) {
        // Escape 시퀀스 (방향키, history recall 등): 버퍼 리셋
        lineBufferRef.current = ''
      } else if (data.length > 1) {
        // 멀티 문자 붙여넣기: 라인 포함 시 검사
        if (data.includes('\r') || data.includes('\n')) {
          const fullPaste = lineBufferRef.current + data
          const safety = checkCommandSafety(fullPaste.replace(/\r/g, '\n'))
          if (safety.level === 'danger') {
            writeSafetyBlock(term, safety)
            shellWriteRef.current('\x03').catch(() => {})
            lineBufferRef.current = ''
            return
          }
        }
        lineBufferRef.current += data.replace(/[\r\n]/g, '')
      } else if (data >= ' ') {
        // 일반 인쇄 가능 문자
        lineBufferRef.current += data
      }

      // 셸에 전달
      shellWriteRef.current(data).catch(err => {
        logger.error('Shell write error', { error: err })
      })
      acceleratePollRef.current?.()
    })

    // Send terminal resize to SSH server
    term.onResize(({ cols, rows }) => {
      sshBridge.resize(cols, rows).catch(() => { /* resize best-effort */ })
    })

    // 드래그 선택 → 클립보드 자동 복사
    term.onSelectionChange(() => {
      const selected = term.getSelection()
      if (selected) {
        navigator.clipboard.writeText(selected).catch(() => {})
      }
    })

    // 우클릭 → 클립보드에서 붙여넣기 (위험 명령어 검사 포함)
    const containerEl = terminalRef.current
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      navigator.clipboard.readText()
        .then(text => {
          if (!text) return
          const fullCommand = lineBufferRef.current + text
          const safety = checkCommandSafety(fullCommand.replace(/\r/g, '\n'))
          if (safety.level === 'danger') {
            writeSafetyBlock(term, safety)
            return
          }
          lineBufferRef.current += text.replace(/[\r\n]/g, '')
          shellWriteRef.current(text).catch(() => {})
        })
        .catch(() => {
          term.writeln('\r\n\x1b[33m⚠ 클립보드 권한 없음. Ctrl+V를 사용하세요.\x1b[0m')
        })
    }
    containerEl?.addEventListener('contextmenu', handleContextMenu)
    // 터미널 영역 클릭 시 xterm.js 포커스 복원 — AI 패널 이동 후 돌아올 때 즉시 입력 가능
    const handleClick = () => term.focus()
    containerEl?.addEventListener('click', handleClick)
    // AI 스트리밍 종료 시 포커스 복원 — 회색 화면 복구 후 SSH 입력 즉시 활성화
    const handleStreamingEnd = () => term.focus()
    window.addEventListener('ai-streaming-end', handleStreamingEnd)

    logger.info('Terminal initialized')

    return () => {
      containerEl?.removeEventListener('contextmenu', handleContextMenu)
      containerEl?.removeEventListener('click', handleClick)
      window.removeEventListener('ai-streaming-end', handleStreamingEnd)
      term.dispose()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-connect when connection prop changes
  useEffect(() => {
    if (connection && !cliAutoConnect && !sshState.isConnected && !sshState.isConnecting) {
      handleConnect(connection)
    }
  }, [connection]) // eslint-disable-line react-hooks/exhaustive-deps

  // CLI 자동접속 (HiWare/PuTTY 호환) — 비밀번호가 IPC를 넘지 않고 C# 메모리에서 직접 사용
  useEffect(() => {
    if (!cliAutoConnect || sshState.isConnected || sshState.isConnecting) return

    const doCliConnect = async () => {
      try {
        termRef.current?.writeln(`\x1b[33mConnecting to ${connection?.host}:${connection?.port}...\x1b[0m`)

        const result = await cliBridge.autoConnect()

        if (!result.success) {
          throw new Error(result.error || 'CLI auto-connect failed')
        }

        termRef.current?.clear()
        termRef.current?.writeln(`\x1b[32m✓ Connected to ${connection?.host}:${connection?.port} as ${connection?.username}\x1b[0m`)
        termRef.current?.writeln('')

        setShowConnectForm(false)
        onConnect?.()
        startPolling()
        startHealthCheck(showBanner)
        setTimeout(() => termRef.current?.focus(), 50)
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Connection failed'
        termRef.current?.writeln(`\x1b[31mCLI auto-connect failed: ${msg}\x1b[0m`)
        termRef.current?.writeln('\x1b[33mFalling back to manual connection form.\x1b[0m')
        // 폼에 CLI 접속 정보 사전입력
        if (connection) {
          setFormData(prev => ({
            ...prev,
            host: connection.host,
            port: String(connection.port),
            username: connection.username,
          }))
        }
        setShowConnectForm(true)
      }
    }

    doCliConnect()
  }, [cliAutoConnect]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleConnect = async (conn?: SSHConnection) => {
    const target = conn || {
      host: formData.host,
      port: parseInt(formData.port) || 22,
      username: formData.username,
      password: formData.password || undefined,
      privateKey: formData.privateKey || undefined,
    }

    if (!target.host || !target.username) {
      termRef.current?.writeln('\x1b[31mError: Host and username are required\x1b[0m')
      return
    }

    try {
      termRef.current?.writeln(`\x1b[33mConnecting to ${target.host}:${target.port}...\x1b[0m`)

      await connect(target)

      // 배너 지우고 접속 정보 출력
      termRef.current?.clear()
      termRef.current?.writeln(`\x1b[32m✓ Connected to ${target.host}:${target.port} as ${target.username}\x1b[0m`)
      termRef.current?.writeln('')

      setShowConnectForm(false)
      onRequestConnect?.(target)
      onConnect?.()

      // Start polling for shell output (MOTD, prompt, etc.)
      startPolling()
      startHealthCheck(showBanner)
      // WebView2 렌더 사이클 후 xterm.js 포커스 확보 — 접속 후 즉시 타이핑 가능
      setTimeout(() => termRef.current?.focus(), 50)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Connection failed'
      termRef.current?.writeln(`\x1b[31mFailed: ${msg}\x1b[0m`)
    }
  }

  const handleDisconnect = async () => {
    try {
      stopHealthCheck()
      stopPolling()
      await disconnect()
      // 배너 재표시
      if (termRef.current) {
        termRef.current.clear()
        showBanner(termRef.current)
      }
      setShowConnectForm(true)
      onDisconnect?.()
    } catch (error) {
      logger.error('Disconnect error', { error })
    }
  }

  const handleClear = () => {
    termRef.current?.clear()
  }

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    handleConnect()
  }

  return (
    <div className="ssh-terminal">
      <div className="ssh-panel-header">
        <div className="ssh-panel-header-left">
          <svg className="ssh-panel-header-icon" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span className="ssh-panel-header-title">SSH TERMINAL</span>
        </div>
        <div className="ssh-panel-header-right">
          {sshState.isConnected ? (
            <>
              <span className="ssh-status-badge ssh-status-connected">
                <span className="ssh-status-dot" /> Connected
              </span>
              <button className="ssh-btn-header" onClick={handleDisconnect}>Disconnect</button>
              <button className="ssh-btn-header" onClick={handleClear}>Clear</button>
            </>
          ) : sshState.isConnecting ? (
            <span className="ssh-status-badge ssh-status-connecting">Connecting...</span>
          ) : (
            <span className="ssh-status-badge ssh-status-disconnected">Disconnected</span>
          )}
        </div>
      </div>

      {showConnectForm && !sshState.isConnected && (
        <form className="ssh-connect-form" onSubmit={handleFormSubmit}>
          <div className="ssh-form-grid">
            <div className="ssh-form-field">
              <label className="ssh-form-label">Host</label>
              <input
                type="text"
                className="ssh-form-input"
                value={formData.host}
                onChange={e => setFormData(p => ({ ...p, host: e.target.value }))}
                placeholder="127.0.0.1"
              />
            </div>
            <div className="ssh-form-field ssh-form-field-port">
              <label className="ssh-form-label">Port</label>
              <input
                type="text"
                className="ssh-form-input"
                value={formData.port}
                onChange={e => setFormData(p => ({ ...p, port: e.target.value }))}
                placeholder="22"
              />
            </div>
            <div className="ssh-form-field">
              <label className="ssh-form-label">Username</label>
              <input
                type="text"
                className="ssh-form-input"
                value={formData.username}
                onChange={e => setFormData(p => ({ ...p, username: e.target.value }))}
                placeholder="username"
                autoComplete="username"
              />
            </div>
            <div className="ssh-form-field ssh-form-field-password">
              <label className="ssh-form-label">Password</label>
              <input
                type="password"
                className="ssh-form-input"
                value={formData.password}
                onChange={e => setFormData(p => ({ ...p, password: e.target.value }))}
                placeholder="••••"
                autoComplete="current-password"
              />
            </div>
            <div className="ssh-form-buttons">
              <button
                type="submit"
                className="ssh-btn-connect"
                disabled={sshState.isConnecting || !formData.host || !formData.username}
              >
                {sshState.isConnecting ? 'Connecting...' : 'Connect'}
              </button>
              <button type="button" className="ssh-btn-clear" onClick={handleClear}>Clear</button>
            </div>
          </div>

          <details className="ssh-form-advanced">
            <summary className="ssh-form-advanced-toggle">Advanced</summary>
            <div className="ssh-form-advanced-fields">
              <div className="ssh-form-field">
                <label className="ssh-form-label">Private Key</label>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {availableKeys.length > 0 ? (
                    <select
                      className="ssh-form-input"
                      value={formData.privateKey}
                      onChange={e => setFormData(p => ({ ...p, privateKey: e.target.value }))}
                      style={{ flex: 1 }}
                    >
                      <option value="">None (use password)</option>
                      {availableKeys.map(k => (
                        <option key={k} value={k}>{k.replace(/^.*[/\\]/, '')}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      className="ssh-form-input"
                      value={formData.privateKey}
                      onChange={e => setFormData(p => ({ ...p, privateKey: e.target.value }))}
                      placeholder="~/.ssh/id_rsa"
                      style={{ flex: 1 }}
                    />
                  )}
                  <button
                    type="button"
                    className="ssh-btn-browse"
                    onClick={async () => {
                      try {
                        const result = await keysBridge.browse()
                        if (result.selected && result.path) {
                          setFormData(p => ({ ...p, privateKey: result.path! }))
                          if (!availableKeys.includes(result.path))
                            setAvailableKeys(prev => [...prev, result.path!])
                          if (!result.valid)
                            termRef.current?.writeln('\x1b[33m⚠ 선택한 키 파일이 유효하지 않을 수 있습니다.\x1b[0m')
                        }
                      } catch { /* dialog cancelled or IPC error */ }
                    }}
                  >
                    Browse...
                  </button>
                </div>
              </div>
            </div>
          </details>
        </form>
      )}

      <div className="terminal-container" ref={resizeRef} style={{ flex: 1 }}>
        <div ref={terminalRef} className="terminal-content" />
      </div>
    </div>
  )
}
