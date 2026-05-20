#!/usr/bin/env bash
# ============================================================
#  logcheck.sh - 단일 로그파일 분석 도구
#  Usage:
#    ./logcheck.sh <file>                          # 요약 + 레벨분포 + 상위 에러
#    ./logcheck.sh <file> -p "OutOfMemory" -A 5    # 패턴 검색 (다음 5줄 컨텍스트)
#    ./logcheck.sh <file> -l ERROR -t 1h           # 최근 1시간 ERROR
#    ./logcheck.sh <file> -t "2026-04-27 14:00,2026-04-27 15:00"
#    ./logcheck.sh <file> -T 20                    # 상위 20개 빈출 패턴
#    ./logcheck.sh <file> -f -p "ERROR|FATAL"      # 실시간 모니터링
#    ./logcheck.sh /var/log/syslog.1.gz -l ERROR   # 압축 파일 자동 처리
# ============================================================

set -uo pipefail
export LC_ALL=C

# ---------- 인자 처리 ----------
usage() { sed -n '3,12p' "$0"; exit 0; }
[[ $# -lt 1 ]] && usage

FILE=""; PATTERN=""; LEVEL=""; TIME_SPEC=""
CTX_AFTER=0; CTX_BEFORE=0; TOP_N=10
IGNORE_CASE=0; FOLLOW=0; MODE="summary"

while [[ $# -gt 0 ]]; do
    case "$1" in
        -p) PATTERN="$2"; MODE="search"; shift 2 ;;
        -i) IGNORE_CASE=1; shift ;;
        -l) LEVEL="$2"; shift 2 ;;
        -t) TIME_SPEC="$2"; shift 2 ;;
        -A) CTX_AFTER="$2"; shift 2 ;;
        -B) CTX_BEFORE="$2"; shift 2 ;;
        -T) TOP_N="$2"; MODE="top"; shift 2 ;;
        -f) FOLLOW=1; MODE="follow"; shift ;;
        -h|--help) usage ;;
        -*) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
        *) FILE="$1"; shift ;;
    esac
done

[[ -z "$FILE" ]] && { echo "로그파일 경로가 필요합니다." >&2; usage; }
[[ ! -r "$FILE" ]] && { echo "파일을 읽을 수 없습니다: $FILE" >&2; exit 1; }

# ---------- 색상 ----------
if [[ -t 1 ]]; then
    C_R=$'\e[0m'; C_RED=$'\e[31m'; C_YEL=$'\e[33m'
    C_GRN=$'\e[32m'; C_BLU=$'\e[36m'; C_BOLD=$'\e[1m'
else
    C_R=""; C_RED=""; C_YEL=""; C_GRN=""; C_BLU=""; C_BOLD=""
fi

# ============================================================
# 압축 파일 자동 감지 → 적절한 cat 명령 반환
# ============================================================
log_reader() {
    case "$FILE" in
        *.gz)  echo "zcat" ;;
        *.xz)  echo "xzcat" ;;
        *.bz2) echo "bzcat" ;;
        *.zst) echo "zstdcat" ;;
        *)     echo "cat" ;;
    esac
}
READER=$(log_reader)

# ============================================================
# 시간 사양 파싱
#   "1h", "30m", "2d" → ISO 시작시각
#   "FROM,TO"          → 시작,종료 페어
# ============================================================
parse_time() {
    local spec=$1 num unit
    if [[ "$spec" == *","* ]]; then
        TIME_FROM="${spec%,*}"
        TIME_TO="${spec#*,}"
    else
        num=${spec%[smhd]}
        unit=${spec: -1}
        case $unit in
            s) TIME_FROM=$(date -d "$num seconds ago" '+%Y-%m-%d %H:%M:%S') ;;
            m) TIME_FROM=$(date -d "$num minutes ago" '+%Y-%m-%d %H:%M:%S') ;;
            h) TIME_FROM=$(date -d "$num hours ago"   '+%Y-%m-%d %H:%M:%S') ;;
            d) TIME_FROM=$(date -d "$num days ago"    '+%Y-%m-%d %H:%M:%S') ;;
            *) echo "잘못된 시간 형식: $spec (예: 1h, 30m, 2d)" >&2; exit 1 ;;
        esac
        TIME_TO=""
    fi
}

