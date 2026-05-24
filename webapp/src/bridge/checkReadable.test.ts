import { describe, it, expect } from 'vitest'
import { parseCheckReadableOutput } from './ipcBridge'

/**
 * parseCheckReadableOutput — `ssh.checkReadable` stdout 파싱 단위 테스트.
 *
 * 입력 라인 종류:
 *  - `OK_READABLE`           : head -c 1 성공
 *  - `UID=<n>`               : id -u 결과 (root는 UID=0)
 *  - `<size> <mode> <user> <group>` : stat 결과
 *
 * 판정 정책: hasOK || isRoot → readable=true.
 */
describe('parseCheckReadableOutput — head + id -u 결합 파싱', () => {
  it('case A — 일반 사용자가 정상적으로 읽을 수 있는 파일 (OK + UID!=0)', () => {
    // `head -c 1` 성공 + 비-root UID + stat 메타
    const stdout = 'OK_READABLE\nUID=1000\n10 644 user user'
    const result = parseCheckReadableOutput(stdout)
    expect(result.readable).toBe(true)
    expect(result.stat).toBe('10 644 user user')
  })

  it('case B — root이지만 head는 실패한 케이스 (UID=0만 폴백 통과)', () => {
    // 예: SELinux/capability quirk로 head -c 1이 실패해도 root는 trust
    const stdout = 'UID=0\n100 640 syslog adm'
    const result = parseCheckReadableOutput(stdout)
    expect(result.readable).toBe(true)
    expect(result.stat).toBe('100 640 syslog adm')
  })

  it('case C — 일반 사용자 + 권한 없는 파일 (둘 다 실패 → readable=false)', () => {
    // head -c 1 실패(OK_READABLE 없음) + 비-root → 모달 표시되어야 함
    const stdout = 'UID=1000\n100 640 syslog adm'
    const result = parseCheckReadableOutput(stdout)
    expect(result.readable).toBe(false)
    expect(result.stat).toBe('100 640 syslog adm')
  })

  it('case D — 빈 응답 (SSH 미연결/완전 실패)', () => {
    // 권한 모달이 빈 stat과 readable=false로 떠야 함
    const result = parseCheckReadableOutput('')
    expect(result.readable).toBe(false)
    expect(result.stat).toBe('')
  })

  it('null 입력에도 안전하게 동작 (readable=false, stat="")', () => {
    // 방어 코드 — invoke가 output: null을 반환하는 케이스
    const result = parseCheckReadableOutput(null)
    expect(result.readable).toBe(false)
    expect(result.stat).toBe('')
  })

  it('OK_READABLE + UID=0 동시 존재 (root이고 head도 성공)', () => {
    // 일반적인 root 케이스 — 둘 다 통과
    const stdout = 'OK_READABLE\nUID=0\n100 640 syslog adm'
    const result = parseCheckReadableOutput(stdout)
    expect(result.readable).toBe(true)
    expect(result.stat).toBe('100 640 syslog adm')
  })

  it('stat 라인 없이도 readable 판정은 독립적으로 동작', () => {
    // stat 실패해도 head 성공이면 readable=true
    const stdout = 'OK_READABLE\nUID=1000'
    const result = parseCheckReadableOutput(stdout)
    expect(result.readable).toBe(true)
    expect(result.stat).toBe('')
  })

  // ─── Fix 1+2+3 신규 (v0.4.x): username/fileType/sudoAvailable 수집 ───
  it('case E — USER=admin 사용자 이름 추출', () => {
    // SSH exec channel의 인증된 사용자 — 인터랙티브 sudo 전환과 무관함을 진단용으로 노출
    const stdout = 'TYPE=file\nUID=1000\nUSER=admin\n100 644 admin admin'
    const result = parseCheckReadableOutput(stdout)
    expect(result.username).toBe('admin')
    expect(result.uid).toBe(1000)
  })

  it('case F — 디렉토리 경로 감지 (fileType=directory, readable=false)', () => {
    // /var/log/journal 같은 디렉토리 — head -c 1 실패 + UID!=0 → readable=false
    // 모달에서 별도 "디렉토리 안내" UI로 분기
    const stdout = 'TYPE=directory\nUID=1000\nUSER=admin\n4096 755 root root'
    const result = parseCheckReadableOutput(stdout)
    expect(result.fileType).toBe('directory')
    expect(result.readable).toBe(false)
  })

  it('case G — 파일 없음 감지 (fileType=missing)', () => {
    const stdout = 'TYPE=missing\nUID=1000\nUSER=admin'
    const result = parseCheckReadableOutput(stdout)
    expect(result.fileType).toBe('missing')
    expect(result.readable).toBe(false)
    expect(result.stat).toBe('')
  })

  it('case H — sudo NOPASSWD 가용성 감지', () => {
    // sudo -n true 성공 → 모달에 sudo 승급 옵션 제공
    const stdout = 'TYPE=file\nUID=1000\nUSER=admin\nSUDO_NOPASSWD\n100 640 root root'
    const result = parseCheckReadableOutput(stdout)
    expect(result.sudoAvailable).toBe(true)
    expect(result.stat).toBe('100 640 root root')
  })

  it('case I — sudo 없음 (sudoAvailable=false 또는 undefined)', () => {
    const stdout = 'TYPE=file\nUID=1000\nUSER=admin\n100 640 root root'
    const result = parseCheckReadableOutput(stdout)
    expect(result.sudoAvailable).toBeFalsy()
  })

  it('case J — 디렉토리 + root (fileType=directory지만 readable=true via UID=0)', () => {
    // root는 디렉토리 read 가능. 모달이 디렉토리 안내로 분기해서 다른 처리 권장.
    const stdout = 'TYPE=directory\nUID=0\nUSER=root\n4096 755 root root'
    const result = parseCheckReadableOutput(stdout)
    expect(result.fileType).toBe('directory')
    expect(result.readable).toBe(true)  // root는 디렉토리도 통과
    expect(result.uid).toBe(0)
  })
})
