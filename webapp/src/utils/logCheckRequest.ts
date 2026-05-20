import type { LogCheckMode, LogCheckRequest } from '@bridge/ipcBridge'

/**
 * UI 액션 버튼별 요청 페이로드 빌더 + 사전 검증.
 * 백엔드(LogCheckService.Validate)와 동일한 규칙을 프론트에서 1차 적용해 IPC 왕복을 줄인다.
 *
 * 검증 실패 시 한국어 메시지 던짐 — LogTab에서 catch해 사용자에게 표시.
 */

export interface SearchOptions {
  pattern: string
  ignoreCase?: boolean
  ctxAfter?: number   // 0~50
  ctxBefore?: number  // 0~50
}

export interface RecentOptions {
  hours: number       // 1~720
}

export interface RangeOptions {
  from: string        // "YYYY-MM-DD HH:MM:SS"
  to: string
}

export interface TopOptions {
  topN: number        // 1~100
}

const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

function validatePath(path: string): void {
  const trimmed = path.trim()
  if (!trimmed) throw new Error('로그 파일 경로를 입력하세요')
  if (trimmed.length > 4096) throw new Error('경로가 너무 깁니다 (최대 4096)')
  if (trimmed.includes('\0')) throw new Error('경로에 NUL 문자가 포함되어 있습니다')
  if (!trimmed.startsWith('/')) throw new Error('절대 경로(/ 시작)만 허용됩니다')
  if (trimmed.includes('..')) throw new Error('상대 경로(..)는 허용되지 않습니다')
}

function checkRange(label: string, n: number, min: number, max: number): void {
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${label}는 ${min}~${max} 범위 정수만 허용됩니다`)
  }
}

export function buildSummaryRequest(path: string): LogCheckRequest {
  validatePath(path)
  return { path: path.trim(), mode: 'summary' }
}

export function buildSearchRequest(path: string, opts: SearchOptions): LogCheckRequest {
  validatePath(path)
  const pattern = opts.pattern?.trim() ?? ''
  if (!pattern) throw new Error('검색 패턴을 입력하세요')
  if (pattern.length > 1024) throw new Error('패턴이 너무 깁니다 (최대 1024)')
  if (opts.ctxAfter  !== undefined && opts.ctxAfter  > 0) checkRange('-A 컨텍스트', opts.ctxAfter, 0, 50)
  if (opts.ctxBefore !== undefined && opts.ctxBefore > 0) checkRange('-B 컨텍스트', opts.ctxBefore, 0, 50)
  return {
    path: path.trim(),
    mode: 'search',
    pattern,
    ignoreCase: opts.ignoreCase ?? false,
    ...(opts.ctxAfter  ? { ctxAfter:  opts.ctxAfter  } : {}),
    ...(opts.ctxBefore ? { ctxBefore: opts.ctxBefore } : {}),
  }
}

export function buildRecentRequest(path: string, opts: RecentOptions): LogCheckRequest {
  validatePath(path)
  checkRange('시간', opts.hours, 1, 720)
  return { path: path.trim(), mode: 'recent', hours: opts.hours }
}

export function buildRangeRequest(path: string, opts: RangeOptions): LogCheckRequest {
  validatePath(path)
  if (!DATETIME_RE.test(opts.from) || !DATETIME_RE.test(opts.to)) {
    throw new Error('FROM/TO는 "YYYY-MM-DD HH:MM:SS" 형식이어야 합니다')
  }
  if (opts.from > opts.to) {
    throw new Error('FROM은 TO보다 이후일 수 없습니다')
  }
  return { path: path.trim(), mode: 'range', from: opts.from, to: opts.to }
}

export function buildTopRequest(path: string, opts: TopOptions): LogCheckRequest {
  validatePath(path)
  checkRange('빈출 패턴 N', opts.topN, 1, 100)
  return { path: path.trim(), mode: 'top', topN: opts.topN }
}

/** datetime-local("YYYY-MM-DDTHH:MM") → logcheck용 "YYYY-MM-DD HH:MM:SS" */
export function fromDateTimeLocal(dt: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(dt)
  if (!m) throw new Error('잘못된 datetime-local 값')
  const ss = m[6] ?? '00'
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${ss}`
}

/** Date 또는 ISO → datetime-local "YYYY-MM-DDTHH:MM" (분 단위) */
export function toDateTimeLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** UI 헬퍼 — 한국어 모드명 */
export function modeLabel(mode: LogCheckMode): string {
  switch (mode) {
    case 'summary': return '요약'
    case 'search':  return '패턴 검색'
    case 'recent':  return '최근 시간'
    case 'range':   return '기간 설정'
    case 'top':     return '빈출 패턴'
  }
}
