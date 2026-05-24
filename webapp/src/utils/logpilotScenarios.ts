/**
 * LogPilot 시나리오 6종 정의 — 초보 운영자가 클릭만으로 분석 진입.
 *
 * 각 시나리오는:
 *  1) 메타(아이콘/제목/설명) — UI 카드 렌더링
 *  2) buildRequest(path) — 사용자가 입력한 파일/명령 경로 + 시나리오별 logcheck 모드/패턴 자동 채움
 *  3) systemContext — AI 시스템 프롬프트 끝에 합성될 시나리오 맥락 한 줄
 *  4) nextActionChips — 시나리오별 정적 후속 액션 칩 3개 (v2에서 AI 자동 추출로 대체 예정)
 */

import type { LogCheckRequest } from '@bridge/ipcBridge'
import {
  buildSearchRequest,
  buildRecentRequest,
  buildSummaryRequest,
} from '@utils/logCheckRequest'

export type LogPilotScenarioKey =
  | 'error'
  | 'slow'
  | 'disk'
  | 'login'
  | 'yesterday'
  | 'checkup'

export interface LogPilotScenario {
  key: LogPilotScenarioKey
  icon: string
  title: string
  detail: string
  /** 사용자가 입력한 path를 받아 logcheck 요청 페이로드 생성. */
  buildRequest: (path: string) => LogCheckRequest
  /** AI 시스템 프롬프트 부록 — "[추가 지시]" 본문에 합성될 시나리오 맥락. */
  systemContext: string
  /** 분석 완료 후 사용자에게 제시할 후속 액션 칩 (시나리오별 정적 3개). */
  nextActionChips: string[]
}

export const LOGPILOT_SCENARIOS: Record<LogPilotScenarioKey, LogPilotScenario> = {
  error: {
    key: 'error',
    icon: '🔥',
    title: '에러 났어요',
    detail: '최근 1시간 ERROR / FATAL / CRITICAL 메시지를 검색합니다',
    buildRequest: (path) =>
      buildSearchRequest(path, {
        pattern: 'ERROR|FATAL|CRITICAL|Exception',
        ignoreCase: true,
        ctxBefore: 2,
        ctxAfter: 2,
      }),
    systemContext:
      '사용자는 "에러 났어요" 시나리오로 진입했습니다 — ERROR/FATAL/CRITICAL/Exception 메시지에 집중해서 분석하세요. 동일 메시지 반복 여부와 첫 발생 시각도 짚어주세요.',
    nextActionChips: [
      '에러 발생 시각 전후 30분 로그 보기',
      '동일 패턴의 반복 횟수 집계',
      '관련 서비스 상태 확인 (systemctl status)',
    ],
  },

  slow: {
    key: 'slow',
    icon: '🐌',
    title: '서버 느려요',
    detail: '메모리 부족·OOM·응답 지연 흔적을 최근 6시간에서 탐색합니다',
    buildRequest: (path) =>
      buildSearchRequest(path, {
        pattern: 'OOM|out of memory|killed|timeout|slow|latency|swap',
        ignoreCase: true,
        ctxBefore: 1,
        ctxAfter: 3,
      }),
    systemContext:
      '사용자는 "서버 느려요" 시나리오로 진입했습니다 — OOM Killer 호출, swap 폭증, 응답 지연 키워드, 프로세스 강제 종료 흔적에 집중하세요. free/top/vmstat 명령을 후속 조치로 제안하세요.',
    nextActionChips: [
      '현재 메모리 사용량 확인 (free -h)',
      'CPU 점유 상위 프로세스 (top -n 1)',
      '최근 OOM Killer 이력 (dmesg | grep -i oom)',
    ],
  },

  disk: {
    key: 'disk',
    icon: '💾',
    title: '디스크 부족',
    detail: 'No space / I/O error / inode 경고 메시지를 찾습니다',
    buildRequest: (path) =>
      buildSearchRequest(path, {
        pattern: 'no space|disk full|I/O error|inode|EIO|ENOSPC',
        ignoreCase: true,
        ctxBefore: 1,
        ctxAfter: 2,
      }),
    systemContext:
      '사용자는 "디스크 부족" 시나리오로 진입했습니다 — 디스크 풀, inode 고갈, I/O 오류 메시지에 집중하세요. df -h, du -sh, inode 점검 명령을 후속으로 제안하세요.',
    nextActionChips: [
      '디스크 여유 확인 (df -h)',
      '용량 큰 디렉토리 찾기 (du -sh /var/*)',
      'inode 사용량 확인 (df -i)',
    ],
  },

  login: {
    key: 'login',
    icon: '🔐',
    title: '로그인 의심',
    detail: '실패한 SSH 시도와 비정상 접근을 점검합니다',
    buildRequest: (path) =>
      buildSearchRequest(path, {
        pattern: 'Failed password|authentication failure|invalid user|Accepted|sudo:',
        ignoreCase: false,
        ctxBefore: 0,
        ctxAfter: 1,
      }),
    systemContext:
      '사용자는 "로그인 의심" 시나리오로 진입했습니다 — 실패한 SSH 인증, 무차별 대입(brute force) 패턴, 일반적이지 않은 IP/사용자명에 집중하세요. 비정상 IP는 정렬·집계해 표로 보여주세요.',
    nextActionChips: [
      '실패 IP TOP 10 집계',
      'sudo 사용 이력 확인',
      '현재 접속 중인 사용자 (who)',
    ],
  },

  yesterday: {
    key: 'yesterday',
    icon: '📅',
    title: '어제 무슨 일?',
    detail: '지난 24시간 주요 이벤트를 요약합니다',
    buildRequest: (path) =>
      buildRecentRequest(path, { hours: 24 }),
    systemContext:
      '사용자는 "어제 무슨 일?" 시나리오로 진입했습니다 — 지난 24시간 동안 발생한 주요 이벤트를 시간순으로 요약하세요. 정기 작업(cron/logrotate) 외의 비정상 이벤트만 강조하세요.',
    nextActionChips: [
      '특정 시간대 집중 분석',
      '재시작/중단된 서비스 확인',
      '지난주 동일 시간대와 비교',
    ],
  },

  checkup: {
    key: 'checkup',
    icon: '📊',
    title: '지금 상태 점검',
    detail: '시스템 전반의 정상 동작 여부를 한 눈에 보여줍니다',
    buildRequest: (path) =>
      buildSummaryRequest(path),
    systemContext:
      '사용자는 "지금 상태 점검" 시나리오로 진입했습니다 — 전반적 정상 동작 여부를 점검하세요. ERROR/WARN 카운트, 마지막 로그 시각, 알려진 이상 신호 부재 등으로 결론을 내리세요. 큰 문제가 없으면 "🟢 정상"으로 답하세요.',
    nextActionChips: [
      'CPU/메모리/디스크 한 번에 보기',
      '실행 중인 주요 서비스 확인',
      '최근 1시간 에러만 다시 점검',
    ],
  },
}

