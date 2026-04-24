declare global {
  interface Window {
    chrome?: {
      webview?: {
        postMessage(message: unknown): void
        addEventListener(type: string, listener: (e: MessageEvent) => void): void
        removeEventListener(type: string, listener: (e: MessageEvent) => void): void
      }
    }
  }
}

export interface SavedSSHConnection {
  host: string
  port: number
  username: string
  privateKey?: string
  password?: string
  passphrase?: string
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

type StreamChunkHandler = (chunk: string) => void
type ProgressHandler = (p: { index: number; total: number; bytes: number }) => void

const pending = new Map<string, PendingRequest>()
const streamListeners = new Map<string, StreamChunkHandler>()
const progressListeners = new Map<string, ProgressHandler>()
const REQUEST_TIMEOUT = 30_000
const STREAM_TIMEOUT = 120_000
// 분할 분석은 최대 20분(청크 연쇄 + 종합 요약)
const CHUNKED_TIMEOUT = 20 * 60 * 1000

function isWebView2(): boolean {
  return !!window.chrome?.webview
}

function init() {
  if (!isWebView2()) return

  window.chrome!.webview!.addEventListener('message', (e: MessageEvent) => {
    try {
      const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data

      // ai:stream:chunk / ai:ssh:analyze:chunk / ai:ssh:suggest:chunk 통합 처리
      if (msg.type.endsWith(':chunk')) {
        const listener = streamListeners.get(msg.id)
        if (listener && msg.payload?.chunk) {
          listener(msg.payload.chunk)
        }
        return
      }

      // logs:chunk-progress 는 같은 msg.id로 도착하지만 완료 이벤트가 아니므로
      // pending 프로미스를 조기 resolve 하지 않도록 먼저 처리한다.
      if (msg.type === 'logs:chunk-progress') {
        const progressHandler = progressListeners.get(msg.id)
        if (progressHandler && msg.payload) progressHandler(msg.payload)
        return
      }

      const req = pending.get(msg.id)
      if (!req) return

      clearTimeout(req.timer)
      pending.delete(msg.id)
      streamListeners.delete(msg.id)
      progressListeners.delete(msg.id)

      if (msg.error) {
        req.reject(new Error(msg.error))
      } else {
        req.resolve(msg.payload)
      }
    } catch (err) {
      console.error('[ipcBridge] Failed to parse message', err)
    }
  })
}

export function invoke<T = unknown>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!isWebView2()) {
    return Promise.reject(new Error('WebView2 not available, running in browser mode'))
  }

  return new Promise<T>((resolve, reject) => {
    const id = crypto.randomUUID()
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`IPC timeout: ${type}`))
    }, REQUEST_TIMEOUT)

    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
    window.chrome!.webview!.postMessage({ id, type, payload })
  })
}

export const ssh = {
  connect: (conn: { host: string; port: number; username: string; password?: string; privateKey?: string; passphrase?: string }) =>
    invoke<{ success: boolean }>('ssh:connect', conn),
  disconnect: () => invoke<{ success: boolean }>('ssh:disconnect'),
  exec: (command: string) => invoke<{ output: string }>('ssh:exec', { command }),
  test: () => invoke<{ success: boolean }>('ssh:test'),
  state: () => invoke<{ isConnected: boolean; isConnecting: boolean; error?: string; host?: string }>('ssh:state'),
  shellWrite: (data: string) => invoke<{ success: boolean }>('ssh:shell:write', { data }),
  shellRead: () => invoke<{ data: string | null }>('ssh:shell:read'),
  resize: (cols: number, rows: number) => invoke<{ success: boolean }>('ssh:resize', { cols, rows }),
}

