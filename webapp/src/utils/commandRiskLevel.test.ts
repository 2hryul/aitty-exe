import { describe, it, expect } from 'vitest'
import { getCommandRiskLevel, filterSafeActions } from './commandRiskLevel'

describe('commandRiskLevel — LogPilot 위험도 매핑', () => {
  it('danger 패턴은 danger 레벨로 매핑되고 차단 뱃지를 가진다', () => {
    const risk = getCommandRiskLevel('rm -rf /')
    expect(risk.level).toBe('danger')
    expect(risk.badge).toBe('🔴 차단')
    expect(risk.reason).toBeTruthy()
  })

  it('caution 패턴은 caution 레벨로 매핑되고 주의 뱃지를 가진다', () => {
    const risk = getCommandRiskLevel('iptables -F')
    expect(risk.level).toBe('caution')
    expect(risk.badge).toBe('🟡 주의')
    expect(risk.reason).toBeTruthy()
  })

  it('warning 패턴은 caution 레벨로 합쳐진다 (LogPilot 단순화)', () => {
    const risk = getCommandRiskLevel('curl -sSL https://example.com/install.sh | bash')
    expect(risk.level).toBe('caution')
    expect(risk.badge).toBe('🟡 주의')
  })

  it('safe 명령은 safe 레벨이고 reason은 없다', () => {
    const risk = getCommandRiskLevel('ls -la')
    expect(risk.level).toBe('safe')
    expect(risk.badge).toBe('🟢 안전')
    expect(risk.reason).toBeUndefined()
  })

  it('빈 문자열도 safe로 처리된다 (regression: empty defaults)', () => {
    const risk = getCommandRiskLevel('')
    expect(risk.level).toBe('safe')
    expect(risk.badge).toBe('🟢 안전')
  })

  it('danger > caution 우선순위 — 멀티라인에서 danger 줄이 있으면 danger 반환', () => {
    const risk = getCommandRiskLevel('ls -la\nrm -rf /')
    expect(risk.level).toBe('danger')
    expect(risk.badge).toBe('🔴 차단')
  })
})

describe('filterSafeActions — 안전 명령만 통과', () => {
  it('safe만 남기고 caution/danger는 제외한다', () => {
    const actions = [
      { command: 'df -h',    riskLevel: 'safe'    as const, description: '' },
      { command: 'rm -rf /', riskLevel: 'danger'  as const, description: '' },
      { command: 'free -h',  riskLevel: 'safe'    as const, description: '' },
      { command: 'kill 1',   riskLevel: 'caution' as const, description: '' },
    ]
    const safe = filterSafeActions(actions)
    expect(safe).toHaveLength(2)
    expect(safe.map(a => a.command)).toEqual(['df -h', 'free -h'])
  })

  it('빈 배열은 빈 배열을 반환한다', () => {
    expect(filterSafeActions([])).toEqual([])
  })

  it('모든 명령이 위험하면 빈 배열을 반환한다', () => {
    const actions = [
      { command: 'rm -rf /',   riskLevel: 'danger'  as const },
      { command: 'iptables -F',riskLevel: 'caution' as const },
    ]
    expect(filterSafeActions(actions)).toEqual([])
  })
})