# ============================================================
# 시간 필터 awk (ISO-8601 프리픽스 기반)
#   ISO 형식이 아니면 효과 없음 (필요시 grep 으로 prefix 매칭)
# ============================================================
time_filter() {
    if [[ -z "$TIME_SPEC" ]]; then
        cat
    elif [[ -z "$TIME_TO" ]]; then
        awk -v s="$TIME_FROM" '$0 >= s'
    else
        awk -v s="$TIME_FROM" -v e="$TIME_TO" '$0 >= s && $0 <= e'
    fi
}

# ============================================================
# 패턴 정규화 (TOP N 분석용)
#   변동값(타임스탬프/IP/UUID/숫자)을 placeholder로 치환
# ============================================================
normalize() {
    sed -E '
        s/[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9:]+)?/<TS>/g
        s/[0-9]{1,3}(\.[0-9]{1,3}){3}(:[0-9]+)?/<IP>/g
        s/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/<UUID>/g
        s/0x[0-9a-fA-F]+/<HEX>/g
        s/\b[0-9]{4,}\b/<N>/g
        s/\/[a-zA-Z0-9_./-]+\.(java|py|go|rs|js|ts|c|cpp):[0-9]+/<FILE:LINE>/g
    '
}

[[ -n "$TIME_SPEC" ]] && parse_time "$TIME_SPEC"

# ============================================================
# 모드 1: 요약 (summary)
# ============================================================
mode_summary() {
    local lines size first last
    size=$(du -h "$FILE" | awk '{print $1}')
    lines=$($READER "$FILE" | wc -l)
    first=$($READER "$FILE" | head -1 | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}' | head -1)
    last=$($READER "$FILE" | tail -1 | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}' | head -1)

    echo "${C_BOLD}${C_BLU}═══ 파일 정보 ═══${C_R}"
    printf "  %-12s %s\n" "Path"     "$FILE"
    printf "  %-12s %s\n" "Size"     "$size"
    printf "  %-12s %s\n" "Lines"    "$(printf "%'d" "$lines")"
    [[ -n "$first" ]] && printf "  %-12s %s\n" "First entry" "$first"
    [[ -n "$last"  ]] && printf "  %-12s %s\n" "Last entry"  "$last"
    [[ "$READER" != "cat" ]] && printf "  %-12s %s\n" "Compression" "$READER"

    echo
    echo "${C_BOLD}${C_BLU}═══ 로그 레벨 분포 ═══${C_R}"
    $READER "$FILE" | time_filter | awk '
        BEGIN{ total=0; for(l in c) c[l]=0 }
        /\[?(FATAL|CRITICAL)\]?/  { c["FATAL"]++; total++; next }
        /\[?ERROR\]?|\[?ERR\]?/   { c["ERROR"]++; total++; next }
        /\[?WARN(ING)?\]?/        { c["WARN"]++;  total++; next }
        /\[?INFO\]?/              { c["INFO"]++;  total++; next }
        /\[?DEBUG\]?/             { c["DEBUG"]++; total++; next }
        /\[?TRACE\]?/             { c["TRACE"]++; total++; next }
                                  { total++ }
        END {
            for (l in c)
                if (c[l] > 0)
                    printf "  %-8s : %10d (%5.2f%%)\n", l, c[l], c[l]*100/total
            printf "  %-8s : %10d\n", "TOTAL", total
        }'

    echo
    echo "${C_BOLD}${C_RED}═══ 상위 ERROR/FATAL 패턴 (TOP $TOP_N) ═══${C_R}"
    $READER "$FILE" | time_filter \
        | grep -E "ERROR|FATAL|CRITICAL|Exception|Traceback" \
        | normalize | sort | uniq -c | sort -rn | head -"$TOP_N" \
        | awk '{ count=$1; $1=""; sub(/^ /,""); printf "  %5d  %s\n", count, substr($0,1,150) }'

    echo
    echo "${C_BOLD}${C_BLU}═══ 시간대별 에러 분포 (시간단위) ═══${C_R}"
    $READER "$FILE" | time_filter \
        | grep -E "ERROR|FATAL" \
        | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}' \
        | sort | uniq -c | tail -24 \
        | awk '{
            n = ($1 > 50) ? 50 : $1;
            bar = "";
            for (i = 0; i < n; i++) bar = bar "█";
            printf "  %s시  %5d  %s\n", $2, $1, bar
        }'
}

