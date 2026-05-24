/**
 * AI 응답 파서 — LogPilot 4섹션 / 신호등 / 코드블록 / dry-run 설명 추출.
 *
 * 시스템 프롬프트가 4섹션 출력을 강제해도 모델이 따르지 않을 수 있음 (Plan §Risks Flag 1).
 * 모든 파서는 **폴백 분기**를 가진다:
 *   - 신호등 헤더 없음 → verdict = 'unknown' (⚪)
 *   - 4섹션 미충족 → 전체 응답을 conclusion에 넣고 나머지 빈 상태로 표시
 *   - 코드블록 없음 → actionsNow = []
 *   - dry-run 설명 누락 → description = '' (UI가 폴백 문구 표시)
 *
 * 파싱 실패 ≠ 분석 실패 — UI는 항상 raw 응답을 함께 보존해 사용자에게 노출 가능.
 */

import { getCommandRiskLevel, type LogPilotRiskLevel } from '@utils/commandRiskLevel'

export type LogPilotVerdict = 'red' | 'yellow' | 'green' | 'unknown'

export interface ParsedAction {
  description: string
  command: string
  riskLevel: LogPilotRiskLevel
}

export interface ParsedLogPilotResult {
  /** 신호등 — 첫 줄 정규식 매칭 결과. 미일치 시 'unknown'. */
  verdict: LogPilotVerdict
  /** 신호등 라벨 첫 줄 그대로 (예: "🔴 위험 — 디스크 풀 발생"). */
  verdictText: string
  conclusion: string
  cause: string
  actionsNow: ParsedAction[]
  actionsLater: string
  /** 파싱 시 4섹션 중 하나라도 누락되어 폴백 경로를 탔다면 true. */
  parseFallback: boolean
}

const VERDICT_RE = /(🔴|🟡|🟢)\s*(위험|주의|정상)/

/**
 * 신호등 추출 — 응답 앞부분에서 첫 번째 매칭 찾기.
 * 헤더(`## 📌 결론`) 직후 줄에 있는 경우, 응답 첫 줄에 있는 경우 모두 커버.
 * 비-헤더 라인 중 첫 매칭을 verdictText로 보존 (UI 노출용).
 */
function extractVerdict(text: string): { verdict: LogPilotVerdict; verdictText: string } {
  const lines = text.split('\n').map(l => l.trim())
  for (const line of lines) {
    if (line.length === 0) continue
    if (line.startsWith('#')) continue // 헤더 줄 건너뛰기 — 본문에서 찾기
    const match = VERDICT_RE.exec(line)
    if (match) {
      const verdict: LogPilotVerdict =
        match[1] === '🔴' ? 'red' :
        match[1] === '🟡' ? 'yellow' :
        match[1] === '🟢' ? 'green' :
        'unknown'
      return { verdict, verdictText: line }
    }
  }
  // 폴백 — 첫 비어있지 않은 줄을 라벨로 보존하되 verdict=unknown
  const firstLine = lines.find(l => l.length > 0 && !l.startsWith('#')) ?? ''
  return { verdict: 'unknown', verdictText: firstLine }
}

/**
 * 4섹션 분리 — `## 📌 결론`, `## 🧭 원인`, `## 🚨 지금 할 일`, `## 🗓 나중에 검토할 일`.
 * 이모지가 빠진 변형(예: `## 결론`)도 매칭. 한국어 헤더 키워드 기준.
 */
interface RawSections {
  conclusion: string
  cause: string
  actionsNow: string
  actionsLater: string
  hasAll: boolean
}

function splitSections(text: string): RawSections {
  // H2(## …) 또는 H1/H3 변형도 헤더로 인정 (모델이 H 레벨을 자주 헷갈림).
  // 헤더 본문 키워드: 결론 / 원인 / 지금 할 일 / 나중에.
  // 부제목 허용 — `## 📌 결론 — 디스크 풀` 같은 형태도 헤더로 인식 (`(?:[\s—\-:].*)?$`).
  const HEADER_RE = /^#+\s*(?:📌|🧭|🚨|🗓)?\s*(결론|원인|지금\s*할\s*일|나중에(?:\s*검토할\s*일)?)(?:[\s—\-:].*)?$/m

  // 한 줄 전체 헤더만 split 기준으로 — 다중라인 분리
  const lines = text.split('\n')
  const sections: Record<string, string[]> = {}
  let current: string | null = null

  for (const line of lines) {
    const h = HEADER_RE.exec(line.trim())
    if (h) {
      const kw = h[1].replace(/\s+/g, '')
      // 정규화: '지금할일' / '나중에' / '나중에검토할일' 등 → 표준 key
      const norm =
        kw.startsWith('결론') ? 'conclusion' :
        kw.startsWith('원인') ? 'cause' :
        kw.startsWith('지금') ? 'actionsNow' :
        kw.startsWith('나중') ? 'actionsLater' :
        null
      if (norm) {
        current = norm
        sections[current] = []
        continue
      }
    }
    if (current) sections[current].push(line)
  }

  const get = (k: string) => (sections[k] ?? []).join('\n').trim()
  const result = {
    conclusion: get('conclusion'),
    cause: get('cause'),
    actionsNow: get('actionsNow'),
    actionsLater: get('actionsLater'),
    hasAll: false,
  }
  result.hasAll =
    !!result.conclusion && !!result.cause && !!result.actionsNow && !!result.actionsLater
  return result
}

