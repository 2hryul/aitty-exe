#!/bin/bash

# Source common functions
source ./common.sh

# Initialize fix-specific variables
TIMESTAMP=$(date +%Y%m%d%H%M%S)
HOSTNAME=$(hostname)
FIX_OUTPUT_FILE="${HOSTNAME}-fix_${TIMESTAMP}.txt"
BACKUP_DIR="/var/backup/security_fix_${TIMESTAMP}"

# 초기화 함수
init_fix() {
    # 로그 초기화
    init_log "$FIX_OUTPUT_FILE" "Fix"
    log_message "보안 취약점 조치 스크립트를 시작합니다."
    
    # 백업 디렉터리 생성
    if [ ! -d "$BACKUP_DIR" ]; then
        mkdir -p "$BACKUP_DIR"
        log_message "백업 디렉터리를 생성했습니다: $BACKUP_DIR"
    fi
}

# 파일 백업 함수
backup_file() {
    local file=$1
    local backup_path="${BACKUP_DIR}$(dirname "$file")"
    
    if [ -f "$file" ]; then
        mkdir -p "$backup_path"
        cp -p "$file" "${BACKUP_DIR}${file}"
        log_message "${GREEN}[백업]${NC} $file -> ${BACKUP_DIR}${file}"
        return 0
    else
        log_message "${YELLOW}[경고]${NC} 백업하려는 파일이 존재하지 않습니다: $file"
        return 1
    fi
}

# K8S 영향 항목 확인 함수
confirm_k8s_sensitive() {
    local id=$1
    local item_name=$2
    
    if is_k8s_sensitive "$id"; then
        log_message "${YELLOW}[주의]${NC} 이 조치는 K8S 운영에 영향을 줄 수 있습니다: $item_name"
        read -p "계속 진행하시겠습니까? (y/n): " choice
        
        case "$choice" in
            y|Y) return 0 ;;
            *) log_message "사용자 요청으로 $item_name 조치를 건너뜁니다."
               return 1 ;;
        esac
    fi
    
    return 0
}

# 파일 내용 표시 함수
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

# U-03: SU 명령 사용가능 그룹 제한 조치 (Ubuntu 버전)
fix_u03() {
    log_message "\n[U-03] SU 명령 사용가능 그룹 제한 조치"
    
    if [ ! -f "/etc/pam.d/su" ] || [ ! -f "/usr/bin/su" ]; then
        log_message "${YELLOW}[해당없음]${NC} SU 관련 파일이 존재하지 않습니다."
        return
    fi
    
    # 현재 설정 확인 및 표시
    local pam_wheel=$(grep "^auth.*required.*pam_wheel.so" /etc/pam.d/su)
    local su_perm=$(stat -c %a /usr/bin/su)
    
    # Ubuntu에서는 sudo 그룹 확인
    local sudo_group=$(grep "^sudo:" /etc/group)
    
    log_message "현재 PAM 설정: $(grep "pam_wheel.so" /etc/pam.d/su || echo "없음")"
    log_message "현재 SU 권한: $su_perm"
    log_message "sudo 그룹: $sudo_group"
    show_file_content "/etc/pam.d/su"
    
    # 백업
    backup_file "/etc/pam.d/su"
    
    # PAM wheel 설정 추가
    if [[ -z "$pam_wheel" ]]; then
        log_message "PAM wheel 설정을 추가합니다."
        echo "auth required pam_wheel.so use_uid" >> /etc/pam.d/su
    fi
    
    # SU 권한 조정
    if [[ "$su_perm" -gt "4750" ]]; then
        log_message "SU 명령어 권한을 4750으로 제한합니다."
        chmod 4750 /usr/bin/su
    fi
    
    # Ubuntu에서는 기본적으로 sudo 그룹 사용
    if [[ -z "$sudo_group" ]]; then
        log_message "sudo 그룹이 없습니다. wheel 그룹을 생성합니다."
        groupadd wheel
        log_message "root 사용자를 wheel 그룹에 추가합니다."
        usermod -aG wheel root
    else
        log_message "Ubuntu는 기본적으로 sudo 그룹을 사용합니다."
        # root 사용자가 sudo 그룹에 없으면 추가
        if ! id -nG root | grep -q "sudo"; then
            log_message "root 사용자를 sudo 그룹에 추가합니다."
            usermod -aG sudo root
        fi
    fi
    
    log_message "${GREEN}[조치완료]${NC} SU 명령 사용가능 그룹 제한 조치를 완료했습니다."
    log_message "변경된 설정:"
    log_message "PAM 설정: $(grep "pam_wheel.so" /etc/pam.d/su || echo "없음")"
    log_message "SU 권한: $(stat -c %a /usr/bin/su)"
    if [[ -n "$sudo_group" ]]; then
        log_message "sudo 그룹: $sudo_group"
    else
        log_message "wheel 그룹: $(grep "^wheel:" /etc/group)"
    fi
}

