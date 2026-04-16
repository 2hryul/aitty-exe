#!/bin/bash

# Source common functions
source ./common.sh

# Initialize check-specific variables
CHECK_OUTPUT_FILE="${HOSTNAME}-check_${TIMESTAMP}.txt"
init_log "$CHECK_OUTPUT_FILE" "Check"

# 점검 결과를 저장할 배열 선언
declare -A check_results
declare -A check_names
declare -A check_remediation

# 통계 변수 초기화
total_checks=0
passed_checks=0
failed_checks=0
na_checks=0

# Helper function to display file content
show_file_content() {
    local file=$1
    local max_lines=${2:-20}  # 기본적으로 20줄까지 표시
    
    if [ -f "$file" ]; then
        log_message "\n${BLUE}파일 내용 ($file):${NC}"
        log_message "$(head -n $max_lines "$file" | sed 's/^/    /')"
        
        # 파일이 20줄보다 길면 표시 생략 메시지 추가
        if [ $(wc -l < "$file") -gt $max_lines ]; then
            log_message "    ... (파일 내용이 더 있습니다)"
        fi
    else
        log_message "\n${YELLOW}파일이 존재하지 않습니다: $file${NC}"
    fi
}

# 점검 결과 저장 함수
save_result() {
    local id=$1
    local name=$2
    local result=$3
    
    check_results["$id"]="$result"
    check_names["$id"]="$name"
    
    # 통계 업데이트
    total_checks=$((total_checks + 1))
    
    case "$result" in
        "양호") passed_checks=$((passed_checks + 1));;
        "취약") failed_checks=$((failed_checks + 1));;
        "해당없음") na_checks=$((na_checks + 1));;
    esac
}

# 결과 테이블 출력 함수
print_result_table() {
    log_message "\n\n============================================================"
    log_message "                  보안 취약점 점검 결과 요약                    "
    log_message "============================================================"
    log_message "| 항목번호 |           점검 항목           |   결과   |"
    log_message "|----------|------------------------------|----------|"
    
    for id in "${!check_results[@]}"; do
        printf -v line "| %-8s | %-30s | %-8s |" "$id" "${check_names[$id]}" "${check_results[$id]}"
        log_message "$line"
    done
    
    log_message "============================================================"
    log_message "통계 요약:"
    log_message "  - 총 점검 항목: $total_checks"
    log_message "  - 양호 항목: $passed_checks"
    log_message "  - 취약 항목: $failed_checks"
    log_message "  - 해당없음 항목: $na_checks"
    log_message "============================================================"
}

# 1. U-03: SU 명령 사용가능 그룹 제한 점검 (Ubuntu 버전)
check_u03() {
    log_message "\n[U-03] SU 명령 사용가능 그룹 제한 점검"
    local item_name="SU 명령 사용가능 그룹 제한"
    
    check_remediation["U-03"]="
    [조치 방법]
    1. /etc/pam.d/su 파일에 다음 라인 추가:
       auth required pam_wheel.so use_uid
    2. su 명령어 권한 제한:
       chmod 4750 /usr/bin/su
    3. Ubuntu에서는 기본적으로 sudo 그룹 사용:
       usermod -aG sudo <관리자계정>
    "
    
    if [ -f "/etc/pam.d/su" ] && [ -f "/usr/bin/su" ]; then
        local pam_wheel=$(grep "^auth.*required.*pam_wheel.so" /etc/pam.d/su)
        local su_perm=$(stat -c %a /usr/bin/su)
        
        # Ubuntu에서는 sudo 그룹 확인
        local sudo_group=$(grep "^sudo:" /etc/group)
        
        if [[ -n "$pam_wheel" ]] && [[ "$su_perm" -le "4750" ]]; then
            log_message "${GREEN}[양호]${NC} SU 명령 사용가능 그룹이 제한되어 있습니다."
            log_message "PAM 설정: $pam_wheel"
            log_message "SU 권한: $su_perm"
            show_file_content "/etc/pam.d/su"
            save_result "U-03" "$item_name" "양호"
        elif [[ -n "$sudo_group" ]] && [[ "$su_perm" -le "4755" ]]; then
            # Ubuntu는 sudo 시스템을 사용하므로 이 경우도 양호로 처리
            log_message "${GREEN}[양호]${NC} Ubuntu sudo 시스템을 통해 SU 명령 사용이 제한되어 있습니다."
            log_message "sudo 그룹: $sudo_group"
            log_message "SU 권한: $su_perm"
            save_result "U-03" "$item_name" "양호"
        else
            log_message "${RED}[취약]${NC} SU 명령 사용가능 그룹이 제한되어 있지 않습니다."
            log_message "현재 PAM 설정: $(grep "pam_wheel.so" /etc/pam.d/su || echo "없음")"
            log_message "현재 SU 권한: $su_perm"
            log_message "sudo 그룹: $(grep "^sudo:" /etc/group || echo "없음")"
            show_file_content "/etc/pam.d/su"
            log_message "${YELLOW}[조치 방법]${NC}${check_remediation["U-03"]}"
            save_result "U-03" "$item_name" "취약"
        fi
    else
        log_message "${YELLOW}[해당없음]${NC} SU 관련 파일이 존재하지 않습니다."
        save_result "U-03" "$item_name" "해당없음"
    fi
}


