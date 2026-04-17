import { useCallback, useRef, useState } from 'react'
import { logs, type LogFileInfo, type LogPayload } from '@bridge/ipcBridge'
import { evaluate, type BudgetCheck } from '@utils/logBudget'
import { logger } from '@utils/logger'

export type LogMode = 'file' | 'command'

export interface ChunkProgress {
  index: number
  total: number
  bytes: number
}

export interface LogAnalyzeState {
  statInfo: LogFileInfo | null
  payload: LogPayload | null
  budgetCheck: BudgetCheck | null
  isFetching: boolean
  isStreaming: boolean
  chunkProgress: ChunkProgress | null
  result: string
  error: string | null
}

export interface LogAnalyzeActions {
  checkFile: (path: string) => Promise<void>
  fetchFile: (path: string, tailBytes: number, fullFile: boolean) => Promise<void>
  fetchExec: (command: string) => Promise<void>
  setPayload: (payload: LogPayload) => void      // 자르기 등 클라이언트 조작 결과 반영
  analyze: (question: string) => Promise<void>
  analyzeChunked: (question: string) => Promise<void>
  cancel: () => void
  reset: () => void
}

export interface UseLogAnalyzeArgs {
  provider: string
  model: string
}

const INITIAL_STATE: LogAnalyzeState = {
  statInfo: null,
  payload: null,
  budgetCheck: null,
  isFetching: false,
  isStreaming: false,
  chunkProgress: null,
  result: '',
  error: null,
}

/**
 * 백엔드 원문을 UI에 그대로 노출하지 않고 화이트리스트 기반으로 한국어 메시지로 매핑.
 * 원문은 devtools용으로 logger.error 쪽에 남겨 디버그성 유지 (CLAUDE.md §보안규칙 §에러 메시지).
 * 알려지지 않은 에러는 내부 경로/스택 노출 방지 차원에서 제네릭 폴백 문구 반환.
 */
function sanitizeErrorMessage(raw: string, action: string): string {
  // IPC timeout — ipcBridge에서 'timeout' 포함 메시지 반환
  if (/timeout|time[\s-]?out|시간 초과/i.test(raw)) {
    return `${action} 실패 — 응답 시간 초과. 다시 시도하세요.`
  }
  // 위험 명령 차단 (CommandSafetyService)
  if (/command blocked by safety policy|안전 정책/i.test(raw)) {
    return `${action} 실패 — 안전 정책으로 차단된 명령입니다.`
  }
  // IPC 응답 크기 초과
  if (/exceeds\s*\d*\s*(mb|kb)|payload exceeds|too large/i.test(raw)) {
    return `${action} 실패 — 응답이 너무 큽니다. 수집 크기를 줄이세요.`
  }
  // 내부 구조 노출 가능성 — .NET 예외 클래스명/스택/경로
  if (/Exception|at\s+\w+\.\w+|System\.|[A-Za-z]:\\|\n\s+at\s/.test(raw)) {
    return `${action} 실패 — 로그 수집/분석 실패. 경로와 권한을 확인하세요.`
  }
  // 기본 폴백 — 원문 그대로 흘리지 않음
  return `${action} 실패 — 요청을 처리하지 못했습니다. 다시 시도하세요.`
}

/** 에러 객체를 사용자 친화 문자열로 변환. 원문은 logger로만, UI엔 화이트리스트 매핑 결과만. */
function formatError(fn: string, action: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  logger.error('log analyze error', { fn, action, err, raw })
  return sanitizeErrorMessage(raw, action)
}

/** 수집 직후 자동 예산 평가 → 프론트 미러 사용 (네트워크 왕복 없음) */
function recheckBudget(payload: LogPayload, provider: string, model: string): BudgetCheck {
  return evaluate(payload.sizeBytes, provider, model)
}