# U-07: 계정 잠금 임계값 설정 조치 (Ubuntu 22.04 버전)
fix_u07() {
    log_message "\n[U-07] 계정 잠금 임계값 설정 조치"
    
    local auth_file="/etc/pam.d/common-auth"
    local faillock_conf="/etc/security/faillock.conf"
    
    if [ ! -f "$auth_file" ]; then
        log_message "${YELLOW}[주의]${NC} PAM 인증 설정 파일을 찾을 수 없습니다."
        return
    fi
    
    # 현재 설정 확인 및 표시
    log_message "현재 설정 파일: $auth_file"
    local current_setting=$(grep "pam_faillock.so\|pam_tally2.so" "$auth_file" || echo "설정 없음")
    log_message "현재 설정: $current_setting"
    show_file_content "$auth_file"
    
    # faillock.conf 파일 확인
    if [ -f "$faillock_conf" ]; then
        log_message "현재 faillock 설정 파일: $faillock_conf"
        show_file_content "$faillock_conf"
    fi
    
    # 백업
    backup_file "$auth_file"
    if [ -f "$faillock_conf" ]; then
        backup_file "$faillock_conf"
    fi
    
    # 계정 잠금 설정 추가
    local updated=false
    
    # Ubuntu 22.04는 주로 pam_faillock.so 사용
    if ! grep -q "pam_faillock.so" "$auth_file"; then
        log_message "계정 잠금 임계값을 설정합니다 (pam_faillock 사용)."
        sed -i '/^auth.*sufficient.*pam_unix.so/i auth required pam_faillock.so preauth silent deny=5 unlock_time=300' "$auth_file"
        sed -i '/^auth.*sufficient.*pam_unix.so/a auth [default=die] pam_faillock.so authfail deny=5 unlock_time=300' "$auth_file"
        updated=true
    fi
    
    # faillock.conf 파일이 있으면 설정 추가
    if [ -f "$faillock_conf" ] && ! grep -q "deny =" "$faillock_conf"; then
        log_message "faillock.conf에 계정 잠금 임계값을 설정합니다."
        echo "deny = 5" >> "$faillock_conf"
        echo "unlock_time = 300" >> "$faillock_conf"
        updated=true
    # faillock.conf 파일이 없으면 생성
    elif [ ! -f "$faillock_conf" ] && [ -d "$(dirname "$faillock_conf")" ]; then
        log_message "faillock.conf 파일을 생성하고 계정 잠금 임계값을 설정합니다."
        mkdir -p "$(dirname "$faillock_conf")"
        cat > "$faillock_conf" << EOF
# Default settings for faillock

# 5회 인증 실패 시 계정 잠금
deny = 5
# 5분 후 자동 잠금 해제
unlock_time = 300
EOF
        updated=true
    fi
    
    if $updated; then
        log_message "${GREEN}[조치완료]${NC} 계정 잠금 임계값 설정 조치를 완료했습니다."
        
        log_message "변경된 PAM 설정:"
        show_file_content "$auth_file"
        
        if [ -f "$faillock_conf" ]; then
            log_message "변경된 faillock 설정:"
            show_file_content "$faillock_conf"
        fi
    else
        log_message "${GREEN}[양호]${NC} 계정 잠금 임계값이 이미 설정되어 있습니다."
    fi
}

# U-08: 불필요한 Shell 계정 조치 (Ubuntu 버전)
fix_u08() {
    log_message "\n[U-08] 불필요한 Shell 계정 조치"
    
    # K8S 영향 확인
    if ! confirm_k8s_sensitive "U-08" "불필요한 Shell 계정 조치"; then
        return
    fi
    
    # Ubuntu 22.04에서 일반적으로 허용되는 계정 목록 (root, ubuntu 포함)
    # UID 1000 이상의 일반 사용자 계정만 검사
    local unnecessary_shells=$(awk -F: '$7 != "/usr/sbin/nologin" && $7 != "/bin/false" && $1 != "root" && $1 != "ubuntu" && $3 >= 1000 {print $1}' /etc/passwd)
    
    if [ -z "$unnecessary_shells" ]; then
        log_message "${GREEN}[양호]${NC} 불필요한 Shell 계정이 존재하지 않습니다."
        return
    fi
    
    # 백업
    backup_file "/etc/passwd"
    
    # 계정 목록 표시
    log_message "다음 계정들의 쉘을 /usr/sbin/nologin으로 변경합니다:"
    for account in $unnecessary_shells; do
        log_message "  - $account (현재 설정: $(grep "^$account:" /etc/passwd | cut -d: -f7))"
        usermod -s /usr/sbin/nologin "$account"
    done
    
    log_message "${GREEN}[조치완료]${NC} 불필요한 Shell 계정 조치를 완료했습니다."
    log_message "변경된 설정:"
    for account in $unnecessary_shells; do
        log_message "  - $account (변경 후: $(grep "^$account:" /etc/passwd | cut -d: -f7))"
    done
}

