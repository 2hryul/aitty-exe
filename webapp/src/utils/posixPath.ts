/**
 * posixPath — POSIX(`/`) 스타일 경로 유틸. SSH 셸 cwd 추적용.
 *
 * 책임:
 *  - `normalize` — `.` 제거, `..` resolve, 다중 `/` 단일화, 끝 슬래시 제거(root 제외)
 *  - `join`     — base(절대 경로) + sub(절대 또는 상대) 결합 후 normalize
 *  - `expandTilde` — `~` 또는 `~/...` → `home` + 나머지
 *
 * 설계 메모:
 *  - 입력은 항상 POSIX 셸 경로(`/`). Windows 경로(`\`)는 본 유틸의 입력으로 들어오지 않음 (SSH 원격은 Linux).
 *  - normalize는 `..`가 root(`/`)를 넘어가도 root에 머무름 (`/../..` → `/`).
 *  - 절대 경로 sub는 base를 무시 (POSIX `cd /abs` 동작과 일치).
 */

/**
 * POSIX 경로를 정규화한다.
 * - 다중 `/` → 단일 `/`
 * - `.` 세그먼트 제거
 * - `..` 세그먼트 resolve (root를 넘어가도 root 유지)
 * - root(`/`) 외엔 끝 슬래시 제거
 * 빈 입력은 `'.'` 반환 (POSIX 관례).
 */
export function normalize(path: string): string {
  if (!path) return '.'
  const isAbsolute = path.startsWith('/')
  const segments = path.split('/').filter(s => s.length > 0 && s !== '.')
  const stack: string[] = []
  for (const seg of segments) {
    if (seg === '..') {
      // 절대 경로면 root 위로 못 올라감. 상대 경로면 `..` 유지(상위 디렉토리 표현).
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop()
      } else if (!isAbsolute) {
        stack.push('..')
      }
      // 절대 + 빈 스택은 root에 머무름 → 아무것도 안 함
    } else {
      stack.push(seg)
    }
  }
  const joined = stack.join('/')
  if (isAbsolute) return '/' + joined
  return joined.length > 0 ? joined : '.'
}

/**
 * base(절대) + sub를 POSIX 규칙으로 결합한 뒤 normalize한다.
 * - sub가 절대(`/...`)면 base 무시, sub 자체를 normalize한 결과 반환
 * - sub가 상대면 `base/sub`로 합친 뒤 normalize
 */
export function join(base: string, sub: string): string {
  if (sub.startsWith('/')) return normalize(sub)
  if (!base.startsWith('/')) {
    // 호출자 계약 위반(base는 절대여야 함). 안전상 normalize만 시도.
    return normalize(base + '/' + sub)
  }
  // base가 root('/')이면 중복 슬래시 방지를 위해 base 그대로 사용
  const sep = base === '/' ? '' : '/'
  return normalize(base + sep + sub)
}

/**
 * `~` 또는 `~/...`를 home + 나머지로 확장한다.
 * - `~` → home
 * - `~/sub` → `home + '/' + sub` (normalize)
 * - 그 외(`~user` 등)는 미지원 — 입력 그대로 반환
 * home이 비어있거나 절대 경로가 아니면 입력 그대로 반환.
 */
export function expandTilde(path: string, home: string): string {
  if (!path.startsWith('~')) return path
  if (!home || !home.startsWith('/')) return path
  if (path === '~') return normalize(home)
  if (path.startsWith('~/')) {
    const rest = path.slice(2)
    return join(home, rest)
  }
  // `~user` 형식 — 미지원 (셸 함수/계정 조회 필요)
  return path
}
