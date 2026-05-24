/**
 * LogPilot 위험도 뱃지 매핑 — 기존 commandSafety 4단계를 LogPilot UI의 3단계로 축약.
 *
 *  - danger             → 'danger'  (Run 버튼 비활성화 + "차단됨" 표시)
 *  - caution            → 'caution' (Run 시 확인 모달 1회)
 *  - warning            → 'caution' (Run 시 인라인 경고 — LogPilot에서는 caution과 같은 모달 처리)
 *  - safe / 매치 없음   → 'safe'    (읽기 전용, Run 즉시 가능)
 *
 * v2에서 warning vs caution UX 분리 가능. 현재는 LogPilot 단순성 우선.
 */

import { checkCommandSafety, type SafetyResult } from '@utils/commandSafety'

export type LogPilotRiskLevel = 'safe' | 'caution' | 'danger'

/**
 * 일괄 실행 후보 — 'safe' 레벨만 통과시킴.
 * ParsedAction을 직접 받는 대신 `{ riskLevel }` 형태를 제너릭으로 받아
 * logpilotResponseParser와의 순환 import 회피.
 */
export function filterSafeActions<T extends { riskLevel: LogPilotRiskLevel }>(actions: T[]): T[] {
  if (!actions || actions.length === 0) return []
  return actions.filter(a => a.riskLevel === 'safe')
}

export interface LogPilotRisk {
  level: LogPilotRiskLevel
  /** 위험도 뱃지 텍스트 — UI에서 그대로 노출. */
  badge: string
  /** 사용자에게 보여줄 위험 사유 (없으면 undefined). */
  reason?: string
  /** 권고되는 안전한 대안 명령 (없으면 undefined). */
  alternative?: string
}

const BADGES: Record<LogPilotRiskLevel, string> = {
  safe:    '🟢 안전',
  caution: '🟡 주의',
  danger:  '🔴 차단',
}

/**
 * commandSafety 결과를 LogPilot 3단계 위험도로 변환.
 * "danger 매치 시" 우선순위가 가장 높으므로 다른 카테고리 검사를 생략 — checkCommandSafety가 이미 처리.
 */
export function getCommandRiskLevel(code: string): LogPilotRisk {
  const result: SafetyResult = checkCommandSafety(code)

  switch (result.level) {
    case 'danger':
      return {
        level: 'danger',
        badge: BADGES.danger,
        reason: result.reason,
        alternative: result.alternative,
      }
    case 'caution':
    case 'warning':
      // 두 카테고리 모두 LogPilot에서는 'caution'으로 합쳐 모달 1회 확인 패턴 적용.
      return {
        level: 'caution',
        badge: BADGES.caution,
        reason: result.reason,
        alternative: result.alternative,
      }
    case 'safe':
    default:
      return {
        level: 'safe',
        badge: BADGES.safe,
      }
  }
}
