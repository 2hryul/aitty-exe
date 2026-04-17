/**
 * 프론트엔드 예산 평가 유틸 — C# `AiBudget`의 미러.
 * 모델 변경 시 네트워크 왕복 없이 즉시 재계산하기 위함.
 * 백엔드 `logs:evaluate`와 결과가 항상 일치해야 한다.
 */

export type BudgetStatus = 'ok' | 'warn' | 'reject'

export interface BudgetCheck {
  status: BudgetStatus
  budget: number            // bytes
  sizeBytes: number
  ratio: number             // sizeBytes / budget
  suggestedChunks: number   // 최소 1
}

interface BudgetRow {
  provider: string
  pattern: RegExp
  budget: number
}

const FALLBACK_BUDGET = 50_000

// C# BudgetTable과 1:1 일치. 위에서부터 첫 매치 적용.
const BUDGET_TABLE: readonly BudgetRow[] = [
  // Claude
  { provider: 'claude', pattern: /claude-(opus|sonnet)-4/i, budget: 600_000 },
  { provider: 'claude', pattern: /claude-haiku-4\.5/i,      budget: 400_000 },

  // OpenAI — 구체적인 패턴 먼저
  { provider: 'openai', pattern: /gpt-4o-mini|gpt-3\.5/i,   budget: 200_000 },
  { provider: 'openai', pattern: /gpt-4o/i,                 budget: 350_000 },

  // Gemini
  { provider: 'gemini', pattern: /gemini-1\.5-pro/i,        budget: 1_000_000 },
  { provider: 'gemini', pattern: /gemini-1\.5-flash/i,      budget: 800_000 },
  { provider: 'gemini', pattern: /gemini-2\.0-flash/i,      budget: 800_000 },

  // Ollama — 32k variant 우선
  { provider: 'ollama', pattern: /32k|qwen2\.5/i,           budget: 90_000 },
  { provider: 'ollama', pattern: /.*/,                      budget: 24_000 },
]

/** provider+model에 맞는 입력 바이트 상한. 미지의 조합은 폴백 50KB. */
export function budgetFor(provider: string, model: string): number {
  if (!provider || !model) return FALLBACK_BUDGET
  const p = provider.toLowerCase()
  for (const row of BUDGET_TABLE) {
    if (row.provider !== p) continue
    if (row.pattern.test(model)) return row.budget
  }
  return FALLBACK_BUDGET
}

/**
 * UTF-8 바이트 기준 뒤쪽 `maxBytes` 만 남기고 자른다.
 * 멀티바이트 문자 중간에서 자르는 걸 막기 위해 잘린 첫 바이트부터
 * 첫 '\n' 이후(포함 X)까지 추가로 버려 라인 경계를 맞춘다.
 * 반환값은 원문 문자열(전체가 budget 이내면 원문 그대로).
 */
export function truncateTailBytes(content: string, maxBytes: number): string {
  if (maxBytes <= 0 || !content) return ''
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const bytes = encoder.encode(content)
  if (bytes.byteLength <= maxBytes) return content

  let start = bytes.byteLength - maxBytes

  // UTF-8 continuation byte(0x80~0xBF) 중간에 걸렸다면 시작 바이트까지 전진
  while (start < bytes.byteLength && (bytes[start] & 0xC0) === 0x80) start++

  // 첫 '\n' 다음 위치부터 자르기 — 라인 중간 방지
  for (let i = start; i < bytes.byteLength; i++) {
    if (bytes[i] === 0x0A) { start = i + 1; break }
  }

  return decoder.decode(bytes.slice(start))
}

/**
 * 입력 크기 대 예산 비율로 Ok/Warn/Reject 판정.
 * - size <= budget          → ok
 * - size <= budget * 5      → warn
 * - size >  budget * 5      → reject
 */
export function evaluate(sizeBytes: number, provider: string, model: string): BudgetCheck {
  const budget = budgetFor(provider, model)
  const ratio = budget > 0 ? sizeBytes / budget : 0

  let status: BudgetStatus
  if (sizeBytes <= budget) status = 'ok'
  else if (sizeBytes <= budget * 5) status = 'warn'
  else status = 'reject'

  // 청크 크기는 budget의 80% — 안전 여유
  const chunkSize = Math.max(1, Math.floor(budget * 0.8))
  const suggestedChunks = Math.max(1, Math.ceil(sizeBytes / chunkSize))

  return { status, budget, sizeBytes, ratio, suggestedChunks }
}
