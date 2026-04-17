import { describe, it, expect } from 'vitest'
import { budgetFor, evaluate, truncateTailBytes } from './logBudget'

describe('logBudget.budgetFor', () => {
  it('Claude Opus 4 → 600KB', () => {
    expect(budgetFor('claude', 'claude-opus-4.1')).toBe(600_000)
  })

  it('Claude Sonnet 4.6 → 600KB', () => {
    expect(budgetFor('claude', 'claude-sonnet-4.6')).toBe(600_000)
  })

  it('Claude Haiku 4.5 → 400KB', () => {
    expect(budgetFor('claude', 'claude-haiku-4.5')).toBe(400_000)
  })

  it('gpt-4o-mini → 200KB (구체 패턴 우선)', () => {
    expect(budgetFor('openai', 'gpt-4o-mini')).toBe(200_000)
  })

  it('gpt-3.5-turbo → 200KB', () => {
    expect(budgetFor('openai', 'gpt-3.5-turbo')).toBe(200_000)
  })

  it('gpt-4o → 350KB', () => {
    expect(budgetFor('openai', 'gpt-4o')).toBe(350_000)
  })

  it('gemini-1.5-pro → 1MB', () => {
    expect(budgetFor('gemini', 'gemini-1.5-pro')).toBe(1_000_000)
  })

  it('gemini-1.5-flash → 800KB', () => {
    expect(budgetFor('gemini', 'gemini-1.5-flash')).toBe(800_000)
  })

  it('gemini-2.0-flash → 800KB', () => {
    expect(budgetFor('gemini', 'gemini-2.0-flash')).toBe(800_000)
  })

  it('Ollama qwen2.5-coder → 90KB', () => {
    expect(budgetFor('ollama', 'qwen2.5-coder:7b')).toBe(90_000)
  })

  it('Ollama 32k variant → 90KB', () => {
    expect(budgetFor('ollama', 'llama3-32k')).toBe(90_000)
  })

  it('Ollama 기본 → 24KB', () => {
    expect(budgetFor('ollama', 'llama3:8b')).toBe(24_000)
  })

  it('미지 provider → 50KB 폴백', () => {
    expect(budgetFor('unknown-provider', 'foo-model')).toBe(50_000)
  })

  it('빈 provider → 50KB 폴백', () => {
    expect(budgetFor('', 'gpt-4o')).toBe(50_000)
  })

  it('빈 model → 50KB 폴백', () => {
    expect(budgetFor('claude', '')).toBe(50_000)
  })

  it('대소문자 무관', () => {
    expect(budgetFor('CLAUDE', 'Claude-Opus-4.1')).toBe(600_000)
  })
})

describe('logBudget.evaluate — 상태 경계값', () => {
  const provider = 'ollama'
  const model = 'llama3:8b'   // 24_000
  const budget = 24_000

  it('sizeBytes < budget → ok', () => {
    const r = evaluate(budget - 1, provider, model)
    expect(r.status).toBe('ok')
    expect(r.budget).toBe(budget)
    // suggestedChunks는 항상 ceil(size/(budget*0.8)). ok 상태라도 1보다 클 수 있음.
    expect(r.suggestedChunks).toBeGreaterThanOrEqual(1)
  })

  it('sizeBytes == budget → ok (경계값)', () => {
    const r = evaluate(budget, provider, model)
    expect(r.status).toBe('ok')
  })

  it('sizeBytes == budget + 1 → warn', () => {
    const r = evaluate(budget + 1, provider, model)
    expect(r.status).toBe('warn')
  })

  it('sizeBytes == budget * 5 → warn (경계값)', () => {
    const r = evaluate(budget * 5, provider, model)
    expect(r.status).toBe('warn')
  })

  it('sizeBytes == budget * 5 + 1 → reject', () => {
    const r = evaluate(budget * 5 + 1, provider, model)
    expect(r.status).toBe('reject')
  })

  it('ratio 계산 정확', () => {
    const r = evaluate(budget * 2, provider, model)
    expect(r.ratio).toBeCloseTo(2.0)
  })
})