# 2. U-07: 계정 잠금 임계값 설정 점검 (Ubuntu 22.04 버전)
check_u07() {
    log_message "\n[U-07] 계정 잠금 임계값 설정 점검"
    local item_name="계정 잠금 임계값 설정"
    
    check_remediation["U-07"]="
    [조치 방법]
    1. /etc/pam.d/common-auth 파일에 다음 라인 추가:
       auth required pam_faillock.so preauth silent deny=5 unlock_time=300
       
    2. /etc/security/faillock.conf 파일에 다음 설정 추가/수정:
       deny = 5
       unlock_time = 300
       
    3. 패스워드 인증 실패 횟수 및 잠금 해제 시간 설정:
       - deny: 패스워드 인증 실패 횟수 (5회 권장)
       - unlock_time: 계정 잠금 해제 시간 (초 단위, 300초 권장)
    "
    
    local found=false
    
    if [ -f "/etc/pam.d/common-auth" ]; then
        if grep -q "pam_faillock.so" /etc/pam.d/common-auth; then
            found=true
            log_message "${GREEN}[양호]${NC} 계정 잠금 임계값이 설정되어 있습니다."
            log_message "설정 내용:"
            log_message "$(grep "pam_faillock.so" /etc/pam.d/common-auth | sed 's/^/    /')"
            show_file_content "/etc/pam.d/common-auth"
            save_result "U-07" "$item_name" "양호"
        fi
    fi
    
    # Ubuntu 22.04에서는 faillock.conf 파일도 확인
    if [ -f "/etc/security/faillock.conf" ]; then
        if grep -q "deny = " /etc/security/faillock.conf; then
            found=true
            log_message "${GREEN}[양호]${NC} 계정 잠금 임계값이 faillock.conf에 설정되어 있습니다."
            log_message "설정 내용:"
            log_message "$(grep -E 'deny|unlock_time' /etc/security/faillock.conf | sed 's/^/    /')"
            show_file_content "/etc/security/faillock.conf"
            save_result "U-07" "$item_name" "양호"
        fi
    fi
    
    # Ubuntu 22.04에서는 pam_tally2 대신 pam_faillock이 사용됨
    # 하지만 일부 시스템에서는 여전히 pam_tally2를 사용할 수 있으므로 확인
    if ! $found && grep -q "pam_tally2.so" /etc/pam.d/common-auth 2>/dev/null; then
        found=true
        log_message "${GREEN}[양호]${NC} 계정 잠금 임계값이 pam_tally2를 통해 설정되어 있습니다."
        log_message "설정 내용:"
        log_message "$(grep "pam_tally2.so" /etc/pam.d/common-auth | sed 's/^/    /')"
        show_file_content "/etc/pam.d/common-auth"
        save_result "U-07" "$item_name" "양호"
    fi
    
    if ! $found; then
        log_message "${RED}[취약]${NC} 계정 잠금 임계값이 설정되어 있지 않습니다."
        if [ -f "/etc/pam.d/common-auth" ]; then
            show_file_content "/etc/pam.d/common-auth"
        fi
        log_message "${YELLOW}[조치 방법]${NC}${check_remediation["U-07"]}"
        save_result "U-07" "$item_name" "취약"
    fi
}

