export type SafetyLevel = 'safe' | 'warning' | 'caution' | 'danger'

export interface SafetyResult {
  level: SafetyLevel
  reason?: string
  alternative?: string
}

interface DangerPattern {
  pattern: RegExp
  reason: string
  alternative: string
}

// ── 🔴 danger — 즉시 복구 불가 ────────────────────────────────
const DANGER_PATTERNS: DangerPattern[] = [
  // 파일시스템 — 루트/시스템 디렉토리 재귀 삭제
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+\/\s*$/m, reason: '루트 파일시스템 삭제 (rm -rf /)', alternative: 'rm -ri ./target' },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+\/\*/, reason: '루트 하위 전체 삭제 (rm -rf /*)', alternative: 'ls -la ./' },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+\$\w+/, reason: '변수 참조 재귀 삭제 — 변수 오타 시 rm -rf / 동일', alternative: 'echo $VARIABLE 로 먼저 확인' },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+\/(etc|boot|usr|var|sys|proc|dev|root|bin|sbin|lib)\b/, reason: '시스템 디렉토리 재귀 삭제', alternative: 'rm -ri ./target' },

  // 디스크 — 포맷/덮어쓰기
  { pattern: /\bmkfs(\.\w+)?\s+\/dev\//, reason: '디스크 포맷 (mkfs)', alternative: 'lsblk 로 디바이스 구조 확인' },
  { pattern: /\bdd\s+.*if=\/dev\/(zero|random|urandom)\s+.*of=\/dev\/sd/, reason: '디스크 제로필/랜덤 덮어쓰기 (dd)', alternative: 'dd if=image.iso of=/dev/sdX status=progress (파티션 명시)' },
  { pattern: /\bdd\s+.*of=\/dev\/sd[a-z]\b/, reason: '디스크 직접 쓰기 (dd)', alternative: '파티션 단위 /dev/sdX1 명시' },

  // 리다이렉트 — 블록 디바이스 직접 쓰기
  { pattern: />\s*\/dev\/sd[a-z]/, reason: '블록 디바이스에 직접 리다이렉션', alternative: '> output.txt (파일로 리다이렉션)' },

  // 프로세스 — Fork Bomb (`:(){ :|:& };:` 변형 포함)
  { pattern: /:\(\)\s*\{[^}]*:\s*\|\s*:/, reason: 'Fork Bomb — 시스템 마비', alternative: 'ulimit -u 100 (프로세스 수 제한)' },

  // 권한 — 루트 전체 대상
  { pattern: /\bchmod\s+777\s+(-[a-zA-Z]*R|-[a-zA-Z]*R[a-zA-Z]*)\s+\/\s*$/, reason: '전체 파일 권한 777 개방', alternative: 'chmod 755 /specific/dir' },
  { pattern: /\bchmod\s+(-[a-zA-Z]*R|-[a-zA-Z]*R[a-zA-Z]*)\s+777\s+\/\s*$/, reason: '전체 파일 권한 777 개방', alternative: 'chmod 755 /specific/dir' },
  { pattern: /\bchown\s+(-[a-zA-Z]*R|-[a-zA-Z]*R[a-zA-Z]*)\s+\w+\s+\/\s*$/, reason: '루트 전체 소유자 변경', alternative: 'chown -R user /home/user' },
  { pattern: /\bchown\s+\w+\s+(-[a-zA-Z]*R|-[a-zA-Z]*R[a-zA-Z]*)\s+\/\s*$/, reason: '루트 전체 소유자 변경', alternative: 'chown -R user /home/user' },

  // 루트 보호 비활성화 삭제
  { pattern: /\brm\s+.*--no-preserve-root/, reason: '루트 보호 비활성화 삭제 (--no-preserve-root)', alternative: 'rm -ri ./target' },

  // 시스템 종료/재시작 — SSH 원격 연결 영구 차단
  { pattern: /\b(poweroff|halt)\b/, reason: '시스템 종료 — SSH 원격 연결 영구 차단', alternative: '관리자에게 종료 요청 또는 systemctl suspend' },
  { pattern: /\bshutdown\b(?!\s+(-c|--cancel|--help|--version))/, reason: '시스템 종료 — SSH 원격 연결 영구 차단', alternative: '관리자에게 종료 요청' },
  { pattern: /\breboot\b(?!\s+--(help|version))/, reason: '시스템 재시작 — SSH 연결 차단 (재시작 후 수동 재접속 필요)', alternative: '관리자에게 재시작 요청' },
  { pattern: /\bsystemctl\s+(poweroff|halt|reboot)\b/, reason: 'systemctl 시스템 종료/재시작', alternative: '관리자에게 문의' },
  { pattern: /\binit\s+[06]\b/, reason: '런레벨 0(종료)/6(재시작) 전환', alternative: '관리자에게 문의' },
  { pattern: /\btelinit\s+[06]\b/, reason: '런레벨 0(종료)/6(재시작) 전환 (telinit)', alternative: '관리자에게 문의' },
]

