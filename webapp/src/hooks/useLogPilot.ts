/**
 * useLogPilot — LogPilot 탭 전용 훅.
 *
 * 책임:
 *  - SSH 현재 디렉토리(pwd) 자동 감지 + 수동 새로고침
 *  - 시나리오 선택 상태 + 권한 사전 체크 흐름
 *  - logcheck 실행 → AI 분석 자동 연쇄 (4섹션/신호등 시스템 프롬프트 merge)
 *  - 분석 완료 후 AI 응답을 logpilotResponseParser로 가공한 파생 상태 제공
 *
 * 설계 메모:
 *  - useLogAnalyze의 `analyze`는 `state.payload`를 deps로 캡처하기 때문에
 *    "runLogCheck → analyze" 를 같은 클로저 안에서 연속 await하면 stale state.payload(null)를 보게 된다.
 *    이를 피하기 위해 useLogPilot은 IPC를 직접 호출(logs.check / logs.analyze)하고 상태를
 *    자체 관리한다. useLogAnalyze는 본 step에서 LogPilot이 직접 사용하지 않음 (재사용은 향후 필요 시).
 *
 * Plan §Risks 3개 반영:
 *  - pwd 응답 trim/Linux 검증은 IPC bridge 단(ssh.pwd) 책임. 훅은 받은 값을 그대로 표시.
 *  - 권한 체크 path escape는 ssh.checkReadable 책임. 훅은 결과만 사용.
 *  - 시나리오별 후속 액션 칩은 정적 정의 (logpilotScenarios.ts).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  logs,
  ssh,
  type LogPayload,
  type SshReadableCheck,
} from '@bridge/ipcBridge'
import { logger } from '@utils/logger'
import { evaluate as evaluateBudget } from '@utils/logBudget'
import {
  LOGPILOT_SCENARIOS,
  isCommandPath,
  type LogPilotScenario,
  type LogPilotScenarioKey,
} from '@utils/logpilotScenarios'
import {
  parseLogPilotResponse,
  type ParsedLogPilotResult,
} from '@utils/logpilotResponseParser'

/**
 * 청크 진행률 + ETA — UI 진행률 바 노출용.
 * `etaSec === null`이면 "예상 시간 계산 중..." 표시 (Flag DE-A).
 */
export interface LogPilotProgress {
  /** 현재 완료된 청크 인덱스 (1부터). */
  index: number
  /** 전체 청크 수. */
  total: number
  /** 누적 처리된 바이트 수. */
  bytes: number
  /** 남은 청크 처리에 걸릴 예상 시간(초). 첫 청크 도착 전엔 null. */
  etaSec: number | null
}

export interface PermissionCheckState {
  loading: boolean
  result: SshReadableCheck | null
  /** 이 체크가 어떤 path에 대한 것인지 — UI 모달에서 표시용. */
  path: string
}

export interface UseLogPilotArgs {
  provider: string
  model: string
  /** SSH 연결 상태 — 진입 시 pwd 자동 호출 여부 판단. */
  sshConnected: boolean
}

export interface UseLogPilotReturn {
  // ── SSH 경로 ─────────────────────────────────
  sshCwd: string | null
  refreshCwd: () => Promise<void>
  isCwdLoading: boolean

  // ── 시나리오 ────────────────────────────────
  selectedScenario: LogPilotScenario | null
  pickScenario: (key: LogPilotScenarioKey) => void

  // ── 권한 체크 ───────────────────────────────
  permissionCheck: PermissionCheckState | null
  clearPermissionCheck: () => void

  // ── 분석 흐름 ───────────────────────────────
  runWithPermCheck: (path: string, scenario: LogPilotScenario, forceProceed?: boolean) => Promise<void>
  /** 자연어 질문 흐름 — checkup 시나리오로 logcheck 수집 + 사용자 질문을 AI에 전달. */
  runWithFreeText: (path: string, question: string, forceProceed?: boolean) => Promise<void>

  // ── 분석 결과 ───────────────────────────────
  rawResult: string
  parsed: ParsedLogPilotResult | null
  isFetching: boolean
  isStreaming: boolean
  error: string | null
  payload: LogPayload | null

  /** 청크 진행률 + ETA. 비-청크 흐름 또는 분석 미진행 시 null. */
  progress: LogPilotProgress | null

  cancel: () => void
  reset: () => void
}

/**
 * 백엔드 에러 원문을 UI에 그대로 노출하지 않고 화이트리스트 한국어 매핑.
 * 자세한 원문은 logger.error로 남기고 사용자에게는 친절한 안내만.
 */
function sanitizeError(raw: string, action: string): string {
  if (/timeout|시간 초과/i.test(raw)) return `${action} 실패 — 응답 시간 초과. 다시 시도하세요.`
  if (/command blocked by safety policy|안전 정책/i.test(raw)) return `${action} 실패 — 안전 정책으로 차단된 명령입니다.`
  if (/Exception|System\.|[A-Za-z]:\\/.test(raw)) return `${action} 실패 — 경로/권한을 확인하세요.`
  return `${action} 실패 — 다시 시도하세요.`
}