# 5. U-08: 불필요한 Shell 계정 점검 (Ubuntu 계정 목록 업데이트)
check_u08() {
    log_message "\n[U-08] 불필요한 Shell 계정 점검"
    local item_name="불필요한 Shell 계정 점검"
    
    check_remediation["U-08"]="
    [조치 방법]
    1. 불필요한 계정의 쉘을 nologin으로 변경:
       usermod -s /usr/sbin/nologin <계정명>
       
    2. 또는 불필요한 계정 삭제:
       userdel <계정명>
       
    3. 시스템 계정은 보통 로그인이 필요하지 않으므로 /usr/sbin/nologin 또는 /bin/false로 설정해야 합니다.
    "
    
    if is_k8s_sensitive "U-08"; then
        log_message "${YELLOW}[주의]${NC} 이 점검은 K8S 운영에 영향을 줄 수 있습니다."
    fi
    
    # Ubuntu 22.04에서 일반적으로 허용되는 계정 목록 (root, ubuntu 포함)
    # systemd-network, systemd-resolve 등 Ubuntu 고유 계정도 제외
    local unnecessary_shells=$(awk -F: '$7 != "/usr/sbin/nologin" && $7 != "/bin/false" && $1 != "root" && $1 != "ubuntu" && $3 >= 1000 {print $1}' /etc/passwd)
    
    if [ -z "$unnecessary_shells" ]; then
        log_message "${GREEN}[양호]${NC} 불필요한 Shell 계정이 존재하지 않습니다."
        save_result "U-08" "$item_name" "양호"
    else
        log_message "${RED}[취약]${NC} 불필요한 Shell 계정이 존재합니다:"
        for account in $unnecessary_shells; do
            log_message "계정: $account"
            log_message "$(grep "^$account:" /etc/passwd | sed 's/^/    /')"
        done
        log_message "\n/etc/passwd 내용 일부:"
        show_file_content "/etc/passwd"
        log_message "${YELLOW}[조치 방법]${NC}${check_remediation["U-08"]}"
        save_result "U-08" "$item_name" "취약"
    fi
}

# U-10: Remote Terminal Timeout Check
check_u10() {
    log_message "\n[U-10] 원격 터미널 접속 타임아웃 설정 점검"
    local item_name="원격 터미널 접속 타임아웃 설정"
    
    check_remediation["U-10"]="
    [조치 방법]
    1. /etc/profile 파일에 다음 설정 추가:
       TMOUT=600
       readonly TMOUT
       export TMOUT
       
    2. 설정값 권장사항:
       - TMOUT: 600초(10분) 이하로 설정 권장
       - readonly TMOUT: 사용자가 TMOUT 값을 변경하지 못하도록 읽기 전용으로 설정
       
    3. 변경 후 시스템 재시작 또는 다음 명령어 실행:
       source /etc/profile
    "
    
    local tmout_set=false
    local tmout_file=""
    local tmout_value=""
    
    for file in /etc/profile /etc/bash.bashrc; do
        if [ -f "$file" ] && grep -q "TMOUT=" "$file"; then
            tmout_set=true
            tmout_file="$file"
            tmout_value=$(grep "TMOUT=" "$file" | sed 's/^/    /')
            break
        fi
    done
    
    if $tmout_set; then
        log_message "${GREEN}[양호]${NC} 원격 터미널 타임아웃이 설정되어 있습니다."
        log_message "파일: $tmout_file"
        log_message "설정값: $tmout_value"
        show_file_content "$tmout_file"
        save_result "U-10" "$item_name" "양호"
    else
        log_message "${RED}[취약]${NC} 원격 터미널 타임아웃이 설정되어 있지 않습니다."
        log_message "다음 파일에 TMOUT 설정이 필요합니다:"
        for file in /etc/profile /etc/bash.bashrc; do
            if [ -f "$file" ]; then
                show_file_content "$file" 10
            fi
        done
        log_message "${YELLOW}[조치 방법]${NC}${check_remediation["U-10"]}"
        save_result "U-10" "$item_name" "취약"
    fi
}