// ── 🟠 caution — 시스템에 심각한 영향 ──────────────────────────
const CAUTION_PATTERNS: DangerPattern[] = [
  // 파일시스템
  { pattern: /\bfind\s+\/\s+.*-delete\b/, reason: '루트부터 전체 탐색 삭제', alternative: "find /path -name '*.tmp' -delete (경로/조건 한정)" },
  { pattern: /\bmv\s+\/etc\/(passwd|shadow|group|sudoers)\b/, reason: '핵심 시스템 파일 이동', alternative: 'cp /etc/passwd /etc/passwd.bak (백업 먼저)' },

  // 권한/계정
  { pattern: /\bpasswd\s+root\b/, reason: '루트 패스워드 변경', alternative: 'sudo 정책 강화로 root 직접 접근 차단' },
  { pattern: /\bsudo\s+su\s*(-|$)/, reason: '루트 쉘 전환', alternative: 'sudo command (필요한 명령만 실행)' },
  { pattern: /\buserdel\b/, reason: '사용자 삭제', alternative: 'usermod -L user (계정 잠금)' },

  // 프로세스
  { pattern: /\bkill\s+-9\s+1\b/, reason: 'PID 1 (init/systemd) 강제 종료 — 커널 패닉', alternative: 'systemctl stop service-name' },
  { pattern: /\bkillall\s+-9\b/, reason: '프로세스명 전체 강제 Kill', alternative: 'pgrep name → kill PID (확인 후 종료)' },
  { pattern: /\bkillall\s+\w/, reason: '프로세스 일괄 종료', alternative: 'pgrep name → kill PID' },

  // 네트워크
  { pattern: /\biptables\s+-F\b/, reason: '방화벽 규칙 전체 삭제 — 외부 공격 노출', alternative: 'iptables -L (규칙 확인 먼저)' },
  { pattern: /\bifconfig\s+\w+\s+down\b/, reason: '네트워크 인터페이스 중단 — 원격 연결 끊김', alternative: '콘솔 접근 확보 후 실행' },
  { pattern: /\bip\s+link\s+set\s+\w+\s+down\b/, reason: '네트워크 인터페이스 중단', alternative: '콘솔 접근 확보 후 실행' },
  { pattern: /\bufw\s+disable\b/, reason: '방화벽 비활성화', alternative: 'ufw status (상태 확인 먼저)' },

  // 리다이렉트 — 시스템 파일
  { pattern: />\s*\/etc\/(shadow|passwd|group|sudoers)\b/, reason: '핵심 시스템 파일 덮어쓰기', alternative: 'vipw, visudo 등 전용 도구 사용' },

  // 서비스
  { pattern: /\bsystemctl\s+(stop|disable|mask)\s/, reason: '서비스 중단/비활성화', alternative: 'systemctl status service (상태 확인 먼저)' },
]

// ── 🟡 warning — 잠재적 위험 ───────────────────────────────────
const WARNING_PATTERNS: DangerPattern[] = [
  // 파일시스템
  { pattern: /\bln\s+-s\s+\/\s/, reason: '루트 심링크 생성 — 경로 조작 위험', alternative: '대상 경로 명시적으로 확인' },

  // 디스크
  { pattern: /\bfdisk\s+\/dev\/sd/, reason: '파티션 테이블 편집 — 잘못된 조작 시 부팅 불가', alternative: 'fdisk -l (읽기 전용 확인)' },
  { pattern: /\bparted\s+\/dev\/sd/, reason: '파티션 편집', alternative: 'parted -l (읽기 전용 확인)' },

  // 네트워크 — 원격 스크립트 실행
  { pattern: /\bcurl\s+.*\|\s*(sudo\s+)?(bash|sh|zsh)\b/, reason: '원격 스크립트 검토 없이 실행 — 악성 코드 위험', alternative: 'curl url > script.sh && cat script.sh && bash script.sh' },
  { pattern: /\bwget\s+.*\|\s*(sudo\s+)?(bash|sh|zsh)\b/, reason: '원격 스크립트 검토 없이 실행', alternative: 'wget -O script.sh url && cat script.sh && bash script.sh' },
  { pattern: /\bwget\s+.*-O\s*-\s*\|\s*(sudo\s+)?(bash|sh|zsh)\b/, reason: '원격 스크립트 파이프 실행', alternative: 'wget -O script.sh url && cat script.sh' },
]

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
