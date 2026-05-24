/**
 * LogPilotPermModal — 권한/파일종류 사전 체크 실패 시 가이드 모달.
 *
 * 화면 분기 (fileType + readable 조합):
 *  - directory  → "디렉토리 안내" 패널: `journalctl -xe` 명령으로 분석 권장
 *  - missing    → "파일 없음" 패널: 경로 확인 안내
 *  - file + 권한없음 → 기존 권한 거부 패널 (3 옵션 + 진단)
 *
 * 공통 진단 — SSH 인증 사용자(UID/USER) 노출. 인터랙티브 셸의 sudo 전환이 exec 채널에는 적용되지 않음을 명시.
 *
 * "그래도 분석 시도" 버튼 — 사용자가 명시적으로 force run 요청 시 분석 흐름 계속.
 *
 * stat 파싱: `stat -c '%s %a %U %G'` 출력 — "size mode owner group" 공백 4토큰.
 */

import { useMemo } from 'react'
import { shellQuoteSingle, type SshReadableCheck } from '@bridge/ipcBridge'

interface LogPilotPermModalProps {
  targetPath: string
  check: SshReadableCheck | null
  loading: boolean
  /** 사용자가 "다른 파일 선택" 클릭 시 호출 — 호스트가 프리셋 패널을 열도록. */
  onPickAnother: () => void
  /** 사용자가 "그래도 분석 시도" 클릭 — force run. */
  onForceProceed: () => void
  /** 모달 닫기만 (취소). */
  onCancel: () => void
  /** SSH 터미널로 명령 보내기 — Run 버튼이 사용. */
  onRunCommand?: (command: string) => void
  /** 디렉토리 안내 패널의 "이 명령으로 분석" 버튼 — 호스트가 path를 명령으로 교체 + 분석 시작. */
  onSwitchPathAndRun?: (command: string) => void
  sshConnected: boolean
}

interface StatInfo {
  size?: string
  mode?: string
  owner?: string
  group?: string
}

function parseStat(stat: string | undefined): StatInfo {
  if (!stat) return {}
  const parts = stat.trim().split(/\s+/)
  if (parts.length < 4) return {}
  return { size: parts[0], mode: parts[1], owner: parts[2], group: parts[3] }
}