export const config = {
  load: () => invoke<{ theme: 'light' | 'dark'; fontSize: number; fontFamily: string; sshConnections: SavedSSHConnection[]; lastConnection?: string }>('config:load'),
  save: (cfg: Record<string, unknown>) => invoke<{ success: boolean }>('config:save', cfg),
  addConnection: (conn: SavedSSHConnection) => invoke<{ success: boolean }>('config:connections:add', conn as unknown as Record<string, unknown>),
  removeConnection: (host: string) => invoke<{ success: boolean }>('config:connections:remove', { host }),
}

export const keys = {
  list: () => invoke<{ keys: string[]; directory: string }>('keys:list'),
  validate: (path: string) => invoke<{ valid: boolean }>('keys:validate', { path }),
  browse: () => invoke<{ selected: boolean; path: string | null; valid: boolean }>('keys:browse'),
  sshConfig: () => invoke<Record<string, Record<string, string>>>('keys:ssh-config'),
}

export interface AiSendResponse {
  content: string
  model: string
  inputTokens: number
  outputTokens: number
}

export interface AiStreamResponse {
  content: string
  done: boolean
}

export interface AiState {
  isConfigured: boolean
  model: string
  historyCount: number
  engine: string
  provider: string
  baseUrl?: string
}

export interface AiProvider {
  id: string
  name: string
  status: string
  requiresApiKey: boolean
  endpoint?: string
}

export interface AiProvidersResponse {
  providers: AiProvider[]
  active: string
}

export interface OpenWebUiDiagnosis {
  success: boolean
  isBlocked: boolean
  baseUrl: string
  isOpenWebUi: boolean
  modelsCount: number
  logs: string[]
  /** 엔드포인트가 OpenAI 호환 게이트웨이(vLLM/Shinhan Hands 등)로 의심될 때 true. */
  suggestOpenAiProvider?: boolean
}

export interface ApiLogSaveResult {
  success: boolean
  path: string
}

function createStreamRequest<T>(
  type: string,
  payload: Record<string, unknown>,
  onChunk?: StreamChunkHandler,
): Promise<T> {
  if (!isWebView2()) {
    return Promise.reject(new Error('WebView2 not available, running in browser mode'))
  }

  return new Promise<T>((resolve, reject) => {
    const id = crypto.randomUUID()
    const timer = setTimeout(() => {
      pending.delete(id)
      streamListeners.delete(id)
      progressListeners.delete(id)
      reject(new Error(`IPC timeout: ${type}`))
    }, STREAM_TIMEOUT)

    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
    if (onChunk) streamListeners.set(id, onChunk)
    window.chrome!.webview!.postMessage({ id, type, payload })
  })
}

// 분할 분석 전용 — progress listener 맵 관리 + 훨씬 긴 타임아웃
function createChunkedRequest<T>(
  type: string,
  payload: Record<string, unknown>,
  onChunk?: StreamChunkHandler,
  onProgress?: ProgressHandler,
): Promise<T> {
  if (!isWebView2()) {
    return Promise.reject(new Error('WebView2 not available, running in browser mode'))
  }

  return new Promise<T>((resolve, reject) => {
    const id = crypto.randomUUID()
    const timer = setTimeout(() => {
      pending.delete(id)
      streamListeners.delete(id)
      progressListeners.delete(id)
      reject(new Error(`IPC timeout: ${type}`))
    }, CHUNKED_TIMEOUT)

    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
    if (onChunk) streamListeners.set(id, onChunk)
    if (onProgress) progressListeners.set(id, onProgress)
    window.chrome!.webview!.postMessage({ id, type, payload })
  })
}

export const ai = {
  send: (message: string) => invoke<AiSendResponse>('ai:send', { message }),
  stream: (message: string, onChunk: StreamChunkHandler) =>
    createStreamRequest<AiStreamResponse>('ai:stream', { message }, onChunk),
  cancelStream: () => invoke<{ success: boolean }>('ai:stream:cancel'),
  configure: (config: { model?: string; systemPrompt?: string; maxTokens?: number }) => invoke<{ success: boolean }>('ai:configure', config),
  setModel: (model: string) => invoke<{ success: boolean; model: string }>('ai:set-model', { model }),
  setSystem: (systemPrompt: string | null) => invoke<{ success: boolean }>('ai:set-system', { systemPrompt }),
  setEndpoint: (url: string) => invoke<{ success: boolean; url: string }>('ai:set-endpoint', { url }),
  /** SSL 인증서 검증 건너뛰기 토글 — 내부망 자체서명 인증서 엔드포인트 지원. */
  setAllowInsecureSsl: (enabled: boolean) => invoke<{ success: boolean; enabled: boolean }>('ai:set-insecure-ssl', { enabled }),
  openWebUiDiagnose: (url?: string) => invoke<OpenWebUiDiagnosis>('ai:openwebui:diagnose', { url: url ?? '' }),
  saveApiLog: (content: string) => invoke<ApiLogSaveResult>('ai:api-log:save', { content }),
  state: () => invoke<AiState>('ai:state'),
  history: () => invoke<{ messages: Array<{ role: string; content: string }> }>('ai:history'),
  clear: () => invoke<{ success: boolean }>('ai:clear'),
  models: () => invoke<{ models: string[] }>('ai:models'),
  // ── 제공자 관리 ─────────────────────────────── //
  providers: () => invoke<AiProvidersResponse>('ai:providers'),
  setProvider: (provider: string) => invoke<{ success: boolean; provider: string }>('ai:set-provider', { provider }),
  setApiKey: (provider: string, apiKey: string) => invoke<{ success: boolean; provider: string; hasKey: boolean }>('ai:set-apikey', { provider, apiKey }),
  // 스트리밍으로 전환: 30초 타임아웃 → 120초 + 청크 실시간 출력
  analyzeLast: (onChunk?: StreamChunkHandler) =>
    createStreamRequest<{ content: string }>('ai:ssh:analyze', {}, onChunk),
  suggestCommand: (onChunk?: StreamChunkHandler) =>
    createStreamRequest<{ content: string }>('ai:ssh:suggest-command', {}, onChunk),
}

export const security = {
  browseScripts: () => invoke<{
    selected: boolean
    files: Array<{ name: string; path: string; size: number }>
  }>('security:browse-scripts'),

  deploy: (files: string[]) => invoke<{
    success: boolean
    files: string[]
    remoteDir: string
  }>('security:deploy', { files }),

  run: (func: string, useSudo: boolean = false) => invoke<{
    function: string
    status: 'pass' | 'fail' | 'na' | 'fixed' | 'error' | 'unknown'
    reason: string
    output: string
  }>('security:run', { function: func, useSudo }),
}

// ── Log Tab — 수집 · 예산 · 분석 ─────────────────────────── //

export interface LogFileInfo {
  exists: boolean
  size: number
  lastWriteUtc: string | null
}

export interface LogPayload {
  source: string
  host: string | null
  sizeBytes: number
  lineCount: number
  content: string
  collectedAt: string
}

// 백엔드 응답은 C# PascalCase 그대로 수신 ("Ok" | "Warn" | "Reject").
// 훅 레이어에서 소문자로 정규화.
export interface LogBudgetCheckResponse {
  status: 'Ok' | 'Warn' | 'Reject'
  budget: number
  sizeBytes: number
  ratio: number
  suggestedChunks: number
}

export const logs = {
  statFile: (path: string) =>
    invoke<LogFileInfo>('logs:stat-file', { path }),

  fetchFile: (path: string, tailBytes: number, fullFile: boolean) =>
    invoke<LogPayload>('logs:fetch-file', { path, tailBytes, fullFile }),

  fetchExec: (command: string) =>
    invoke<LogPayload>('logs:fetch-exec', { command }),

  evaluate: (sizeBytes: number, provider: string, model: string) =>
    invoke<LogBudgetCheckResponse>('logs:evaluate', { sizeBytes, provider, model }),

  analyze: (payload: LogPayload, question: string, onChunk?: StreamChunkHandler) =>
    createStreamRequest<{ content: string }>(
      'logs:analyze',
      { payload, question },
      onChunk,
    ),

  analyzeChunked: (
    payload: LogPayload,
    question: string,
    budget: number,
    onChunk?: StreamChunkHandler,
    onProgress?: ProgressHandler,
  ) =>
    createChunkedRequest<{ content: string; chunks?: number }>(
      'logs:analyze-chunked',
      { payload, question, budget },
      onChunk,
      onProgress,
    ),

  cancelAnalyze: () => invoke<{ success: boolean }>('ai:stream:cancel'),
}

