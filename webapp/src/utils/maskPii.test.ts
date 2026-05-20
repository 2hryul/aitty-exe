import { describe, it, expect } from 'vitest'
import { maskPii } from './maskPii'

describe('maskPii', () => {
  describe('빈 입력', () => {
    it('빈 문자열은 그대로 반환', () => {
      expect(maskPii('')).toBe('')
    })
  })

  describe('키-값 시크릿', () => {
    it('password= 형식 마스킹', () => {
      expect(maskPii('password=secret123')).toBe('password=***')
    })
    it('Bearer/authorization 헤더 마스킹', () => {
      expect(maskPii('Authorization: Bearer eyJabc.def.ghi'))
        .toMatch(/authorization=\*\*\*/i)
    })
    it('TOKEN 대문자 매칭', () => {
      expect(maskPii('TOKEN=abc123')).toBe('TOKEN=***')
    })
  })

  describe('주민등록번호', () => {
    it('하이픈 포함 마스킹', () => {
      expect(maskPii('주민번호 800101-1234567 임')).toContain('***-*******')
    })
    it('하이픈 없는 13자리 마스킹', () => {
      expect(maskPii('id=8001011234567')).toContain('***-*******')
    })
    it('성별코드 5는 매칭 안 함 (외국인 코드는 별도 — 보수적으로 1~4만)', () => {
      expect(maskPii('800101-5234567')).toBe('800101-5234567')
    })
  })

  describe('카드번호', () => {
    it('하이픈 구분 마스킹', () => {
      expect(maskPii('카드 1234-5678-9012-3456'))
        .toContain('****-****-****-****')
    })
    it('공백 구분 마스킹', () => {
      expect(maskPii('1234 5678 9012 3456')).toContain('****-****-****-****')
    })
    it('연속 16자리 마스킹', () => {
      expect(maskPii('1234567890123456')).toContain('****-****-****-****')
    })
  })

  describe('JWT', () => {
    it('eyJ로 시작하는 3섹션 토큰 마스킹', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
      // 'Token:' 접두사는 SECRET_PATTERN(token=)에 먼저 잡혀 별도 마스킹됨 → JWT 단독 입력으로 검증
      expect(maskPii(`Header: ${jwt} signed`)).toContain('eyJ***')
      expect(maskPii(`Header: ${jwt} signed`)).not.toContain(jwt)
    })
  })

  describe('이메일', () => {
    it('일반 이메일 마스킹', () => {
      expect(maskPii('user@example.com')).toBe('u***@example.com')
    })
    it('점/플러스 포함 로컬파트', () => {
      expect(maskPii('john.doe+filter@shinhan.com')).toBe('j***@shinhan.com')
    })
  })

  describe('IPv4', () => {
    it('옥텟 마스킹 (앞 2 보존)', () => {
      expect(maskPii('10.0.123.45')).toBe('10.0.*.*')
    })
    it('255 경계값', () => {
      expect(maskPii('255.255.255.255')).toBe('255.255.*.*')
    })
    it('256 같은 비IP 숫자는 매칭 안 함', () => {
      expect(maskPii('256.300.999.0')).toBe('256.300.999.0')
    })
  })

  describe('사번 키-값', () => {
    it('employee_id= 마스킹', () => {
      expect(maskPii('employee_id=12345')).toBe('employee_id=***')
    })
    it('emp_id= 마스킹', () => {
      expect(maskPii('emp_id=A001')).toBe('emp_id=***')
    })
    it('한글 "사번=" 마스킹', () => {
      expect(maskPii('사번=10001234')).toBe('사번=***')
    })
  })

  describe('복합 케이스', () => {
    it('한 줄에 여러 패턴 동시 마스킹', () => {
      const input = 'user u@x.kr from 10.0.5.6 with token=ABC and rrn 800101-1234567'
      const out = maskPii(input)
      expect(out).toContain('u***@x.kr')
      expect(out).toContain('10.0.*.*')
      expect(out).toContain('token=***')
      expect(out).toContain('***-*******')
    })

    it('정상 텍스트는 변형되지 않음', () => {
      const safe = '에러 발생: ConnectionTimeout at handler L42'
      expect(maskPii(safe)).toBe(safe)
    })
  })
})