# U-10: 원격 터미널 접속 타임아웃 설정 조치
fix_u10() {
    log_message "\n[U-10] 원격 터미널 접속 타임아웃 설정 조치"
    
    local profile_file="/etc/profile"
    
    # 현재 설정 확인 및 표시
    local tmout_set=false
    local tmout_value=""
    
    for file in /etc/profile /etc/bash.bashrc; do
        if [ -f "$file" ] && grep -q "TMOUT=" "$file"; then
            tmout_set=true
            tmout_value=$(grep "TMOUT=" "$file")
            log_message "현재 설정 파일: $file"
            log_message "현재 설정: $tmout_value"
            break
        fi
    done
    
    if ! $tmout_set; then
        log_message "타임아웃 설정이 없습니다."
    fi
    
    show_file_content "$profile_file"
    
    # 백업
    backup_file "$profile_file"
    
    # 타임아웃 설정 추가
    if ! $tmout_set; then
        log_message "원격 터미널 타임아웃을 설정합니다."
        echo "" >> "$profile_file"
        echo "# Set session timeout (600 seconds = 10 minutes)" >> "$profile_file"
        echo "TMOUT=600" >> "$profile_file"
        echo "readonly TMOUT" >> "$profile_file"
        echo "export TMOUT" >> "$profile_file"
    fi
    
    log_message "${GREEN}[조치완료]${NC} 원격 터미널 접속 타임아웃 설정 조치를 완료했습니다."
    log_message "변경된 설정:"
    show_file_content "$profile_file" 5 | tail -5
}

# U-11: 계정 비밀번호 기록 개수 설정 조치 (Ubuntu 버전)
fix_u11() {
    log_message "\n[U-11] 계정 비밀번호 기록 개수 설정 조치"
    
    local password_file="/etc/pam.d/common-password"
    
    if [ ! -f "$password_file" ]; then
        log_message "${YELLOW}[주의]${NC} common-password 파일이 존재하지 않습니다."
        return
    fi
    
    # 현재 설정 확인 및 표시
    log_message "현재 PAM 설정 파일: $password_file"
    local pwhistory_setting=$(grep "pam_pwhistory.so.*remember=" "$password_file" || echo "없음")
    local unix_setting=$(grep "pam_unix.so.*remember=" "$password_file" || echo "없음")
    
    log_message "현재 pwhistory 설정: $pwhistory_setting"
    log_message "현재 pam_unix 설정: $unix_setting"
    show_file_content "$password_file"
    
    # 백업
    backup_file "$password_file"
    
    # 비밀번호 기록 개수 설정
    if [ "$pwhistory_setting" = "없음" ] && [ "$unix_setting" = "없음" ]; then
        log_message "비밀번호 기록 개수를 설정합니다 (pam_pwhistory 사용)."
        
        # Ubuntu에서는 pam_pwhistory.so 모듈 사용
        if grep -q "pam_unix.so" "$password_file"; then
            # pam_unix.so 라인 앞에 pwhistory 모듈 추가
            sed -i '/^password.*pam_unix.so/i password        required      pam_pwhistory.so remember=5' "$password_file"
        else
            # 파일 끝에 추가
            echo "password        required      pam_pwhistory.so remember=5" >> "$password_file"
        fi
        
        log_message "${GREEN}[조치완료]${NC} 계정 비밀번호 기록 개수 설정 조치를 완료했습니다."
        log_message "변경된 설정:"
        show_file_content "$password_file"
    else
        log_message "${GREEN}[양호]${NC} 비밀번호 기록 개수가 이미 설정되어 있습니다."
    fi
}

