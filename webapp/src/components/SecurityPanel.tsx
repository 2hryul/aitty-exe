import { useState, useCallback } from 'react'
import { security } from '@bridge/ipcBridge'

// 13개 보안 점검 항목 정의
const SECURITY_ITEMS = [
  { id: 'u03', label: 'U-03', name: 'SU 명령 그룹 제한', slow: false, k8s: false },
  { id: 'u07', label: 'U-07', name: '계정 잠금 임계값', slow: false, k8s: false },
  { id: 'u08', label: 'U-08', name: '불필요한 Shell 계정', slow: false, k8s: true },
  { id: 'u10', label: 'U-10', name: '원격 터미널 타임아웃', slow: false, k8s: false },
  { id: 'u11', label: 'U-11', name: '비밀번호 기록 개수', slow: false, k8s: false },
  { id: 'u15', label: 'U-15', name: '불필요한 숨김 파일', slow: true, k8s: false },
  { id: 'u23', label: 'U-23', name: 'SUID/SGID 점검', slow: true, k8s: true },
  { id: 'u24', label: 'U-24', name: '사용자 환경파일 권한', slow: true, k8s: false },
  { id: 'u25', label: 'U-25', name: 'World writable 파일', slow: true, k8s: true },
  { id: 'u28', label: 'U-28', name: '시스템 디렉터리 권한', slow: true, k8s: false },
  { id: 'u45', label: 'U-45', name: '시스템 경고 메시지', slow: false, k8s: false },
  { id: 'u70', label: 'U-70', name: '시스템 로깅', slow: false, k8s: false },
  { id: 'u73', label: 'U-73', name: 'Cron 로깅', slow: false, k8s: false },
] as const

type Status = 'pending' | 'running' | 'pass' | 'fail' | 'na' | 'fixed' | 'error' | 'unknown'

interface ItemState {
  status: Status
  reason: string
  output: string
}

const STATUS_CONFIG: Record<Status, { icon: string; label: string; cls: string }> = {
  pending: { icon: '⬜', label: '미점검', cls: 'sec-pending' },
  running: { icon: '⏳', label: '실행중', cls: 'sec-running' },
  pass:    { icon: '✅', label: '양호',   cls: 'sec-pass' },
  fail:    { icon: '❌', label: '취약',   cls: 'sec-fail' },
  na:      { icon: '➖', label: '해당없음', cls: 'sec-na' },
  fixed:   { icon: '🔧', label: '조치완료', cls: 'sec-fixed' },
  error:   { icon: '⚠️', label: '오류',   cls: 'sec-error' },
  unknown: { icon: '❓', label: '불명',   cls: 'sec-unknown' },
}

interface SecurityPanelProps {
  sshConnected?: boolean
}

