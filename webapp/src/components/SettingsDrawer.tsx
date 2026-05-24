import { useEffect, useRef, useState } from 'react'
import { AISettingsPanel, type AISettingsPanelProps } from '@components/AISettingsPanel'
import '@styles/titlebar.css'

interface SettingsDrawerProps extends AISettingsPanelProps {
  isOpen: boolean
  onClose: () => void
}

const STORAGE_KEY = 'aitty:settings-drawer-w'
// 프리셋 행(select + 로드/🗑/저장 3버튼)이 초기 상태에서 잘리지 않도록 480px로 설정.
const DEFAULT_WIDTH = 480
const MIN_WIDTH = 280
const MAX_WIDTH = 720

function clampWidth(px: number): number {
  if (Number.isNaN(px)) return DEFAULT_WIDTH
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(px)))
}

function applyWidth(px: number) {
  document.documentElement.style.setProperty('--settings-drawer-w', `${px}px`)
}

export function SettingsDrawer({ isOpen, onClose, ...settingsProps }: SettingsDrawerProps) {
  const [dragging, setDragging] = useState(false)
  const draggingRef = useRef(false)

  useEffect(() => {
    const stored = Number(localStorage.getItem(STORAGE_KEY))
    applyWidth(clampWidth(stored > 0 ? stored : DEFAULT_WIDTH))
  }, [])

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    setDragging(true)
    const prevUserSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return
      // 드로어가 화면 우측에 고정 → 마우스가 왼쪽으로 갈수록 폭 증가
      const next = clampWidth(window.innerWidth - ev.clientX)
      applyWidth(next)
    }
    const onUp = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      setDragging(false)
      document.body.style.userSelect = prevUserSelect
      const finalPx = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue('--settings-drawer-w'),
        10,
      )
      if (!Number.isNaN(finalPx)) {
        localStorage.setItem(STORAGE_KEY, String(finalPx))
      }
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className={`settings-drawer ${isOpen ? 'open' : ''}`}>
      <div
        className={`settings-drawer-resize-handle ${dragging ? 'dragging' : ''}`}
        onMouseDown={handleMouseDown}
        title="드래그하여 폭 조정"
      />
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
