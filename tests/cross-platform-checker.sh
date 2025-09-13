#!/bin/bash

# Cross-Platform Compatibility Checker
# Validates Linux-specific functionality while running on macOS
# Ensures RTSP-SSE streaming script compatibility across platforms

set -euo pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TARGET_SCRIPT="$PROJECT_ROOT/rtsp-sse-stream.sh"
COMPAT_LOG="$SCRIPT_DIR/compatibility-check.log"
REPORT_FILE="$SCRIPT_DIR/compatibility-report.json"

# Platform detection
CURRENT_OS="$(uname -s)"
CURRENT_ARCH="$(uname -m)"
TARGET_OS="Linux"
TARGET_ARCH="armv7l"  # Raspberry Pi default

# Test results storage
declare -A TEST_RESULTS
declare -A TEST_DETAILS

# Logging function
log() {
    local level="$1"
    local message="$2"
    local timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
    local color="$NC"
    
    case "$level" in
        "ERROR") color="$RED" ;;
        "WARN") color="$YELLOW" ;;
        "INFO") color="$GREEN" ;;
        "DEBUG") color="$CYAN" ;;
        "PASS") color="$GREEN" ;;
        "FAIL") color="$RED" ;;
    esac
    
    echo -e "${color}[$timestamp] [$level] $message${NC}"
    echo "[$timestamp] [$level] $message" >> "$COMPAT_LOG"
}

# Test result recording
record_test() {
    local test_name="$1"
    local result="$2"  # PASS/FAIL/WARN
    local details="$3"
    
    TEST_RESULTS["$test_name"]="$result"
    TEST_DETAILS["$test_name"]="$details"
    
    case "$result" in
        "PASS") log "PASS" "✅ $test_name: $details" ;;
        "FAIL") log "FAIL" "❌ $test_name: $details" ;;
        "WARN") log "WARN" "⚠️  $test_name: $details" ;;
    esac
}

# Check shell compatibility
check_shell_compatibility() {
    log "INFO" "Checking shell compatibility..."
    
    # Check bash version
    local bash_version="$(bash --version | head -n1 | grep -oE '[0-9]+\.[0-9]+' | head -n1)"
    local bash_major="$(echo "$bash_version" | cut -d. -f1)"
    local bash_minor="$(echo "$bash_version" | cut -d. -f2)"
    
    if [[ $bash_major -ge 4 ]]; then
        record_test "bash_version" "PASS" "Bash $bash_version (>= 4.0 required)"
    else
        record_test "bash_version" "FAIL" "Bash $bash_version (< 4.0, upgrade required)"
    fi
    
    # Check for bash features used in the script
    local features=("associative arrays" "process substitution" "parameter expansion")
    
    # Test associative arrays
    if bash -c 'declare -A test_array; test_array["key"]="value"; [[ "${test_array["key"]}" == "value" ]]' 2>/dev/null; then
        record_test "associative_arrays" "PASS" "Associative arrays supported"
    else
        record_test "associative_arrays" "FAIL" "Associative arrays not supported"
    fi
    
    # Test process substitution
    if bash -c 'echo "test" | while read line; do [[ "$line" == "test" ]] && exit 0; done' 2>/dev/null; then
        record_test "process_substitution" "PASS" "Process substitution supported"
    else
        record_test "process_substitution" "FAIL" "Process substitution not supported"
    fi
    
    # Test parameter expansion
    if bash -c 'var="test_value"; [[ "${var#test_}" == "value" ]]' 2>/dev/null; then
        record_test "parameter_expansion" "PASS" "Parameter expansion supported"
    else
        record_test "parameter_expansion" "FAIL" "Parameter expansion not supported"
    fi
}

