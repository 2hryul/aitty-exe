import { AISettingsPanel, type AISettingsPanelProps } from '@components/AISettingsPanel'
import '@styles/titlebar.css'

interface SettingsDrawerProps extends AISettingsPanelProps {
  isOpen: boolean
  onClose: () => void
}

export function SettingsDrawer({ isOpen, onClose, ...settingsProps }: SettingsDrawerProps) {
  return (
    <div className={`settings-drawer ${isOpen ? 'open' : ''}`}>
      <div className="settings-drawer-header">
        <span className="settings-drawer-title">AI Settings</span>
        <button className="settings-drawer-close" onClick={onClose} title="Close">
          &#10005;
        </button>
      </div>
      <div className="settings-drawer-body">
        <AISettingsPanel {...settingsProps} />
      </div>
    </div>
  )
}