# U-15: 불필요한 숨김 파일 또는 디렉터리 조치
fix_u15() {
    log_message "\n[U-15] 불필요한 숨김 파일 또는 디렉터리 조치"
    
    # 불필요한 숨김 파일 목록 가져오기
    local hidden_files=$(find /tmp -name ".*" -type f 2>/dev/null)
    
    if [ -z "$hidden_files" ]; then
        log_message "${GREEN}[양호]${NC} 불필요한 숨김 파일이 존재하지 않습니다."
        return
    fi
    
    # 파일 목록 표시
    log_message "다음 불필요한 숨김 파일을 제거합니다:"
    for file in $hidden_files; do
        log_message "  - $file (권한: $(ls -la "$file" | awk '{print $1, $3, $4}'))"
        show_file_content "$file" 3
    done
    
    # 제거 확인
    read -p "위 파일들을 제거하시겠습니까? (y/n): " choice
    
    if [[ "$choice" =~ ^[Yy]$ ]]; then
        # 백업 디렉터리 생성
        local hidden_backup_dir="${BACKUP_DIR}/tmp_hidden_files"
        mkdir -p "$hidden_backup_dir"
        
        # 파일 백업 및 제거
        for file in $hidden_files; do
            local backup_filename=$(echo "$file" | sed 's|/|_|g')
            cp -p "$file" "${hidden_backup_dir}/${backup_filename}"
            log_message "${GREEN}[백업]${NC} $file -> ${hidden_backup_dir}/${backup_filename}"
            rm -f "$file"
            log_message "파일을 제거했습니다: $file"
        done
        
        log_message "${GREEN}[조치완료]${NC} 불필요한 숨김 파일 제거 조치를 완료했습니다."
    else
        log_message "사용자 요청으로 파일 제거를 취소했습니다."
    fi
}