# ============================================================
# 모드 2: 패턴 검색 (search)
# ============================================================
mode_search() {
    local grep_opts=("-n" "--color=auto")
    [[ $IGNORE_CASE -eq 1 ]] && grep_opts+=("-i")
    [[ $CTX_AFTER  -gt 0 ]] && grep_opts+=("-A" "$CTX_AFTER")
    [[ $CTX_BEFORE -gt 0 ]] && grep_opts+=("-B" "$CTX_BEFORE")

    local effective_pattern="$PATTERN"
    [[ -n "$LEVEL" ]] && effective_pattern="(${LEVEL}).*${PATTERN}|${PATTERN}.*(${LEVEL})"

    local matched
    matched=$($READER "$FILE" | time_filter | grep "${grep_opts[@]}" -E "$effective_pattern" | tee /dev/stderr | wc -l)
    echo
    echo "${C_BOLD}매치: ${matched} 라인${C_R}" >&2
} 2> >(cat)   # stderr → stdout 그대로 (matched line은 stderr로 흘림)

# ============================================================
# 모드 3: 레벨 필터 (search 의 특수형)
# ============================================================
mode_level_only() {
    local level_pat="$LEVEL"
    [[ -n "$PATTERN" ]] && PATTERN="$PATTERN" || PATTERN="$level_pat"
    mode_search
}

# ============================================================
# 모드 4: TOP N 패턴 분석
# ============================================================
mode_top() {
    echo "${C_BOLD}${C_BLU}═══ 상위 ${TOP_N}개 빈출 패턴 ═══${C_R}"
    local filter='.'
    [[ -n "$LEVEL" ]] && filter="$LEVEL"

    $READER "$FILE" | time_filter \
        | grep -E "$filter" \
        | normalize | sort | uniq -c | sort -rn | head -"$TOP_N" \
        | awk '{ count=$1; $1=""; sub(/^ /,""); printf "  %5d  %s\n", count, substr($0,1,180) }'
}

# ============================================================
# 모드 5: 실시간 모니터링 (follow)
# ============================================================
mode_follow() {
    [[ "$READER" != "cat" ]] && { echo "압축 파일은 follow 모드 미지원"; exit 1; }
    local grep_opts=("--line-buffered" "--color=always")
    [[ $IGNORE_CASE -eq 1 ]] && grep_opts+=("-i")

    if [[ -n "$PATTERN" ]]; then
        echo "${C_BOLD}실시간 모니터링: $FILE | 패턴: $PATTERN${C_R}"
        tail -F "$FILE" 2>/dev/null | grep "${grep_opts[@]}" -E "$PATTERN"
    elif [[ -n "$LEVEL" ]]; then
        echo "${C_BOLD}실시간 모니터링: $FILE | 레벨: $LEVEL${C_R}"
        tail -F "$FILE" 2>/dev/null | grep "${grep_opts[@]}" -E "$LEVEL"
    else
        echo "${C_BOLD}실시간 모니터링: $FILE${C_R}"
        tail -F "$FILE" 2>/dev/null
    fi
}

# ============================================================
# 디스패처
# ============================================================
case "$MODE" in
    summary)
        if [[ -n "$LEVEL" || -n "$PATTERN" ]]; then
            mode_search   # 레벨/패턴 지정시 검색 모드
        else
            mode_summary
        fi
        ;;
    search) mode_search ;;
    top)    mode_top ;;
    follow) mode_follow ;;
esac
