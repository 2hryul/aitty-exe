#!/usr/bin/env bash
# ============================================================
#  system_healthcheck.sh
#  Linux 시스템 종합 점검 스크립트 (RHEL/CentOS/Ubuntu 호환)
#  Usage:
#    ./system_healthcheck.sh                    # 일반 실행
#    ./system_healthcheck.sh -q                 # WARN/CRIT만 출력
#    ./system_healthcheck.sh -o report.log      # 파일 저장
#    sudo ./system_healthcheck.sh               # 보안 점검 포함 (root 권장)
#  Exit code: 0=OK, 1=WARN 있음, 2=CRIT 있음
# ============================================================

set -uo pipefail
export LC_ALL=C   # 로케일 차이로 인한 awk 파싱 오류 방지

# ---------- 임계값 (필요시 조정) ----------
CPU_WARN=70 ;  CPU_CRIT=90
MEM_WARN=70 ;  MEM_CRIT=90
DISK_WARN=80;  DISK_CRIT=90
LOAD_WARN_PER_CPU=1.0
LOAD_CRIT_PER_CPU=2.0
LOG_HOURS=1                       # 최근 N시간 로그 검사
LOG_PATTERN="error|fatal|critical|panic|segfault"

# ---------- 인자 처리 ----------
PLAIN=0; OUTPUT=""; QUIET=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        -p|--plain)  PLAIN=1; shift ;;
        -o|--output) OUTPUT="$2"; shift 2 ;;
        -q|--quiet)  QUIET=1; shift ;;
        -h|--help)
            sed -n '3,11p' "$0"; exit 0 ;;
        *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
    esac
done
[[ -n "$OUTPUT" ]] && PLAIN=1

# ---------- 색상 ----------
if [[ $PLAIN -eq 1 ]] || [[ ! -t 1 ]]; then
    C_RESET=""; C_RED=""; C_YEL=""; C_GRN=""; C_BLU=""; C_BOLD=""
else
    C_RESET=$'\e[0m'; C_RED=$'\e[31m'; C_YEL=$'\e[33m'
    C_GRN=$'\e[32m'; C_BLU=$'\e[36m'; C_BOLD=$'\e[1m'
fi

# ---------- 공통 출력 함수 ----------
HOSTNAME_F=$(hostname)
START_TS=$(date '+%Y-%m-%d %H:%M:%S')
declare -i WARN_COUNT=0 CRIT_COUNT=0

out() {
    if [[ -n "$OUTPUT" ]]; then printf '%b\n' "$*" | tee -a "$OUTPUT"
    else printf '%b\n' "$*"; fi
}
section() { out ""; out "${C_BOLD}${C_BLU}═══ $1 ═══${C_RESET}"; }

status() {  # status <OK|WARN|CRIT> <label> <value>
    local level=$1 label=$2 value=$3 color tag
    case $level in
        OK)   color=$C_GRN; tag=" OK ";;
        WARN) color=$C_YEL; tag="WARN"; ((WARN_COUNT++));;
        CRIT) color=$C_RED; tag="CRIT"; ((CRIT_COUNT++));;
    esac
    [[ $QUIET -eq 1 && $level == "OK" ]] && return
    out "  ${color}[${tag}]${C_RESET} ${label}: ${value}"
}
info() { [[ $QUIET -eq 1 ]] && return; out "  ${C_BLU}•${C_RESET} $*"; }

# 부동소수점 비교 (awk 사용)
ge() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a>=b)}'; }

# ============================================================
# 1. 시스템 기본 정보
# ============================================================
check_system_info() {
    section "1. 시스템 기본 정보"
    info "Hostname  : $HOSTNAME_F"
    info "Kernel    : $(uname -sr)"
    if [[ -r /etc/os-release ]]; then
        info "OS        : $(. /etc/os-release && echo "$PRETTY_NAME")"
    fi
    info "Uptime    : $(uptime -p 2>/dev/null || uptime | awk -F'up ' '{print $2}' | awk -F',' '{print $1}')"
    info "현재 시간 : $START_TS"
    info "실행 사용자: $(id -un) (UID=$EUID)"
    [[ $EUID -ne 0 ]] && info "${C_YEL}일부 점검(보안/lastb 등)은 root 권한이 필요합니다${C_RESET}"
}