describe('logBudget.evaluate — suggestedChunks', () => {
  it('ok 상태에서도 최소 1', () => {
    const r = evaluate(0, 'claude', 'claude-opus-4.1')
    expect(r.suggestedChunks).toBe(1)
  })

  it('size <= 80% budget → 1개', () => {
    // budget=600000, chunkSize=480000. size=400000 < chunkSize → 1
    const r = evaluate(400_000, 'claude', 'claude-opus-4.1')
    expect(r.status).toBe('ok')
    expect(r.suggestedChunks).toBe(1)
  })

  it('size가 chunkSize 초과하면 ok라도 2개', () => {
    // budget=600000, chunkSize=480000. size=500000 > chunkSize → 2 (status=ok)
    const r = evaluate(500_000, 'claude', 'claude-opus-4.1')
    expect(r.status).toBe('ok')
    expect(r.suggestedChunks).toBe(2)
  })

  it('정확히 chunkSize 배수: ceil 확인', () => {
    // budget=24000, chunkSize=19200(floor(24000*0.8)), sizeBytes=19200*3=57600 → 3 chunks
    const r = evaluate(57_600, 'ollama', 'llama3:8b')
    expect(r.suggestedChunks).toBe(3)
  })

  it('chunkSize 배수 + 1: ceil 올림', () => {
    const r = evaluate(57_601, 'ollama', 'llama3:8b')
    expect(r.suggestedChunks).toBe(4)
  })

  it('reject 상태 대용량', () => {
    // budget=24000 → 5배 초과 (120001) → reject
    const r = evaluate(200_000, 'ollama', 'llama3:8b')
    expect(r.status).toBe('reject')
    // chunkSize = 19200, ceil(200000/19200) = 11
    expect(r.suggestedChunks).toBe(11)
  })
})

describe('logBudget.evaluate — 폴백 예산 시나리오', () => {
  it('미지 모델에 큰 입력 → reject', () => {
    const r = evaluate(300_000, 'unknown', 'foo')  // budget=50000, *5=250000
    expect(r.status).toBe('reject')
    expect(r.budget).toBe(50_000)
  })
})

describe('logBudget.truncateTailBytes', () => {
  it('빈 문자열 → 빈 문자열', () => {
    expect(truncateTailBytes('', 100)).toBe('')
  })

  it('maxBytes = 0 → 빈 문자열', () => {
    expect(truncateTailBytes('hello', 0)).toBe('')
  })

  it('maxBytes < 0 → 빈 문자열 (방어적 처리)', () => {
    expect(truncateTailBytes('hello', -1)).toBe('')
  })

  it('전체 바이트가 maxBytes 이내 → 원문 그대로', () => {
    const s = 'hello world'
    expect(truncateTailBytes(s, 100)).toBe(s)
  })

  it('정확히 경계 바이트 → 원문 그대로', () => {
    // "abc" = 3 bytes
    expect(truncateTailBytes('abc', 3)).toBe('abc')
  })

  it('UTF-8 멀티바이트 경계 — 뒤 바이트가 continuation 중간에 걸리면 정상 시작 바이트까지 전진', () => {
    // "abcd한글" = 4 + 3 + 3 = 10 bytes. maxBytes=5 → start=5 (continuation) → start=7 (한 끝, 글 시작)
    // '\n' 없으므로 start 유지, decode → "글"
    const result = truncateTailBytes('abcd한글', 5)
    expect(result).toBe('글')
    // 깨진 문자 포함 안 됨을 재확인 (replacement character \uFFFD 금지)
    expect(result.includes('\uFFFD')).toBe(false)
  })

  it('뒤에 \\n 있으면 첫 \\n 이후부터 잘라 라인 경계 정렬', () => {
    // "xxxxx\nabc" = 9 bytes. maxBytes=6 → start=3. bytes[5]=0x0A → start=6. decode "abc"
    expect(truncateTailBytes('xxxxx\nabc', 6)).toBe('abc')
  })

  it('cut 이후 \\n 없으면 continuation 보정 후 그대로 반환 (무한루프 없음)', () => {
    // "abcdef" 6 bytes. maxBytes=3 → start=3. 모두 ASCII, '\n' 없음 → "def"
    expect(truncateTailBytes('abcdef', 3)).toBe('def')
  })

  it('한글 다중 문자 — 중간에서 잘려도 항상 유효 UTF-8 반환', () => {
    // "한글로그데이터" 7글자 × 3바이트 = 21 bytes. maxBytes=10 → start=11 (continuation) → 다음 시작 바이트
    const result = truncateTailBytes('한글로그데이터', 10)
    expect(result.includes('\uFFFD')).toBe(false)
    // 바이트 길이가 maxBytes 이하 (시작 보정으로 줄어듦)
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(10)
  })
})