function formatSize(sizeStr: string | undefined): string {
  if (!sizeStr) return ''
  const n = parseInt(sizeStr, 10)
  if (!Number.isFinite(n)) return sizeStr
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function LogPilotPermModal({
  targetPath,
  check,
  loading,
  onPickAnother,
  onForceProceed,
  onCancel,
  onRunCommand,
  onSwitchPathAndRun,
  sshConnected,
}: LogPilotPermModalProps) {
  const stat = useMemo(() => parseStat(check?.stat), [check?.stat])

  const groupAddCmd = 'sudo usermod -aG adm $USER'
  // path는 bash 단일따옴표로 wrap — $/backtick 변수 확장 방지 (보안 일관성, ipcBridge.checkReadable와 동일 패턴)
  const quotedPath = shellQuoteSingle(targetPath)
  const tempCopyCmd = `sudo cat ${quotedPath} | tail -n 5000 > ~/$(basename ${quotedPath})_copy.log`
  // sudo + tail로 즉시 분석 가능한 형태로 LogPilot 입력에 채울 명령 — onSwitchPathAndRun 경로용
  const sudoTailCmd = `sudo tail -n 1000 ${quotedPath}`

  // ── 화면 분기: 디렉토리 / missing / 파일+권한없음 ─────────────────
  const fileType = check?.fileType
  const username = check?.username
  const uid = check?.uid
  const sudoAvailable = check?.sudoAvailable

  const isDirectory = fileType === 'directory' && !check?.readable
  const isMissing = fileType === 'missing'

  // 헤더 메타 (이번 케이스 → 표시 텍스트)
  const headerTitle = isDirectory ? '이 경로는 디렉토리입니다'
                    : isMissing  ? '경로를 찾을 수 없습니다'
                    : '파일을 읽을 수 없습니다'
  const headerIcon  = isDirectory ? '📁' : isMissing ? '❓' : '🚫'

  // 디렉토리 케이스의 추천 명령 — /var/log/journal → journalctl
  const suggestedCmd = (() => {
    if (!isDirectory) return null
    if (/journal/.test(targetPath)) return 'journalctl -xe --no-pager -n 1000'
    // 일반 디렉토리는 첫 .log 파일 찾기 안내
    return `ls -la ${quotedPath} | head -20`
  })()

  return (
    <div className="logpilot-modal-backdrop" onClick={onCancel}>
      <div className="logpilot-modal" onClick={e => e.stopPropagation()}>
        <div className="logpilot-modal-header">
          <span className="logpilot-modal-icon">{headerIcon}</span>
          <div className="logpilot-modal-title-block">
            <div className="logpilot-modal-title">{headerTitle}</div>
            <div className="logpilot-modal-target mono">{targetPath}</div>
          </div>
          <button
            type="button"
            className="logpilot-modal-close"
            onClick={onCancel}
            title="닫기"
          >
            ✕
          </button>
        </div>

        <div className="logpilot-modal-body">
          {loading && <div className="logpilot-modal-loading">권한 확인 중...</div>}

          {!loading && (
            <>
              {/* 공통 진단 — SSH 인증 사용자 정보 */}
              {(username || uid !== undefined) && (
                <div className="logpilot-modal-diag">
                  <strong>🆔 SSH 인증 사용자:</strong>{' '}
                  <span className="mono">{username ?? '?'}</span>
                  {uid !== undefined && <span className="mono"> (UID {uid})</span>}
                  {uid !== 0 && (
                    <div className="logpilot-modal-diag-note">
                      ⚠ <strong>인터랙티브 터미널의 sudo 전환은 별도 명령 채널에 적용되지 않습니다.</strong>
                      LogPilot은 SSH 접속 시 인증된 계정으로 명령을 실행합니다.
                    </div>
                  )}
                </div>
              )}

              {/* 디렉토리 안내 */}
              {isDirectory && (
                <>
                  <div className="logpilot-modal-section">
                    <strong>진단:</strong> 이 경로는 일반 파일이 아니라 <strong>디렉토리</strong>입니다.
                    LogPilot의 logcheck 분석은 단일 로그 파일을 대상으로 합니다.
                  </div>
                  {suggestedCmd && (
                    <div className="logpilot-modal-option logpilot-modal-option-recommend">
                      <div className="logpilot-modal-option-header">
                        <span>✨ 권장: 명령으로 분석하기</span>
                        {onSwitchPathAndRun && sshConnected && (
                          <button
                            type="button"
                            className="logpilot-btn logpilot-btn-run"
                            onClick={() => onSwitchPathAndRun(suggestedCmd)}
                          >
                            ▶ 이 명령으로 분석
                          </button>
                        )}
                      </div>
                      <div className="logpilot-modal-option-desc">
                        <strong>이 명령은:</strong>{' '}
                        {/journal/.test(targetPath)
                          ? 'systemd 통합 로그를 페이저 없이 최근 1000줄 가져옵니다. LogPilot이 명령 결과를 분석합니다.'
                          : '디렉토리 내용을 나열합니다. 실제 분석할 .log 파일을 골라 다시 시도하세요.'}
                      </div>
                      <pre className="logpilot-modal-code mono">{suggestedCmd}</pre>
                    </div>
                  )}
                  <div className="logpilot-modal-option">
                    <div className="logpilot-modal-option-header">
                      <span>또는 다른 로그 파일 선택</span>
                      <button type="button" className="logpilot-link-btn" onClick={onPickAnother}>
                        자주 쓰는 로그에서 고르기 →
                      </button>
                    </div>
                  </div>
                </>
              )}

              {/* Missing 안내 */}
              {isMissing && (
                <>
                  <div className="logpilot-modal-section">
                    <strong>진단:</strong> 입력하신 경로에 파일이나 디렉토리가 존재하지 않습니다. 오타·경로 확인이 필요합니다.
                  </div>
                  <div className="logpilot-modal-option">
                    <div className="logpilot-modal-option-header">
                      <span>다른 로그 파일 선택</span>
                      <button type="button" className="logpilot-link-btn" onClick={onPickAnother}>
                        자주 쓰는 로그에서 고르기 →
                      </button>
                    </div>
                  </div>
                </>
              )}

              {/* 파일 + 권한 없음 (기존 흐름) */}
              {!isDirectory && !isMissing && (
                <>
                  <div className="logpilot-modal-section">
                    <strong>진단:</strong> 현재 사용자에게 이 파일의 <strong>읽기 권한</strong>이 없습니다.
                  </div>

                  {(stat.size || stat.mode || stat.owner || stat.group) && (
                    <div className="logpilot-modal-stat">
                      <div className="logpilot-modal-stat-label">파일 정보 (서버에서 확인됨)</div>
                      <div className="logpilot-modal-stat-list mono">
                        {stat.size && <div>크기: <strong>{formatSize(stat.size)}</strong></div>}
                        {stat.mode && <div>권한: <strong>{stat.mode}</strong></div>}
                        {stat.owner && stat.group && (
                          <div>소유자: <strong>{stat.owner}:{stat.group}</strong></div>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="logpilot-modal-section">
                    <strong>해결 방법 (선택)</strong>
                  </div>

                  {/* 옵션 1 — sudo로 즉시 분석 (NOPASSWD 환경 권장) */}
                  {sudoAvailable !== false && onSwitchPathAndRun && sshConnected && (
                    <div className="logpilot-modal-option logpilot-modal-option-recommend">
                      <div className="logpilot-modal-option-header">
                        <span>① sudo로 즉시 분석 {sudoAvailable === true ? '(권장 · NOPASSWD 확인됨)' : '(sudo 비밀번호 필요할 수 있음)'}</span>
                        <button
                          type="button"
                          className="logpilot-btn logpilot-btn-run"
                          onClick={() => onSwitchPathAndRun(sudoTailCmd)}
                        >
                          ▶ sudo로 분석
                        </button>
                      </div>
                      <div className="logpilot-modal-option-desc">
                        <strong>이 명령은:</strong> sudo로 마지막 1000줄을 읽어 LogPilot이 분석합니다.
                        {sudoAvailable === true
                          ? ' NOPASSWD sudo가 확인되어 즉시 실행됩니다.'
                          : ' sudo 비밀번호가 필요한 환경이면 실패할 수 있습니다 — 그땐 옵션 ②/③을 사용하세요.'}
                      </div>
                      <pre className="logpilot-modal-code mono">{sudoTailCmd}</pre>
                    </div>
                  )}

                  {/* 옵션 2 — adm 그룹 추가 */}
                  <div className="logpilot-modal-option">
                    <div className="logpilot-modal-option-header">
                      <span>② adm 그룹에 사용자 추가 (영구 · 재접속 필요)</span>
                      {onRunCommand && sshConnected && (
                        <button
                          type="button"
                          className="logpilot-btn logpilot-btn-run"
                          onClick={() => onRunCommand(groupAddCmd)}
                        >
                          ▶ 실행
                        </button>
                      )}
                    </div>
                    <div className="logpilot-modal-option-desc">
                      <strong>이 명령은:</strong> 현재 사용자를 adm 그룹에 추가합니다. 다시 SSH 접속 후 적용됩니다.
                      <strong> sudo 권한이 필요합니다.</strong>
                    </div>
                    <pre className="logpilot-modal-code mono">{groupAddCmd}</pre>
                  </div>

                  {/* 옵션 3 — sudo로 임시 복사 */}
                  <div className="logpilot-modal-option logpilot-modal-option-caution">
                    <div className="logpilot-modal-option-header">
                      <span>③ sudo로 홈 디렉토리에 복사 (수동 검토용)</span>
                      {onRunCommand && sshConnected && (
                        <button
                          type="button"
                          className="logpilot-btn logpilot-btn-caution"
                          onClick={() => onRunCommand(tempCopyCmd)}
                        >
                          ▶ 실행
                        </button>
                      )}
                    </div>
                    <div className="logpilot-modal-option-desc">
                      <strong>주의:</strong> sudo를 사용하면 비밀번호 입력이 필요할 수 있습니다.
                      홈 디렉토리에 복사 후 그 경로로 LogPilot에서 다시 시도하세요.
                    </div>
                    <pre className="logpilot-modal-code mono">{tempCopyCmd}</pre>
                  </div>

                  {/* 옵션 4 — 다른 파일 */}
                  <div className="logpilot-modal-option">
                    <div className="logpilot-modal-option-header">
                      <span>④ 읽을 수 있는 다른 파일 선택</span>
                      <button
                        type="button"
                        className="logpilot-link-btn"
                        onClick={onPickAnother}
                      >
                        자주 쓰는 로그에서 고르기 →
                      </button>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <div className="logpilot-modal-footer">
          <button
            type="button"
            className="logpilot-btn"
            onClick={onCancel}
          >
            취소
          </button>
          {/* 파일 + 권한없음 케이스만 "그래도 분석 시도" 노출 — 디렉토리/missing은 의미 없음 */}
          {!isDirectory && !isMissing && (
            <button
              type="button"
              className="logpilot-btn logpilot-btn-primary"
              onClick={onForceProceed}
              disabled={loading}
            >
              그래도 분석 시도 (실패 가능)
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