# U-23: SUID/SGID 조치
fix_u23() {
    log_message "\n[U-23] SUID, SGID, STICKY BIT 설정 파일 조치"
    
    # K8S 영향 확인
    if ! confirm_k8s_sensitive "U-23" "SUID/SGID 파일 조치"; then
        return
    fi
    
    # 필수 SUID/SGID 파일 목록 (시스템 운영에 필요한 파일)
    local essential_suid=(
        "/bin/su" "/usr/bin/su" "/bin/sudo" "/usr/bin/sudo" 
        "/bin/mount" "/usr/bin/mount" "/bin/umount" "/usr/bin/umount" 
        "/bin/ping" "/usr/bin/ping" "/usr/bin/passwd" "/bin/passwd"
        "/usr/bin/chfn" "/usr/bin/chsh" "/usr/bin/newgrp" "/usr/bin/gpasswd"
    )
    
    # SUID/SGID 파일 목록 가져오기
    local suid_files=$(find / -type f \( -perm -4000 -o -perm -2000 \) -exec ls -l {} \; 2>/dev/null)
    
    if [ -z "$suid_files" ]; then
        log_message "${GREEN}[양호]${NC} SUID/SGID 파일이 존재하지 않습니다."
        return
    fi
    
    # 파일 분류
    log_message "SUID/SGID 파일 목록:"
    log_message "$suid_files"
    
    local nonessential_files=()
    
    for file in $(echo "$suid_files" | awk '{print $9}'); do
        local is_essential=false
        
        for essential in "${essential_suid[@]}"; do
            if [ "$file" = "$essential" ]; then
                is_essential=true
                break
            fi
        done
        
        if ! $is_essential; then
            nonessential_files+=("$file")
        fi
    done
    
    if [ ${#nonessential_files[@]} -eq 0 ]; then
        log_message "${GREEN}[양호]${NC} 모든 SUID/SGID 파일이 필수 파일입니다."
        return
    fi
    
    # 불필요한 파일 목록 표시
    log_message "다음 불필요한 SUID/SGID 파일의 권한을 변경합니다:"
    for file in "${nonessential_files[@]}"; do
        log_message "  - $file (권한: $(ls -la "$file" | awk '{print $1}'))"
    done
    
    # 제거 확인
    read -p "위 파일들의 SUID/SGID 권한을 제거하시겠습니까? (y/n): " choice
    
    if [[ "$choice" =~ ^[Yy]$ ]]; then
        # 백업 및 권한 변경
        for file in "${nonessential_files[@]}"; do
            # 파일 속성 백업
            local perm=$(stat -c %a "$file")
            local owner=$(stat -c %U "$file")
            local group=$(stat -c %G "$file")
            
            # 백업 정보 저장
            echo "$file:$perm:$owner:$group" >> "${BACKUP_DIR}/suid_sgid_backups.txt"
            
            # SUID/SGID 비트 제거 (권한 맨 앞자리 변경)
            local new_perm=$(echo "$perm" | sed 's/^[4-7]/0/')
            chmod "$new_perm" "$file"
            
            log_message "권한을 변경했습니다: $file ($perm -> $new_perm)"
        done
        
        log_message "${GREEN}[조치완료]${NC} 불필요한 SUID/SGID 파일 권한 변경 조치를 완료했습니다."
        log_message "백업 정보: ${BACKUP_DIR}/suid_sgid_backups.txt"
    else
        log_message "사용자 요청으로 권한 변경을 취소했습니다."
    fi
}

# U-24: 사용자 환경파일의 소유자 또는 권한 설정 조치
fix_u24() {
    log_message "\n[U-24] 사용자 환경파일의 소유자 또는 권한 설정 조치"
    
    local env_files=(".profile" ".bashrc" ".bash_profile")
    local vulnerable_files=()
    
    # 취약한 파일 찾기
    for file in "${env_files[@]}"; do
        if [ -f "$HOME/$file" ]; then
            local perm=$(stat -c %a "$HOME/$file")
            if [ "$perm" -gt "750" ]; then
                vulnerable_files+=("$HOME/$file")
            fi
        fi
    done
    
    if [ ${#vulnerable_files[@]} -eq 0 ]; then
        log_message "${GREEN}[양호]${NC} 모든 환경 파일의 권한이 적절히 설정되어 있습니다."
        return
    fi
    
    # 취약한 파일 목록 표시
    log_message "다음 환경 파일의 권한이 750보다 큽니다:"
    for file in "${vulnerable_files[@]}"; do
        log_message "  - $file (권한: $(stat -c %a "$file"))"
        show_file_content "$file" 5
    done
    
    # 백업 및 권한 변경
    for file in "${vulnerable_files[@]}"; do
        # 백업
        backup_file "$file"
        
        # 권한 변경
        local old_perm=$(stat -c %a "$file")
        chmod 750 "$file"
        
        log_message "파일 권한을 변경했습니다: $file ($old_perm -> 750)"
    done
    
    log_message "${GREEN}[조치완료]${NC} 사용자 환경파일 권한 설정 조치를 완료했습니다."
}

# U-25: World Writable 파일 조치
fix_u25() {
    log_message "\n[U-25] 불필요한 world writable 파일 조치"
    
    # K8S 영향 확인
    if ! confirm_k8s_sensitive "U-25" "World Writable 파일 조치"; then
        return
    fi
    
    # World writable 파일 목록 가져오기
    local world_writable=$(find / -type f -perm -0002 -not -path "/proc/*" -not -path "/sys/*" -not -path "/run/*" -not -path "/dev/*" -ls 2>/dev/null)
    
    if [ -z "$world_writable" ]; then
        log_message "${GREEN}[양호]${NC} 불필요한 world writable 파일이 존재하지 않습니다."
        return
    fi
    
    # 파일 목록 표시
    log_message "다음 world writable 파일의 권한을 변경합니다:"
    echo "$world_writable" > "${BACKUP_DIR}/world_writable_files.txt"
    log_message "전체 파일 목록이 ${BACKUP_DIR}/world_writable_files.txt 에 저장되었습니다."
    
    # 일부 파일 예시 표시
    local sample_files=$(echo "$world_writable" | awk '{print $11}' | head -5)
    for file in $sample_files; do
        log_message "  - $file (권한: $(ls -la "$file" | awk '{print $1}'))"
    done
    log_message "  ... 외 다수 (총 $(echo "$world_writable" | wc -l)개 파일)"
    
    # 제거 확인
    read -p "모든 world writable 파일의 권한을 변경하시겠습니까? (y/n): " choice
    
    if [[ "$choice" =~ ^[Yy]$ ]]; then
        # 백업 및 권한 변경
        for file in $(echo "$world_writable" | awk '{print $11}'); do
            # 파일 속성 백업
            local perm=$(stat -c %a "$file")
            local owner=$(stat -c %U "$file")
            local group=$(stat -c %G "$file")
            
            # 백업 정보 저장
            echo "$file:$perm:$owner:$group" >> "${BACKUP_DIR}/world_writable_backups.txt"
            
            # World writable 비트 제거
            chmod o-w "$file"
            
            # 로그 문구를 간소화하여 불필요한 스크롤을 줄임
            if [ $(echo "$world_writable" | wc -l) -lt 20 ]; then
                log_message "권한을 변경했습니다: $file ($(stat -c %a "$file")))"
            fi
        done
        
        log_message "${GREEN}[조치완료]${NC} World writable 파일 권한 변경 조치를 완료했습니다."
        log_message "총 $(echo "$world_writable" | wc -l)개 파일의 권한을 변경했습니다."
        log_message "백업 정보: ${BACKUP_DIR}/world_writable_backups.txt"
    else
        log_message "사용자 요청으로 권한 변경을 취소했습니다."
    fi
}

# U-28: 시스템 주요 디렉터리 권한 설정 조치
fix_u28() {
    log_message "\n[U-28] 시스템 주요 디렉터리 권한 설정 조치"
    
    local dirs=("/etc" "/usr" "/var" "/bin" "/sbin")
    local vulnerable_dirs=()
    
    # 취약한 디렉터리 찾기
    for dir in "${dirs[@]}"; do
        if [ -d "$dir" ]; then
            local perm=$(stat -c %a "$dir")
            if [ "$perm" -gt "755" ]; then
                vulnerable_dirs+=("$dir")
            fi
        fi
    done
    
    if [ ${#vulnerable_dirs[@]} -eq 0 ]; then
        log_message "${GREEN}[양호]${NC} 모든 시스템 디렉터리의 권한이 적절히 설정되어 있습니다."
        return
    fi
    
    # 취약한 디렉터리 목록 표시
    log_message "다음 시스템 디렉터리의 권한이 755보다 큽니다:"
    for dir in "${vulnerable_dirs[@]}"; do
        log_message "  - $dir (권한: $(stat -c %a "$dir"))"
        log_message "    소유자: $(stat -c %U "$dir"), 그룹: $(stat -c %G "$dir")"
        ls -ld "$dir"
    done
    
    # 백업 및 권한 변경
    for dir in "${vulnerable_dirs[@]}"; do
        # 백업 정보 저장
        local perm=$(stat -c %a "$dir")
        local owner=$(stat -c %U "$dir")
        local group=$(stat -c %G "$dir")
        echo "$dir:$perm:$owner:$group" >> "${BACKUP_DIR}/system_dirs_backups.txt"
        
        # 권한 변경
        chmod 755 "$dir"
        
        log_message "디렉터리 권한을 변경했습니다: $dir ($perm -> 755)"
    done
    
    log_message "${GREEN}[조치완료]${NC} 시스템 주요 디렉터리 권한 설정 조치를 완료했습니다."
    log_message "백업 정보: ${BACKUP_DIR}/system_dirs_backups.txt"
}

# U-45: 시스템 사용 주의사항 출력 조치
fix_u45() {
    log_message "\n[U-45] 시스템 사용 주의사항 출력 조치"
    
    local warning_files=("/etc/motd" "/etc/issue.net" "/etc/issue")
    local warning_set=false
    
    # 현재 설정 확인
    for file in "${warning_files[@]}"; do
        if [ -s "$file" ]; then
            warning_set=true
            log_message "경고 메시지가 설정된 파일: $file"
            show_file_content "$file"
        fi
    done
    
    if $warning_set; then
        log_message "${GREEN}[양호]${NC} 시스템 사용 주의사항이 이미 설정되어 있습니다."
        return
    fi
    
    # 경고 메시지 추가
    local warning_message="
******************************************
* WARNING: Unauthorized access prohibited *
* All activities are monitored and logged *
* Violators will be prosecuted            *
******************************************

This system is for authorized use only.
Unauthorized access is prohibited.
"
    
    for file in "${warning_files[@]}"; do
        backup_file "$file"
        
        # 경고 메시지 설정
        echo "$warning_message" > "$file"
        
        log_message "경고 메시지를 추가했습니다: $file"
        show_file_content "$file"
    done
    
    log_message "${GREEN}[조치완료]${NC} 시스템 사용 주의사항 출력 조치를 완료했습니다."
}

# U-70: 시스템 로깅 설정 조치 (Ubuntu 버전)
fix_u70() {
    log_message "\n[U-70] 정책에 따른 시스템 로깅 설정 조치"
    
    local rsyslog_conf="/etc/rsyslog.conf"
    local rsyslog_dir="/etc/rsyslog.d"
    local default_conf="${rsyslog_dir}/50-default.conf"
    
    if [ ! -f "$rsyslog_conf" ]; then
        log_message "${YELLOW}[주의]${NC} rsyslog.conf 파일이 존재하지 않습니다."
        
        # rsyslog 설치 여부 확인
        if ! command -v rsyslogd &> /dev/null; then
            log_message "rsyslog가 설치되어 있지 않습니다. 설치를 시도합니다."
            
            # 패키지 매니저 확인 및 설치
            if command -v apt-get &> /dev/null; then
                apt-get update && apt-get install -y rsyslog
            elif command -v yum &> /dev/null; then
                yum install -y rsyslog
            else
                log_message "${RED}[오류]${NC} 패키지 매니저를 찾을 수 없습니다. rsyslog를 수동으로 설치해주세요."
                return
            fi
            
            # 설치 확인
            if [ -f "$rsyslog_conf" ]; then
                log_message "rsyslog를 설치했습니다."
            else
                log_message "${RED}[오류]${NC} rsyslog 설치 후에도 설정 파일이 없습니다."
                return
            fi
        fi
    fi
    
    # 현재 설정 확인
    log_message "현재 rsyslog 설정:"
    show_file_content "$rsyslog_conf"
    
    # rsyslog.d 디렉토리 확인
    if [ -d "$rsyslog_dir" ]; then
        for conf_file in "$rsyslog_dir"/*.conf; do
            if [ -f "$conf_file" ]; then
                log_message "rsyslog.d 내 설정 파일: $conf_file"
                show_file_content "$conf_file" 10
            fi
        done
    fi
    
    # 적절한 로깅 설정 확인
    local found_proper_logging=false
    
    # rsyslog.conf에서 확인
    if grep -q "^\*\.\|^auth,\|^authpriv\.\|^mail\.\|^cron\." "$rsyslog_conf"; then
        found_proper_logging=true
    fi
    
    # rsyslog.d 디렉토리에서 확인
    if [ -d "$rsyslog_dir" ]; then
        for conf_file in "$rsyslog_dir"/*.conf; do
            if [ -f "$conf_file" ] && grep -q "^\*\.\|^auth,\|^authpriv\.\|^mail\.\|^cron\." "$conf_file"; then
                found_proper_logging=true
                break
            fi
        done
    fi
    
    if ! $found_proper_logging; then
        # 백업
        if [ -f "$default_conf" ]; then
            backup_file "$default_conf"
        else
            # default.conf가 없으면 디렉토리 생성
            mkdir -p "$rsyslog_dir"
        fi
        
        # Ubuntu 스타일 로깅 설정 추가
        log_message "Ubuntu 표준 로깅 설정을 추가합니다."
        
        cat > "$default_conf" << EOF
# Default logging rules for Ubuntu
#
auth,authpriv.*                 /var/log/auth.log
*.*;auth,authpriv.none          /var/log/syslog
cron.*                          /var/log/cron.log
daemon.*                        /var/log/daemon.log
kern.*                          /var/log/kern.log
lpr.*                           /var/log/lpr.log
mail.*                          /var/log/mail.log
user.*                          /var/log/user.log

# Emergencies are sent to everybody logged in.
*.emerg                         :omusrmsg:*
EOF
        
        # 로그 파일 권한 설정
        log_message "로그 파일 권한을 설정합니다."
        for log_file in /var/log/auth.log /var/log/syslog /var/log/cron.log /var/log/daemon.log /var/log/kern.log /var/log/mail.log /var/log/user.log; do
            if [ ! -f "$log_file" ]; then
                touch "$log_file"
            fi
            chmod 640 "$log_file"
            log_message "로그 파일 권한 설정: $log_file (640)"
        done
        
        # rsyslog 서비스 재시작
        if systemctl is-active --quiet rsyslog; then
            systemctl restart rsyslog
            log_message "rsyslog 서비스를 재시작했습니다."
        else
            log_message "${YELLOW}[주의]${NC} rsyslog 서비스가 실행 중이 아닙니다. 수동으로 시작해주세요."
        fi
        
        log_message "${GREEN}[조치완료]${NC} 시스템 로깅 설정 조치를 완료했습니다."
        log_message "설정 파일: $default_conf"
        show_file_content "$default_conf"
    else
        log_message "${GREEN}[양호]${NC} 시스템 로깅이 이미 적절히 설정되어 있습니다."
    fi
}

# U-73: Cron 로깅 설정 조치 (Ubuntu 버전)
fix_u73() {
    log_message "\n[U-73] Cron 서비스 로깅 설정 조치"
    
    local rsyslog_conf="/etc/rsyslog.conf"
    local cron_conf="/etc/rsyslog.d/cron.conf"
    
    # rsyslog 설치 확인
    if [ ! -f "$rsyslog_conf" ]; then
        log_message "${YELLOW}[주의]${NC} rsyslog.conf 파일이 존재하지 않습니다."
        return
    fi
    
    # 현재 설정 확인
    local cron_log_found=false
    local cron_log_file=""
    
    if grep -q "cron\.\*" "$rsyslog_conf"; then
        cron_log_found=true
        cron_log_file="$rsyslog_conf"
    else
        # rsyslog.d 디렉터리 확인
        for conf_file in /etc/rsyslog.d/*.conf; do
            if [ -f "$conf_file" ] && grep -q "cron\.\*" "$conf_file"; then
                cron_log_found=true
                cron_log_file="$conf_file"
                break
            fi
        done
    fi
    
    if $cron_log_found; then
        log_message "${GREEN}[양호]${NC} Cron 로깅이 이미 설정되어 있습니다."
        log_message "설정 파일: $cron_log_file"
        log_message "설정 내용: $(grep "cron\.\*" "$cron_log_file")"
        return
    fi
    
    # rsyslog.d 디렉터리 확인 및 생성
    if [ ! -d "/etc/rsyslog.d" ]; then
        mkdir -p "/etc/rsyslog.d"
        log_message "rsyslog.d 디렉터리를 생성했습니다."
    fi
    
    # Cron 로깅 설정 추가
    log_message "Cron 로깅 설정을 추가합니다."
    
    if [ -f "$rsyslog_conf" ]; then
        backup_file "$rsyslog_conf"
    fi
    
    # Ubuntu에서 표준 경로 사용
    echo "cron.*  /var/log/cron.log" > "$cron_conf"
    log_message "Cron 로깅 설정을 추가했습니다: $cron_conf"
    
    # cron 로그 파일 확인 및 생성
    if [ ! -f "/var/log/cron.log" ]; then
        touch "/var/log/cron.log"
        chmod 640 "/var/log/cron.log"
        log_message "Cron 로그 파일을 생성했습니다: /var/log/cron.log"
    fi
    
    # rsyslog 서비스 재시작
    if systemctl is-active --quiet rsyslog; then
        systemctl restart rsyslog
        log_message "rsyslog 서비스를 재시작했습니다."
    else
        log_message "${YELLOW}[주의]${NC} rsyslog 서비스가 실행 중이 아닙니다. 수동으로 시작해주세요."
    fi
    
    log_message "${GREEN}[조치완료]${NC} Cron 로깅 설정 조치를 완료했습니다."
}

# 모든 항목 조치 함수
fix_all() {
    log_message "\n전체 보안 취약점 조치를 시작합니다..."
    
    local fix_functions=(
        "u03" "u07" "u08" "u10" "u11" "u15" "u23" 
        "u24" "u25" "u28" "u45" "u70" "u73"
    )
    
    for id in "${fix_functions[@]}"; do
        fix_$id
    done
    
    log_message "\n전체 보안 취약점 조치가 완료되었습니다."
    log_message "백업 디렉터리: $BACKUP_DIR"
}

# 선택 항목 조치 함수
fix_selected() {
    echo -e "\n${GREEN}조치할 항목을 선택하세요 (공백으로 구분)${NC}"
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
            1) fix_u03 ;;
            2) fix_u07 ;;
            3) fix_u08 ;;
            4) fix_u10 ;;
            5) fix_u11 ;;
            6) fix_u15 ;;
            7) fix_u23 ;;
            8) fix_u24 ;;
            9) fix_u25 ;;
            10) fix_u28 ;;
            11) fix_u45 ;;
            12) fix_u70 ;;
            13) fix_u73 ;;
            *) echo "잘못된 선택: $selection" ;;
        esac
    done
}

# 조치 후 점검 실행 함수
run_check_after_fix() {
    log_message "\n조치 후 취약점 점검을 실행합니다..."
    
    if [ -f "./check.sh" ]; then
        bash ./check.sh
    else
        log_message "${RED}[오류]${NC} check.sh 파일을 찾을 수 없습니다."
    fi
}

# 메인 메뉴
main_menu() {
    # 초기화
    init_fix
    
    while true; do
        echo -e "\n${GREEN}===== 보안 취약점 조치 메뉴 =====${NC}"
        echo "1) 모든 항목 조치"
        echo "2) 선택 항목 조치"
        echo "3) 조치 후 점검 실행"
        echo "4) 종료"
        
        read -p "선택하세요: " choice

        case $choice in
            1) fix_all ;;
            2) fix_selected ;;
            3) run_check_after_fix ;;
            4) exit 0 ;;
            *) echo "잘못된 선택입니다." ;;
        esac
    done
}

# 스크립트 시작
main_menu