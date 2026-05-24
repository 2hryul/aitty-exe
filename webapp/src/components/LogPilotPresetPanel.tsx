/**
 * LogPilotPresetPanel — 자주 쓰는 로그 (시스템 기본 + 사용자 추가).
 *
 * 시스템 기본 6개는 logpilotScenarios.ts의 LOGPILOT_DEFAULT_PRESETS (수정 불가).
 * 사용자 추가는 localStorage 키 `aitty:logpilot-presets:v1`에 저장 — 페이지 새로고침 후 보존.
 *
 * LogPresetSelect.tsx와 동일한 localStorage CRUD 패턴이지만 키와 UX는 다름:
 *  - Section 분리(시스템/사용자)
 *  - inline 추가 폼 (alert/prompt 대신)
 *  - 클릭 → 경로 채움 (드롭다운 자동 닫힘 X — 사용자가 명시적으로 닫음)
 */

import { useCallback, useEffect, useState } from 'react'
import {
  LOGPILOT_DEFAULT_PRESETS,
  isCommandPath,
  type LogPilotPreset,
} from '@utils/logpilotScenarios'

const STORAGE_KEY = 'aitty:logpilot-presets:v1'

interface LogPilotPresetPanelProps {
  isOpen: boolean
  onSelect: (path: string) => void
  onClose: () => void
}

interface UserPreset {
  label: string
  path: string
  description?: string
}

function loadUserPresets(): UserPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p: unknown): p is UserPreset =>
        typeof p === 'object' && p !== null &&
        typeof (p as UserPreset).label === 'string' &&
        typeof (p as UserPreset).path === 'string',
    )
  } catch {
    return []
  }
}

function saveUserPresets(presets: UserPreset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets))
  } catch {
    // quota 초과 등 — 런타임 동작은 계속 (메모리 상태만 유지)
  }
}

export function LogPilotPresetPanel({ isOpen, onSelect, onClose }: LogPilotPresetPanelProps) {
  const [userPresets, setUserPresets] = useState<UserPreset[]>([])
  const [addFormOpen, setAddFormOpen] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [newLabel, setNewLabel] = useState('')

  useEffect(() => {
    setUserPresets(loadUserPresets())
  }, [])

  const handleAdd = useCallback(() => {
    const path = newPath.trim()
    const label = newLabel.trim() || path.split('/').pop() || path
    if (!path) return
    if (!path.startsWith('/')) {
      // 절대 경로만 받음 — logCheckRequest validatePath 와 동일 규칙 1차 적용
      window.alert('절대 경로(/로 시작)만 추가할 수 있습니다.')
      return
    }
    const next = [...userPresets, { label, path, description: '' }]
    setUserPresets(next)
    saveUserPresets(next)
    setNewPath('')
    setNewLabel('')
    setAddFormOpen(false)
  }, [newPath, newLabel, userPresets])

  const handleRemove = useCallback((idx: number) => {
    const next = userPresets.filter((_, i) => i !== idx)
    setUserPresets(next)
    saveUserPresets(next)
  }, [userPresets])

  const handlePick = useCallback((p: string) => {
    onSelect(p)
    onClose()
  }, [onSelect, onClose])

  if (!isOpen) return null

  return (
    <div className="logpilot-preset-panel">
      <div className="logpilot-preset-header">
        <span className="logpilot-preset-title">자주 쓰는 로그 (Linux 기본 + 사용자 추가)</span>
        <button
          type="button"
          className="logpilot-link-btn"
          onClick={() => setAddFormOpen(v => !v)}
        >
          + 새 경로 추가
        </button>
      </div>

      <div className="logpilot-preset-section-label">시스템 기본 (Linux)</div>
      <ul className="logpilot-preset-list">
        {LOGPILOT_DEFAULT_PRESETS.map((p: LogPilotPreset) => {
          const cmd = isCommandPath(p.path)
          return (
            <li key={p.path}>
              <button
                type="button"
                className={`logpilot-preset-row${cmd ? ' logpilot-preset-row-cmd' : ''}`}
                onClick={() => handlePick(p.path)}
                title={p.path}
              >
                {/* 명령은 `$` 접두사로 파일 경로(/...)와 시각 구분 */}
                <span className="logpilot-preset-kind mono" aria-hidden="true">{cmd ? '$' : '/'}</span>
                <span className="logpilot-preset-path mono">{p.path}</span>
                <span className="logpilot-preset-desc">{p.description}</span>
              </button>
            </li>
          )
        })}
      </ul>

      {userPresets.length > 0 && (
        <>
          <div className="logpilot-preset-section-label">내가 추가한 경로</div>
          <ul className="logpilot-preset-list">
            {userPresets.map((p, idx) => (
              <li key={`${p.label}-${idx}`}>
                <div className="logpilot-preset-row logpilot-preset-row-user">
                  <button
                    type="button"
                    className="logpilot-preset-row-pick"
                    onClick={() => handlePick(p.path)}
                    title={p.path}
                  >
                    <span className="logpilot-preset-path mono">{p.path}</span>
                    <span className="logpilot-preset-desc">{p.label}</span>
                  </button>
                  <button
                    type="button"
                    className="logpilot-preset-remove"
                    onClick={() => handleRemove(idx)}
                    title="삭제"
                  >
                    🗑
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {addFormOpen && (
        <div className="logpilot-preset-addform">
          <input
            type="text"
            className="logpilot-preset-input mono"
            placeholder="경로 (예: /opt/myapp/log/app.log)"
            value={newPath}
            onChange={e => setNewPath(e.target.value)}
          />
          <input
            type="text"
            className="logpilot-preset-input"
            placeholder="설명 (예: 앱 메인 로그)"
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
          />
          <button
            type="button"
            className="logpilot-btn logpilot-btn-primary"
            onClick={handleAdd}
            disabled={!newPath.trim()}
          >
            저장
          </button>
          <button
            type="button"
            className="logpilot-btn"
            onClick={() => {
              setAddFormOpen(false)
              setNewPath('')
              setNewLabel('')
            }}
          >
            취소
          </button>
        </div>
      )}
    </div>
  )
}