# 3. U-11: 계정 비밀번호 기록 개수 설정 점검 (Ubuntu 버전)
check_u11() {
    log_message "\n[U-11] 계정 비밀번호 기록 개수 설정 점검"
    local item_name="계정 비밀번호 기록 개수 설정"
    
    check_remediation["U-11"]="
    [조치 방법]
    1. /etc/pam.d/common-password 파일에 다음 라인 추가 또는 수정:
       password        required      pam_pwhistory.so remember=5
       
    2. 권장 설정:
       - remember: 5 이상의 값 (최근 5개 비밀번호는 재사용 불가)
    "
    
    local found=false
    
    if [ -f "/etc/pam.d/common-password" ]; then
        # Ubuntu는 pam_pwhistory.so 모듈 사용
        if grep -q "pam_pwhistory.so.*remember=" /etc/pam.d/common-password; then
            found=true
            log_message "${GREEN}[양호]${NC} 비밀번호 기록 개수가 설정되어 있습니다."
            log_message "설정값: $(grep "pam_pwhistory.so.*remember=" /etc/pam.d/common-password | sed 's/^/    /')"
            show_file_content "/etc/pam.d/common-password"
            save_result "U-11" "$item_name" "양호"
        # 일부 시스템에서는 pam_unix.so를 통해 remember 설정 가능
        elif grep -q "pam_unix.so.*remember=" /etc/pam.d/common-password; then
            found=true
            log_message "${GREEN}[양호]${NC} 비밀번호 기록 개수가 pam_unix.so를 통해 설정되어 있습니다."
            log_message "설정값: $(grep "pam_unix.so.*remember=" /etc/pam.d/common-password | sed 's/^/    /')"
            show_file_content "/etc/pam.d/common-password"
            save_result "U-11" "$item_name" "양호"
        fi
    fi
    
    if ! $found; then
        log_message "${RED}[취약]${NC} 비밀번호 기록 개수가 설정되어 있지 않습니다."
        if [ -f "/etc/pam.d/common-password" ]; then
            show_file_content "/etc/pam.d/common-password"
        else
            log_message "common-password 파일이 존재하지 않습니다."
        fi
        log_message "${YELLOW}[조치 방법]${NC}${check_remediation["U-11"]}"
        save_result "U-11" "$item_name" "취약"
    fi
}

# U-15: Hidden Files Check
check_u15() {
    log_message "\n[U-15] 불필요한 숨김 파일 또는 디렉터리 점검"
    local item_name="불필요한 숨김 파일 또는 디렉터리 점검"
    
    check_remediation["U-15"]="
    [조치 방법]
    1. /tmp 디렉터리 내 불필요한 숨김 파일 삭제:
       find /tmp -name '.*' -type f -exec rm -f {} \\;
       
    2. 주기적으로 임시 디렉터리 점검 및 정리:
       - cron을 통해 정기적인 임시 파일 정리 작업 설정
       - 임시 디렉터리 접근 권한 확인 및 제한
    "
    
    local hidden_files=$(find /tmp -name ".*" -type f 2>/dev/null)
    
    if [ -z "$hidden_files" ]; then
        log_message "${GREEN}[양호]${NC} 불필요한 숨김 파일이 존재하지 않습니다."
        save_result "U-15" "$item_name" "양호"
    else
        log_message "${RED}[취약]${NC} 불필요한 숨김 파일이 존재합니다:"
        for file in $hidden_files; do
            log_message "파일: $file"
            log_message "권한: $(ls -la "$file" | awk '{print $1, $3, $4}')"
            show_file_content "$file" 5
        done
        log_message "${YELLOW}[조치 방법]${NC}${check_remediation["U-15"]}"
        save_result "U-15" "$item_name" "취약"
    fi
}

# U-23: SUID/SGID Check
check_u23() {
    log_message "\n[U-23] SUID, SGID, STICKY BIT 설정 파일 점검"
    local item_name="SUID, SGID, STICKY BIT 설정 파일 점검"
    
    check_remediation["U-23"]="
    [조치 방법]
    1. 불필요한 SUID/SGID 권한 제거:
       chmod -s <파일경로>
       
    2. 일반적으로 필요한 SUID/SGID 파일만 유지하고 나머지는 제거하는 것이 좋습니다.
       필수 유틸리티:
       - /bin/su, /usr/bin/sudo, /usr/bin/passwd 등
       
    3. 정기적으로 새로운 SUID/SGID 파일을 모니터링하는 스크립트 실행 권장
    "
    
    if is_k8s_sensitive "U-23"; then
        log_message "${YELLOW}[주의]${NC} 이 점검은 K8S 운영에 영향을 줄 수 있습니다."
    fi
    
    local suid_files=$(find / -type f \( -perm -4000 -o -perm -2000 \) -exec ls -l {} \; 2>/dev/null)
    
    if [ -z "$suid_files" ]; then
        log_message "${GREEN}[양호]${NC} 불필요한 SUID/SGID 파일이 존재하지 않습니다."
        save_result "U-23" "$item_name" "양호"
    else
        log_message "${RED}[취약]${NC} SUID/SGID 파일이 존재합니다:"
        log_message "$suid_files"
        
        # 일부 중요 SUID/SGID 파일만 샘플로 내용 확인 (대부분 바이너리라 내용 확인은 제한적)
        local sample_count=0
        for file in $(echo "$suid_files" | awk '{print $9}' | head -5); do
            log_message "\n파일 정보: $file"
            log_message "파일 타입: $(file "$file" | sed 's/^/    /')"
            if file "$file" | grep -q "text"; then
                # 텍스트 파일인 경우만 내용 표시
                show_file_content "$file" 5
                sample_count=$((sample_count + 1))
            else
                log_message "    (바이너리 파일입니다. 내용 표시 생략)"
            fi
            if [ $sample_count -ge 3 ]; then
                log_message "\n    ... (나머지 파일 생략)"
                break
            fi
        done
        log_message "${YELLOW}[조치 방법]${NC}${check_remediation["U-23"]}"
        save_result "U-23" "$item_name" "취약"
    fi
}