export const LOGPILOT_SCENARIO_LIST: LogPilotScenario[] = [
  LOGPILOT_SCENARIOS.error,
  LOGPILOT_SCENARIOS.slow,
  LOGPILOT_SCENARIOS.disk,
  LOGPILOT_SCENARIOS.login,
  LOGPILOT_SCENARIOS.yesterday,
  LOGPILOT_SCENARIOS.checkup,
]

/** LogPilot 기본 자주 쓰는 로그 — Linux 시스템 표준 6종 (사용자 추가 프리셋과 별도 시드).
 *  path는 두 가지 형태를 모두 허용:
 *   - `/`로 시작 → 파일 경로 (logcheck.sh로 분석)
 *   - 그 외      → 셸 명령 (logs.fetchExec로 실행 후 분석)
 */
export interface LogPilotPreset {
  label: string
  path: string
  description: string
}

export const LOGPILOT_DEFAULT_PRESETS: LogPilotPreset[] = [
  { label: 'syslog',           path: '/var/log/syslog',                   description: '시스템 전체 메시지' },
  { label: 'auth.log',         path: '/var/log/auth.log',                 description: '로그인·인증 기록' },
  { label: 'kern.log',         path: '/var/log/kern.log',                 description: '커널 메시지' },
  { label: 'nginx access',     path: '/var/log/nginx/access.log',         description: 'nginx 접속 로그' },
  { label: 'nginx error',      path: '/var/log/nginx/error.log',          description: 'nginx 오류 로그' },
  // /var/log/journal 은 디렉토리라 logcheck.sh로 직접 분석 불가 — journalctl 명령으로 교체.
  // `$ ` 접두사가 없어도 useLogPilot이 "/"로 시작 안 하면 명령으로 인식.
  { label: 'journalctl',       path: 'journalctl -xe --no-pager -n 1000', description: 'systemd 통합 로그 (명령)' },
]

/**
 * 자연어 textarea placeholder 회전용 예시 10개 (Step E #3).
 * 사용자가 어떤 질문을 던질 수 있는지 학습시키는 목적.
 * 5초마다 순차 회전 + ▾ 버튼 클릭 시 현재 예시를 textarea에 자동 채움.
 */
export const LOGPILOT_PLACEHOLDER_EXAMPLES: string[] = [
  '오늘 새벽 갑자기 느려진 이유 알려줘',
  '어제부터 디스크가 가득 차는데 원인이 뭐야?',
  '최근 30분 동안 발생한 에러를 정리해줘',
  '누가 SSH 로그인을 시도했는지 확인해줘',
  '서비스가 자꾸 죽는 이유를 찾아줘',
  '메모리 부족으로 죽은 프로세스가 있어?',
  '지난 24시간 동안 의심스러운 활동 있었어?',
  'cron 작업이 정상적으로 돌았는지 확인해줘',
  'nginx 응답 지연이 자주 발생하나?',
  '시스템이 재부팅된 흔적이 있어?',
]

/**
 * path가 셸 명령인지 파일 경로인지 판정.
 * 로직: `/`로 시작하지 않으면 명령으로 간주 (`journalctl -xe`, `dmesg | tail -200` 등).
 * Windows 경로는 LogPilot이 Linux 전용이므로 고려하지 않음.
 */
export function isCommandPath(path: string): boolean {
  return !path.startsWith('/')
}
