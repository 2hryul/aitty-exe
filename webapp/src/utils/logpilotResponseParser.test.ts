import { describe, it, expect } from 'vitest'
import { parseLogPilotResponse, serializeAsMarkdown } from './logpilotResponseParser'

describe('logpilotResponseParser — 4섹션/신호등/코드블록 추출', () => {
  it('정상 4섹션 응답을 모두 추출한다', () => {
    const raw = [
      '## 📌 결론',
      '🟢 정상 — 큰 문제는 없습니다.',
      '',
      '## 🧭 원인',
      '- ERROR 0건',
      '- 정상 cron 실행',
      '',
      '## 🚨 지금 할 일',
      '**이 명령은:** 디스크 사용량을 확인합니다.',
      '```bash',
      'df -h',
      '```',
      '',
      '## 🗓 나중에 검토할 일',
      '- 모니터링 알림 임계값 점검',
    ].join('\n')

    const r = parseLogPilotResponse(raw)
    expect(r.verdict).toBe('green')
    expect(r.verdictText).toContain('🟢')
    expect(r.conclusion).toContain('큰 문제는 없습니다')
    expect(r.cause).toContain('ERROR 0건')
    expect(r.actionsNow).toHaveLength(1)
    expect(r.actionsNow[0].command).toBe('df -h')
    expect(r.actionsNow[0].description).toBe('디스크 사용량을 확인합니다.')
    expect(r.actionsNow[0].riskLevel).toBe('safe')
    expect(r.actionsLater).toContain('모니터링')
    expect(r.parseFallback).toBe(false)
  })

  it('🔴 위험 시나리오 — verdict red 매핑', () => {
    const raw = [
      '## 📌 결론',
      '🔴 위험 — 디스크 풀 발생.',
      '## 🧭 원인',
      '- /var 파티션 100%',
      '## 🚨 지금 할 일',
      '**이 명령은:** 디스크 여유를 즉시 확인합니다.',
      '```bash',
      'df -h',
      '```',
      '## 🗓 나중에 검토할 일',
      '- 로테이션 정책 조정',
    ].join('\n')
    const r = parseLogPilotResponse(raw)
    expect(r.verdict).toBe('red')
  })

  it('🟡 주의 시나리오 — verdict yellow 매핑', () => {
    const raw = [
      '## 📌 결론',
      '🟡 주의 — 일부 경고가 보입니다.',
      '## 🧭 원인',
      '- WARN 메시지 다수',
      '## 🚨 지금 할 일',
      '**이 명령은:** 메모리를 확인합니다.',
      '```bash',
      'free -h',
      '```',
      '## 🗓 나중에 검토할 일',
      '- 자원 모니터링 강화',
    ].join('\n')
    const r = parseLogPilotResponse(raw)
    expect(r.verdict).toBe('yellow')
  })

  it('신호등 라벨 누락 시 verdict=unknown + 전체 텍스트는 보존', () => {
    const raw = [
      '## 📌 결론',
      '결론을 적어놓고 신호등을 빠뜨림.',
      '## 🧭 원인',
      '- 어떤 원인',
      '## 🚨 지금 할 일',
      '- 별도 명령 없음',
      '## 🗓 나중에 검토할 일',
      '- TBD',
    ].join('\n')
    const r = parseLogPilotResponse(raw)
    expect(r.verdict).toBe('unknown')
    expect(r.conclusion).toContain('신호등을 빠뜨림')
    expect(r.parseFallback).toBe(false)
  })

  it('4섹션 중 하나라도 누락되면 폴백 — 전체를 conclusion에 보관', () => {
    const raw = [
      '## 📌 결론',
      '🟢 정상',
      '## 🧭 원인',
      '- ok',
      // "지금 할 일" 누락
      '## 🗓 나중에 검토할 일',
      '- noop',
    ].join('\n')
    const r = parseLogPilotResponse(raw)
    expect(r.parseFallback).toBe(true)
    expect(r.conclusion).toBe(raw.trim())
    expect(r.actionsNow).toHaveLength(0)
    expect(r.actionsLater).toBe('')
  })

  it('빈 응답은 폴백 — 모든 필드 빈 상태', () => {
    const r = parseLogPilotResponse('')
    expect(r.verdict).toBe('unknown')
    expect(r.conclusion).toBe('')
    expect(r.parseFallback).toBe(true)
  })

  it('코드블록이 없는 "지금 할 일" 섹션 — actionsNow 빈 배열', () => {
    const raw = [
      '## 📌 결론',
      '🟢 정상',
      '## 🧭 원인',
      '- 별 일 없음',
      '## 🚨 지금 할 일',
      '특별히 실행할 명령이 없습니다.',
      '## 🗓 나중에 검토할 일',
      '- 다음 점검 4시간 후',
    ].join('\n')
    const r = parseLogPilotResponse(raw)
    expect(r.actionsNow).toHaveLength(0)
    expect(r.parseFallback).toBe(false)
  })

  it('dry-run 설명 누락된 코드블록도 빈 description으로 포함', () => {
    const raw = [
      '## 📌 결론',
      '🟡 주의',
      '## 🧭 원인',
      '- 뭔가',
      '## 🚨 지금 할 일',
      '```bash',
      'ls -la /var/log',
      '```',
      '## 🗓 나중에 검토할 일',
      '- TBD',
    ].join('\n')
    const r = parseLogPilotResponse(raw)
    expect(r.actionsNow).toHaveLength(1)
    expect(r.actionsNow[0].command).toBe('ls -la /var/log')
    expect(r.actionsNow[0].description).toBe('')
  })

  it('위험 명령은 riskLevel=danger로 분류', () => {
    const raw = [
      '## 📌 결론',
      '🔴 위험',
      '## 🧭 원인',
      '- 심각',
      '## 🚨 지금 할 일',
      '**이 명령은:** (예시로) 위험 명령을 표시합니다.',
      '```bash',
      'rm -rf /',
      '```',
      '## 🗓 나중에 검토할 일',
      '- 절대 실행 금지',
    ].join('\n')
    const r = parseLogPilotResponse(raw)
    expect(r.actionsNow[0].riskLevel).toBe('danger')
  })

  it('헤더에 부제목이 붙어도 4섹션을 정상 인식한다 (—/-/: 구분자)', () => {
    // 실제 AI 모델은 "## 📌 결론 — 디스크 풀" 처럼 부제목을 자주 붙임.
    const raw = [
      '## 📌 결론 — 디스크 풀 의심',
      '🔴 위험 — /var 파티션 가득',
      '## 🧭 원인: 로그 파일 누적',
      '- /var/log/syslog 1.8GB',
      '## 🚨 지금 할 일 - 즉시 조치',
      '**이 명령은:** 디스크 사용량을 봅니다.',
      '```bash',
      'df -h',
      '```',
      '## 🗓 나중에 검토할 일 — 정책 수립',
      '- logrotate 주기 점검',
    ].join('\n')
    const r = parseLogPilotResponse(raw)
    expect(r.parseFallback).toBe(false)
    expect(r.verdict).toBe('red')
    expect(r.conclusion).toContain('/var')
    expect(r.cause).toContain('1.8GB')
    expect(r.actionsNow).toHaveLength(1)
    expect(r.actionsNow[0].command).toBe('df -h')
    expect(r.actionsLater).toContain('logrotate')
  })

  it('serializeAsMarkdown — 4섹션 + 메타 + 면책문구 포함', () => {
    const raw = [
      '## 📌 결론',
      '🔴 위험 — 디스크 풀 발생.',
      '',
      '## 🧭 원인',
      '- /var 파티션 100%',
      '',
      '## 🚨 지금 할 일',
      '**이 명령은:** 디스크 여유를 확인합니다.',
      '```bash',
      'df -h',
      '```',
      '',
      '## 🗓 나중에 검토할 일',
      '- 로테이션 정책 조정',
    ].join('\n')
    const parsed = parseLogPilotResponse(raw)
    const md = serializeAsMarkdown(parsed, {
      scenario: '디스크 부족',
      source: '/var/log/syslog',
      lineCount: 1234,
      timestamp: '2026-05-24T10:30:00.000Z',
    })

    // 헤더 신호등 + verdict body
    expect(md).toMatch(/^# 🔴 위험 — 디스크 풀 발생\./)
    // 메타 블록
    expect(md).toContain('> 분석 시각: ')
    expect(md).toContain('> 출처: /var/log/syslog (1,234 줄)')
    expect(md).toContain('> 시나리오: 디스크 부족')
    // 4섹션
    expect(md).toContain('## 📌 결론')
    expect(md).toContain('## 🧭 원인')
    expect(md).toContain('## 🚨 지금 할 일')
    expect(md).toContain('## 🗓 나중에 검토할 일')
    // 코드블록
    expect(md).toContain('**이 명령은:** 디스크 여유를 확인합니다.')
    expect(md).toContain('```bash')
    expect(md).toContain('df -h')
    // 면책 문구
    expect(md).toContain('※ AI는 정확하지 않은 정보를 제공할 수 있습니다')
  })

  it('serializeAsMarkdown — 메타 없이도 동작 (출처/시나리오 라인 생략)', () => {
    const raw = [
      '## 📌 결론',
      '🟢 정상',
      '## 🧭 원인',
      '- 별 일 없음',
      '## 🚨 지금 할 일',
      '- 명령 없음',
      '## 🗓 나중에 검토할 일',
      '- 모니터링 유지',
    ].join('\n')
    const parsed = parseLogPilotResponse(raw)
    const md = serializeAsMarkdown(parsed)

    expect(md).toMatch(/^# 🟢 정상/)
    // S-1 회귀 방지: verdictText에 구분자가 없을 때 라벨이 두 번 찍히지 않아야 함.
    expect(md).not.toMatch(/— 🟢 정상/)
    expect(md.split('\n')[0]).toBe('# 🟢 정상')
    expect(md).toContain('> 분석 시각: ')
    expect(md).not.toContain('> 출처:')
    expect(md).not.toContain('> 시나리오:')
    expect(md).toContain('## 📌 결론')
    expect(md).toContain('※ AI는 정확하지 않은 정보')
  })

  it('serializeAsMarkdown — verdictText에 구분자 있으면 본문 분리해서 헤더에 합성', () => {
    // S-1 양성 케이스: " — " 구분자가 있으면 body 추출되어 헤더에 "— body" 형태로.
    const raw = [
      '🔴 위험 — 디스크 풀 임박',
      '## 📌 결론',
      '- 디스크 95% 사용',
      '## 🧭 원인',
      '- /var/log 로테이션 실패',
      '## 🚨 지금 할 일',
      '- 즉시 정리',
      '## 🗓 나중에 검토할 일',
      '- 로테이션 점검',
    ].join('\n')
    const parsed = parseLogPilotResponse(raw)
    const md = serializeAsMarkdown(parsed)
    expect(md.split('\n')[0]).toBe('# 🔴 위험 — 디스크 풀 임박')
  })

  it('serializeAsMarkdown — parseFallback 시 원문만 + 폴백 알림', () => {
    const r = parseLogPilotResponse('알 수 없는 응답 형식의 본문 텍스트.')
    expect(r.parseFallback).toBe(true)
    const md = serializeAsMarkdown(r, {
      timestamp: '2026-05-24T10:30:00.000Z',
    })

    expect(md).toContain('ℹ️ AI 응답이 표준 형식을 따르지 않아')
    expect(md).toContain('알 수 없는 응답 형식의 본문 텍스트.')
    // 4섹션 헤더는 없어야 함
    expect(md).not.toContain('## 📌 결론')
    expect(md).not.toContain('## 🧭 원인')
    // 면책 문구는 여전히 포함
    expect(md).toContain('※ AI는 정확하지 않은 정보')
  })

  it('serializeAsMarkdown — verdictText 신호등 본문 추출 (— 구분자)', () => {
    const raw = [
      '## 📌 결론',
      '🟡 주의 — 메모리 압박',
      '## 🧭 원인',
      '- 일부 swap',
      '## 🚨 지금 할 일',
      '**이 명령은:** 메모리를 확인합니다.',
      '```bash',
      'free -h',
      '```',
      '## 🗓 나중에 검토할 일',
      '- 자원 증설',
    ].join('\n')
    const parsed = parseLogPilotResponse(raw)
    const md = serializeAsMarkdown(parsed)

    // verdict body가 정확히 추출되어야 함
    expect(md).toMatch(/^# 🟡 주의 — 메모리 압박/)
    // 두 번 들어가지 않아야 함 (헤더는 한 줄만)
    const titleLines = md.split('\n').filter(l => l.startsWith('# '))
    expect(titleLines).toHaveLength(1)
  })

  it('코드블록 2개 이상도 모두 추출한다', () => {
    const raw = [
      '## 📌 결론',
      '🟡 주의',
      '## 🧭 원인',
      '- 메모리 부족',
      '## 🚨 지금 할 일',
      '**이 명령은:** 메모리 사용량을 봅니다.',
      '```bash',
      'free -h',
      '```',
      '**이 명령은:** CPU 상위 프로세스를 봅니다.',
      '```bash',
      'top -n 1 -b | head -20',
      '```',
      '## 🗓 나중에 검토할 일',
      '- 모니터링 강화',
    ].join('\n')
    const r = parseLogPilotResponse(raw)
    expect(r.actionsNow).toHaveLength(2)
    expect(r.actionsNow[0].command).toBe('free -h')
    expect(r.actionsNow[1].command).toBe('top -n 1 -b | head -20')
    expect(r.actionsNow[1].description).toContain('CPU')
  })
})