# U-24: User Environment File Permission Check
check_u24() {
    log_message "\n[U-24] 사용자 환경파일의 소유자 또는 권한 설정 점검"
    local item_name="사용자 환경파일의 소유자 또는 권한 설정"
    
    check_remediation["U-24"]="
    [조치 방법]
    1. 환경 파일의 권한을 750 이하로 제한:
       chmod 750 ~/.profile ~/.bashrc ~/.bash_profile
       
    2. 소유자 및 그룹 설정 확인:
       chown <사용자>:<그룹> ~/.profile ~/.bashrc ~/.bash_profile
       
    3. 주기적으로 환경 파일 권한 확인 권장
    "
    
    local vulnerable=false
    local env_files=(".profile" ".bashrc" ".bash_profile")
    
    for file in "${env_files[@]}"; do
        if [ -f "$HOME/$file" ]; then
            local perm=$(stat -c %a "$HOME/$file")
            if [ "$perm" -gt "750" ]; then
                vulnerable=true
                log_message "${RED}[취약]${NC} $file 파일의 권한이 750보다 큽니다: $perm"
                log_message "파일 정보: $(ls -la "$HOME/$file")"
                show_file_content "$HOME/$file" 10
            fi
        fi
    done
    
    if ! $vulnerable; then
        log_message "${GREEN}[양호]${NC} 모든 환경 파일의 권한이 적절히 설정되어 있습니다."
        for file in "${env_files[@]}"; do
            if [ -f "$HOME/$file" ]; then
                log_message "파일: $HOME/$file, 권한: $(stat -c %a "$HOME/$file")"
            fi
        done
        save_result "U-24" "$item_name" "양호"
    else
        log_message "${YELLOW}[조치 방법]${NC}${check_remediation["U-24"]}"
        save_result "U-24" "$item_name" "취약"
    fi
}

# U-25: World Writable File Check
check_u25() {
    log_message "\n[U-25] 불필요한 world writable 파일 점검"
    local item_name="불필요한 world writable 파일 점검"
    
    check_remediation["U-25"]="
    [조치 방법]
    1. world writable 권한 제거:
       find / -type f -perm -0002 -exec chmod o-w {} \\;
       
    2. 권한 변경 시 주의사항:
       - 일부 파일은 의도적으로 world writable 일 수 있으므로 시스템 기능에 영향을 줄 수 있는 파일은 신중히 처리
       - 애플리케이션 로그 파일, 임시 디렉터리 내 파일 등은 제외 가능
       
    3. 정기적인 world writable 파일 점검 및 모니터링 권장
    "
    
    if is_k8s_sensitive "U-25"; then
        log_message "${YELLOW}[주의]${NC} 이 점검은 K8S 운영에 영향을 줄 수 있습니다."
    fi
    
    local world_writable=$(find / -type f -perm -0002 -not -path "/proc/*" -not -path "/sys/*" -ls 2>/dev/null)
    
    if [ -z "$world_writable" ]; then
        log_message "${GREEN}[양호]${NC} 불필요한 world writable 파일이 존재하지 않습니다."
        save_result "U-25" "$item_name" "양호"
    else
        log_message "${RED}[취약]${NC} World writable 파일이 존재합니다:"
        log_message "$world_writable"
        
        # 일부 파일 내용 확인
        log_message "\n일부 world writable 파일 내용:"
        local sample_count=0
        for file in $(echo "$world_writable" | awk '{print $11}' | head -5); do
            log_message "\n파일: $file"
            log_message "권한: $(ls -la "$file" | awk '{print $1, $3, $4}')"
            if file "$file" | grep -q "text"; then
                show_file_content "$file" 5
                sample_count=$((sample_count + 1))
            else
                log_message "    (바이너리 파일입니다. 내용 표시 생략)"
            fi
            if [ $sample_count -ge 3 ]; then
                log_message "\n    ... (나머지 파일 생략)"
                break
            fi
        done
        log_message "${YELLOW}[조치 방법]${NC}${check_remediation["U-25"]}"
        save_result "U-25" "$item_name" "취약"
    fi
}

