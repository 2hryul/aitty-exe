import { app } from '@bridge/ipcBridge'
import '@styles/titlebar.css'

interface TitleBarProps {
  appVersion: string
  sshConnected: boolean
  sshHost?: string
  aiModel?: string
  aiConfigured: boolean
}

export function TitleBar({ appVersion, sshConnected, sshHost, aiModel, aiConfigured }: TitleBarProps) {
  return (
    <header className="titlebar">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <div className="titlebar-logo">S</div>
        <span className="titlebar-brand">Aitty</span>
        <span className="titlebar-version">{appVersion}</span>
      </div>

      <div className="titlebar-center">
        <div className="titlebar-status-pill">
          <span className={`status-dot ${sshConnected ? 'status-dot-ok' : ''} pulse-dot`}
                style={!sshConnected ? { background: 'var(--txt-3)' } : undefined} />
          <span style={{ color: sshConnected ? 'var(--ok)' : 'var(--txt-3)' }}>
            {sshConnected ? 'Connected' : 'Disconnected'}
          </span>
          {sshHost && <span style={{ color: 'var(--txt-3)', marginLeft: 4 }}>{sshHost}</span>}
          <span style={{ color: 'var(--txt-3)', margin: '0 4px' }}>|</span>
          <span className={`status-dot ${aiConfigured ? 'status-dot-accent' : ''} pulse-dot`}
                style={!aiConfigured ? { background: 'var(--txt-3)' } : undefined} />
          <span style={{ color: 'var(--accent-1)' }}>{aiModel || 'No AI'}</span>
        </div>
      </div>

      <div className="titlebar-controls">
        <button className="titlebar-btn" title="Minimize"
                onClick={() => app.windowMinimize()}>&#x2015;</button>
        <button className="titlebar-btn" title="Maximize"
                onClick={() => app.windowMaximize()}>&#9723;</button>
        <button className="titlebar-btn titlebar-btn-close" title="Close"
                onClick={() => app.windowClose()}>&#10005;</button>
      </div>
    </header>
  )
}