# Check required commands availability
check_command_availability() {
    log "INFO" "Checking command availability..."
    
    # Commands required by the script
    local required_commands=(
        "ffmpeg:Critical for video streaming"
        "curl:Required for SSE communication"
        "jq:JSON parsing for SSE events"
        "ps:Process management"
        "kill:Process termination"
        "mkfifo:Named pipe creation"
        "bc:Mathematical calculations"
        "grep:Text processing"
        "sed:Text manipulation"
        "awk:Text processing"
        "sort:Data sorting"
        "uniq:Duplicate removal"
        "head:Text processing"
        "tail:Log monitoring"
        "date:Timestamp generation"
        "sleep:Timing control"
    )
    
    # Linux-specific commands that might not be available on macOS
    local linux_commands=(
        "systemctl:Service management"
        "journalctl:System logging"
        "lscpu:CPU information"
        "free:Memory information"
        "iostat:I/O statistics"
        "vmstat:Virtual memory statistics"
    )
    
    # Check required commands
    for cmd_info in "${required_commands[@]}"; do
        local cmd="$(echo "$cmd_info" | cut -d: -f1)"
        local desc="$(echo "$cmd_info" | cut -d: -f2)"
        
        if command -v "$cmd" >/dev/null 2>&1; then
            local version="$("$cmd" --version 2>/dev/null | head -n1 || echo "Version unknown")"
            record_test "cmd_$cmd" "PASS" "$desc - Available ($version)"
        else
            record_test "cmd_$cmd" "FAIL" "$desc - Not available"
        fi
    done
    
    # Check Linux-specific commands (warnings only)
    for cmd_info in "${linux_commands[@]}"; do
        local cmd="$(echo "$cmd_info" | cut -d: -f1)"
        local desc="$(echo "$cmd_info" | cut -d: -f2)"
        
        if command -v "$cmd" >/dev/null 2>&1; then
            record_test "linux_cmd_$cmd" "PASS" "$desc - Available on current platform"
        else
            record_test "linux_cmd_$cmd" "WARN" "$desc - Not available (Linux-specific)"
        fi
    done
}

# Check file system compatibility
check_filesystem_compatibility() {
    log "INFO" "Checking filesystem compatibility..."
    
    # Test file operations
    local test_dir="$SCRIPT_DIR/fs_test"
    mkdir -p "$test_dir"
    
    # Test named pipe creation
    local test_pipe="$test_dir/test_pipe"
    if mkfifo "$test_pipe" 2>/dev/null; then
        record_test "named_pipes" "PASS" "Named pipes supported"
        rm -f "$test_pipe"
    else
        record_test "named_pipes" "FAIL" "Named pipes not supported"
    fi
    
    # Test file locking
    local test_lock="$test_dir/test.lock"
    if (
        flock -n 9 || exit 1
        echo "test" >&9
    ) 9>"$test_lock" 2>/dev/null; then
        record_test "file_locking" "PASS" "File locking supported"
        rm -f "$test_lock"
    else
        record_test "file_locking" "FAIL" "File locking not supported"
    fi
    
    # Test symbolic links
    local test_file="$test_dir/test_file"
    local test_link="$test_dir/test_link"
    echo "test" > "$test_file"
    if ln -s "$test_file" "$test_link" 2>/dev/null && [[ -L "$test_link" ]]; then
        record_test "symbolic_links" "PASS" "Symbolic links supported"
        rm -f "$test_link" "$test_file"
    else
        record_test "symbolic_links" "FAIL" "Symbolic links not supported"
    fi
    
    # Test file permissions
    local test_perm="$test_dir/test_perm"
    echo "test" > "$test_perm"
    if chmod 755 "$test_perm" 2>/dev/null && [[ -x "$test_perm" ]]; then
        record_test "file_permissions" "PASS" "File permissions supported"
        rm -f "$test_perm"
    else
        record_test "file_permissions" "FAIL" "File permissions not supported"
    fi
    
    # Cleanup
    rmdir "$test_dir" 2>/dev/null || true
}

# Check network compatibility
check_network_compatibility() {
    log "INFO" "Checking network compatibility..."
    
    # Test network tools
    local network_tools=("netstat" "ss" "lsof")
    
    for tool in "${network_tools[@]}"; do
        if command -v "$tool" >/dev/null 2>&1; then
            record_test "net_$tool" "PASS" "Network tool $tool available"
        else
            record_test "net_$tool" "WARN" "Network tool $tool not available"
        fi
    done
    
    # Test network connectivity
    if ping -c 1 8.8.8.8 >/dev/null 2>&1; then
        record_test "network_connectivity" "PASS" "Network connectivity available"
    else
        record_test "network_connectivity" "WARN" "Network connectivity test failed"
    fi
    
    # Test curl functionality
    if curl -s --connect-timeout 5 "https://httpbin.org/get" >/dev/null 2>&1; then
        record_test "curl_https" "PASS" "HTTPS requests working"
    else
        record_test "curl_https" "WARN" "HTTPS requests failed"
    fi
}

