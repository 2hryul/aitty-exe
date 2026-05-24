/**
 * useSshCwd — SSH 셸 cwd 추적 훅 (Step F).
 *
 * 책임:
 *  - SSH 연결 성공 시 1회 `ssh.pwd()` 호출 → cwd 초기 시드 (DF-2)
 *  - SSHTerminal xterm `onData` 이벤트에서 사용자 키스트로크 라인 buffer 누적 후 Enter 시
 *    `cd ...` 패턴 매칭 → cwd state 갱신 (DF-A 케이스, DF-3)
 *  - SSHTerminal xterm OSC 7 핸들러 등록 → 서버 셸의 `\e]7;file://host/path\e\\`
 *    시퀀스에서 cwd 추출 → state 갱신 (DF-B 케이스, DF-5). cd 패턴보다 신뢰도 ↑
 *  - 추적 실패/지원 안 함 시 cwd state는 `null` 유지 — UI는 "(미연결 또는 확인 불가)" 표시
 *
 * 설계 메모:
 *  - cwd state는 App.tsx에서 인스턴스화 → SSHTerminal(키 입력 가로채기) + AITerminal/LogPilotTab(표시)
 *    양쪽에 동일 source 공급. 브리프상 `useAITerminal` 위치 안은 SSH xterm이 sibling 컴포넌트에 있어
 *    구조적으로 불가능. App.tsx 리프트가 최소 침습.
 *  - 라인 buffer는 본 훅이 자체 관리 — SSHTerminal의 `lineBufferRef`(safety용)와 분리.
 *    safety check가 paste를 다르게 처리해도 cd 매칭은 사용자 키스트로크만 신뢰.
 *  - `prevCwd`는 `cd -` 지원용. cwd 갱신 직전 값을 ref에 백업.
 *  - home은 초기 시드 시 받은 cwd를 그대로 사용 (Linux는 로그인 셸이 항상 $HOME에서 시작).
 *  - SSH 끊김 시 모든 state/ref 초기화 — 재접속 시 깨끗한 상태에서 다시 시드.
 */

import { useCallback, useRef, useState, useEffect } from 'react'
import { Terminal } from 'xterm'
import { ssh } from '@bridge/ipcBridge'
import { logger } from '@utils/logger'
import { normalize as posixNormalize, join as posixJoin, expandTilde } from '@utils/posixPath'

/** 라인 buffer 누적 상한 — Flag DF-E. 초과 시 폐기 + 다음 Enter까지 새로 시작. */
const MAX_LINE_BUFFER = 4096

/**
 * `cd ...` 패턴 정규식. 첫 캡처가 인자(없으면 undefined).
 * 매칭 실패 시 cd가 아니거나 셸 함수/$VAR/$(cmd)/pushd 등 — 추적 안 함.
 */
const CD_PATTERN = /^\s*cd(?:\s+(.+?))?\s*$/

export interface UseSshCwdReturn {
  /** 현재 추적 중인 SSH cwd. 미연결 또는 시드 실패 시 null. */
  sshCwd: string | null
  /** 사용자 강제 새로고침 — `ssh.pwd()` 직접 호출 (OSC 7 미감지 환경 대비). */
  refreshCwd: () => Promise<void>
  /** SSH 연결 성공 시 호출 — 초기 cwd 시드(`ssh.pwd()`) + 이후 OSC 7 콜백 활성. */
  onSshConnected: () => Promise<void>
  /** SSH 연결 끊김 시 호출 — cwd/prev/buffer 모두 초기화. */
  onSshDisconnected: () => void
  /** SSHTerminal에서 xterm 생성 직후 1회 호출 — onData 후킹 + OSC 7 핸들러 등록. */
  attachToTerminal: (term: Terminal) => () => void
  /** cwd 로딩 중 표시용 (refreshCwd/onSshConnected 동안 true). */
  isCwdLoading: boolean
}

/**
 * `cd <arg>` 매칭 결과를 새 cwd로 변환.
 * 반환 null이면 추적 불가(=cwd state 유지).
 *
 * @param arg cd 인자 (`undefined` = 인자 없음 → 홈)
 * @param cwd 현재 cwd (null이면 추적 시작 전)
 * @param prevCwd `cd -` 처리용
 * @param home 홈 디렉토리 (null이면 `~` 확장 불가)
 */
