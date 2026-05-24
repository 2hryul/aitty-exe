/**
 * LogPilotScenarioGrid — 6개 시나리오 진입점 (Step D: 카드 → 칩 디자인 교체).
 *
 * 파일/컴포넌트명 + props 인터페이스 유지 (호출부 변경 비용 회피).
 * 내부 JSX만 가로 wrap 칩으로 교체.
 *
 * 동작:
 *  - 칩 클릭 → 즉시 onPick(key) (Flag DD-D — 자연어 textarea 입력 무시)
 *  - 추천 칩(checkup, 미선택 상태) → 강조 표시
 *  - 선택된 칩 → border-color + 배경 색상 변경
 */

import { LOGPILOT_SCENARIO_LIST, type LogPilotScenario, type LogPilotScenarioKey } from '@utils/logpilotScenarios'

interface LogPilotScenarioGridProps {
  selectedKey: LogPilotScenarioKey | null
  onPick: (key: LogPilotScenarioKey) => void
}

export function LogPilotScenarioGrid({ selectedKey, onPick }: LogPilotScenarioGridProps) {
  return (
    <div className="logpilot-scenario-chips-row">
      {LOGPILOT_SCENARIO_LIST.map((s: LogPilotScenario) => {
        const isSelected = selectedKey === s.key
        const isRecommended = s.key === 'checkup' && selectedKey === null
        const cls = [
          'logpilot-scenario-chip',
          isSelected ? 'selected' : '',
          isRecommended ? 'recommended' : '',
        ].filter(Boolean).join(' ')
        return (
          <button
            key={s.key}
            type="button"
            className={cls}
            onClick={() => onPick(s.key)}
            aria-pressed={isSelected}
            title={s.detail}
          >
            <span className="logpilot-scenario-chip-icon">{s.icon}</span>
            <span className="logpilot-scenario-chip-title">{s.title}</span>
            {isRecommended && (
              <span className="logpilot-scenario-chip-badge">추천</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
