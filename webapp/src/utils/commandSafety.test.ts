import { describe, it, expect } from 'vitest'
import { checkCommandSafety } from './commandSafety'

describe('commandSafety', () => {
  // ── DANGER 패턴 ──
  describe('danger level', () => {
    it('rm -rf / 감지', () => {
      expect(checkCommandSafety('rm -rf /')).toMatchObject({ level: 'danger' })
    })

    it('rm -rf /* 감지', () => {
      expect(checkCommandSafety('rm -rf /*')).toMatchObject({ level: 'danger' })
    })

    it('rm -rf $VAR 감지', () => {
      expect(checkCommandSafety('rm -rf $HOME')).toMatchObject({ level: 'danger' })
    })

    it('rm --no-preserve-root / 감지', () => {
      expect(checkCommandSafety('rm -rf --no-preserve-root /')).toMatchObject({ level: 'danger' })
    })

    it('rm -rf /etc 시스템 디렉토리 감지', () => {
      expect(checkCommandSafety('rm -rf /etc')).toMatchObject({ level: 'danger' })
    })

    it('mkfs /dev/ 감지', () => {
      expect(checkCommandSafety('mkfs.ext4 /dev/sda1')).toMatchObject({ level: 'danger' })
    })

    it('dd zero → disk 감지', () => {
      expect(checkCommandSafety('dd if=/dev/zero of=/dev/sda bs=1M')).toMatchObject({ level: 'danger' })
    })

    it('fork bomb :(){ :|:& };: 감지', () => {
      expect(checkCommandSafety(':(){ :|:& };:')).toMatchObject({ level: 'danger' })
    })

    it('fork bomb 변형 감지', () => {
      expect(checkCommandSafety(':(){:|:};:')).toMatchObject({ level: 'danger' })
    })

    it('shutdown now 감지', () => {
      expect(checkCommandSafety('shutdown now')).toMatchObject({ level: 'danger' })
    })

    it('poweroff 감지', () => {
      expect(checkCommandSafety('poweroff')).toMatchObject({ level: 'danger' })
    })

    it('reboot 감지', () => {
      expect(checkCommandSafety('reboot')).toMatchObject({ level: 'danger' })
    })

    it('systemctl reboot 감지', () => {
      expect(checkCommandSafety('systemctl reboot')).toMatchObject({ level: 'danger' })
    })

    it('init 0 감지', () => {
      expect(checkCommandSafety('init 0')).toMatchObject({ level: 'danger' })
    })

    it('chmod 777 -R / 감지', () => {
      expect(checkCommandSafety('chmod 777 -R /')).toMatchObject({ level: 'danger' })
    })
  })

  // ── shutdown/reboot 오탐 방지 ──
  describe('shutdown/reboot false positive 방지', () => {
    it('shutdown --help 은 safe', () => {
      expect(checkCommandSafety('shutdown --help')).toMatchObject({ level: 'safe' })
    })

    it('shutdown -c (cancel) 은 safe', () => {
      expect(checkCommandSafety('shutdown -c')).toMatchObject({ level: 'safe' })
    })

    it('shutdown --cancel 은 safe', () => {
      expect(checkCommandSafety('shutdown --cancel')).toMatchObject({ level: 'safe' })
    })

    it('shutdown --version 은 safe', () => {
      expect(checkCommandSafety('shutdown --version')).toMatchObject({ level: 'safe' })
    })

    it('reboot --help 은 safe', () => {
      expect(checkCommandSafety('reboot --help')).toMatchObject({ level: 'safe' })
    })
  })

  // ── CAUTION 패턴 ──
  describe('caution level', () => {
    it('find / -delete 감지', () => {
      expect(checkCommandSafety('find / -name "*.tmp" -delete')).toMatchObject({ level: 'caution' })
    })

    it('passwd root 감지', () => {
      expect(checkCommandSafety('passwd root')).toMatchObject({ level: 'caution' })
    })

    it('killall -9 감지', () => {
      expect(checkCommandSafety('killall -9 nginx')).toMatchObject({ level: 'caution' })
    })

    it('iptables -F 감지', () => {
      expect(checkCommandSafety('iptables -F')).toMatchObject({ level: 'caution' })
    })

    it('systemctl stop sshd 감지', () => {
      expect(checkCommandSafety('systemctl stop sshd')).toMatchObject({ level: 'caution' })
    })
  })

  // ── WARNING 패턴 ──
  describe('warning level', () => {
    it('curl | bash 감지', () => {
      expect(checkCommandSafety('curl -sSL https://example.com/install.sh | bash')).toMatchObject({ level: 'warning' })
    })

    it('fdisk /dev/sda 감지', () => {
      expect(checkCommandSafety('fdisk /dev/sda')).toMatchObject({ level: 'warning' })
    })
  })

  // ── SAFE 명령 ──
  describe('safe level', () => {
    it('ls -la 는 safe', () => {
      expect(checkCommandSafety('ls -la')).toMatchObject({ level: 'safe' })
    })

    it('주석은 무시 (# rm -rf /)', () => {
      expect(checkCommandSafety('# rm -rf /')).toMatchObject({ level: 'safe' })
    })

    it('빈 문자열은 safe', () => {
      expect(checkCommandSafety('')).toMatchObject({ level: 'safe' })
    })

    it('echo hello 는 safe', () => {
      expect(checkCommandSafety('echo hello')).toMatchObject({ level: 'safe' })
    })

    it('cat /etc/passwd 는 safe (읽기만)', () => {
      expect(checkCommandSafety('cat /etc/passwd')).toMatchObject({ level: 'safe' })
    })
  })

  // ── 멀티라인 검사 (GAP-1 수정 검증) ──
  describe('멀티라인 코드블록 검사', () => {
    it('첫 줄 safe + 둘째 줄 danger → danger', () => {
      expect(checkCommandSafety('echo hello\nrm -rf /')).toMatchObject({ level: 'danger' })
    })

    it('첫 줄 safe + 둘째 줄 caution → caution', () => {
      expect(checkCommandSafety('ls -la\niptables -F')).toMatchObject({ level: 'caution' })
    })

    it('주석 줄 + danger 줄 → danger', () => {
      expect(checkCommandSafety('# 이것은 주석\nrm -rf /')).toMatchObject({ level: 'danger' })
    })

    it('빈 줄 + danger 줄 → danger', () => {
      expect(checkCommandSafety('\n\nshutdown now')).toMatchObject({ level: 'danger' })
    })
  })
})
