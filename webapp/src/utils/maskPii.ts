/**
 * 한국 실무 환경 PII/시크릿 마스킹.
 *
 * **중요**: 이 함수는 UI 미리보기·표시 전용. AI 분석 페이로드(payload.content)에는
 * 절대 적용하지 말 것 — 분석 정확도가 즉시 훼손됨.
 *
 * 백엔드 SshAuditLogger.MaskPii와 동일한 패턴 세트로 유지(감사 로그/UI 일관성).
 */

// 키-값 시크릿 (password=, apikey=, token=, secret=, passphrase=, authorization)
const SECRET_PATTERN = /(password|passwd|apikey|api_key|token|secret|passphrase|authorization)\s*[=:'"\s]\s*\S+/gi

// 주민등록번호: 6자리-7자리 (백엔드와 동일하게 성별코드 1~4 한정)
const PII_RRN = /\b\d{6}-?[1-4]\d{6}\b/g

// 카드번호: 4-4-4-4 (구분자 -, 공백, 없음 모두)
const PII_CARD = /\b(?:\d{4}[- ]?){3}\d{4}\b/g

// JWT (eyJ로 시작하는 base64 3섹션)
const PII_JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g

// 이메일
const PII_EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g

// IPv4 (옥텟 0~255)
const PII_IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g

// 사번 키-값 (emp_id=, employee_id=)
// `\b`는 ASCII 워드 경계라 한글 매칭 불가 — 한글 키는 별도 패턴으로 분리
const PII_EMP_KEY = /\b(emp(?:loyee)?_?id)\s*[=:]\s*\S+/gi
const PII_EMP_KEY_KR = /(사번)\s*[=:]\s*\S+/g

function maskEmail(e: string): string {
  const i = e.indexOf('@')
  if (i <= 0) return '***'
  return e[0] + '***' + e.slice(i)
}

function maskIpv4(ip: string): string {
  const p = ip.split('.')
  return p.length === 4 ? `${p[0]}.${p[1]}.*.*` : ip
}

/**
 * 시크릿/PII 일괄 마스킹.
 * 입력 그대로 반환 가능(빈 문자열, null 비슷한 값은 호출자에서 가드).
 */
export function maskPii(s: string): string {
  if (!s) return s
  let out = s.replace(SECRET_PATTERN, (_, key) => `${key}=***`)
  out = out.replace(PII_RRN, '***-*******')
  out = out.replace(PII_CARD, '****-****-****-****')
  out = out.replace(PII_JWT, 'eyJ***')
  out = out.replace(PII_EMAIL, m => maskEmail(m))
  out = out.replace(PII_IPV4, m => maskIpv4(m))
  out = out.replace(PII_EMP_KEY, (_, key) => `${key}=***`)
  out = out.replace(PII_EMP_KEY_KR, (_, key) => `${key}=***`)
  return out
}