# U-28: System Directory Permission Check
check_u28() {
    log_message "\n[U-28] 시스템 주요 디렉터리 권한 설정 점검"
    local item_name="시스템 주요 디렉터리 권한 설정"
    
    check_remediation["U-28"]="
    [조치 방법]
    1. 시스템 주요 디렉터리 권한 제한:
       chmod 755 /etc /bin /usr /var /sbin
       
    2. 소유자 및 그룹 확인:
       chown root:root /etc /bin /usr /var /sbin
       
    3. 디렉터리 이하 모든 파일 권한 점검 및 조정:
       find /etc -type f -perm -o+w -exec chmod o-w {} \\;
    "
    
    local dirs=("/etc" "/usr" "/var" "/bin" "/sbin")
    local vulnerable=false
    
    for dir in "${dirs[@]}"; do
        if [ -d "$dir" ]; then
            local perm=$(stat -c %a "$dir")
            if [ "$perm" -gt "755" ]; then
                vulnerable=true
                log_message "${RED}[취약]${NC} $dir 디렉터리의 권한이 755보다 큽니다: $perm"
                log_message "디렉터리 정보: $(ls -ld "$dir")"
                log_message "디렉터리 내용 샘플:"
                log_message "$(ls -la "$dir" | head -10 | sed 's/^/    /')"
            fi
        fi
    done
    
    if ! $vulnerable; then
        log_message "${GREEN}[양호]${NC} 모든 시스템 디렉터리의 권한이 적절히 설정되어 있습니다."
        for dir in "${dirs[@]}"; do
            if [ -d "$dir" ]; then
                log_message "디렉터리: $dir, 권한: $(stat -c %a "$dir")"
            fi
        done
        save_result "U-28" "$item_name" "양호"
    else
        log_message "${YELLOW}[조치 방법]${NC}${check_remediation["U-28"]}"
        save_result "U-28" "$item_name" "취약"
    fi
}

# U-45: System Warning Banner Check
check_u45() {
    log_message "\n[U-45] 시스템 사용 주의사항 출력 점검"
    local item_name="시스템 사용 주의사항 출력"
    
    check_remediation["U-45"]="
    [조치 방법]
    1. 다음 파일에 경고 메시지 추가:
       - /etc/motd (로그인 후 표시)
       - /etc/issue (로컬 로그인 전 표시)
       - /etc/issue.net (원격 텔넷 로그인 전 표시)
       
    2. 권장 경고 메시지 내용:
       - 무단 접근 금지 경고
       - 모든 접근 로그 기록 안내
       - 법적 조치 가능성 명시
       
    3. 예시 메시지:
       
       ******************************************
       * WARNING: Unauthorized access prohibited *
       * All activities are monitored and logged *
       * Violators will be prosecuted            *
       ******************************************
    "
    
    local warning_files=("/etc/motd" "/etc/issue.net" "/etc/issue")
    local warning_set=false
    
    for file in "${warning_files[@]}"; do
        if [ -s "$file" ]; then
            warning_set=true
            log_message "경고 메시지 파일: $file"
            show_file_content "$file"
        fi
    done
    
    if $warning_set; then
        log_message "${GREEN}[양호]${NC} 시스템 사용 주의사항이 설정되어 있습니다."
        save_result "U-45" "$item_name" "양호"
    else
        log_message "${RED}[취약]${NC} 시스템 사용 주의사항이 설정되어 있지 않습니다."
        for file in "${warning_files[@]}"; do
            if [ -f "$file" ]; then
                log_message "파일 $file이 비어있습니다."
            else
                log_message "파일 $file이 존재하지 않습니다."
            fi
        done
        log_message "${YELLOW}[조치 방법]${NC}${check_remediation["U-45"]}"
        save_result "U-45" "$item_name" "취약"
    fi
}

