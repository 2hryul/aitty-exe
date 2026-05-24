/**
 * posixPath 단위 테스트 (DF-4) — 8 케이스 필수 커버리지.
 * 절대/상대/`..`/`.`/`~`/끝슬래시/멀티슬래시 + join 동작.
 */

import { describe, it, expect } from 'vitest'
import { normalize, join, expandTilde } from './posixPath'

describe('posixPath.normalize', () => {
  it('절대 경로 — 다중 슬래시 단일화 + 끝 슬래시 제거', () => {
    expect(normalize('//var//log///')).toBe('/var/log')
    expect(normalize('/var/log/')).toBe('/var/log')
    expect(normalize('/')).toBe('/')
  })

  it('`.` 세그먼트 제거', () => {
    expect(normalize('/var/./log/./.')).toBe('/var/log')
    expect(normalize('./a/./b')).toBe('a/b')
  })

  it('`..` resolve — 절대 경로는 root 넘지 못함', () => {
    expect(normalize('/var/log/../tmp')).toBe('/var/tmp')
    expect(normalize('/../..')).toBe('/')
    expect(normalize('/a/b/../../../c')).toBe('/c')
  })

  it('`..` resolve — 상대 경로는 `..` 유지', () => {
    expect(normalize('a/b/../c')).toBe('a/c')
    expect(normalize('../a')).toBe('../a')
    expect(normalize('a/../../b')).toBe('../b')
  })

  it('빈 입력은 `.` 반환', () => {
    expect(normalize('')).toBe('.')
  })
})

describe('posixPath.join', () => {
  it('상대 sub를 base에 결합', () => {
    expect(join('/home/admin', 'work')).toBe('/home/admin/work')
    expect(join('/home/admin', './work/../docs')).toBe('/home/admin/docs')
  })

  it('절대 sub는 base 무시', () => {
    expect(join('/home/admin', '/etc')).toBe('/etc')
    expect(join('/home/admin', '/var/log/')).toBe('/var/log')
  })

  it('base가 root(`/`)일 때 중복 슬래시 없음', () => {
    expect(join('/', 'etc')).toBe('/etc')
    expect(join('/', '..')).toBe('/')
  })
})

describe('posixPath.expandTilde', () => {
  it('`~` 단독 → home', () => {
    expect(expandTilde('~', '/home/admin')).toBe('/home/admin')
  })

  it('`~/sub` → home + sub', () => {
    expect(expandTilde('~/work', '/home/admin')).toBe('/home/admin/work')
    expect(expandTilde('~/work/../docs', '/home/admin')).toBe('/home/admin/docs')
  })

  it('`~user` 형식은 미지원 — 입력 그대로 반환', () => {
    expect(expandTilde('~root', '/home/admin')).toBe('~root')
  })

  it('home이 비었거나 상대 경로면 입력 그대로 반환', () => {
    expect(expandTilde('~/work', '')).toBe('~/work')
    expect(expandTilde('~/work', 'home/admin')).toBe('~/work')
  })

  it('`~` 시작 아닌 입력은 변형 없음', () => {
    expect(expandTilde('/var/log', '/home/admin')).toBe('/var/log')
    expect(expandTilde('work', '/home/admin')).toBe('work')
  })
})