# ============================================================
# 2. CPU & Load Average
# ============================================================
check_load() {
    section "2. CPU 및 Load Average"
    local cpus load1 load5 load15 lpc
    cpus=$(nproc)
    read -r load1 load5 load15 _ < /proc/loadavg
    info "CPU 코어: ${cpus} / Load: ${load1} (1m) ${load5} (5m) ${load15} (15m)"

    lpc=$(awk -v l="$load1" -v c="$cpus" 'BEGIN{printf "%.2f", l/c}')
    if   ge "$lpc" "$LOAD_CRIT_PER_CPU"; then status CRIT "Load per CPU" "$lpc (>= $LOAD_CRIT_PER_CPU)"
    elif ge "$lpc" "$LOAD_WARN_PER_CPU"; then status WARN "Load per CPU" "$lpc (>= $LOAD_WARN_PER_CPU)"
    else status OK "Load per CPU" "$lpc"
    fi

    # CPU 사용률 (top 1회)
    local cpu_idle cpu_used
    cpu_idle=$(top -bn1 2>/dev/null | awk '/^%Cpu/ {gsub(",",""); for(i=1;i<=NF;i++) if($i ~ /id$/) print $(i-1)}' | head -1)
    if [[ -n "$cpu_idle" ]]; then
        cpu_used=$(awk -v i="$cpu_idle" 'BEGIN{printf "%.1f", 100-i}')
        if   ge "$cpu_used" "$CPU_CRIT"; then status CRIT "CPU 사용률" "${cpu_used}%"
        elif ge "$cpu_used" "$CPU_WARN"; then status WARN "CPU 사용률" "${cpu_used}%"
        else status OK "CPU 사용률" "${cpu_used}%"
        fi
    fi
}

# ============================================================
# 3. 메모리 & Swap
# ============================================================
check_memory() {
    section "3. 메모리 사용량"
    local total used avail pct
    read -r total used avail < <(free -m | awk '/^Mem:/ {print $2, $3, $7}')
    pct=$(awk -v u="$used" -v t="$total" 'BEGIN{printf "%.1f", u*100/t}')
    info "Total: ${total} MB / Used: ${used} MB / Available: ${avail} MB"
    if   ge "$pct" "$MEM_CRIT"; then status CRIT "메모리 사용률" "${pct}%"
    elif ge "$pct" "$MEM_WARN"; then status WARN "메모리 사용률" "${pct}%"
    else status OK "메모리 사용률" "${pct}%"
    fi

    local sw_total sw_used sw_pct
    read -r sw_total sw_used < <(free -m | awk '/^Swap:/ {print $2, $3}')
    if [[ ${sw_total:-0} -gt 0 ]]; then
        sw_pct=$(awk -v u="$sw_used" -v t="$sw_total" 'BEGIN{printf "%.1f", u*100/t}')
        if   ge "$sw_pct" 50; then status WARN "Swap 사용률" "${sw_pct}% (${sw_used}/${sw_total} MB)"
        else status OK "Swap 사용률" "${sw_pct}% (${sw_used}/${sw_total} MB)"
        fi
    else
        info "Swap: 비활성화"
    fi
}

# ============================================================
# 4. 디스크 & inode
# ============================================================
check_disk() {
    section "4. 디스크 및 inode 사용량"
    while read -r _ size used _ pct mount; do
        local p=${pct%%%}
        if   (( p >= DISK_CRIT )); then status CRIT "Disk $mount" "$pct (used $used / $size)"
        elif (( p >= DISK_WARN )); then status WARN "Disk $mount" "$pct (used $used / $size)"
        else status OK "Disk $mount" "$pct (used $used / $size)"
        fi
    done < <(df -hPT 2>/dev/null | awk 'NR>1 && $2 !~ /tmpfs|devtmpfs|squashfs|overlay|udev/ {print $1,$3,$4,$5,$6,$7}')

    while read -r _ ipct mount; do
        local p=${ipct%%%}
        [[ "$p" == "-" || -z "$p" ]] && continue
        if   (( p >= DISK_CRIT )); then status CRIT "Inode $mount" "$ipct"
        elif (( p >= DISK_WARN )); then status WARN "Inode $mount" "$ipct"
        fi
    done < <(df -iPT 2>/dev/null | awk 'NR>1 && $2 !~ /tmpfs|devtmpfs|squashfs|overlay|udev/ {print $1,$6,$7}')
}

# ============================================================
# 5. 네트워크
# ============================================================
check_network() {
    section "5. 네트워크"
    if command -v ss >/dev/null 2>&1; then
        local listen est tw
        listen=$(ss -tnl 2>/dev/null | tail -n +2 | wc -l)
        est=$(ss -tn state established 2>/dev/null | tail -n +2 | wc -l)
        tw=$(ss -tn state time-wait 2>/dev/null | tail -n +2 | wc -l)
        info "리스닝 포트: ${listen} / ESTABLISHED: ${est} / TIME_WAIT: ${tw}"
        if (( tw > 10000 )); then status WARN "TIME_WAIT 과다" "$tw 건 (커널 튜닝 검토)"
        else status OK "TIME_WAIT" "$tw"
        fi
    elif command -v netstat >/dev/null 2>&1; then
        info "리스닝 포트(netstat): $(netstat -tnl 2>/dev/null | tail -n +3 | wc -l)"
    fi

    # 게이트웨이 응답 확인
    local gw
    gw=$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')
    if [[ -n "$gw" ]]; then
        if ping -c 1 -W 2 "$gw" >/dev/null 2>&1; then
            status OK "Gateway($gw)" "응답 정상"
        else
            status CRIT "Gateway($gw)" "응답 없음"
        fi
    fi
}