export function useLogAnalyze(args: UseLogAnalyzeArgs): LogAnalyzeState & LogAnalyzeActions {
  const [state, setState] = useState<LogAnalyzeState>(INITIAL_STATE)

  // provider/model 최신값을 비동기 콜백에서 참조하기 위한 ref
  const providerRef = useRef(args.provider)
  const modelRef = useRef(args.model)
  providerRef.current = args.provider
  modelRef.current = args.model

  // 결과 누적 버퍼 — 청크 도착 시 state 경합 없이 순차 누적
  const resultBufferRef = useRef<string>('')

  const resetResult = () => {
    resultBufferRef.current = ''
  }

  const appendChunk = useCallback((chunk: string) => {
    resultBufferRef.current += chunk
    setState(s => ({ ...s, result: resultBufferRef.current }))
  }, [])

  const reset = useCallback(() => {
    resetResult()
    setState(INITIAL_STATE)
  }, [])

  const setPayload = useCallback((payload: LogPayload) => {
    setState(s => ({
      ...s,
      payload,
      budgetCheck: recheckBudget(payload, providerRef.current, modelRef.current),
      error: null,
    }))
  }, [])

  const checkFile = useCallback(async (path: string) => {
    setState(s => ({ ...s, error: null }))
    try {
      const info = await logs.statFile(path)
      setState(s => ({ ...s, statInfo: info }))
    } catch (err) {
      const msg = formatError('checkFile', `파일 확인 (${path})`, err)
      logger.error(msg)
      setState(s => ({ ...s, error: msg, statInfo: null }))
    }
  }, [])

  const fetchFile = useCallback(async (path: string, tailBytes: number, fullFile: boolean) => {
    setState(s => ({ ...s, isFetching: true, error: null }))
    try {
      const payload = await logs.fetchFile(path, tailBytes, fullFile)
      setState(s => ({
        ...s,
        payload,
        budgetCheck: recheckBudget(payload, providerRef.current, modelRef.current),
        isFetching: false,
      }))
    } catch (err) {
      const msg = formatError('fetchFile', `파일 수집 (${path})`, err)
      logger.error(msg)
      setState(s => ({ ...s, isFetching: false, error: msg }))
    }
  }, [])

  const fetchExec = useCallback(async (command: string) => {
    setState(s => ({ ...s, isFetching: true, error: null }))
    try {
      const payload = await logs.fetchExec(command)
      setState(s => ({
        ...s,
        payload,
        budgetCheck: recheckBudget(payload, providerRef.current, modelRef.current),
        isFetching: false,
      }))
    } catch (err) {
      const msg = formatError('fetchExec', '명령 실행', err)
      logger.error(msg)
      setState(s => ({ ...s, isFetching: false, error: msg }))
    }
  }, [])

  const analyze = useCallback(async (question: string) => {
    const payload = state.payload
    if (!payload) {
      setState(s => ({ ...s, error: '[analyze] 수집된 로그가 없습니다.' }))
      return
    }
    resetResult()
    setState(s => ({ ...s, isStreaming: true, result: '', error: null, chunkProgress: null }))
    try {
      await logs.analyze(payload, question, appendChunk)
      setState(s => ({ ...s, isStreaming: false }))
    } catch (err) {
      const msg = formatError('analyze', 'AI 분석', err)
      logger.error(msg)
      setState(s => ({ ...s, isStreaming: false, error: msg }))
    }
  }, [state.payload, appendChunk])

  const analyzeChunked = useCallback(async (question: string) => {
    const payload = state.payload
    const check = state.budgetCheck
    if (!payload || !check) {
      setState(s => ({ ...s, error: '[analyzeChunked] 수집된 로그 또는 예산 정보가 없습니다.' }))
      return
    }
    resetResult()
    setState(s => ({ ...s, isStreaming: true, result: '', error: null, chunkProgress: null }))
    try {
      await logs.analyzeChunked(
        payload,
        question,
        check.budget,
        appendChunk,
        progress => setState(s => ({ ...s, chunkProgress: progress })),
      )
      setState(s => ({ ...s, isStreaming: false }))
    } catch (err) {
      const msg = formatError('analyzeChunked', '분할 분석', err)
      logger.error(msg)
      setState(s => ({ ...s, isStreaming: false, error: msg }))
    }
  }, [state.payload, state.budgetCheck, appendChunk])

  const cancel = useCallback(() => {
    logs.cancelAnalyze().catch(() => {})
    setState(s => ({ ...s, isStreaming: false }))
  }, [])

  return {
    ...state,
    checkFile,
    fetchFile,
    fetchExec,
    setPayload,
    analyze,
    analyzeChunked,
    cancel,
    reset,
  }
}
