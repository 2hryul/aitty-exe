import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from 'xterm'
import { ai, session, aiPreset, type AiProvider, type AiPresetInfo } from '@bridge/ipcBridge'
import type { ChatMessage } from '@app-types/chat'
import { logger } from '@utils/logger'

// Fallback only; backend `ai:providers` is the source of truth for default model/system prompt/endpoint.
// 부팅 초기 paint 전 ai.providers() 응답 도착 전 사용되는 임시 placeholder.
export const DEFAULT_ENDPOINT = import.meta.env.VITE_DEFAULT_OLLAMA_ENDPOINT || 'http://127.0.0.1:11434'

export function isWebView2(): boolean {
  return !!window.chrome?.webview
}

export const THINKING_MESSAGES = [
  'AI가 지식의 바다를 헤엄치는 중! 잠시 후 최선의 답변을 가져다 드릴게요...',
  'AI 뉴런들이 전속력으로 달리는 중! 최고의 답변을 향해 질주하고 있습니다...',
  'AI가 수천만 개의 파라미터를 총동원 중! 최적의 답을 조합하고 있어요...',
  'AI가 도서관 백만 권을 동시에 검색하는 중! 핵심만 쏙 뽑아 드릴게요...',
  'AI 요리사가 답변을 정성껏 요리하는 중! 잠시만 기다리시면 곧 나옵니다...',
  'AI가 생각의 미로 속을 탐험하는 중! 최선의 경로를 찾고 있습니다...',
  'AI 회의실에서 수천 개의 의견이 충돌 중! 잠시 후 최종 결론이 나옵니다...',
  'AI가 은하수만큼 광활한 데이터를 스캔하는 중! 잠시 후 결과를 알려드립니다...',
  'AI 탐정이 최선의 답을 추적하는 중! 모든 단서를 수집하고 있어요...',
  'AI가 천재들의 집단 지성을 결집하는 중! 잠시 후 최고의 답변으로 돌아올게요...',
] as const

let startupTracePrinted = false

// 터미널 표시 폭 계산 (한글·CJK = 2cell, 그 외 = 1cell)
export function charDisplayWidth(char: string): number {
  const cp = char.codePointAt(0) ?? 0
  if (cp < 0x1100) return 1
  return (
    cp <= 0x115F                    ||  // Hangul Jamo
    (cp >= 0x2E80 && cp <= 0x303E) ||  // CJK Radicals
    (cp >= 0x3041 && cp <= 0xA4CF) ||  // CJK / Japanese
    (cp >= 0xA960 && cp <= 0xA97F) ||  // Hangul Jamo Ext-A
    (cp >= 0xAC00 && cp <= 0xD7FF) ||  // Hangul Syllables (가-힣)
    (cp >= 0xF900 && cp <= 0xFAFF) ||  // CJK Compat
    (cp >= 0xFE10 && cp <= 0xFE6F) ||  // CJK Forms
    (cp >= 0xFF01 && cp <= 0xFF60) ||  // Full-width Latin
    (cp >= 0xFFE0 && cp <= 0xFFE6)     // Full-width signs
  ) ? 2 : 1
}

export interface UseAITerminalReturn {
  // refs
  termRef: React.RefObject<Terminal | null>
  inputBufferRef: React.MutableRefObject<string>
  isProcessingRef: React.MutableRefObject<boolean>
  sendMessageRef: React.MutableRefObject<(message: string) => Promise<void>>
  handleBuiltinCommandRef: React.MutableRefObject<(command: string) => Promise<boolean>>
  writePromptRef: React.MutableRefObject<() => void>
  runDetailedConnectionTraceRef: React.MutableRefObject<(title: string, applyConfig: boolean) => Promise<boolean>>
  endpointUrlRef: React.MutableRefObject<string>
  providersRef: React.MutableRefObject<AiProvider[]>

  // state
  isConfigured: boolean
  currentModel: string
  isStreaming: boolean
  engineName: string
  availableModels: string[]
  isSettingsOpen: boolean
  isSystemPromptOpen: boolean
  systemPrompt: string
  endpointUrl: string
  statusMessage: string
  isBusy: boolean
  isDirty: boolean
  /** null = 미시도, true = 성공, false = 실패 */
  isApplySuccess: boolean | null
  activeProvider: string
  apiKey: string
  providers: AiProvider[]
  saveApiLog: boolean
  allowInsecureSsl: boolean
  presets: AiPresetInfo[]

  // setters
  setIsSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>
  setIsSystemPromptOpen: React.Dispatch<React.SetStateAction<boolean>>
  setSystemPrompt: React.Dispatch<React.SetStateAction<string>>
  setApiKey: React.Dispatch<React.SetStateAction<string>>
  setSaveApiLog: React.Dispatch<React.SetStateAction<boolean>>
  setAllowInsecureSsl: React.Dispatch<React.SetStateAction<boolean>>
  setIsDirty: React.Dispatch<React.SetStateAction<boolean>>
  setIsApplySuccess: React.Dispatch<React.SetStateAction<boolean | null>>

  // handlers
  writePrompt: () => void
  writeLine: (text: string) => void
  handleEndpointChange: (value: string) => void
  handleProviderChange: (provider: string) => Promise<void>
  handleModelChange: (newModel: string) => Promise<void>
  handleCheck: () => Promise<void>
  handleApplySettings: () => Promise<void>
  handleSavePreset: (name: string) => Promise<boolean>
  handleLoadPreset: (name: string) => Promise<boolean>
  handleDeletePreset: (name: string) => Promise<boolean>
  handleAnalyzeClick: () => Promise<void>
  handleCancel: () => Promise<void>
  handleClear: () => void
  sendMessage: (message: string) => Promise<void>

  // chat
  chatMessages: ChatMessage[]
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>

  // startup
  initializeOnMount: (term: Terminal) => void
}

