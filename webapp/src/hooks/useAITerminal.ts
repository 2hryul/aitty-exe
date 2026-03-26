import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from 'xterm'
import { ai, session, type AiProvider } from '@bridge/ipcBridge'
import type { ChatMessage } from '@app-types/chat'

export const DEFAULT_MODEL = 'qwen2.5-coder:7b'
export const DEFAULT_SYSTEM_PROMPT = 'You are a local Linux SSH assistant. Analyze terminal output, explain issues, and suggest safe next commands. Prefer minimal-risk commands first.'
export const DEFAULT_ENDPOINT = import.meta.env.VITE_DEFAULT_OLLAMA_ENDPOINT || 'http://127.0.0.1:11434'

// 프로바이더별 실제 API 엔드포인트 (프론트엔드 표시용)
const PROVIDER_ENDPOINTS: Record<string, string> = {
  gemini: 'https://generativelanguage.googleapis.com',
  claude: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
}

function mergeProviderEndpoints(backendProviders: AiProvider[]): AiProvider[] {
  const PROVIDER_NAMES: Record<string, string> = {
    ollama: 'API 접속',
    gemini: 'Google Gemini',
    claude: 'Anthropic Claude',
    openai: 'OpenAI ChatGPT',
  }
  return backendProviders.map(p => ({
    ...p,
    name: PROVIDER_NAMES[p.id] ?? p.name,
    ...(PROVIDER_ENDPOINTS[p.id] ? { endpoint: PROVIDER_ENDPOINTS[p.id] } : {}),
  }))
}

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
  isApplySuccess: boolean
  activeProvider: string
  apiKey: string
  providers: AiProvider[]
  saveApiLog: boolean

  // setters
  setIsSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>
  setIsSystemPromptOpen: React.Dispatch<React.SetStateAction<boolean>>
  setSystemPrompt: React.Dispatch<React.SetStateAction<string>>
  setApiKey: React.Dispatch<React.SetStateAction<string>>
  setSaveApiLog: React.Dispatch<React.SetStateAction<boolean>>
  setIsDirty: React.Dispatch<React.SetStateAction<boolean>>
  setIsApplySuccess: React.Dispatch<React.SetStateAction<boolean>>

  // handlers
  writePrompt: () => void
  writeLine: (text: string) => void
  handleEndpointChange: (value: string) => void
  handleProviderChange: (provider: string) => Promise<void>
  handleModelChange: (newModel: string) => Promise<void>
  handleCheck: () => Promise<void>
  handleApplySettings: () => Promise<void>
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
  const [currentModel, setCurrentModel] = useState(DEFAULT_MODEL)
  const [isStreaming, setIsStreaming] = useState(false)
  const [engineName, setEngineName] = useState('ollama')
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [isSettingsOpen, setIsSettingsOpen] = useState(true)
  const [isSystemPromptOpen, setIsSystemPromptOpen] = useState(false)
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT)
  const [endpointUrl, setEndpointUrl] = useState(_savedEndpoint)
  const [statusMessage, setStatusMessage] = useState('Not checked')
  const [isBusy, setIsBusy] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [isApplySuccess, setIsApplySuccess] = useState(false)

  const [activeProvider, setActiveProvider] = useState<string>('ollama')
  const [apiKey, setApiKey] = useState('')
  const [providers, setProviders] = useState<AiProvider[]>([
    { id: 'ollama', name: 'API 접속',          status: 'local',      requiresApiKey: false },
    { id: 'gemini', name: 'Google Gemini',    status: 'no-api-key', requiresApiKey: true,  endpoint: 'https://generativelanguage.googleapis.com' },
    { id: 'claude', name: 'Anthropic Claude', status: 'no-api-key', requiresApiKey: true,  endpoint: 'https://api.anthropic.com' },
    { id: 'openai', name: 'OpenAI ChatGPT',   status: 'no-api-key', requiresApiKey: true,  endpoint: 'https://api.openai.com' },
  ])
  const [saveApiLog, setSaveApiLog] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('aitty.saveApiLog')
      return stored === null ? true : stored === '1'
    } catch {
      return true
    }
  })

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
  useEffect(() => {
    try { localStorage.setItem('aitty.endpointUrl', endpointUrl) } catch { /* ignore */ }
  }, [endpointUrl])

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
      setProviders(mergeProviderEndpoints(provResult.providers))
      setAvailableModels(modelList)

      const currentProviderInfo = provResult.providers.find(p => p.id === currentProvider)
      const isApiKeyProvider = currentProviderInfo?.requiresApiKey ?? false
      const providerLabel = currentProviderInfo?.name ?? currentProvider

      const statusMsg = isApiKeyProvider
        ? (state.isConfigured ? `${providerLabel} Ready` : `${providerLabel}: API Key 없음`)
        : (state.isConfigured ? `Ready on ${serverEp}` : `Offline at ${serverEp}`)
      setStatusMessage(statusMsg)

      const serverModel = state.model || DEFAULT_MODEL
      const resolvedModel = modelList.length > 0
        ? (modelList.includes(serverModel) ? serverModel : modelList[0])
        : serverModel
      setCurrentModel(resolvedModel)

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
    setIsApplySuccess(false)
    if (!isWebView2()) return
    try {
      await ai.setProvider(provider)
      await loadEngineState(false)
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
    const serverModel = state.model || DEFAULT_MODEL
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

  const handleAnalyzeClick = useCallback(async () => {
    const term = termRef.current
    if (!term) return

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
  }, [writeLine, writePrompt])

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

    try {
      const response = await streamPromise
      term.writeln('')
      if (!response.content.trim()) {
        term.writeln('\x1b[33mNo content returned.\x1b[0m')
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      term.writeln(`\r\n\x1b[31mError: ${errorMsg}\x1b[0m`)
    } finally {
      // 대기 중 타이머 취소 후 최종 상태 1회 반영
      if (chatUpdateTimer !== null) {
        clearTimeout(chatUpdateTimer)
        chatUpdateTimer = null
      }
      isProcessingRef.current = false
      setIsStreaming(false)
      setChatMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, isStreaming: false, content: contentRef.current } : m
      ))
      window.dispatchEvent(new CustomEvent('ai-streaming-end'))
    }
  }, [])

  useEffect(() => { sendMessageRef.current = sendMessage }, [sendMessage])
  useEffect(() => { handleBuiltinCommandRef.current = handleBuiltinCommand }, [handleBuiltinCommand])
  useEffect(() => { writePromptRef.current = writePrompt }, [writePrompt])
  useEffect(() => { runDetailedConnectionTraceRef.current = runDetailedConnectionTrace }, [runDetailedConnectionTrace])

  // AI 30초 헬스체크
  useEffect(() => {
    if (!isWebView2()) return
    const timer = setInterval(async () => {
      if (document.visibilityState === 'hidden') return
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
      } catch {
        setIsConfigured(false)
        setStatusMessage(`Offline at ${endpointUrlRef.current}`)
      }
    }, 30_000)
    return () => clearInterval(timer)
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

    setIsSettingsOpen,
    setIsSystemPromptOpen,
    setSystemPrompt,
    setApiKey,
    setSaveApiLog,
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
    handleAnalyzeClick,
    handleCancel,
    handleClear,
    sendMessage,

    initializeOnMount,
  }
}