export function useLogPilot(args: UseLogPilotArgs): UseLogPilotReturn {
  const { sshConnected, provider, model } = args

  const [sshCwd, setSshCwd] = useState<string | null>(null)
  const [isCwdLoading, setIsCwdLoading] = useState(false)
  const [selectedScenario, setSelectedScenario] = useState<LogPilotScenario | null>(null)
  const [permissionCheck, setPermissionCheck] = useState<PermissionCheckState | null>(null)

  // 분석 흐름 상태 — useLogAnalyze가 가졌던 것을 직접 들고 있음 (stale closure 회피)
  const [payload, setPayload] = useState<LogPayload | null>(null)
  const [rawResult, setRawResult] = useState<string>('')
  const [isFetching, setIsFetching] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<LogPilotProgress | null>(null)

  // 누적 스트림 버퍼 — 청크 도착 시 setState 경합 없이 순차 누적
  const resultBufferRef = useRef<string>('')
  const lastConnectedRef = useRef(false)

  // provider/model 최신값을 비동기 콜백에서 참조 (budget 평가용)
  const providerRef = useRef(provider)
  const modelRef = useRef(model)
  providerRef.current = provider
  modelRef.current = model

  // ETA 계산용 — 첫 청크 도착 시각 기준 누적 평균(elapsed / progressIndex).
  // (이전 chunkDurationsRef 이동평균 후보는 사용되지 않아 제거 — Reviewer S-3)
  const chunkStartRef = useRef<number | null>(null)

  const refreshCwd = useCallback(async () => {
    if (!sshConnected) {
      setSshCwd(null)
      return
    }
    setIsCwdLoading(true)
    try {
      const { output } = await ssh.pwd()
      setSshCwd(output)
    } catch (err) {
      logger.error('[useLogPilot.refreshCwd] pwd 실패', { error: err })
      setSshCwd(null)
    } finally {
      setIsCwdLoading(false)
    }
  }, [sshConnected])

  useEffect(() => {
    if (sshConnected && !lastConnectedRef.current) {
      lastConnectedRef.current = true
      refreshCwd()
    }
    if (!sshConnected) {
      lastConnectedRef.current = false
      setSshCwd(null)
    }
  }, [sshConnected, refreshCwd])

  const pickScenario = useCallback((key: LogPilotScenarioKey) => {
    setSelectedScenario(LOGPILOT_SCENARIOS[key])
  }, [])

  const clearPermissionCheck = useCallback(() => {
    setPermissionCheck(null)
  }, [])

  const appendChunk = useCallback((chunk: string) => {
    resultBufferRef.current += chunk
    setRawResult(resultBufferRef.current)
  }, [])

  /**
   * 권한 체크 → 로그 수집 → AI 분석 공통 helper.
   * `runWithPermCheck` (시나리오 칩 경로) + `runWithFreeText` (자연어 경로) 둘 다 사용.
   *
   * 흐름:
   * 1) path가 명령(`/`로 시작 안 함)이면 권한 체크 생략 → logs.fetchExec
   *    파일 경로면 (forceProceed=false면) ssh.checkReadable → readable=false면 모달 트리거 후 return
   *    단, fileType=directory/missing이면 readable과 무관하게 별도 모달 분기 (useLogPilot은 상태만, UI는 모달이 분기)
   * 2) 명령: logs.fetchExec(command); 파일: scenario.buildRequest → logs.check
   * 3) logs.analyze(collected, question, ..., 'merge', scenario.systemContext) — 스트리밍
   */
  const runAnalysis = useCallback(async (
    path: string,
    scenario: LogPilotScenario,
    question: string,
    forceProceed: boolean,
  ) => {
    setError(null)
    const isCommand = isCommandPath(path)

    // ── 권한 체크 (파일 경로만 해당, 명령은 셸이 자체 검증) ───────────────
    if (!isCommand && !forceProceed) {
      setPermissionCheck({ loading: true, result: null, path })
      let permResult: SshReadableCheck
      try {
        permResult = await ssh.checkReadable(path)
      } catch (err) {
        logger.error('[useLogPilot.runAnalysis] 권한 체크 실패', { error: err })
        permResult = { readable: false, stat: '' }
      }
      setPermissionCheck({ loading: false, result: permResult, path })

      // 디렉토리/missing은 readable과 무관하게 모달 표시(별도 안내 UI). root도 디렉토리는 logcheck.sh로 분석 불가.
      if (permResult.fileType === 'directory' || permResult.fileType === 'missing') {
        return
      }
      if (!permResult.readable) {
        return
      }
    } else if (isCommand) {
      // 명령 경로는 권한 모달 상태 초기화 — 이전 검사 잔재가 남아 다시 뜨는 일 방지.
      setPermissionCheck(null)
    }

    // 시나리오를 상태에 반영 — 결과 패널이 시나리오 메타(다음 액션 칩 등)를 활용함
    setSelectedScenario(scenario)

    // 1단계 — 로그 수집 (명령은 fetchExec, 파일은 logcheck.sh)
    let collected: LogPayload
    setIsFetching(true)
    try {
      if (isCommand) {
        collected = await logs.fetchExec(path)
      } else {
        const req = scenario.buildRequest(path)
        collected = await logs.check(req)
      }
      setPayload(collected)
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      logger.error('[useLogPilot.runAnalysis] 로그 수집 실패', { error: err, isCommand })
      setError(sanitizeError(raw, '로그 수집'))
      setIsFetching(false)
      return
    }
    setIsFetching(false)

    if (!collected.content) {
      setError('로그 수집은 성공했으나 결과가 비어있습니다 — 다른 시나리오를 시도하세요')
      return
    }

    // 2단계 — AI 분석 (항상 chunked, Step E DE-5/DE-6).
    //   - 단일 청크여도 progress 1회 발송 → UI 일관성
    //   - 첫 청크 도착 후 평균 청크 시간 × 남은 청크 = ETA (Flag DE-A)
    resultBufferRef.current = ''
    setRawResult('')
    setProgress(null)
    chunkStartRef.current = null
    setIsStreaming(true)
    const budget = evaluateBudget(collected.sizeBytes, providerRef.current, modelRef.current).budget
    try {
      await logs.analyzeChunked(
        collected,
        question,
        budget,
        appendChunk,
        p => {
          // p.index는 백엔드 1-base 청크 완료 인덱스. 첫 청크 도착 시점에 시작시각 기록.
          // ETA = 그 이후 처리된 (p.index - 1) 청크의 평균 시간 × 남은 청크 수.
          // 첫 progress(p.index===1) 시점엔 비교 기준이 없으므로 etaSec=null (Flag DE-A).
          const now = Date.now()
          if (chunkStartRef.current === null) {
            chunkStartRef.current = now
            setProgress({ index: p.index, total: p.total, bytes: p.bytes, etaSec: null })
          } else {
            const elapsedMs = now - chunkStartRef.current
            const processedSinceStart = Math.max(p.index - 1, 1)
            const avgMs = elapsedMs / processedSinceStart
            const remaining = Math.max(p.total - p.index, 0)
            const etaSec = Math.round((avgMs * remaining) / 1000)
            setProgress({ index: p.index, total: p.total, bytes: p.bytes, etaSec })
          }
        },
        'merge',
        scenario.systemContext,
      )
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      logger.error('[useLogPilot.runAnalysis] AI 분석 실패', { error: err })
      setError(sanitizeError(raw, 'AI 분석'))
    } finally {
      setIsStreaming(false)
      setProgress(null)
    }
  }, [appendChunk])

  /**
   * 시나리오 칩 경로 — Step C부터 유지. question은 빈 문자열로 시스템 프롬프트만 의존.
   */
  const runWithPermCheck = useCallback(async (
    path: string,
    scenario: LogPilotScenario,
    forceProceed: boolean = false,
  ) => {
    await runAnalysis(path, scenario, '', forceProceed)
  }, [runAnalysis])

  /**
   * 자연어 질문 경로 (Step D 신규) — 디폴트 시나리오 `checkup`으로 로그를 수집하되
   * 사용자 자연어 질문을 그대로 AI에 전달한다. (v3에서 AI 사전 분류로 자동 시나리오 매핑 예정.)
   */
  const runWithFreeText = useCallback(async (
    path: string,
    question: string,
    forceProceed: boolean = false,
  ) => {
    const checkup = LOGPILOT_SCENARIOS.checkup
    await runAnalysis(path, checkup, question, forceProceed)
  }, [runAnalysis])

  const cancel = useCallback(() => {
    logs.cancelAnalyze().catch(() => {})
    setIsStreaming(false)
    setIsFetching(false)
    setProgress(null)
    chunkStartRef.current = null
  }, [])

  const reset = useCallback(() => {
    resultBufferRef.current = ''
    chunkStartRef.current = null
    setSelectedScenario(null)
    setPermissionCheck(null)
    setPayload(null)
    setRawResult('')
    setIsFetching(false)
    setIsStreaming(false)
    setError(null)
    setProgress(null)
  }, [])

  // AI 응답 파싱 — result가 바뀔 때만 재파싱
  const parsed = useMemo<ParsedLogPilotResult | null>(() => {
    if (!rawResult) return null
    return parseLogPilotResponse(rawResult)
  }, [rawResult])

  return {
    sshCwd,
    refreshCwd,
    isCwdLoading,

    selectedScenario,
    pickScenario,

    permissionCheck,
    clearPermissionCheck,

    runWithPermCheck,
    runWithFreeText,

    rawResult,
    parsed,
    isFetching,
    isStreaming,
    error,
    payload,
    progress,

    cancel,
    reset,
  }
}