function resolveCdArg(
  arg: string | undefined,
  cwd: string | null,
  prevCwd: string | null,
  home: string | null,
): string | null {
  // 1. `cd` (인자 없음) → 홈
  if (arg === undefined) {
    return home
  }

  // 따옴표 제거 (Flag DF-A) — `cd "/path with space"` 한정. 셸 escape는 미지원.
  const stripped = arg.replace(/^["']|["']$/g, '').trim()
  if (!stripped) return home

  // 2. `cd -` → 이전 cwd
  if (stripped === '-') {
    return prevCwd
  }

  // 추적 불가 패턴 — $VAR / $(cmd) / 명령 치환은 매칭 무시
  if (/[$`]/.test(stripped)) return null

  // 3. `~` 또는 `~/...` → 홈 + 나머지
  if (stripped === '~' || stripped.startsWith('~/')) {
    if (!home) return null
    return expandTilde(stripped, home)
  }

  // 4. 절대 경로
  if (stripped.startsWith('/')) {
    return posixNormalize(stripped)
  }

  // 5. 상대 경로 — cwd가 있어야 join 가능
  if (!cwd) return null
  return posixJoin(cwd, stripped)
}

/**
 * OSC 7 콜백 인자(`file://hostname/path`)에서 path 추출.
 * 매칭 실패 시 null — 호출자는 무시.
 */
function parseOsc7Path(data: string): string | null {
  const match = data.match(/^file:\/\/[^/]*(\/.*)$/)
  if (!match) return null
  // URL 디코딩(공백 %20 등). 실패 시 raw 사용.
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

export function useSshCwd(): UseSshCwdReturn {
  const [sshCwd, setSshCwd] = useState<string | null>(null)
  const [isCwdLoading, setIsCwdLoading] = useState(false)

  // ref로 최신값 유지 — onData 콜백(클로저)에서 stale state 회피.
  const sshCwdRef = useRef<string | null>(null)
  const prevCwdRef = useRef<string | null>(null)
  const homeRef = useRef<string | null>(null)
  const lineBufferRef = useRef<string>('')

  // state 변경 시 ref 동기화
  useEffect(() => {
    sshCwdRef.current = sshCwd
  }, [sshCwd])

  /** cwd 갱신 + prev 백업. 동일 값이면 no-op. */
  const updateCwd = useCallback((next: string | null) => {
    if (next === null) return
    const current = sshCwdRef.current
    if (current === next) return
    prevCwdRef.current = current
    sshCwdRef.current = next
    setSshCwd(next)
  }, [])

  const refreshCwd = useCallback(async () => {
    setIsCwdLoading(true)
    try {
      const { output } = await ssh.pwd()
      if (output && output.startsWith('/')) {
        // 강제 재동기화 — prev 백업 후 갱신
        updateCwd(output)
      }
    } catch (err) {
      logger.error('[useSshCwd.refreshCwd] ssh.pwd 실패', { error: err })
    } finally {
      setIsCwdLoading(false)
    }
  }, [updateCwd])

  const onSshConnected = useCallback(async () => {
    setIsCwdLoading(true)
    lineBufferRef.current = ''
    prevCwdRef.current = null
    try {
      const { output } = await ssh.pwd()
      if (output && output.startsWith('/')) {
        homeRef.current = output  // 첫 응답은 로그인 홈 디렉토리
        sshCwdRef.current = output
        setSshCwd(output)
      } else {
        // 시드 실패 — cwd null 유지. 사용자 cd 첫 입력 후 추적 시작 (Flag DF-B).
        homeRef.current = null
        sshCwdRef.current = null
        setSshCwd(null)
      }
    } catch (err) {
      logger.error('[useSshCwd.onSshConnected] 초기 pwd 시드 실패', { error: err })
      homeRef.current = null
      sshCwdRef.current = null
      setSshCwd(null)
    } finally {
      setIsCwdLoading(false)
    }
  }, [])

  const onSshDisconnected = useCallback(() => {
    sshCwdRef.current = null
    prevCwdRef.current = null
    homeRef.current = null
    lineBufferRef.current = ''
    setSshCwd(null)
    setIsCwdLoading(false)
  }, [])

  /** Enter 시 호출 — buffer를 cd 패턴에 매칭하고 cwd 갱신. buffer는 클리어. */
  const commitLine = useCallback(() => {
    const line = lineBufferRef.current
    lineBufferRef.current = ''
    const match = line.match(CD_PATTERN)
    if (!match) return  // cd 아님 — 무시 (사용자 일반 명령)
    const arg = match[1]
    const next = resolveCdArg(arg, sshCwdRef.current, prevCwdRef.current, homeRef.current)
    if (next !== null) updateCwd(next)
  }, [updateCwd])

  /**
   * SSHTerminal에서 xterm 생성 직후 호출.
   * onData 키스트로크 buffer + OSC 7 핸들러 두 흐름을 설치.
   * 반환 cleanup은 SSHTerminal의 useEffect cleanup에서 호출.
   */
  const attachToTerminal = useCallback((term: Terminal): (() => void) => {
    // ── onData: 사용자 키스트로크만 누적 (서버 출력 stream과 분리, Flag DF-C) ──
    const onDataDisposable = term.onData((data: string) => {
      // Enter — 라인 commit
      if (data === '\r' || data === '\n') {
        commitLine()
        return
      }
      // Backspace (Flag DF-F)
      if (data === '\b' || data === '\x7f') {
        if (lineBufferRef.current.length > 0) {
          lineBufferRef.current = lineBufferRef.current.slice(0, -1)
        }
        return
      }
      // Ctrl+C / Ctrl+U — buffer 전체 클리어
      if (data === '\x03' || data === '\x15') {
        lineBufferRef.current = ''
        return
      }
      // Ctrl+W (Reviewer M1) — bash readline 마지막 단어 삭제.
      // SSHTerminal lineBufferRef와 동일 의미론 유지. 누락 시 cd /etc<Ctrl+W>/var<Enter>가
      // false-positive로 /etc/var로 추적되는 결함 발생.
      if (data === '\x17') {
        lineBufferRef.current = lineBufferRef.current.replace(/\S+\s*$/, '')
        return
      }
      // Escape 시퀀스 (방향키/history 등) — buffer 리셋 (히스토리 recall 후 누적 방지)
      if (data.startsWith('\x1b')) {
        lineBufferRef.current = ''
        return
      }
      // 멀티 문자 (붙여넣기 등) — `\r`/`\n`이 포함되면 그 직전까지만 누적 후 commit
      if (data.length > 1) {
        const newlineIdx = data.search(/[\r\n]/)
        if (newlineIdx >= 0) {
          lineBufferRef.current += data.slice(0, newlineIdx)
          commitLine()
          // 첫 줄 이후는 무시 — multiline 명령 추적은 본 step 범위 밖
          return
        }
        lineBufferRef.current += data
      } else if (data >= ' ') {
        lineBufferRef.current += data
      }
      // buffer 크기 상한 — Flag DF-E
      if (lineBufferRef.current.length > MAX_LINE_BUFFER) {
        lineBufferRef.current = ''
      }
    })

    // ── OSC 7 핸들러: 서버 셸이 `\e]7;file://host/path\e\\` emit하면 cwd 갱신 ──
    // 콜백은 boolean 반환 — `true`면 소비, `false`면 다음 핸들러로 전달.
    // 본 핸들러는 단일 OSC 7 가정으로 항상 `true` 반환 (Flag DF-D).
    const oscDisposable = term.parser.registerOscHandler(7, (data: string) => {
      const path = parseOsc7Path(data)
      if (path) updateCwd(path)
      return true
    })

    return () => {
      onDataDisposable.dispose()
      oscDisposable.dispose()
    }
  }, [commitLine, updateCwd])

  return {
    sshCwd,
    refreshCwd,
    onSshConnected,
    onSshDisconnected,
    attachToTerminal,
    isCwdLoading,
  }
}
