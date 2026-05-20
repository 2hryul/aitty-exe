import { describe, it, expect } from 'vitest'
import {
  buildSummaryRequest,
  buildSearchRequest,
  buildRecentRequest,
  buildRangeRequest,
  buildTopRequest,
  fromDateTimeLocal,
  toDateTimeLocal,
  modeLabel,
} from './logCheckRequest'

describe('logCheckRequest builders', () => {
  describe('경로 검증', () => {
    it('빈 경로 거절', () => {
      expect(() => buildSummaryRequest('')).toThrow(/경로를 입력/)
      expect(() => buildSummaryRequest('   ')).toThrow(/경로를 입력/)
    })
    it('상대 경로 거절', () => {
      expect(() => buildSummaryRequest('var/log/syslog')).toThrow(/절대 경로/)
    })
    it('".." 포함 거절', () => {
      expect(() => buildSummaryRequest('/var/../etc/passwd')).toThrow(/상대 경로/)
    })
    it('NUL 문자 거절', () => {
      expect(() => buildSummaryRequest('/var/log/\0evil')).toThrow(/NUL/)
    })
    it('정상 경로 통과 + trim', () => {
      const r = buildSummaryRequest('  /var/log/syslog  ')
      expect(r.path).toBe('/var/log/syslog')
      expect(r.mode).toBe('summary')
    })
  })

  describe('summary', () => {
    it('mode=summary 외 필드 미설정', () => {
      const r = buildSummaryRequest('/var/log/syslog')
      expect(r).toEqual({ path: '/var/log/syslog', mode: 'summary' })
    })
  })

  describe('search', () => {
    it('패턴 비어있으면 거절', () => {
      expect(() => buildSearchRequest('/x', { pattern: '' })).toThrow(/패턴을 입력/)
    })
    it('정상 패턴 + ignoreCase + 컨텍스트', () => {
      const r = buildSearchRequest('/var/log/syslog', {
        pattern: 'OutOfMemory',
        ignoreCase: true,
        ctxAfter: 5,
        ctxBefore: 2,
      })
      expect(r).toEqual({
        path: '/var/log/syslog',
        mode: 'search',
        pattern: 'OutOfMemory',
        ignoreCase: true,
        ctxAfter: 5,
        ctxBefore: 2,
      })
    })
    it('컨텍스트 0이면 필드 생략 (백엔드 기본 동작 그대로)', () => {
      const r = buildSearchRequest('/x', { pattern: 'ERROR', ctxAfter: 0, ctxBefore: 0 })
      expect(r.ctxAfter).toBeUndefined()
      expect(r.ctxBefore).toBeUndefined()
    })
    it('컨텍스트 51 거절', () => {
      expect(() =>
        buildSearchRequest('/x', { pattern: 'p', ctxAfter: 51 })
      ).toThrow(/0~50/)
    })
    it('패턴 1025자 거절', () => {
      expect(() =>
        buildSearchRequest('/x', { pattern: 'a'.repeat(1025) })
      ).toThrow(/너무 깁니다/)
    })
  })

  describe('recent', () => {
    it('1시간 통과', () => {
      const r = buildRecentRequest('/x', { hours: 1 })
      expect(r).toEqual({ path: '/x', mode: 'recent', hours: 1 })
    })
    it('720 통과 (30일)', () => {
      const r = buildRecentRequest('/x', { hours: 720 })
      expect(r.hours).toBe(720)
    })
    it('0 거절', () => {
      expect(() => buildRecentRequest('/x', { hours: 0 })).toThrow(/1~720/)
    })
    it('721 거절', () => {
      expect(() => buildRecentRequest('/x', { hours: 721 })).toThrow(/1~720/)
    })
    it('소수 거절', () => {
      expect(() => buildRecentRequest('/x', { hours: 1.5 })).toThrow(/정수/)
    })
  })

  describe('range', () => {
    it('정상 FROM/TO', () => {
      const r = buildRangeRequest('/x', {
        from: '2026-04-27 12:00:00',
        to:   '2026-04-27 13:00:00',
      })
      expect(r.mode).toBe('range')
      expect(r.from).toBe('2026-04-27 12:00:00')
    })
    it('형식 오류 거절', () => {
      expect(() =>
        buildRangeRequest('/x', { from: '2026-04-27', to: '2026-04-27 13:00:00' })
      ).toThrow(/형식/)
    })
    it('역순 거절 (FROM > TO)', () => {
      expect(() =>
        buildRangeRequest('/x', {
          from: '2026-04-27 13:00:00',
          to:   '2026-04-27 12:00:00',
        })
      ).toThrow(/이후일 수 없/)
    })
  })

  describe('top', () => {
    it('기본 10', () => {
      const r = buildTopRequest('/x', { topN: 10 })
      expect(r.topN).toBe(10)
    })
    it('100 통과', () => {
      const r = buildTopRequest('/x', { topN: 100 })
      expect(r.topN).toBe(100)
    })
    it('0 거절', () => {
      expect(() => buildTopRequest('/x', { topN: 0 })).toThrow(/1~100/)
    })
    it('101 거절', () => {
      expect(() => buildTopRequest('/x', { topN: 101 })).toThrow(/1~100/)
    })
  })

  describe('datetime-local 변환', () => {
    it('fromDateTimeLocal 분단위 → 초 0 패딩', () => {
      expect(fromDateTimeLocal('2026-04-27T12:34')).toBe('2026-04-27 12:34:00')
    })
    it('fromDateTimeLocal 초 포함', () => {
      expect(fromDateTimeLocal('2026-04-27T12:34:56')).toBe('2026-04-27 12:34:56')
    })
    it('잘못된 입력 throw', () => {
      expect(() => fromDateTimeLocal('invalid')).toThrow()
    })
    it('toDateTimeLocal 분 단위 0 패딩', () => {
      const d = new Date(2026, 3, 27, 5, 7) // April = month 3, 05:07
      expect(toDateTimeLocal(d)).toBe('2026-04-27T05:07')
    })
  })

  describe('modeLabel', () => {
    it('5개 모드 모두 매핑', () => {
      expect(modeLabel('summary')).toBe('요약')
      expect(modeLabel('search')).toBe('패턴 검색')
      expect(modeLabel('recent')).toBe('최근 시간')
      expect(modeLabel('range')).toBe('기간 설정')
      expect(modeLabel('top')).toBe('빈출 패턴')
    })
  })
})