/**
 * "지금 할 일" 섹션에서 코드블록 + 위쪽 dry-run 설명 추출.
 *
 * 입력 예:
 *   **이 명령은:** 디스크 사용량을 확인합니다.
 *   ```bash
 *   df -h
 *   ```
 *
 * 설명이 누락된 코드블록도 빈 description으로 함께 반환 (UI 폴백).
 */
function extractActions(actionsNowText: string): ParsedAction[] {
  const FENCE_RE = /```(?:[a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g
  const result: ParsedAction[] = []

  let match: RegExpExecArray | null
  while ((match = FENCE_RE.exec(actionsNowText)) !== null) {
    const codeStart = match.index
    const command = match[1].trim()
    if (!command) continue

    // 코드블록 직전 텍스트에서 "**이 명령은:**" 또는 "이 명령은:" 줄 검색
    const before = actionsNowText.slice(0, codeStart)
    const lines = before.split('\n').map(l => l.trim()).filter(l => l.length > 0)
    const lastLine = lines[lines.length - 1] ?? ''
    const DESC_RE = /^\**\s*이\s*명령은[:\s]\**\s*(.+?)\**$/
    const dmatch = DESC_RE.exec(lastLine)
    const description = dmatch ? dmatch[1].trim() : ''

    const { level } = getCommandRiskLevel(command)
    result.push({ description, command, riskLevel: level })
  }

  return result
}

/**
 * 메인 진입점 — AI 응답 원본을 받아 LogPilot UI 데이터로 변환.
 * 어떤 경우에도 throw하지 않음. 폴백 분기 적용 시 parseFallback=true.
 */
export function parseLogPilotResponse(raw: string): ParsedLogPilotResult {
  const text = (raw ?? '').trim()
  if (!text) {
    return {
      verdict: 'unknown',
      verdictText: '',
      conclusion: '',
      cause: '',
      actionsNow: [],
      actionsLater: '',
      parseFallback: true,
    }
  }

  const { verdict, verdictText } = extractVerdict(text)
  const sections = splitSections(text)

  // 4섹션 미충족 → 폴백: 전체를 conclusion에 보관
  if (!sections.hasAll) {
    return {
      verdict,
      verdictText,
      conclusion: text,
      cause: '',
      actionsNow: [],
      actionsLater: '',
      parseFallback: true,
    }
  }

  const actionsNow = extractActions(sections.actionsNow)

  return {
    verdict,
    verdictText,
    conclusion: sections.conclusion,
    cause: sections.cause,
    actionsNow,
    actionsLater: sections.actionsLater,
    parseFallback: false,
  }
}

/**
 * 마크다운 직렬화 메타 — 공유/내보내기 헤더에 들어갈 분석 컨텍스트.
 * 모든 필드는 optional — 부분적으로만 알려진 경우(예: 자연어 흐름은 scenario 없음)에도 동작.
 */
export interface SerializeMeta {
  /** 시나리오 한국어 라벨 (예: "디스크 부족"). 없으면 자연어 분석으로 간주. */
  scenario?: string
  /** 분석한 로그 출처 (파일 경로 또는 명령 문자열). */
  source?: string
  /** 수집된 로그 줄 수. */
  lineCount?: number
  /** 분석 완료 시각 ISO 문자열. 없으면 호출 시점 기준 `new Date()` 사용. */
  timestamp?: string
}

const VERDICT_HEADER: Record<LogPilotVerdict, string> = {
  red:     '🔴 위험',
  yellow:  '🟡 주의',
  green:   '🟢 정상',
  unknown: '⚪ 판정 보류',
}

/**
 * verdictText에서 신호등 이모지/라벨 + " — " 또는 " - " 구분자 이후를 본문으로 분리.
 *
 * 매칭 실패(구분자가 없거나 라벨만 있는 경우)에는 **빈 문자열** 반환 — 호출부는
 * 빈 문자열일 때 라벨만 출력하도록 분기되어 있어, "🟢 정상" → ``# 🟢 정상 — 🟢 정상``
 * 라벨 중복 출력을 회피한다. (Reviewer S-1)
 */
function extractVerdictBody(verdictText: string): string {
  if (!verdictText) return ''
  // "🔴 위험 — 디스크 풀" → "디스크 풀"
  const m = /^(?:🔴|🟡|🟢|⚪)?\s*(?:위험|주의|정상|판정\s*보류)?\s*[—\-:]\s*(.+)$/.exec(verdictText.trim())
  return m ? m[1].trim() : ''
}

/**
 * 파싱된 LogPilot 결과를 슬랙/티켓에 즉시 붙여넣기 가능한 마크다운으로 직렬화.
 *
 * 출력 구조:
 *   # 🔴 위험 — <verdict 본문>
 *   > 분석 시각: 2026-05-24 19:30
 *   > 출처: /var/log/syslog (1,234 줄)
 *   > 시나리오: 디스크 부족
 *
 *   ## 📌 결론
 *   ...
 *   ## 🧭 원인
 *   ...
 *   ## 🚨 지금 할 일
 *   - **이 명령은:** ...
 *     ```bash
 *     ...
 *     ```
 *   ## 🗓 나중에 검토할 일
 *   ...
 *   ---
 *   ※ AI는 정확하지 않은 정보를 제공할 수 있습니다. 중요한 결정 전 원본 로그를 확인하세요.
 *
 * parseFallback=true인 경우: 폴백 알림 + raw conclusion만 본문에 포함.
 */
export function serializeAsMarkdown(
  parsed: ParsedLogPilotResult,
  meta?: SerializeMeta,
): string {
  const verdictBody = extractVerdictBody(parsed.verdictText)
  const headerLabel = VERDICT_HEADER[parsed.verdict]
  const title = verdictBody
    ? `# ${headerLabel} — ${verdictBody}`
    : `# ${headerLabel}`

  // 메타 블록 — 분석 시각/출처/시나리오 (있는 것만)
  const tsIso = meta?.timestamp ?? new Date().toISOString()
  const tsFormatted = formatTimestamp(tsIso)
  const metaLines: string[] = [`> 분석 시각: ${tsFormatted}`]
  if (meta?.source) {
    const lineSuffix = meta.lineCount !== undefined
      ? ` (${meta.lineCount.toLocaleString()} 줄)`
      : ''
    metaLines.push(`> 출처: ${meta.source}${lineSuffix}`)
  }
  if (meta?.scenario) {
    metaLines.push(`> 시나리오: ${meta.scenario}`)
  }

  const parts: string[] = [title, '', metaLines.join('\n'), '']

  // 폴백: 4섹션 없이 raw conclusion만 출력
  if (parsed.parseFallback) {
    parts.push('> ℹ️ AI 응답이 표준 형식을 따르지 않아 원문 그대로 포함했습니다.', '')
    if (parsed.conclusion) parts.push(parsed.conclusion, '')
  } else {
    if (parsed.conclusion) {
      parts.push('## 📌 결론', '', parsed.conclusion, '')
    }
    if (parsed.cause) {
      parts.push('## 🧭 원인', '', parsed.cause, '')
    }
    if (parsed.actionsNow.length > 0) {
      parts.push('## 🚨 지금 할 일', '')
      for (const action of parsed.actionsNow) {
        if (action.description) {
          parts.push(`- **이 명령은:** ${action.description}`)
        } else {
          parts.push('- (설명 없음)')
        }
        parts.push('  ```bash', `  ${action.command}`, '  ```')
      }
      parts.push('')
    }
    if (parsed.actionsLater) {
      parts.push('## 🗓 나중에 검토할 일', '', parsed.actionsLater, '')
    }
  }

  parts.push('---')
  parts.push('※ AI는 정확하지 않은 정보를 제공할 수 있습니다. 중요한 결정 전 원본 로그를 확인하세요.')

  return parts.join('\n')
}

/**
 * ISO 시간 문자열을 `YYYY-MM-DD HH:mm` 로컬 시각으로 포맷.
 * 잘못된 입력은 입력 그대로 반환 (폴백).
 */
function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}