# ============================================================
# 6. 자원 점유 상위 프로세스
# ============================================================
check_top_processes() {
    section "6. 자원 점유 상위 프로세스"
    if [[ $QUIET -eq 0 ]]; then
        info "[CPU TOP 5]"
        ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu --no-headers 2>/dev/null \
            | head -5 | while read -r line; do out "    $line"; done
        info "[MEM TOP 5]"
        ps -eo pid,user,pcpu,pmem,comm --sort=-pmem --no-headers 2>/dev/null \
            | head -5 | while read -r line; do out "    $line"; done
    fi

    local zombies
    zombies=$(ps -eo stat 2>/dev/null | awk '/^Z/' | wc -l)
    if (( zombies > 0 )); then status WARN "좀비 프로세스" "${zombies}개"
    else status OK "좀비 프로세스" "없음"
    fi
}

# ============================================================
# 7. 시스템 로그 에러 검사
# ============================================================
check_logs() {
    section "7. 시스템 로그 에러 (최근 ${LOG_HOURS}시간)"

    if command -v journalctl >/dev/null 2>&1; then
        local err
        err=$(journalctl --since "${LOG_HOURS} hours ago" -p err --no-pager 2>/dev/null | grep -vc "^-- ")
        if   (( err >= 100 )); then status CRIT "journalctl 에러" "${err}건"
        elif (( err >= 10 ));  then status WARN "journalctl 에러" "${err}건"
        else status OK "journalctl 에러" "${err}건"
        fi
    fi

    for log in /var/log/messages /var/log/syslog; do
        [[ -r "$log" ]] || continue
        local cnt
        cnt=$(tail -n 5000 "$log" 2>/dev/null | grep -icE "$LOG_PATTERN")
        if   (( cnt >= 100 )); then status WARN "$log" "${cnt}건 매칭"
        else info "$log: ${cnt}건 매칭 (최근 5000줄 기준)"
        fi
    done

    if command -v dmesg >/dev/null 2>&1; then
        local de
        de=$(dmesg --level=err,crit,alert,emerg 2>/dev/null | wc -l)
        if (( de > 0 )); then status WARN "dmesg 에러" "${de}건"
        else status OK "dmesg 에러" "없음"
        fi
    fi
}

# ============================================================
# 8. systemd 서비스 상태
# ============================================================
check_services() {
    section "8. 주요 서비스 상태"
    if ! command -v systemctl >/dev/null 2>&1; then
        info "systemd 미사용 환경 - 점검 생략"
        return
    fi

    local failed
    failed=$(systemctl --failed --no-legend --no-pager 2>/dev/null | wc -l)
    if (( failed > 0 )); then
        status CRIT "Failed units" "${failed}개"
        systemctl --failed --no-legend --no-pager 2>/dev/null | head -5 \
            | while read -r line; do out "    ✗ $line"; done
    else
        status OK "Failed units" "없음"
    fi
}

# ============================================================
# 9. 보안 점검
# ============================================================
check_security() {
    section "9. 보안 점검"
    if [[ $EUID -eq 0 ]] && command -v lastb >/dev/null 2>&1; then
        local fails
        fails=$(lastb -n 200 2>/dev/null | grep -vcE "^$|^btmp")
        if   (( fails >= 50 )); then status WARN "최근 로그인 실패" "${fails}건"
        else status OK "최근 로그인 실패" "${fails}건"
        fi
    else
        info "lastb 점검 생략 (root 권한 필요)"
    fi

    info "현재 로그인 세션: $(who | wc -l)개"
    local last_root
    last_root=$(last -n 1 root 2>/dev/null | head -1)
    [[ -n "$last_root" ]] && info "Last root login: $last_root"
}

# ============================================================
# 요약
# ============================================================
print_summary() {
    section "★ 점검 요약"
    out "  Hostname    : $HOSTNAME_F"
    out "  점검 시작   : $START_TS"
    out "  점검 종료   : $(date '+%Y-%m-%d %H:%M:%S')"
    out "  ${C_YEL}WARN${C_RESET}  : $WARN_COUNT 건"
    out "  ${C_RED}CRIT${C_RESET}  : $CRIT_COUNT 건"
    out ""
    if   (( CRIT_COUNT > 0 )); then
        out "  ${C_RED}${C_BOLD}⚠  심각한 문제 발견 - 즉시 조치 필요${C_RESET}"
        return 2
    elif (( WARN_COUNT > 0 )); then
        out "  ${C_YEL}${C_BOLD}⚠  주의 항목 있음 - 모니터링 권장${C_RESET}"
        return 1
    else
        out "  ${C_GRN}${C_BOLD}✓  모든 점검 항목 정상${C_RESET}"
        return 0
    fi
}

# ============================================================
# 실행
# ============================================================
[[ -n "$OUTPUT" ]] && : > "$OUTPUT"

out "${C_BOLD}╔══════════════════════════════════════════════════════╗${C_RESET}"
out "${C_BOLD}║       Linux System Health Check Report               ║${C_RESET}"
out "${C_BOLD}╚══════════════════════════════════════════════════════╝${C_RESET}"

check_system_info
check_load
check_memory
check_disk
check_network
check_top_processes
check_logs
check_services
check_security
print_summary
exit $?