# 4. U-70: 정책에 따른 시스템 로깅 설정 점검 (Ubuntu 버전)
check_u70() {
    log_message "\n[U-70] 정책에 따른 시스템 로깅 설정 점검"
    local item_name="정책에 따른 시스템 로깅 설정"
    
    check_remediation["U-70"]="
    [조치 방법]
    1. /etc/rsyslog.conf 파일 또는 /etc/rsyslog.d/*.conf 파일에 다음과 같은 설정 추가:
       *.info;mail.none;authpriv.none;cron.none    /var/log/syslog
       authpriv.*                                  /var/log/auth.log
       mail.*                                      /var/log/mail.log
       cron.*                                      /var/log/cron.log
       *.alert                                     /var/log/alert
       *.emerg                                     *
       
    2. rsyslog 서비스 재시작:
       systemctl restart rsyslog
       
    3. 로그 파일 접근 권한 설정:
       chmod 640 /var/log/*
    "
    
    local found=false
    
    if [ -f "/etc/rsyslog.conf" ]; then
        if grep -q "^\*\.\|^authpriv\.\|^mail\.\|^cron\." /etc/rsyslog.conf; then
            found=true
            log_message "${GREEN}[양호]${NC} 시스템 로깅이 rsyslog.conf에 적절히 설정되어 있습니다."
            log_message "설정 내용:"
            log_message "$(grep "^\*\.\|^authpriv\.\|^mail\.\|^cron\." /etc/rsyslog.conf | sed 's/^/    /')"
            show_file_content "/etc/rsyslog.conf" 15
        fi
    fi
    
    # Ubuntu는 /etc/rsyslog.d/ 디렉토리에 설정 파일을 분리하는 경향이 있음
    if [ -d "/etc/rsyslog.d" ]; then
        for conf_file in /etc/rsyslog.d/*.conf; do
            if [ -f "$conf_file" ] && grep -q "^\*\.\|^authpriv\.\|^mail\.\|^cron\." "$conf_file"; then
                found=true
                log_message "${GREEN}[양호]${NC} 시스템 로깅이 $conf_file에 적절히 설정되어 있습니다."
                log_message "설정 내용:"
                log_message "$(grep "^\*\.\|^authpriv\.\|^mail\.\|^cron\." "$conf_file" | sed 's/^/    /')"
                show_file_content "$conf_file" 15
            fi
        done
    fi
    
    if ! $found; then
        log_message "${RED}[취약]${NC} 시스템 로깅 설정이 미흡합니다."
        if [ -f "/etc/rsyslog.conf" ]; then
            log_message "현재 rsyslog.conf 설정:"
            show_file_content "/etc/rsyslog.conf" 15
        fi
        
        # rsyslog.d 디렉토리 내 파일 확인
        if [ -d "/etc/rsyslog.d" ]; then
            log_message "rsyslog.d 디렉토리 내 설정 파일:"
            for file in /etc/rsyslog.d/*.conf; do
                if [ -f "$file" ]; then
                    log_message "파일: $file"
                    show_file_content "$file" 5
                fi
            done
        fi
        
        log_message "${YELLOW}[조치 방법]${NC}${check_remediation["U-70"]}"
        save_result "U-70" "$item_name" "취약"
    fi
}

# U-73: Cron Logging Check
check_u73() {
    log_message "\n[U-73] Cron 서비스 로깅 설정 점검"
    local item_name="Cron 서비스 로깅 설정"
    
    check_remediation["U-73"]="
    [조치 방법]
    1. /etc/rsyslog.conf 파일에 다음 설정 추가:
       cron.*                                    /var/log/cron
       
    2. 또는 /etc/rsyslog.d/ 디렉터리에 새 파일 생성:
       echo 'cron.*  /var/log/cron' > /etc/rsyslog.d/cron.conf
       
    3. rsyslog 서비스 재시작:
       systemctl restart rsyslog
       
    4. cron 로그 권한 설정:
       chmod 640 /var/log/cron
    "
    
    local cron_log_found=false
    local cron_log_file=""
    
    if [ -f "/etc/rsyslog.conf" ]; then
        if grep -q "cron\.\*" /etc/rsyslog.conf; then
            cron_log_found=true
            cron_log_file="/etc/rsyslog.conf"
            log_message "Cron 로깅 설정: $(grep "cron\.\*" /etc/rsyslog.conf | sed 's/^/    /')"
        else
            # rsyslog.d 디렉터리 확인
            for conf_file in /etc/rsyslog.d/*.conf; do
                if [ -f "$conf_file" ] && grep -q "cron\.\*" "$conf_file"; then
                    cron_log_found=true
                    cron_log_file="$conf_file"
                    log_message "Cron 로깅 설정 ($conf_file): $(grep "cron\.\*" "$conf_file" | sed 's/^/    /')"
                    break
                fi
            done
        fi
        
        if $cron_log_found; then
            log_message "${GREEN}[양호]${NC} Cron 로깅이 설정되어 있습니다."
            show_file_content "$cron_log_file" 15
            save_result "U-73" "$item_name" "양호"
        else
            log_message "${RED}[취약]${NC} Cron 로깅이 설정되어 있지 않습니다."
            log_message "rsyslog.conf 내용:"
            show_file_content "/etc/rsyslog.conf" 15
            
            # rsyslog.d 디렉터리 내 파일 확인
            if [ -d "/etc/rsyslog.d" ]; then
                log_message "rsyslog.d 디렉터리 내 설정 파일:"
                for file in /etc/rsyslog.d/*.conf; do
                    if [ -f "$file" ]; then
                        log_message "파일: $file"
                        show_file_content "$file" 5
                    fi
                done
            fi
            log_message "${YELLOW}[조치 방법]${NC}${check_remediation["U-73"]}"
            save_result "U-73" "$item_name" "취약"
        fi
    else
        log_message "${RED}[취약]${NC} rsyslog 설정 파일이 존재하지 않습니다."
        log_message "${YELLOW}[조치 방법]${NC}${check_remediation["U-73"]}"
        save_result "U-73" "$item_name" "취약"
    fi
}

# Function to check all items
check_all() {
    
    total_checks=0
    passed_checks=0
    failed_checks=0
    na_checks=0
    
    declare -A check_results
    declare -A check_names
    
    log_message "\n전체 보안 취약점 점검을 시작합니다..." "$CHECK_OUTPUT_FILE"
    local check_functions=(
        "u03" "u07" "u08" "u10" "u11" "u15" "u23" 
        "u24" "u25" "u28" "u45" "u70" "u73"
    )
    
    for id in "${check_functions[@]}"; do
        check_$id
    done
    
    # 결과 테이블 출력
    print_result_table
    
    log_message "\n점검이 완료되었습니다. 결과는 ${CHECK_OUTPUT_FILE}에 저장되었습니다." "$CHECK_OUTPUT_FILE"
}

# Function to check items skipping time-consuming ones
check_all_skip_time_consuming() {
    
    # 통계 변수 및 결과 배열 초기화
    
    total_checks=0
    passed_checks=0
    failed_checks=0
    na_checks=0
    
    declare -A check_results
    declare -A check_names

    log_message "\n시간이 오래 걸리는 항목을 제외하고 점검을 시작합니다..." "$CHECK_OUTPUT_FILE"
    local check_functions=(
        "u03" "u07" "u08" "u10" "u11" "u45" "u70" "u73"
    )
    
    for id in "${check_functions[@]}"; do
        check_$id
    done
    
    # 결과 테이블 출력
    print_result_table
    
    log_message "\n점검이 완료되었습니다. 결과는 ${CHECK_OUTPUT_FILE}에 저장되었습니다." "$CHECK_OUTPUT_FILE"
}

# Function to check selected items
check_selected() {

    total_checks=0
    passed_checks=0
    failed_checks=0
    na_checks=0
    
    declare -A check_results
    declare -A check_names

    echo -e "\n${GREEN}점검할 항목을 선택하세요 (공백으로 구분)${NC}"
    echo "1) U-03: SU 명령 사용가능 그룹 제한"
    echo "2) U-07: 계정 잠금 임계값 설정"
    echo "3) U-08: 불필요한 Shell 계정"
    echo "4) U-10: 원격 터미널 접속 타임아웃"
    echo "5) U-11: 계정 비밀번호 기록 개수"
    echo "6) U-15: 불필요한 숨김 파일"
    echo "7) U-23: SUID/SGID"
    echo "8) U-24: 사용자 환경파일 권한"
    echo "9) U-25: World writable 파일"
    echo "10) U-28: 시스템 디렉터리 권한"
    echo "11) U-45: 시스템 경고 메시지"
    echo "12) U-70: 시스템 로깅"
    echo "13) U-73: Cron 로깅"
    
    read -p "선택하세요 (예: 1 3 4): " -a selections
    
    for selection in "${selections[@]}"; do
        case $selection in
            1) check_u03 ;;
            2) check_u07 ;;
            3) check_u08 ;;
            4) check_u10 ;;
            5) check_u11 ;;
            6) check_u15 ;;
            7) check_u23 ;;
            8) check_u24 ;;
            9) check_u25 ;;
            10) check_u28 ;;
            11) check_u45 ;;
            12) check_u70 ;;
            13) check_u73 ;;
            *) echo "잘못된 선택: $selection" ;;
        esac
    done
    
    # 결과 테이블 출력
    print_result_table
}

# Main menu
main_menu() {
    while true; do
        display_menu "점검"
        read -p "선택하세요: " choice

        case $choice in
            1) check_all ;;
            2) check_selected ;;
            3) check_all_skip_time_consuming ;;
            4) exit 0 ;;
            *) echo "잘못된 선택입니다." ;;
        esac
    done
}

# Start script
main_menu