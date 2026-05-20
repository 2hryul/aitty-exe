import policy from '../../policies/command-safety.json'

export type SafetyLevel = 'safe' | 'warning' | 'caution' | 'danger'

export interface SafetyResult {
  level: SafetyLevel
  reason?: string
  alternative?: string
}

export interface DangerPattern {
  pattern: RegExp
  reason: string
  alternative: string
}

// 정책 JSON 단일 진실원 (SoT) — webapp/policies/command-safety.json
// 백엔드(CommandSafetyService.cs)와 동일한 파일을 EmbeddedResource로 공유
interface PatternEntry {
  pattern: string
  flags?: string
  reason: string
  alternative: string
}

function compilePattern(entry: PatternEntry): DangerPattern {
  return {
    pattern: new RegExp(entry.pattern, entry.flags ?? ''),
    reason: entry.reason,
    alternative: entry.alternative,
  }
}

const DANGER_PATTERNS: DangerPattern[] = policy.danger.map(compilePattern)
const CAUTION_PATTERNS: DangerPattern[] = policy.caution.map(compilePattern)
const WARNING_PATTERNS: DangerPattern[] = policy.warning.map(compilePattern)

const LEVEL_PRIORITY: Record<SafetyLevel, number> = {
  safe: 0,
  warning: 1,
  caution: 2,
  danger: 3,
}

export function checkCommandSafety(code: string): SafetyResult {
  const lines = code.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))

  let worst: SafetyResult = { level: 'safe' }

  for (const line of lines) {
    // Check danger first (highest priority)
    for (const { pattern, reason, alternative } of DANGER_PATTERNS) {
      if (pattern.test(line)) {
        return { level: 'danger', reason, alternative }
      }
    }

    for (const { pattern, reason, alternative } of CAUTION_PATTERNS) {
      if (pattern.test(line)) {
        const result: SafetyResult = { level: 'caution', reason, alternative }
        if (LEVEL_PRIORITY[result.level] > LEVEL_PRIORITY[worst.level]) {
          worst = result
        }
      }
    }

    for (const { pattern, reason, alternative } of WARNING_PATTERNS) {
      if (pattern.test(line)) {
        const result: SafetyResult = { level: 'warning', reason, alternative }
        if (LEVEL_PRIORITY[result.level] > LEVEL_PRIORITY[worst.level]) {
          worst = result
        }
      }
    }
  }

  return worst
}

const LEVEL_LABELS: Record<SafetyLevel, string> = {
  safe: '',
  warning: '🟡 경고',
  caution: '🟠 주의',
  danger: '🔴 위험',
}

export function formatSafetyAlert(result: SafetyResult): string {
  const label = LEVEL_LABELS[result.level] || ''
  let msg = `${label}: ${result.reason}`
  if (result.alternative) {
    msg += `\n\n안전한 대안: ${result.alternative}`
  }
  return msg
}