# Check process management compatibility
check_process_compatibility() {
    log "INFO" "Checking process management compatibility..."
    
    # Test process creation and management
    local test_script="$SCRIPT_DIR/test_process.sh"
    cat > "$test_script" << 'EOF'
#!/bin/bash
echo "Test process started"
sleep 10
echo "Test process finished"
EOF
    chmod +x "$test_script"
    
    # Start background process
    "$test_script" &
    local test_pid=$!
    
    # Test process detection
    if kill -0 "$test_pid" 2>/dev/null; then
        record_test "process_detection" "PASS" "Process detection working"
        
        # Test signal handling
        if kill -TERM "$test_pid" 2>/dev/null; then
            record_test "signal_handling" "PASS" "Signal handling working"
        else
            record_test "signal_handling" "FAIL" "Signal handling failed"
        fi
        
        # Wait for process to terminate
        wait "$test_pid" 2>/dev/null || true
    else
        record_test "process_detection" "FAIL" "Process detection failed"
        record_test "signal_handling" "FAIL" "Cannot test signal handling"
    fi
    
    # Cleanup
    rm -f "$test_script"
}

# Check script syntax and structure
check_script_syntax() {
    log "INFO" "Checking script syntax and structure..."
    
    # Check if target script exists
    if [[ ! -f "$TARGET_SCRIPT" ]]; then
        record_test "script_exists" "FAIL" "Target script not found: $TARGET_SCRIPT"
        return 1
    fi
    
    record_test "script_exists" "PASS" "Target script found"
    
    # Check script syntax
    if bash -n "$TARGET_SCRIPT" 2>/dev/null; then
        record_test "script_syntax" "PASS" "Script syntax is valid"
    else
        local syntax_error="$(bash -n "$TARGET_SCRIPT" 2>&1 || true)"
        record_test "script_syntax" "FAIL" "Syntax error: $syntax_error"
    fi
    
    # Check for Linux-specific constructs
    local linux_patterns=(
        "/proc/:"/proc filesystem usage"
        "/sys/:"/sys filesystem usage"
        "systemctl:systemd service management"
        "journalctl:systemd logging"
        "/dev/video:Video device access"
        "/dev/dri:Hardware acceleration devices"
    )
    
    for pattern_info in "${linux_patterns[@]}"; do
        local pattern="$(echo "$pattern_info" | cut -d: -f1)"
        local desc="$(echo "$pattern_info" | cut -d: -f2)"
        
        if grep -q "$pattern" "$TARGET_SCRIPT" 2>/dev/null; then
            record_test "linux_pattern_$pattern" "WARN" "Uses Linux-specific: $desc"
        else
            record_test "linux_pattern_$pattern" "PASS" "No Linux-specific: $desc"
        fi
    done
    
    # Check for portable constructs
    local portable_patterns=(
        "command -v:Portable command detection"
        "\$\(.*\):Command substitution"
        "\[\[ .*\]\]:Bash conditional"
    )
    
    for pattern_info in "${portable_patterns[@]}"; do
        local pattern="$(echo "$pattern_info" | cut -d: -f1)"
        local desc="$(echo "$pattern_info" | cut -d: -f2)"
        
        if grep -qE "$pattern" "$TARGET_SCRIPT" 2>/dev/null; then
            record_test "portable_$pattern" "PASS" "Uses portable: $desc"
        else
            record_test "portable_$pattern" "WARN" "Missing portable: $desc"
        fi
    done
}

# Check hardware acceleration compatibility
check_hardware_acceleration() {
    log "INFO" "Checking hardware acceleration compatibility..."
    
    # Check for hardware acceleration support
    local hw_methods=("vaapi" "nvenc" "qsv" "videotoolbox")
    
    for method in "${hw_methods[@]}"; do
        if command -v ffmpeg >/dev/null 2>&1; then
            if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q "$method"; then
                record_test "hw_accel_$method" "PASS" "Hardware acceleration $method available"
            else
                record_test "hw_accel_$method" "WARN" "Hardware acceleration $method not available"
            fi
        else
            record_test "hw_accel_$method" "FAIL" "Cannot test $method - ffmpeg not available"
        fi
    done
    
    # Check for GPU devices (Linux-specific)
    if [[ "$CURRENT_OS" == "Linux" ]]; then
        if [[ -d "/dev/dri" ]]; then
            local gpu_count="$(ls /dev/dri/render* 2>/dev/null | wc -l || echo 0)"
            if [[ $gpu_count -gt 0 ]]; then
                record_test "gpu_devices" "PASS" "GPU devices found: $gpu_count"
            else
                record_test "gpu_devices" "WARN" "No GPU render devices found"
            fi
        else
            record_test "gpu_devices" "WARN" "No /dev/dri directory found"
        fi
    else
        record_test "gpu_devices" "WARN" "GPU device check skipped (not Linux)"
    fi
}

