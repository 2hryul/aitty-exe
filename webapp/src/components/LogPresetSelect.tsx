import { useCallback, useEffect, useState } from 'react'

export interface LogPreset {
  label: string
  path: string
}

interface LogPresetSelectProps {
  currentPath: string
  onSelect: (path: string) => void
}

const STORAGE_KEY = 'aitty:log-presets:v1'

const DEFAULTS: LogPreset[] = [
  { label: 'syslog',        path: '/var/log/syslog' },
  { label: 'messages',      path: '/var/log/messages' },
  { label: 'nginx error',   path: '/var/log/nginx/error.log' },
  { label: 'app (예시)',    path: '/var/log/app/app.log' },
]

function loadPresets(): LogPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULTS
    // 형식 검증: label/path가 모두 문자열이어야 함
    return parsed.filter(
      (p: unknown): p is LogPreset =>
        typeof p === 'object' && p !== null &&
        typeof (p as LogPreset).label === 'string' &&
        typeof (p as LogPreset).path === 'string',
    )
  } catch {
    return DEFAULTS
  }
}

function savePresets(presets: LogPreset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets))
  } catch {
    // 저장 실패는 치명적이지 않음(quota 초과 등) — 런타임 동작은 계속
  }
}

export function LogPresetSelect({ currentPath, onSelect }: LogPresetSelectProps) {
  const [presets, setPresets] = useState<LogPreset[]>([])
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    setPresets(loadPresets())
  }, [])

  const handleSelect = useCallback((path: string) => {
    onSelect(path)
    setIsOpen(false)
  }, [onSelect])

  const handleAdd = useCallback(() => {
    if (!currentPath.trim()) {
      window.alert('경로를 먼저 입력하세요.')
      return
    }
    const label = window.prompt('프리셋 이름을 입력하세요:', currentPath.split('/').pop() || '')
    if (!label) return
    const next = [...presets, { label: label.trim(), path: currentPath.trim() }]
    setPresets(next)
    savePresets(next)
  }, [currentPath, presets])

  const handleRemove = useCallback((idx: number) => {
    const next = presets.filter((_, i) => i !== idx)
    setPresets(next)
    savePresets(next)
  }, [presets])

  return (
    <div className="log-preset-select">
      <button
        type="button"
        className="log-preset-toggle"
        onClick={() => setIsOpen(v => !v)}
        title="프리셋"
      >
        프리셋 ▾
      </button>
      {isOpen && (
        <div className="log-preset-dropdown">
          {presets.length === 0 && (
            <div className="log-preset-empty">저장된 프리셋 없음</div>
          )}
          {presets.map((p, idx) => (
            <div key={`${p.label}-${idx}`} className="log-preset-item">
              <button
                type="button"
                className="log-preset-item-btn"
                onClick={() => handleSelect(p.path)}
                title={p.path}
              >
                <span className="log-preset-label">{p.label}</span>
                <span className="log-preset-path">{p.path}</span>
              </button>
              <button
                type="button"
                className="log-preset-remove"
                onClick={() => handleRemove(idx)}
                title="삭제"
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="log-preset-add"
            onClick={handleAdd}
          >
            + 현재 경로 추가
          </button>
        </div>
      )}
    </div>
  )
}
