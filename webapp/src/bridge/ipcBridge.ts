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
  // typeof window 가드 — vitest 기본 환경(node)에서 window 미정의 시 ReferenceError 방지.
  // 순수 함수 단위 테스트(parseCheckReadableOutput 등)가 ipcBridge 모듈 import 시 module-level init()이
  // window를 참조하지 못해 깨지는 문제 회피.
  return typeof window !== 'undefined' && !!window.chrome?.webview
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

/**
 * Bash 단일따옴표(`'`) escape — `'` → `'\''` 분할 패턴.
 * 사용자 입력 path를 안전하게 'path'로 wrap하기 위한 helper.
 * 예: /tmp/it's.log → 'it'\''s.log' 형태로 정확히 단일 인자로 전달됨.
 */
export function shellQuoteSingle(input: string): string {
  return `'${input.replace(/'/g, `'\\''`)}'`
}

export type SshPathFileType = 'file' | 'directory' | 'missing' | 'other'

export interface SshReadableCheck {
  readable: boolean
  /** stat -c '%s %a %U %G' 출력 — "크기 모드 소유자 그룹" (실패 시 빈 문자열) */
  stat?: string
  /** SSH exec channel을 실행하는 인증된 사용자의 UID. root는 0. interactive shell의 sudo 전환과 무관. */
  uid?: number
  /** 위 UID에 해당하는 사용자 이름 (`id -un`). */
  username?: string
  /** path의 실제 종류. 디렉토리/missing은 readable=false라도 별도 안내가 필요. */
  fileType?: SshPathFileType
  /** `sudo -n true`가 성공하면 true — NOPASSWD sudo가 가능한 환경 */
  sudoAvailable?: boolean
}

/**
 * `ssh.checkReadable` 의 stdout 파싱 — 순수 함수로 분리하여 단위 테스트 가능.
 *
 * 입력 라인 종류:
 *  - `OK_READABLE`           : `head -c 1`이 성공 → 실제 1바이트 read 가능
 *  - `UID=<n>`               : `id -u` 출력 (root는 `UID=0`)
 *  - `USER=<name>`           : `id -un` 출력 (사용자 이름)
 *  - `TYPE=file|directory|missing|other` : path의 실제 종류
 *  - `SUDO_NOPASSWD`         : `sudo -n true` 성공 — 비밀번호 없는 sudo 가능
 *  - `<size> <mode> <user> <group>` : `stat -c '%s %a %U %G'` 출력
 *
 * readable 판정:
 *  - `OK_READABLE` 있음 → true (일반 케이스: 실제 read 가능)
 *  - `UID=0` 있음 → true (root: SELinux/capability quirk로 head는 실패해도 신뢰)
 *  - 둘 다 없음 → false (진짜 권한 없음 또는 디렉토리/missing 등)
 */
export function parseCheckReadableOutput(output: string | null | undefined): SshReadableCheck {
  const lines = (output ?? '').split('\n').map(l => l.trim()).filter(Boolean)
  const hasOK = lines.includes('OK_READABLE')
  const uidLine = lines.find(l => l.startsWith('UID='))
  const userLine = lines.find(l => l.startsWith('USER='))
  const typeLine = lines.find(l => l.startsWith('TYPE='))
  const sudoOk = lines.includes('SUDO_NOPASSWD')

  const uidStr = uidLine?.slice(4)
  const uid = uidStr !== undefined && /^\d+$/.test(uidStr) ? parseInt(uidStr, 10) : undefined
  const username = userLine?.slice(5) || undefined
  const fileTypeRaw = typeLine?.slice(5) as SshPathFileType | undefined
  const fileType: SshPathFileType | undefined =
    fileTypeRaw && ['file', 'directory', 'missing', 'other'].includes(fileTypeRaw)
      ? fileTypeRaw
      : undefined

  const isRoot = uid === 0
  const readable = hasOK || isRoot

  // 메타 prefix 라인(TYPE=/UID=/USER=/OK_READABLE/SUDO_NOPASSWD)을 제외한 첫 줄을 stat으로 간주
  const META_PREFIX_RE = /^(TYPE=|UID=|USER=|OK_READABLE$|SUDO_NOPASSWD$)/
  const statLine = lines.find(l => !META_PREFIX_RE.test(l)) ?? ''

  return {
    readable,
    stat: statLine,
    uid,
    username,
    fileType,
    sudoAvailable: sudoOk,
  }
}

export const ssh = {
  connect: (conn: { host: string; port: number; username: string; password?: string; privateKey?: string; passphrase?: string }) =>
    invoke<{ success: boolean }>('ssh:connect', conn),
  disconnect: () => invoke<{ success: boolean }>('ssh:disconnect'),
  exec: (command: string) => invoke<{ output: string }>('ssh:exec', { command }),
  /** 현재 SSH 세션의 작업 디렉토리. 미연결/비-Linux 응답 시 output=null. */
  pwd: () => invoke<{ output: string | null }>('ssh:pwd'),
  test: () => invoke<{ success: boolean }>('ssh:test'),
  state: () => invoke<{ isConnected: boolean; isConnecting: boolean; error?: string; host?: string }>('ssh:state'),
  shellWrite: (data: string) => invoke<{ success: boolean }>('ssh:shell:write', { data }),
  shellRead: () => invoke<{ data: string | null }>('ssh:shell:read'),
  resize: (cols: number, rows: number) => invoke<{ success: boolean }>('ssh:resize', { cols, rows }),

  /**
   * 권한 사전 체크 — `head -c 1`(실제 1바이트 read) + `id -u`(root trust) + `stat`(메타).
   *
   * `test -r`이 SSH exec channel의 root capability 처리 quirk로 잘못된 결과를 내는 사례가
   * 보고되어 v0.4.x에서 `head -c 1`로 교체. 둘 다 실패해도 `id -u 0`이면 root로 trust.
   *
   * 별도 IPC 채널 없이 `ssh:exec` 1회로 처리. path는 단일따옴표 wrap + escape + `--` 종료자.
   */
  async checkReadable(path: string): Promise<SshReadableCheck> {
    const quoted = shellQuoteSingle(path)
    // 한 번의 SSH exec로 여러 메타데이터 수집:
    //  - TYPE: 경로가 file/directory/missing/other 중 무엇인지 (디렉토리 사전 차단용)
    //  - OK_READABLE: 실제 1바이트 read 시도 — capability quirk 회피
    //  - UID/USER: 인증된 사용자(인터랙티브 셸의 sudo 전환과 무관) 진단용
    //  - SUDO_NOPASSWD: NOPASSWD sudo 가능 환경이면 모달에 sudo 옵션 제공
    //  - stat: 메타데이터
    // 모든 `${quoted}`는 단일따옴표 wrap + escape 적용. `--` 종료자로 `-`로 시작하는 path 보호.
    const cmd = [
      `if [ -d ${quoted} ]; then echo TYPE=directory;`,
      `elif [ -f ${quoted} ]; then echo TYPE=file;`,
      `elif [ ! -e ${quoted} ]; then echo TYPE=missing;`,
      `else echo TYPE=other; fi`,
      `head -c 1 -- ${quoted} > /dev/null 2>&1 && echo OK_READABLE`,
      `echo "UID=$(id -u 2>/dev/null)"`,
      `echo "USER=$(id -un 2>/dev/null)"`,
      `sudo -n true 2>/dev/null && echo SUDO_NOPASSWD`,
      `stat -c '%s %a %U %G' -- ${quoted} 2>/dev/null`,
    ].join('; ')
    try {
      const { output } = await invoke<{ output: string }>('ssh:exec', { command: cmd })
      return parseCheckReadableOutput(output)
    } catch {
      // SSH 실행 실패 — 미연결 등. 권한 모달이 친절한 메시지를 띄우도록 readable=false 반환.
      return { readable: false, stat: '' }
    }
  },
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
  endpoint?: string | null
  /** 백엔드가 권장하는 기본 모델명. 프론트엔드는 초기 mount 시 이 값으로 currentModel 설정. */
  defaultModel?: string
  /** 백엔드가 권장하는 기본 시스템 프롬프트. null이면 시스템 프롬프트 미사용 권장. */
  defaultSystemPrompt?: string | null
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

// logcheck.sh 5개 모드 — UI 액션 버튼과 1:1 대응
export type LogCheckMode = 'summary' | 'search' | 'recent' | 'range' | 'top'

export interface LogCheckRequest {
  path: string
  mode: LogCheckMode
  pattern?: string
  ignoreCase?: boolean
  ctxAfter?: number
  ctxBefore?: number
  hours?: number          // recent 모드 — 1~720
  from?: string           // range 모드 — "YYYY-MM-DD HH:MM:SS"
  to?: string             // range 모드 — "YYYY-MM-DD HH:MM:SS"
  topN?: number           // top 모드 — 1~100
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

  // logcheck.sh 5개 모드 통합 진입점 — 백엔드가 임베디드 스크립트를 stdin으로 전달해 원격 실행
  check: (req: LogCheckRequest) =>
    invoke<LogPayload>('logs:check', req),

  evaluate: (sizeBytes: number, provider: string, model: string) =>
    invoke<LogBudgetCheckResponse>('logs:evaluate', { sizeBytes, provider, model }),

  // 백엔드 LogAnalyzePayload (flat: source, content, question, systemPromptMode, ...)에 맞춰
  // payload를 spread로 평탄화 — v0.3.0까지 nested {payload, question}로 보내며 backend가 source/content를
  // 인식 못하던 결함을 v0.3.1에서 수정.
  analyze: (
    payload: LogPayload,
    question: string,
    onChunk?: StreamChunkHandler,
    systemPromptMode?: 'default' | 'merge' | 'override',
    systemPromptOverride?: string,
  ) =>
    createStreamRequest<{ content: string }>(
      'logs:analyze',
      { ...payload, question, systemPromptMode, systemPromptOverride },
      onChunk,
    ),

  analyzeChunked: (
    payload: LogPayload,
    question: string,
    budget: number,
    onChunk?: StreamChunkHandler,
    onProgress?: ProgressHandler,
    systemPromptMode?: 'default' | 'merge' | 'override',
    systemPromptOverride?: string,
  ) =>
    createChunkedRequest<{ content: string; chunks?: number }>(
      'logs:analyze-chunked',
      { ...payload, question, budget, systemPromptMode, systemPromptOverride },
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