export default function SecurityPanel({ sshConnected }: SecurityPanelProps) {
  const [deployed, setDeployed] = useState(false)
  const [deployDir, setDeployDir] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<Array<{ name: string; path: string }>>([])
  const [results, setResults] = useState<Record<string, ItemState>>(() => {
    const init: Record<string, ItemState> = {}
    SECURITY_ITEMS.forEach(item => { init[item.id] = { status: 'pending', reason: '', output: '' } })
    return init
  })
  const [logs, setLogs] = useState<string[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [expandedItem, setExpandedItem] = useState<string | null>(null)

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('ko-KR', { hour12: false })
    setLogs(prev => [...prev, `${ts} ${msg}`])
  }, [])

  const handleBrowse = useCallback(async () => {
    try {
      const result = await security.browseScripts()
      if (result.selected && result.files.length > 0) {
        setSelectedFiles(result.files.map(f => ({ name: f.name, path: f.path })))
        addLog(`📂 ${result.files.length}개 파일 선택: ${result.files.map(f => f.name).join(', ')}`)
      }
    } catch (err) {
      addLog(`❌ 파일 선택 실패: ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }, [addLog])

  const handleDeploy = useCallback(async () => {
    if (selectedFiles.length === 0) return
    try {
      addLog('📤 스크립트 업로드 시작...')
      const result = await security.deploy(selectedFiles.map(f => f.path))
      if (result.success) {
        setDeployed(true)
        setDeployDir(result.remoteDir)
        addLog(`✅ 배포 완료: ${result.files.join(', ')} → ${result.remoteDir}`)
      }
    } catch (err) {
      addLog(`❌ 배포 실패: ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }, [selectedFiles, addLog])

  const runFunction = useCallback(async (funcName: string, itemId: string, useSudo = false) => {
    setResults(prev => ({ ...prev, [itemId]: { status: 'running', reason: '', output: '' } }))
    addLog(`▶ ${funcName} 실행...`)
    try {
      const result = await security.run(funcName, useSudo)
      const status = result.status as Status
      setResults(prev => ({
        ...prev,
        [itemId]: { status, reason: result.reason, output: result.output }
      }))
      const cfg = STATUS_CONFIG[status]
      addLog(`${cfg.icon} [${SECURITY_ITEMS.find(i => i.id === itemId)?.label}] ${cfg.label}: ${result.reason}`)
    } catch (err) {
      setResults(prev => ({
        ...prev,
        [itemId]: { status: 'error', reason: err instanceof Error ? err.message : 'unknown', output: '' }
      }))
      addLog(`❌ ${funcName} 실패: ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }, [addLog])

  const handleCheckItem = useCallback((itemId: string) => {
    if (isRunning) return
    runFunction(`check_${itemId}`, itemId)
  }, [isRunning, runFunction])

  const handleFixItem = useCallback((itemId: string) => {
    if (isRunning) return
    const item = SECURITY_ITEMS.find(i => i.id === itemId)
    if (item?.k8s) {
      if (!window.confirm(`⚠️ ${item.name}은(는) K8S 운영에 영향을 줄 수 있습니다.\n조치를 진행하시겠습니까?`)) return
    }
    runFunction(`fix_${itemId}`, itemId, true)
  }, [isRunning, runFunction])

  const handleCheckAll = useCallback(async (skipSlow = false) => {
    if (isRunning) return
    setIsRunning(true)
    const items = skipSlow ? SECURITY_ITEMS.filter(i => !i.slow) : SECURITY_ITEMS
    addLog(`🔍 ${skipSlow ? '빠른' : '전체'} 점검 시작 (${items.length}개 항목)...`)

    for (const item of items) {
      await runFunction(`check_${item.id}`, item.id)
    }

    addLog(`✅ 점검 완료`)
    setIsRunning(false)
  }, [isRunning, addLog, runFunction])

  // 통계
  const stats = SECURITY_ITEMS.reduce(
    (acc, item) => {
      const s = results[item.id]?.status ?? 'pending'
      acc[s] = (acc[s] || 0) + 1
      return acc
    },
    {} as Record<string, number>
  )

  return (
    <div className="security-panel">
      {/* Header: 배포 영역 */}
      <div className="sec-deploy-section">
        <div className="sec-deploy-row">
          <span className="sec-deploy-label">
            {deployed ? `✅ 배포됨: ${deployDir}` : '📦 스크립트 미배포'}
          </span>
          <div className="sec-deploy-actions">
            <button className="sec-btn sec-btn-browse" onClick={handleBrowse} disabled={!sshConnected}>
              📂 파일 선택
            </button>
            <button
              className="sec-btn sec-btn-deploy"
              onClick={handleDeploy}
              disabled={!sshConnected || selectedFiles.length === 0}
            >
              📤 배포
            </button>
          </div>
        </div>
        {selectedFiles.length > 0 && !deployed && (
          <div className="sec-file-list">
            {selectedFiles.map(f => (
              <span key={f.name} className="sec-file-tag">{f.name}</span>
            ))}
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="sec-action-bar">
        <button
          className="sec-btn sec-btn-primary"
          onClick={() => handleCheckAll(false)}
          disabled={!deployed || isRunning}
        >
          🔍 전체 점검
        </button>
        <button
          className="sec-btn sec-btn-secondary"
          onClick={() => handleCheckAll(true)}
          disabled={!deployed || isRunning}
        >
          ⚡ 빠른 점검
        </button>
        {isRunning && <span className="sec-running-indicator">⏳ 실행 중...</span>}
      </div>

      {/* Stats */}
      <div className="sec-stats">
        <span>총 {SECURITY_ITEMS.length}항목</span>
        {stats.pass && <span className="sec-stat-pass">✅ 양호: {stats.pass}</span>}
        {stats.fail && <span className="sec-stat-fail">❌ 취약: {stats.fail}</span>}
        {stats.na && <span className="sec-stat-na">➖ 해당없음: {stats.na}</span>}
        {stats.fixed && <span className="sec-stat-fixed">🔧 조치: {stats.fixed}</span>}
        {stats.pending && <span className="sec-stat-pending">⬜ 미점검: {stats.pending}</span>}
      </div>

      {/* Item Grid */}
      <div className="sec-item-grid">
        {SECURITY_ITEMS.map(item => {
          const state = results[item.id]
          const cfg = STATUS_CONFIG[state?.status ?? 'pending']
          const isExpanded = expandedItem === item.id

          return (
            <div key={item.id} className={`sec-item ${cfg.cls}`}>
              <div
                className="sec-item-header"
                onClick={() => setExpandedItem(isExpanded ? null : item.id)}
              >
                <span className="sec-item-id">{item.label}</span>
                <span className="sec-item-name">
                  {item.name}
                  {item.slow && <span className="sec-badge-slow" title="시간 소요">🕐</span>}
                  {item.k8s && <span className="sec-badge-k8s" title="K8S 민감">⚠️</span>}
                </span>
                <span className={`sec-item-status ${cfg.cls}`}>{cfg.icon} {cfg.label}</span>
                <div className="sec-item-actions">
                  <button
                    className="sec-btn-sm sec-btn-check"
                    onClick={e => { e.stopPropagation(); handleCheckItem(item.id) }}
                    disabled={!deployed || isRunning}
                    title="점검"
                  >
                    점검
                  </button>
                  <button
                    className="sec-btn-sm sec-btn-fix"
                    onClick={e => { e.stopPropagation(); handleFixItem(item.id) }}
                    disabled={!deployed || isRunning}
                    title="조치"
                  >
                    조치
                  </button>
                </div>
              </div>

              {/* Expandable Detail */}
              {isExpanded && state?.reason && (
                <div className="sec-item-detail">
                  <div className="sec-detail-reason">{state.reason}</div>
                  {state.output && (
                    <pre className="sec-detail-output">{state.output}</pre>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Logs */}
      <div className="sec-log-section">
        <div className="sec-log-header">
          <span>실행 로그</span>
          <button className="sec-btn-sm" onClick={() => setLogs([])}>지우기</button>
        </div>
        <div className="sec-log-content">
          {logs.length === 0 && <div className="sec-log-empty">스크립트를 배포하고 점검을 시작하세요.</div>}
          {logs.map((log, i) => (
            <div key={i} className="sec-log-line">{log}</div>
          ))}
        </div>
      </div>
    </div>
  )
}