export function useAITerminal(): UseAITerminalReturn {
  const termRef = useRef<Terminal | null>(null)
  const inputBufferRef = useRef('')
  const isProcessingRef = useRef(false)
  const sendMessageRef = useRef<(message: string) => Promise<void>>(async () => {})
  const handleBuiltinCommandRef = useRef<(command: string) => Promise<boolean>>(async () => false)
  const writePromptRef = useRef<() => void>(() => {})
  const runDetailedConnectionTraceRef = useRef<(title: string, applyConfig: boolean) => Promise<boolean>>(async () => false)

  const _savedEndpoint = (() => {
    try { return localStorage.getItem('aitty.endpointUrl') || DEFAULT_ENDPOINT }
    catch { return DEFAULT_ENDPOINT }
  })()
  const endpointUrlRef = useRef(_savedEndpoint)

  const [isConfigured, setIsConfigured] = useState(false)
  // 초기값은 빈 문자열 — ai.providers() 응답 도착 시 active provider의 defaultModel로 채워짐.
  const [currentModel, setCurrentModel] = useState('')
  // sendMessage의 []-deps useCallback에서 stale closure 방지용 ref
  const currentModelRef = useRef(currentModel)
  useEffect(() => { currentModelRef.current = currentModel }, [currentModel])
  const [isStreaming, setIsStreaming] = useState(false)
  const [engineName, setEngineName] = useState('ollama')
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [isSettingsOpen, setIsSettingsOpen] = useState(true)
  const [isSystemPromptOpen, setIsSystemPromptOpen] = useState(false)
  // 초기값은 빈 문자열 — ai.providers() 응답 도착 시 active provider의 defaultSystemPrompt로 채워짐.
  const [systemPrompt, setSystemPrompt] = useState('')
  const [endpointUrl, setEndpointUrl] = useState(_savedEndpoint)
  const [statusMessage, setStatusMessage] = useState('Not checked')
  const [isBusy, setIsBusy] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [isApplySuccess, setIsApplySuccess] = useState<boolean | null>(null)

  const [activeProvider, setActiveProvider] = useState<string>('ollama')
  const [apiKey, setApiKey] = useState('')
  // 초기값은 backend ai.providers() 응답 도착 전 placeholder. 도착 시 전체 교체됨.
  const [providers, setProviders] = useState<AiProvider[]>([
    { id: 'ollama', name: 'API 접속',          status: 'local',      requiresApiKey: false },
    { id: 'gemini', name: 'Google Gemini',    status: 'no-api-key', requiresApiKey: true  },
    { id: 'claude', name: 'Anthropic Claude', status: 'no-api-key', requiresApiKey: true  },
    { id: 'openai', name: 'OpenAI',           status: 'no-api-key', requiresApiKey: true  },
  ])
  const [saveApiLog, setSaveApiLog] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('aitty.saveApiLog')
      return stored === null ? true : stored === '1'
    } catch {
      return true
    }
  })

  // SSL 검증 건너뛰기 — 내부망 자체서명 인증서 엔드포인트 지원 (기본 false)
  const [allowInsecureSsl, setAllowInsecureSsl] = useState<boolean>(() => {
    try { return localStorage.getItem('aitty.allowInsecureSsl') === '1' }
    catch { return false }
  })

  // AI 프리셋 목록 — 접속 성공한 설정을 AES-256-GCM 암호화로 영속화
  const [presets, setPresets] = useState<AiPresetInfo[]>([])

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])

  const providersRef = useRef<AiProvider[]>([])
  useEffect(() => { providersRef.current = providers }, [providers])
  useEffect(() => {
    try { localStorage.setItem('aitty.saveApiLog', saveApiLog ? '1' : '0') } catch { /* ignore */ }
    // C# SessionService에 저장 활성화 여부 동기화 (앱 종료 시 Save() 게이팅)
    if (isWebView2()) {
      session.setSaveEnabled(saveApiLog).catch(() => { /* non-critical */ })
    }
  }, [saveApiLog])

  // SSL 검증 정책 변경 → localStorage + C# 백엔드에 즉시 반영
  useEffect(() => {
    try { localStorage.setItem('aitty.allowInsecureSsl', allowInsecureSsl ? '1' : '0') } catch { /* ignore */ }
    if (isWebView2()) {
      ai.setAllowInsecureSsl(allowInsecureSsl).catch(() => { /* non-critical */ })
    }
  }, [allowInsecureSsl])
  useEffect(() => {
    // localStorage는 Ollama 전용 — OpenAI Base URL은 C# config.json에 영속화되므로 여기서 덮어쓰지 않음
    if (activeProvider !== 'ollama') return
    try { localStorage.setItem('aitty.endpointUrl', endpointUrl) } catch { /* ignore */ }
  }, [endpointUrl, activeProvider])

  const writePrompt = useCallback(() => {
    termRef.current?.write('\r\n\x1b[36mlocal\x1b[0m@\x1b[33maitty\x1b[0m:\x1b[32m~\x1b[0m$ ')
  }, [])

  const writeLine = useCallback((text: string) => {
    termRef.current?.writeln(text)
  }, [])

  const loadEngineState = useCallback(async (announce = false): Promise<boolean> => {
    try {
      const [state, models, provResult] = await Promise.all([
        ai.state(),
        ai.models(),
        ai.providers(),
      ])
      const modelList = models.models
      const serverEp = state.baseUrl || endpointUrlRef.current
      const currentProvider = state.provider || 'ollama'

      setIsConfigured(state.isConfigured)
      setEngineName(state.engine || 'ollama')
      setActiveProvider(currentProvider)
      // 백엔드 응답 그대로 사용 — endpoint/defaultModel/defaultSystemPrompt 모두 채워져 있음 (SoT).
      setProviders(provResult.providers)
      setAvailableModels(modelList)

      const currentProviderInfo = provResult.providers.find(p => p.id === currentProvider)
      const isApiKeyProvider = currentProviderInfo?.requiresApiKey ?? false
      const providerLabel = currentProviderInfo?.name ?? currentProvider

      const statusMsg = isApiKeyProvider
        ? (state.isConfigured ? `${providerLabel} Ready` : `${providerLabel}: API Key 없음`)
        : (state.isConfigured ? `Ready on ${serverEp}` : `Offline at ${serverEp}`)
      setStatusMessage(statusMsg)

      // active provider의 defaultModel을 SoT로 사용. backend state.model이 비어 있을 때만 폴백.
      const providerDefaultModel = currentProviderInfo?.defaultModel ?? ''
      const serverModel = state.model || providerDefaultModel
      const resolvedModel = modelList.length > 0
        ? (modelList.includes(serverModel) ? serverModel : modelList[0])
        : serverModel
      setCurrentModel(resolvedModel)

      // 시스템 프롬프트 초기 채움 — 사용자가 아직 입력하지 않았을 때만 backend default로 채움.
      // 함수형 업데이트로 latest state 읽어 deps array 오염 회피.
      if (currentProviderInfo?.defaultSystemPrompt) {
        setSystemPrompt(prev => prev || currentProviderInfo.defaultSystemPrompt!)
      }

      if (announce) {
        const announceLabel = isApiKeyProvider ? providerLabel : `Ollama (${serverEp})`
        writeLine(`\x1b[32mEngine: ${announceLabel} | Model: ${resolvedModel}\x1b[0m`)
      }

      return state.isConfigured
    } catch (error) {
      setIsConfigured(false)
      setAvailableModels([])
      setStatusMessage(`Offline at ${endpointUrlRef.current}`)
      if (announce) {
        const message = error instanceof Error ? error.message : 'Connection failed'
        writeLine(`\x1b[31m${message}\x1b[0m`)
      }
      return false
    }
  }, [writeLine])

  const handleEndpointChange = useCallback((value: string) => {
    endpointUrlRef.current = value
    setEndpointUrl(value)
    setIsDirty(true)
    setIsApplySuccess(false)
  }, [])

  const handleProviderChange = useCallback(async (provider: string) => {
    setActiveProvider(provider)
    setApiKey('')
    setIsDirty(true)
    setIsApplySuccess(null)           // ← Step 5와 연계: 성공/실패/중립 3상태
    setStatusMessage('Not checked')   // ← 이전 프로바이더 상태 잔존 방지
    setAvailableModels([])            // ← 이전 프로바이더 모델 목록 제거
    setIsConfigured(false)            // ← 상태 리셋
    if (!isWebView2()) return
    try {
      await ai.setProvider(provider)
      await loadEngineState(false)
      // Provider별 endpoint 동기화: OpenAI/Ollama는 각자의 저장된 Base URL로, 그 외는 변경 없음
      if (provider === 'openai') {
        const openaiInfo = providersRef.current.find(p => p.id === 'openai')
        if (openaiInfo?.endpoint) {
          endpointUrlRef.current = openaiInfo.endpoint
          setEndpointUrl(openaiInfo.endpoint)
        }
      } else if (provider === 'ollama') {
        const ollamaInfo = providersRef.current.find(p => p.id === 'ollama')
        const saved = ollamaInfo?.endpoint
          || (() => { try { return localStorage.getItem('aitty.endpointUrl') || DEFAULT_ENDPOINT } catch { return DEFAULT_ENDPOINT } })()
        endpointUrlRef.current = saved
        setEndpointUrl(saved)
      }
      writeLine(`\x1b[32mProvider: ${provider}\x1b[0m`)
    } catch (error) {
      writeLine(`\x1b[31mProvider 전환 실패: ${error instanceof Error ? error.message : 'Unknown error'}\x1b[0m`)
    } finally {
      writePrompt()
    }
  }, [loadEngineState, writeLine, writePrompt])

  const handleModelChange = useCallback(async (newModel: string) => {
    setCurrentModel(newModel)
    if (!isWebView2()) return
    try {
      await ai.setModel(newModel)
      writeLine(`\x1b[32mModel: ${newModel}\x1b[0m`)
    } catch (error) {
      writeLine(`\x1b[31mModel 변경 실패: ${error instanceof Error ? error.message : 'Unknown error'}\x1b[0m`)
    } finally {
      writePrompt()
    }
  }, [writeLine, writePrompt])

  const runDetailedConnectionTrace = useCallback(async (title: string, applyConfig: boolean): Promise<boolean> => {
    const traceLines: string[] = []
    const time = () => new Date().toLocaleTimeString('ko-KR', { hour12: false })
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
    const log = (renderText: string, plainText?: string) => {
      writeLine(renderText)
      traceLines.push((plainText ?? stripAnsi(renderText)).replace(/\r/g, ''))
    }
    const step = (n: number, total: number, text: string) =>
      log(`\x1b[2;37m[${time()}]\x1b[0m \x1b[36m[${n}/${total}] ${text}\x1b[0m`, `[${time()}] [${n}/${total}] ${text}`)
    const ok = (text: string) => log(`\x1b[32m   ✓ ${text}\x1b[0m`, `   ✓ ${text}`)
    const warn = (text: string) => log(`\x1b[33m   ! ${text}\x1b[0m`, `   ! ${text}`)

    log('', '')
    log(`\x1b[1;36m=== LLM 접속 상세 로그 (${title}) ===\x1b[0m`, `=== LLM 접속 상세 로그 (${title}) ===`)

    const providerInfo = providers.find(p => p.id === activeProvider)
    const runOpenWebUiDiag = !(providerInfo?.requiresApiKey ?? false)
    const totalSteps = runOpenWebUiDiag ? 7 : 6
    const providerLabel = providerInfo?.name ?? activeProvider
    const endpoint = endpointUrlRef.current

    step(1, totalSteps, `Provider 선택 확인: ${providerLabel}`)
    ok(`activeProvider=${activeProvider}`)

    if (applyConfig) {
      if (providerInfo?.requiresApiKey) {
        step(2, totalSteps, 'API Key 구성 적용')
        if (!apiKey.trim()) {
          warn('API Key가 비어 있습니다.')
        } else {
          await ai.setApiKey(activeProvider, apiKey.trim())
          ok('API Key 적용 완료')
        }
        // OpenAI는 호환 게이트웨이(Shinhan Hands 등) Base URL도 적용
        if (activeProvider === 'openai' && endpoint.trim()) {
          await ai.setEndpoint(endpoint.trim())
          ok(`OpenAI Base URL 적용: ${endpoint.trim()}`)
        }
      } else {
        step(2, totalSteps, `Ollama Endpoint 적용: ${endpoint}`)
        await ai.setEndpoint(endpoint)
        if (apiKey.trim()) {
          await ai.setApiKey(activeProvider, apiKey.trim())
          ok(`Endpoint 적용 완료 (API Key 포함)`)
        } else {
          ok('Endpoint 적용 완료')
        }
      }
    } else {
      step(2, totalSteps, '구성 적용 단계는 건너뜀 (이미 적용됨)')
      ok('skip')
    }

    let stepNo = 3
    if (runOpenWebUiDiag) {
      step(stepNo++, totalSteps, 'Open WebUI API 연동 진단')
      const diag = await ai.openWebUiDiagnose(endpoint)
      if (diag.isBlocked) {
        alert(`⛔ 차단된 URL\n\n${endpoint}\n\n클라우드 메타데이터 주소(169.254.x.x)는 보안상 연결이 차단됩니다.`)
      }
      ok(`diagnosis: success=${diag.success}, isOpenWebUi=${diag.isOpenWebUi}, models=${diag.modelsCount}`)
      diag.logs.forEach((line) => log(`\x1b[2;37m   ${line}\x1b[0m`, `   ${line}`))
      if (diag.suggestOpenAiProvider) {
        // OpenAI 호환 게이트웨이 감지 → 사용자에게 명확히 안내
        writeLine('\x1b[33m┌─────────────────────────────────────────────────────────────┐\x1b[0m')
        writeLine('\x1b[33m│ ⚠ 이 엔드포인트는 OpenAI 호환 게이트웨이(vLLM/Shinhan Hands 등)│\x1b[0m')
        writeLine('\x1b[33m│   로 보입니다. Provider를 "OpenAI"로 전환하세요.              │\x1b[0m')
        writeLine('\x1b[33m│   1) AI 설정 → Provider: OpenAI 선택                          │\x1b[0m')
        writeLine('\x1b[33m│   2) Engine Endpoint에 동일 URL 입력 (/v1 자동 제거됨)        │\x1b[0m')
        writeLine('\x1b[33m│   3) API Key + Model 입력 → Apply                             │\x1b[0m')
        writeLine('\x1b[33m└─────────────────────────────────────────────────────────────┘\x1b[0m')
      }
    }

    step(stepNo++, totalSteps, '엔진 상태 조회 (ai.state)')
    const state = await ai.state()
    ok(`isConfigured=${state.isConfigured}, provider=${state.provider}, engine=${state.engine}`)

    step(stepNo++, totalSteps, '모델 목록 조회 (ai.models)')
    let modelList: string[] = []
    try {
      const models = await ai.models()
      modelList = models.models
      ok(`모델 ${modelList.length}개 확인`)
    } catch (err) {
      warn(`모델 목록 조회 실패: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }

    step(stepNo++, totalSteps, 'Provider 상태 조회 (ai.providers)')
    let provResult: Awaited<ReturnType<typeof ai.providers>>
    try {
      provResult = await ai.providers()
      ok(`provider ${provResult.providers.length}개, active=${provResult.active}`)
    } catch (err) {
      warn(`Provider 목록 조회 실패: ${err instanceof Error ? err.message : 'Unknown error'}`)
      provResult = { providers: providers, active: activeProvider }
    }
    const serverEp = state.baseUrl || endpointUrlRef.current
    const currentProvider = state.provider || activeProvider
    const currentProviderInfo = provResult.providers.find(p => p.id === currentProvider)
    const isApiKeyProvider = currentProviderInfo?.requiresApiKey ?? false
    const currentProviderLabel = currentProviderInfo?.name ?? currentProvider
    const statusMsg = isApiKeyProvider
      ? (state.isConfigured ? `${currentProviderLabel} Ready` : `${currentProviderLabel}: API Key 없음`)
      : (state.isConfigured ? `Ready on ${serverEp}` : `Offline at ${serverEp}`)
    // active provider의 defaultModel을 폴백으로 사용 — useState 초기값이 ''이므로 currentModel 폴백은 부적합.
    const providerDefaultModel = currentProviderInfo?.defaultModel ?? currentModel
    const serverModel = state.model || providerDefaultModel
    const resolvedModel = modelList.length > 0
      ? (modelList.includes(serverModel) ? serverModel : modelList[0])
      : serverModel

    setIsConfigured(state.isConfigured)
    setEngineName(state.engine || 'ollama')
    setActiveProvider(currentProvider)
    setProviders(provResult.providers)
    setAvailableModels(modelList)
    setStatusMessage(statusMsg)
    setCurrentModel(resolvedModel)
    // 시스템 프롬프트 초기 채움 — 사용자가 아직 입력하지 않은 경우만.
    if (currentProviderInfo?.defaultSystemPrompt) {
      setSystemPrompt(prev => prev || currentProviderInfo.defaultSystemPrompt!)
    }

    step(stepNo, totalSteps, '최종 판정')
    if (state.isConfigured) {
      const endpointDisplay = isApiKeyProvider ? currentProviderLabel : serverEp
      ok(`연결 성공: ${endpointDisplay} | model=${resolvedModel}`)
    } else {
      warn('연결 실패: 설정값 또는 엔진 상태를 확인하세요.')
      if (runOpenWebUiDiag) {
        let port = '11434'
        try { port = new URL(endpoint).port || '80' } catch { /* invalid url */ }
        log('')
        log('\x1b[2;37m── 대상 서버 SSH 접속 후 확인 ──────────────────────────────\x1b[0m')
        log(`\x1b[2;37m   ① 서비스 실행:  curl -s http://localhost:${port}/api/version\x1b[0m`)
        log(`\x1b[2;37m                   systemctl status ollama   │   ps aux | grep ollama\x1b[0m`)
        log(`\x1b[2;37m   ② 포트 리스닝: ss -tlnp | grep ${port}\x1b[0m`)
        log(`\x1b[2;37m   ③ 외부허용(Ollama): OLLAMA_HOST=0.0.0.0 ollama serve\x1b[0m`)
        log(`\x1b[2;37m   ④ 방화벽:       sudo ufw status   │   firewall-cmd --list-ports\x1b[0m`)
        log('\x1b[2;37m────────────────────────────────────────────────────────────\x1b[0m')
      }
    }

    log('\x1b[33mAI는 정확하지 않는 정보를 제공할 수 있습니다. 중요한 정보는 확인하세요\x1b[0m', 'AI는 정확하지 않는 정보를 제공할 수 있습니다. 중요한 정보는 확인하세요')

    if (saveApiLog) {
      try {
        const saved = await ai.saveApiLog(traceLines.join('\n'))
        log(`\x1b[36mAPI 로그 저장: ${saved.path}\x1b[0m`, `API 로그 저장: ${saved.path}`)
      } catch (error) {
        warn(`API 로그 저장 실패: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    return state.isConfigured
  }, [activeProvider, apiKey, providers, saveApiLog, writeLine])

  const handleCheck = useCallback(async () => {
    setIsBusy(true)
    try {
      const connected = await runDetailedConnectionTrace('Check', true)
      writeLine(connected ? '\x1b[32m✓ 연결되었습니다\x1b[0m' : '\x1b[31m✗ 연결 실패 - 설정을 확인하세요\x1b[0m')
    } catch (error) {
      writeLine(`\x1b[31mCheck 실패: ${error instanceof Error ? error.message : 'Unknown error'}\x1b[0m`)
    } finally {
      setIsBusy(false)
      writePrompt()
    }
  }, [runDetailedConnectionTrace, writeLine, writePrompt])

  const handleApplySettings = useCallback(async () => {
    setIsBusy(true)
    try {
      const providerInfo = providers.find(p => p.id === activeProvider)
      if (providerInfo?.requiresApiKey) {
        if (apiKey.trim()) await ai.setApiKey(activeProvider, apiKey.trim())
      } else {
        await ai.setEndpoint(endpointUrlRef.current)
        if (apiKey.trim()) await ai.setApiKey(activeProvider, apiKey.trim())
      }
      await ai.setModel(currentModel)
      await ai.setSystem(systemPrompt)
      const connected = await runDetailedConnectionTrace('Apply', false)
      const appliedTo = providerInfo?.requiresApiKey
        ? (providerInfo.name ?? activeProvider)
        : endpointUrlRef.current
      writeLine(`\x1b[32mApplied: ${appliedTo} | ${currentModel}\x1b[0m`)
      if (connected) {
        writeLine('\x1b[32m✓ 연결되었습니다\x1b[0m')
        setIsDirty(false)
        setIsApplySuccess(true)
        // 헬스체크가 backoff/중단된 상태라면 즉시 재시작
        healthCheckRestartRef.current?.()
      } else {
        writeLine('\x1b[31m✗ 연결 실패 - 설정을 확인하세요\x1b[0m')
        setIsApplySuccess(false)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to apply settings'
      writeLine(`\x1b[31m${message}\x1b[0m`)
      setIsApplySuccess(false)
    } finally {
      setIsBusy(false)
      writePrompt()
    }
  }, [activeProvider, apiKey, currentModel, providers, runDetailedConnectionTrace, systemPrompt, writeLine, writePrompt])

  // ── AI 프리셋 (AES-256-GCM 암호화 저장/불러오기) ─────────────────── //

  const refreshPresets = useCallback(async () => {
    if (!isWebView2()) return
    try {
      const result = await aiPreset.list()
      setPresets(result.presets ?? [])
    } catch (error) {
      logger.error('[Preset] 목록 조회 실패', { error })
    }
  }, [])

  const handleSavePreset = useCallback(async (name: string, password: string): Promise<{ success: boolean; error?: string }> => {
    if (!name?.trim()) {
      writeLine('\x1b[31m프리셋 이름이 비어있습니다.\x1b[0m')
      return { success: false, error: '프리셋 이름이 비어있습니다.' }
    }
    if (!isWebView2()) return { success: false, error: 'WebView2 환경에서만 사용 가능합니다.' }
    try {
      const result = await aiPreset.save(name.trim(), apiKey, password)
      if (result.success) {
        writeLine(`\x1b[32m✓ 프리셋 '${name.trim()}' 저장됨 (AES-256-GCM, 사용자 암호 기반)\x1b[0m`)
        await refreshPresets()
        return { success: true }
      }
      writeLine(`\x1b[31m프리셋 저장 실패: ${result.error ?? 'unknown'}\x1b[0m`)
      return { success: false, error: result.error ?? 'unknown' }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      writeLine(`\x1b[31m프리셋 저장 오류: ${msg}\x1b[0m`)
      return { success: false, error: msg }
    }
  }, [apiKey, refreshPresets, writeLine])

  const handleLoadPreset = useCallback(async (name: string, password: string): Promise<{ success: boolean; error?: string }> => {
    if (!name?.trim() || !isWebView2()) return { success: false, error: '프리셋 이름이 비어있습니다.' }
    try {
      const result = await aiPreset.load(name.trim(), password)
      if (!result.success) {
        writeLine(`\x1b[31m프리셋 로드 실패: ${result.error ?? 'unknown'}\x1b[0m`)
        return { success: false, error: result.error ?? 'unknown' }
      }
      writeLine(`\x1b[32m✓ 프리셋 '${result.name}' 로드됨\x1b[0m`)
      writeLine(`\x1b[2;37m   provider=${result.provider} baseUrl=${result.baseUrl ?? '(n/a)'} model=${result.model ?? '(n/a)'}\x1b[0m`)
      // UI 상태 동기화
      if (result.provider) setActiveProvider(result.provider)
      if (result.baseUrl != null) {
        endpointUrlRef.current = result.baseUrl
        setEndpointUrl(result.baseUrl)
      }
      if (result.model != null) setCurrentModel(result.model)
      if (result.allowInsecureSsl != null) setAllowInsecureSsl(result.allowInsecureSsl)
      setApiKey('') // 평문 키는 UI에 노출하지 않음 (백엔드에만 저장됨)
      setIsDirty(false)
      setIsApplySuccess(true)
      healthCheckRestartRef.current?.()
      await refreshPresets()
      // 엔진 상태 새로고침
      await loadEngineState(false)
      return { success: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      writeLine(`\x1b[31m프리셋 로드 오류: ${msg}\x1b[0m`)
      return { success: false, error: msg }
    }
  }, [loadEngineState, refreshPresets, writeLine])

  const handleDeletePreset = useCallback(async (name: string) => {
    if (!name?.trim() || !isWebView2()) return false
    try {
      const result = await aiPreset.delete(name.trim())
      if (result.success) {
        writeLine(`\x1b[33m프리셋 '${name.trim()}' 삭제됨\x1b[0m`)
        await refreshPresets()
        return true
      }
      return false
    } catch { return false }
  }, [refreshPresets, writeLine])

  const handleAnalyzeClick = useCallback(async () => {
    const term = termRef.current
    if (!term) return

    // AI 미설정 시 안내 메시지 표시 후 종료
    if (!isConfigured) {
      const warnMsg: ChatMessage = {
        id: crypto.randomUUID(), role: 'system',
        content: '⚠️ AI가 설정되지 않았습니다. Settings에서 AI Provider를 설정하고 Apply를 눌러주세요.',
        timestamp: Date.now(),
      }
      setChatMessages(prev => [...prev, warnMsg])
      term.writeln('\x1b[33m⚠ AI 미설정 — Settings에서 Provider/API Key 설정 후 Apply를 눌러주세요.\x1b[0m')
      return
    }

    setIsBusy(true)
    isProcessingRef.current = true
    term.writeln('')

    // Chat tab sync
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: '🔍 SSH 출력 AI 분석 요청', timestamp: Date.now() }
    const assistantId = crypto.randomUUID()
    const assistantMsg: ChatMessage = { id: assistantId, role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true }
    setChatMessages(prev => [...prev, userMsg, assistantMsg])

    const chunkBuffer: string[] = []
    let animationDone = false
    const contentRef = { current: '' }
    const analyzePromise = ai.analyzeLast((chunk) => {
      if (!isProcessingRef.current) return
      if (animationDone) term.write(chunk)
      else chunkBuffer.push(chunk)
      contentRef.current += chunk
      setChatMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: contentRef.current } : m))
    })

    const randomMsg = THINKING_MESSAGES[Math.floor(Math.random() * THINKING_MESSAGES.length)]
    const indicatorLines: { text: string; color: string }[] = [
      { text: ' ----------------------------------------------------------------------------', color: '\x1b[2;36m' },
      { text: `  ${randomMsg}`, color: '\x1b[36m' },
      { text: '  ※ AI는 정확하지 않는 정보를 제공할 수 있습니다. 중요한 정보는 반드시 확인하세요!', color: '\x1b[33m' },
      { text: ' ----------------------------------------------------------------------------', color: '\x1b[2;36m' },
    ]
    for (const { text, color } of indicatorLines) {
      if (!isProcessingRef.current) break
      term.write(`${color}${text}\x1b[0m\r\n`)
    }
    if (isProcessingRef.current) term.write('\r\n')

    animationDone = true
    for (const chunk of chunkBuffer) {
      if (isProcessingRef.current) term.write(chunk)
    }

    try {
      const result = await analyzePromise
      term.writeln('')
      if (!result.content.trim()) {
        writeLine('\x1b[33mSSH 터미널에서 명령어를 실행한 후 다시 시도하세요.\x1b[0m')
      }
    } catch (error) {
      writeLine(`\x1b[31mError: ${error instanceof Error ? error.message : 'Unknown error'}\x1b[0m`)
    } finally {
      isProcessingRef.current = false
      setIsBusy(false)
      writePrompt()
      setChatMessages(prev => prev.map(m => m.id === assistantId ? { ...m, isStreaming: false } : m))
      window.dispatchEvent(new CustomEvent('ai-streaming-end'))
    }
  }, [isConfigured, writeLine, writePrompt])

  const printHelp = useCallback(() => {
    const term = termRef.current
    if (!term) return
    term.writeln('')
    term.writeln('\x1b[1;36m--- Local LLM Terminal Commands ---\x1b[0m')
    term.writeln('')
    term.writeln('  \x1b[33mengine status\x1b[0m              Check AI engine availability')
    term.writeln('  \x1b[33mmodel list\x1b[0m                List available models')
    term.writeln('  \x1b[33mmodel use <MODEL>\x1b[0m         Switch active model')
    term.writeln('  \x1b[33msystem set <PROMPT>\x1b[0m      Update system prompt')
    term.writeln('  \x1b[33manalyze last\x1b[0m             SSH 마지막 명령어 출력 AI 분석')
    term.writeln('  \x1b[33mstatus\x1b[0m                   Show AI engine state')
    term.writeln('  \x1b[33mclear\x1b[0m                    Clear terminal')
    term.writeln('  \x1b[33mreset\x1b[0m                    Clear conversation history')
    term.writeln('  \x1b[33mhelp\x1b[0m                     Show this help')
    term.writeln('')
    term.writeln('  Any other input is sent to the AI model.')
  }, [])

  const handleBuiltinCommand = useCallback(async (command: string): Promise<boolean> => {
    const normalized = command.trim()
    const lower = normalized.toLowerCase()
    const parts = normalized.split(/\s+/)

    if (lower === 'help') { printHelp(); return true }

    if (lower === 'clear') { termRef.current?.clear(); return true }

    if (lower === 'reset') {
      await ai.clear().catch(() => undefined)
      writeLine('\x1b[32mConversation history cleared.\x1b[0m')
      return true
    }

    if (lower === 'status' || lower === 'engine status') {
      await handleCheck()
      return true
    }

    if (lower === 'model list') {
      try {
        const result = await ai.models()
        setAvailableModels(result.models)
        writeLine('\x1b[1mAvailable Models:\x1b[0m')
        result.models.forEach((model) => {
          const marker = model === currentModel ? ' \x1b[32m<current>\x1b[0m' : ''
          writeLine(`  \x1b[33m${model}\x1b[0m${marker}`)
        })
      } catch (error) {
        writeLine(`\x1b[31m${error instanceof Error ? error.message : 'Failed to list models'}\x1b[0m`)
      }
      return true
    }

    if (parts[0]?.toLowerCase() === 'model' && parts[1]?.toLowerCase() === 'use' && parts[2]) {
      const model = parts.slice(2).join(' ')
      await ai.setModel(model)
      setCurrentModel(model)
      writeLine(`\x1b[32mActive model: ${model}\x1b[0m`)
      return true
    }

    if (parts[0]?.toLowerCase() === 'system' && parts[1]?.toLowerCase() === 'set' && parts[2]) {
      const prompt = parts.slice(2).join(' ')
      await ai.setSystem(prompt)
      setSystemPrompt(prompt)
      writeLine('\x1b[32mSystem prompt updated.\x1b[0m')
      return true
    }

    if (lower === 'analyze last') {
      await handleAnalyzeClick()
      return true
    }

    return false
  }, [currentModel, handleCheck, handleAnalyzeClick, printHelp, writeLine])

  const sendMessage = useCallback(async (message: string) => {
    const term = termRef.current
    if (!term || isProcessingRef.current) return

    isProcessingRef.current = true
    setIsStreaming(true)
    term.writeln('')

    // Chat tab sync: push user message
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: message, timestamp: Date.now() }
    const assistantId = crypto.randomUUID()
    const assistantMsg: ChatMessage = { id: assistantId, role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true }
    setChatMessages(prev => [...prev, userMsg, assistantMsg])

    if (!isWebView2()) {
      term.writeln('\x1b[31mWebView2 not available. Running in browser mode.\x1b[0m')
      term.writeln('\x1b[33mAI calls require the native WPF host.\x1b[0m')
      isProcessingRef.current = false
      setIsStreaming(false)
      setChatMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: 'WebView2 not available.', isStreaming: false } : m))
      return
    }

    const chunkBuffer: string[] = []
    let animationDone = false
    const contentRef = { current: '' }
    // Chat 패널 re-render를 ~80ms 단위로 배치 처리 (청크마다 re-render 방지)
    let chatUpdateTimer: ReturnType<typeof setTimeout> | null = null
    const streamPromise = ai.stream(message, (chunk) => {
      if (!isProcessingRef.current) return
      if (animationDone) term.write(chunk)
      else chunkBuffer.push(chunk)
      contentRef.current += chunk
      if (chatUpdateTimer === null) {
        chatUpdateTimer = setTimeout(() => {
          chatUpdateTimer = null
          setChatMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: contentRef.current } : m))
        }, 80)
      }
    })

    const randomMsg = THINKING_MESSAGES[Math.floor(Math.random() * THINKING_MESSAGES.length)]
    const indicatorLines: { text: string; color: string }[] = [
      { text: ' ----------------------------------------------------------------------------', color: '\x1b[2;36m' },
      { text: `  ${randomMsg}`, color: '\x1b[36m' },
      { text: '  ※ AI는 정확하지 않는 정보를 제공할 수 있습니다. 중요한 정보는 반드시 확인하세요!', color: '\x1b[33m' },
      { text: ' ----------------------------------------------------------------------------', color: '\x1b[2;36m' },
    ]
    for (const { text, color } of indicatorLines) {
      if (!isProcessingRef.current) break
      term.write(`${color}${text}\x1b[0m\r\n`)
    }
    if (isProcessingRef.current) term.write('\r\n')

    animationDone = true
    for (const chunk of chunkBuffer) {
      if (isProcessingRef.current) term.write(chunk)
    }

    // Chat 패널에 표시할 최종 상태 (catch/finally 사이 공유)
    let chatErrorMessage: string | null = null
    let chatEmptyNotice = false

    try {
      const response = await streamPromise
      term.writeln('')
      if (!response.content.trim() && !contentRef.current.trim()) {
        term.writeln('\x1b[33mNo content returned.\x1b[0m')
        chatEmptyNotice = true
      }
      // 모델 자동 교정 감지: 백엔드가 API 키 제한으로 모델을 자동 변경한 경우 UI 동기화
      try {
        const state = await ai.state()
        const prevModel = currentModelRef.current
        if (state.model && state.model !== prevModel) {
          term.writeln('')
          term.writeln(`\x1b[33m🔧 모델 자동 교정: '${prevModel}' → '${state.model}'\x1b[0m`)
          term.writeln(`\x1b[2;37m   (API 키가 이 모델만 허용하므로 자동으로 교체되었습니다)\x1b[0m`)
          setCurrentModel(state.model)
        }
        // 모델 목록도 새로 감지된 목록으로 갱신 (게이트웨이 에러 응답에서 추출한 허용 모델들)
        const modelsResult = await ai.models()
        if (modelsResult.models?.length) {
          setAvailableModels(modelsResult.models)
          term.writeln(`\x1b[2;37m   사용 가능 모델: [${modelsResult.models.join(', ')}]\x1b[0m`)
        }
      } catch { /* state/models 조회 실패 무시 */ }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      term.writeln(`\r\n\x1b[31mError: ${errorMsg}\x1b[0m`)
      chatErrorMessage = errorMsg
    } finally {
      // 대기 중 타이머 취소 후 최종 상태 1회 반영
      if (chatUpdateTimer !== null) {
        clearTimeout(chatUpdateTimer)
        chatUpdateTimer = null
      }
      isProcessingRef.current = false
      setIsStreaming(false)
      // Chat 버블 최종 내용 결정:
      // 1) 에러 발생 → 에러 메시지 표시 (사용자가 원인 인지 가능)
      // 2) 응답이 완전히 비어 있음 → 안내 메시지 표시 (빈 버블 방지)
      // 3) 정상 응답 → 누적된 contentRef.current 그대로
      let finalContent = contentRef.current
      if (chatErrorMessage) {
        finalContent = `⚠️ **응답 실패**: ${chatErrorMessage}\n\n다시 시도하거나 다른 모델을 선택해 주세요.`
      } else if (chatEmptyNotice && !finalContent.trim()) {
        finalContent = '⚠️ **응답이 비어 있습니다.** 모델이 빈 답변을 반환했습니다. 질문을 다시 표현하거나 다른 모델을 선택해 주세요.'
      }
      setChatMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, isStreaming: false, content: finalContent } : m
      ))
      window.dispatchEvent(new CustomEvent('ai-streaming-end'))
    }
  }, [])

  useEffect(() => { sendMessageRef.current = sendMessage }, [sendMessage])
  useEffect(() => { handleBuiltinCommandRef.current = handleBuiltinCommand }, [handleBuiltinCommand])
  useEffect(() => { writePromptRef.current = writePrompt }, [writePrompt])
  useEffect(() => { runDetailedConnectionTraceRef.current = runDetailedConnectionTrace }, [runDetailedConnectionTrace])

  // AI 헬스체크 — 연속 실패 시 backoff (3회 실패 → 5분 간격, 10회 → 중단)
  // Apply 성공 시 healthCheckRestartRef.current()로 재시작 가능
  const healthCheckRestartRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!isWebView2()) return

    let consecutiveFailures = 0
    let currentInterval = 30_000
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false

    const tick = async () => {
      if (stopped) return
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(tick, currentInterval)
        return
      }
      try {
        const state = await ai.state()
        const serverEp = state.baseUrl || endpointUrlRef.current
        const provider = state.provider || 'ollama'
        setIsConfigured(state.isConfigured)
        const provInfo = providersRef.current.find(p => p.id === provider)
        const isApiKey = provInfo?.requiresApiKey ?? false
        const provLabel = provInfo?.name ?? provider
        const statusMsg = isApiKey
          ? (state.isConfigured ? `${provLabel} Ready` : `${provLabel}: API Key 없음`)
          : (state.isConfigured ? `Ready on ${serverEp}` : `Offline at ${serverEp}`)
        setStatusMessage(statusMsg)
        if (state.isConfigured) {
          consecutiveFailures = 0
          currentInterval = 30_000
        } else {
          consecutiveFailures++
        }
      } catch {
        consecutiveFailures++
        setIsConfigured(false)
        setStatusMessage(`Offline at ${endpointUrlRef.current}`)
      }

      if (consecutiveFailures >= 10) {
        logger.warn('[HealthCheck] 10회 연속 실패 → 중단. Apply 누르면 재시작합니다.')
        setStatusMessage(`Offline (health check paused — Apply 시 재시작)`)
        return
      }
      // 3회 이상 실패 → 5분 간격으로 완화 (로그/네트워크 부하 감소)
      currentInterval = consecutiveFailures >= 3 ? 300_000 : 30_000
      timer = setTimeout(tick, currentInterval)
    }

    const restart = () => {
      consecutiveFailures = 0
      currentInterval = 30_000
      if (timer) clearTimeout(timer)
      timer = setTimeout(tick, 1_000)  // 즉시 1초 후 재시작
      logger.info('[HealthCheck] Apply 감지 — 재시작')
    }
    healthCheckRestartRef.current = restart

    timer = setTimeout(tick, currentInterval)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      healthCheckRestartRef.current = null
    }
  }, [])

  const handleCancel = useCallback(async () => {
    try { await ai.cancelStream() } catch { /* ignore */ }
    isProcessingRef.current = false
    setIsStreaming(false)
    termRef.current?.writeln('\r\n\x1b[33mCancelled\x1b[0m')
    writePrompt()
  }, [writePrompt])

  const handleClear = useCallback(() => {
    termRef.current?.clear()
    writePrompt()
    inputBufferRef.current = ''
    setChatMessages([])
  }, [writePrompt])

  // Called from AITerminal after xterm is created
  const initializeOnMount = useCallback((term: Terminal) => {
    termRef.current = term

    term.writeln('\x1b[1;36mLocal LLM Terminal\x1b[0m')
    term.writeln('Type \x1b[33mhelp\x1b[0m for available commands.')

    if (isWebView2()) {
      // 프리셋 목록 최초 로드
      refreshPresets()
      ;(async () => {
        try {
          // 로그저장이 꺼져 있으면 세션 저장/복원 전체 스킵
          const saveEnabled = localStorage.getItem('aitty.saveApiLog') !== '0'
          if (saveEnabled) {
            const saved = await session.getRestored()
            if (saved && saved.messageCount > 0) {
              setCurrentModel(saved.model)
              setEngineName(saved.engine)
              setActiveProvider(saved.provider)
              if (saved.systemPrompt) setSystemPrompt(saved.systemPrompt)
              const date = new Date(saved.savedAt).toLocaleString('ko-KR')
              term.writeln(`\x1b[2m[세션 복원: ${date} | ${saved.messageCount}개 메시지]\x1b[0m`)

              // Chat 탭 히스토리 복원
              try {
                const history = await ai.history()
                if (history.messages?.length) {
                  const restored: ChatMessage[] = history.messages.map((m, i) => ({
                    id: `restored-${i}`,
                    role: m.role as 'user' | 'assistant',
                    content: m.content,
                    timestamp: new Date(saved.savedAt).getTime() + i,
                  }))
                  setChatMessages(restored)
                }
              } catch { /* history load failure — non-critical */ }
            }
          }
        } catch { /* 복원 실패 — 무시하고 새 세션 시작 */ }

        if (startupTracePrinted) {
          writePromptRef.current()
          return
        }
        startupTracePrinted = true
        try {
          const connected = await runDetailedConnectionTraceRef.current('Startup', true)
          if (connected) {
            setIsApplySuccess(true)
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : '초기화 실패'
          term.writeln(`\x1b[31m${message}\x1b[0m`)
        } finally {
          writePromptRef.current()
        }
      })()
    } else {
      term.writeln('\x1b[33mWebView2 host not detected. 상세 접속 로그를 사용할 수 없습니다.\x1b[0m')
      writePromptRef.current()
    }
  }, [])

  return {
    termRef,
    inputBufferRef,
    isProcessingRef,
    sendMessageRef,
    handleBuiltinCommandRef,
    writePromptRef,
    runDetailedConnectionTraceRef,
    endpointUrlRef,
    providersRef,

    isConfigured,
    currentModel,
    isStreaming,
    engineName,
    availableModels,
    isSettingsOpen,
    isSystemPromptOpen,
    systemPrompt,
    endpointUrl,
    statusMessage,
    isBusy,
    isDirty,
    isApplySuccess,
    activeProvider,
    apiKey,
    providers,
    saveApiLog,
    allowInsecureSsl,
    presets,

    setIsSettingsOpen,
    setIsSystemPromptOpen,
    setSystemPrompt,
    setApiKey,
    setSaveApiLog,
    setAllowInsecureSsl,
    setIsDirty,
    setIsApplySuccess,

    chatMessages,
    setChatMessages,

    writePrompt,
    writeLine,
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
  }
}