export const app = {
  version: () => invoke<{ version: string }>('app:version'),
  /** 진단 로그 폴더 열기 (ai_api.log, latest.log 등 사용자 전달용). */
  openLogFolder: () => invoke<{ success: boolean; path?: string; error?: string }>('app:open-log-folder'),
  windowMinimize: () => invoke<{ success: boolean }>('app:window-minimize'),
  windowMaximize: () => invoke<{ success: boolean }>('app:window-maximize'),
  windowClose: () => invoke<{ success: boolean }>('app:window-close'),
}

export interface RestoredSession {
  savedAt: string
  model: string
  engine: string
  provider: string
  systemPrompt: string | null
  messageCount: number
}

export const session = {
  /** 앱 시작 시 자동 복원된 세션 정보 반환. 복원 없으면 null. */
  getRestored: () => invoke<RestoredSession | null>('session:get-restored'),
  /** 로그저장 체크박스 상태를 C# SessionService에 동기화. */
  setSaveEnabled: (enabled: boolean) => invoke<{ success: boolean; saveEnabled: boolean }>('session:set-save-enabled', { enabled }),
}

// ── AI 프리셋 (AES-256-GCM 암호화 저장) ─────────────── //

export interface AiPresetInfo {
  name: string
  provider: string
  baseUrl?: string | null
  model?: string | null
  allowInsecureSsl: boolean
  hasApiKey: boolean
  savedAt: string
  lastUsedAt: string
}

export interface AiPresetLoadResult {
  success: boolean
  error?: string
  name?: string
  provider?: string
  baseUrl?: string | null
  model?: string | null
  allowInsecureSsl?: boolean
  hasApiKey?: boolean
}

export const aiPreset = {
  /** 저장된 프리셋 목록 조회 (API 키는 반환되지 않음 — 메타데이터만). */
  list: () => invoke<{ presets: AiPresetInfo[] }>('ai:preset:list'),
  /** 현재 AI 설정 + 평문 API 키를 사용자 password로 AES-256-GCM 암호화하여 디스크에 저장. */
  save: (name: string, apiKey: string, password: string) =>
    invoke<{ success: boolean; name?: string; error?: string }>('ai:preset:save', { name, apiKey, password }),
  /** 프리셋을 현재 세션에 적용 (provider 전환 + BaseUrl/API키/모델/SSL). password 불일치 시 세션 변경 없이 실패. */
  load: (name: string, password: string) =>
    invoke<AiPresetLoadResult>('ai:preset:load', { name, password }),
  /** 프리셋 삭제. */
  delete: (name: string) => invoke<{ success: boolean; error?: string }>('ai:preset:delete', { name }),
}

// ── CLI 자동접속 (HiWare/PuTTY 호환) ──────────────────── //

export interface CliConnectionInfo {
  host: string
  port: number
  username: string
  hasPassword: boolean
  hasPrivateKey: boolean
}

export const cli = {
  /** CLI 인자로 전달된 접속 정보 조회. 없으면 null (일반 GUI 모드). */
  getConnection: () => invoke<CliConnectionInfo | null>('cli:get-connection'),
  /** CLI 접속 정보로 즉시 SSH 연결. 비밀번호는 C# 메모리에만 유지. */
  autoConnect: () => invoke<{ success: boolean; error?: string }>('cli:auto-connect'),
}

init()