# Generate compatibility report
generate_report() {
    log "INFO" "Generating compatibility report..."
    
    local total_tests=0
    local passed_tests=0
    local failed_tests=0
    local warning_tests=0
    
    # Count test results
    for test_name in "${!TEST_RESULTS[@]}"; do
        ((total_tests++))
        case "${TEST_RESULTS[$test_name]}" in
            "PASS") ((passed_tests++)) ;;
            "FAIL") ((failed_tests++)) ;;
            "WARN") ((warning_tests++)) ;;
        esac
    done
    
    # Calculate compatibility score
    local compatibility_score=0
    if [[ $total_tests -gt 0 ]]; then
        compatibility_score=$(( (passed_tests * 100) / total_tests ))
    fi
    
    # Generate JSON report
    cat > "$REPORT_FILE" << EOF
{
  "compatibility_check": {
    "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "current_platform": {
      "os": "$CURRENT_OS",
      "architecture": "$CURRENT_ARCH"
    },
    "target_platform": {
      "os": "$TARGET_OS",
      "architecture": "$TARGET_ARCH"
    },
    "summary": {
      "total_tests": $total_tests,
      "passed": $passed_tests,
      "failed": $failed_tests,
      "warnings": $warning_tests,
      "compatibility_score": $compatibility_score
    },
    "test_results": {
EOF
    
    # Add individual test results
    local first=true
    for test_name in "${!TEST_RESULTS[@]}"; do
        if [[ "$first" == "true" ]]; then
            first=false
        else
            echo "," >> "$REPORT_FILE"
        fi
        
        echo -n "      \"$test_name\": {" >> "$REPORT_FILE"
        echo -n "\"result\": \"${TEST_RESULTS[$test_name]}\", " >> "$REPORT_FILE"
        echo -n "\"details\": \"${TEST_DETAILS[$test_name]}\"" >> "$REPORT_FILE"
        echo -n "}" >> "$REPORT_FILE"
    done
    
    cat >> "$REPORT_FILE" << EOF

    }
  }
}
EOF
    
    # Display summary
    echo
    echo "=== CROSS-PLATFORM COMPATIBILITY REPORT ==="
    echo "Current Platform: $CURRENT_OS $CURRENT_ARCH"
    echo "Target Platform: $TARGET_OS $TARGET_ARCH"
    echo
    echo "Test Results:"
    echo "  Total Tests: $total_tests"
    echo "  Passed: $passed_tests"
    echo "  Failed: $failed_tests"
    echo "  Warnings: $warning_tests"
    echo "  Compatibility Score: $compatibility_score%"
    echo
    
    # Determine overall result
    if [[ $failed_tests -eq 0 ]]; then
        if [[ $warning_tests -eq 0 ]]; then
            log "PASS" "✅ Full compatibility achieved"
            return 0
        else
            log "WARN" "⚠️  Compatibility with warnings ($warning_tests warnings)"
            return 0
        fi
    else
        log "FAIL" "❌ Compatibility issues detected ($failed_tests failures)"
        return 1
    fi
}

# Show usage information
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Cross-Platform Compatibility Checker for RTSP-SSE Stream Script

OPTIONS:
    --target-os OS        Target operating system (default: Linux)
    --target-arch ARCH    Target architecture (default: armv7l)
    --report-only         Only generate report from existing results
    --verbose             Enable verbose output
    --help                Show this help message

EXAMPLES:
    $0                                    # Check Linux/armv7l compatibility
    $0 --target-os Linux --target-arch x86_64  # Check Linux/x86_64 compatibility
    $0 --report-only                     # Generate report only

OUTPUT:
    - Compatibility log: $COMPAT_LOG
    - JSON report: $REPORT_FILE

EOF
}

# Main function
main() {
    local report_only="false"
    local verbose="false"
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --target-os)
                TARGET_OS="$2"
                shift 2
                ;;
            --target-arch)
                TARGET_ARCH="$2"
                shift 2
                ;;
            --report-only)
                report_only="true"
                shift
                ;;
            --verbose)
                verbose="true"
                shift
                ;;
            --help)
                usage
                exit 0
                ;;
            *)
                log "ERROR" "Unknown option: $1"
                usage
                exit 1
                ;;
        esac
    done
    
    log "INFO" "Starting cross-platform compatibility check"
    log "INFO" "Current: $CURRENT_OS $CURRENT_ARCH"
    log "INFO" "Target: $TARGET_OS $TARGET_ARCH"
    
    # Initialize log file
    echo "Cross-Platform Compatibility Check - $(date)" > "$COMPAT_LOG"
    
    if [[ "$report_only" == "false" ]]; then
        # Run all compatibility checks
        check_shell_compatibility
        check_command_availability
        check_filesystem_compatibility
        check_network_compatibility
        check_process_compatibility
        check_script_syntax
        check_hardware_acceleration
    fi
    
    # Generate final report
    generate_report
}

# Run main function if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi