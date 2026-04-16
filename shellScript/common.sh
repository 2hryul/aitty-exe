#!/bin/bash

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Initialize variables
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
HOSTNAME=$(hostname)

# K8S-sensitive operations
K8S_SENSITIVE=(
    "U-08"  # Shell accounts might affect K8S service accounts
    "U-23"  # SUID/SGID affects container security
    "U-25"  # World-writable files might affect K8S mounted volumes
)

# Function to check if item is K8S sensitive
is_k8s_sensitive() {
    local item=$1
    for sensitive in "${K8S_SENSITIVE[@]}"; do
        if [[ "$item" == "$sensitive" ]]; then
            return 0
        fi
    done
    return 1
}

# Logging function
log_message() {
    local message="$1"
    local output_file="${2:-$CHECK_OUTPUT_FILE}"  # 두 번째 인자가 없으면 CHECK_OUTPUT_FILE 사용
    
    echo -e "$message"
    if [ -n "$output_file" ]; then
        echo -e "$message" >> "$output_file"
    fi
}

# Function to backup file
backup_file() {
    local file=$1
    if [ -f "$file" ]; then
        cp "$file" "${file}.bak.$(date +%Y%m%d)"
        echo "백업 파일이 생성되었습니다: ${file}.bak.$(date +%Y%m%d)"
        return 0
    fi
    return 1
}

# Initialize log file
init_log() {
    local output_file=$1
    local type=$2
    echo "Security Vulnerability $type Report - $(date)" > "$output_file"
    echo "Hostname: $HOSTNAME" >> "$output_file"
    echo "----------------------------------------" >> "$output_file"
}

# Function to display menu
display_menu() {
    local type=$1
    echo -e "\n${GREEN}보안 취약점 $type 메뉴${NC}"
    echo "1) 전체 항목 $type"
    echo "2) 선택 항목 $type"
    echo "3) 시간이 오래 걸리는 항목 건너뛰기"
    echo "4) 종료"
}

# Function to convert selection number to U-XX format
get_check_id() {
    local num=$1
    case $num in
        1) echo "U-03" ;;
        2) echo "U-07" ;;
        3) echo "U-08" ;;
        4) echo "U-10" ;;
        5) echo "U-11" ;;
        6) echo "U-15" ;;
        7) echo "U-23" ;;
        8) echo "U-24" ;;
        9) echo "U-25" ;;
        10) echo "U-28" ;;
        11) echo "U-45" ;;
        12) echo "U-70" ;;
        13) echo "U-73" ;;
        *) echo "" ;;
    esac
}

# Export functions
export -f is_k8s_sensitive
export -f log_message
export -f backup_file
export -f init_log
export -f display_menu
export -f get_check_id