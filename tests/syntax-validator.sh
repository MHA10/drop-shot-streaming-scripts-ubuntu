#!/bin/bash

# RTSP-SSE Stream Script Syntax Validator
# Validates shell syntax, runs shellcheck analysis, and performs structure checks
# Compatible with macOS for development while targeting Linux deployment

set -euo pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Script configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TARGET_SCRIPT="$PROJECT_ROOT/rtsp-sse-stream.sh"
CONFIG_FILE="$PROJECT_ROOT/rtsp-sse-stream.conf"
TEST_LOG="$SCRIPT_DIR/syntax-validation.log"

# Test results
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

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
    esac
    
    echo -e "${color}[$timestamp] [$level] $message${NC}"
    echo "[$timestamp] [$level] $message" >> "$TEST_LOG"
}

# Test result tracking
test_result() {
    local test_name="$1"
    local result="$2"
    local message="$3"
    
    ((TOTAL_TESTS++))
    
    if [[ "$result" == "PASS" ]]; then
        ((PASSED_TESTS++))
        log "INFO" "✓ $test_name: $message"
    else
        ((FAILED_TESTS++))
        log "ERROR" "✗ $test_name: $message"
    fi
}

# Check if file exists and is readable
check_file_exists() {
    local file="$1"
    local description="$2"
    
    if [[ -f "$file" && -r "$file" ]]; then
        test_result "File Existence" "PASS" "$description exists and is readable"
        return 0
    else
        test_result "File Existence" "FAIL" "$description not found or not readable: $file"
        return 1
    fi
}

# Validate shell syntax using bash -n
validate_shell_syntax() {
    local script="$1"
    
    log "INFO" "Validating shell syntax for: $(basename "$script")"
    
    if bash -n "$script" 2>/dev/null; then
        test_result "Shell Syntax" "PASS" "No syntax errors found"
        return 0
    else
        local errors=$(bash -n "$script" 2>&1)
        test_result "Shell Syntax" "FAIL" "Syntax errors found: $errors"
        return 1
    fi
}

# Run shellcheck analysis
run_shellcheck() {
    local script="$1"
    
    log "INFO" "Running shellcheck analysis..."
    
    # Check if shellcheck is available
    if ! command -v shellcheck >/dev/null 2>&1; then
        test_result "Shellcheck" "WARN" "shellcheck not installed, skipping analysis"
        log "WARN" "Install shellcheck with: brew install shellcheck (macOS) or apt-get install shellcheck (Linux)"
        return 0
    fi
    
    # Run shellcheck with appropriate options
    local shellcheck_output
    if shellcheck_output=$(shellcheck -f gcc -e SC1091 -e SC2034 "$script" 2>&1); then
        test_result "Shellcheck" "PASS" "No shellcheck warnings or errors"
        return 0
    else
        # Count warnings and errors
        local error_count=$(echo "$shellcheck_output" | grep -c "error:" || true)
        local warning_count=$(echo "$shellcheck_output" | grep -c "warning:" || true)
        
        if [[ $error_count -gt 0 ]]; then
            test_result "Shellcheck" "FAIL" "$error_count errors, $warning_count warnings found"
            log "ERROR" "Shellcheck output:\n$shellcheck_output"
            return 1
        else
            test_result "Shellcheck" "WARN" "$warning_count warnings found (no errors)"
            log "WARN" "Shellcheck output:\n$shellcheck_output"
            return 0
        fi
    fi
}

# Validate script structure and required functions
validate_script_structure() {
    local script="$1"
    
    log "INFO" "Validating script structure..."
    
    # Required functions in the script
    local required_functions=(
        "log"
        "usage"
        "parse_args"
        "load_config"
        "validate_config"
        "init_environment"
        "cleanup"
        "sse_client"
        "monitor_parameters"
        "start_ffmpeg"
        "streaming_loop"
        "main"
    )
    
    local missing_functions=()
    
    for func in "${required_functions[@]}"; do
        if ! grep -q "^[[:space:]]*$func[[:space:]]*()" "$script"; then
            missing_functions+=("$func")
        fi
    done
    
    if [[ ${#missing_functions[@]} -eq 0 ]]; then
        test_result "Script Structure" "PASS" "All required functions found"
    else
        test_result "Script Structure" "FAIL" "Missing functions: ${missing_functions[*]}"
        return 1
    fi
    
    # Check for proper shebang
    local shebang=$(head -n1 "$script")
    if [[ "$shebang" =~ ^#!/bin/bash ]]; then
        test_result "Shebang" "PASS" "Proper bash shebang found"
    else
        test_result "Shebang" "FAIL" "Invalid or missing bash shebang: $shebang"
    fi
    
    # Check for set -euo pipefail
    if grep -q "set -euo pipefail" "$script"; then
        test_result "Error Handling" "PASS" "Proper error handling flags set"
    else
        test_result "Error Handling" "WARN" "Missing 'set -euo pipefail' for strict error handling"
    fi
}

# Validate configuration file syntax
validate_config_syntax() {
    local config="$1"
    
    log "INFO" "Validating configuration file syntax..."
    
    # Check if config file can be sourced without errors
    if bash -n "$config" 2>/dev/null; then
        test_result "Config Syntax" "PASS" "Configuration file syntax is valid"
    else
        local errors=$(bash -n "$config" 2>&1)
        test_result "Config Syntax" "FAIL" "Configuration syntax errors: $errors"
        return 1
    fi
    
    # Check for required configuration variables
    local required_vars=(
        "RTSP_INPUT"
        "RTMP_OUTPUT"
        "SSE_URL"
        "CURRENT_TSP"
        "CURRENT_RAMP"
        "CURRENT_BUFSIZE"
        "LOG_LEVEL"
    )
    
    local missing_vars=()
    
    for var in "${required_vars[@]}"; do
        if ! grep -q "^[[:space:]]*$var=" "$config"; then
            missing_vars+=("$var")
        fi
    done
    
    if [[ ${#missing_vars[@]} -eq 0 ]]; then
        test_result "Config Variables" "PASS" "All required configuration variables found"
    else
        test_result "Config Variables" "FAIL" "Missing variables: ${missing_vars[*]}"
    fi
}

# Check for potential security issues
check_security_issues() {
    local script="$1"
    
    log "INFO" "Checking for potential security issues..."
    
    local security_issues=()
    
    # Check for eval usage (potential security risk)
    if grep -q "eval" "$script"; then
        security_issues+=("eval usage detected")
    fi
    
    # Check for unquoted variables in dangerous contexts
    if grep -E "\$[A-Za-z_][A-Za-z0-9_]*[^\"\']" "$script" | grep -v "#" | head -5 >/dev/null; then
        security_issues+=("potentially unquoted variables detected")
    fi
    
    # Check for hardcoded credentials (basic check)
    if grep -iE "(password|secret|key|token)=" "$script" | grep -v "#" >/dev/null; then
        security_issues+=("potential hardcoded credentials")
    fi
    
    if [[ ${#security_issues[@]} -eq 0 ]]; then
        test_result "Security Check" "PASS" "No obvious security issues found"
    else
        test_result "Security Check" "WARN" "Potential issues: ${security_issues[*]}"
    fi
}

# Check cross-platform compatibility
check_cross_platform_compatibility() {
    local script="$1"
    
    log "INFO" "Checking cross-platform compatibility..."
    
    local compatibility_issues=()
    
    # Check for Linux-specific commands that might not work on macOS
    local linux_commands=("prlimit" "systemctl" "journalctl")
    
    for cmd in "${linux_commands[@]}"; do
        if grep -q "$cmd" "$script"; then
            # Check if there's a fallback or conditional usage
            if grep -B2 -A2 "$cmd" "$script" | grep -q "command -v\|which\|if.*$cmd"; then
                log "INFO" "Linux command '$cmd' has conditional usage - good!"
            else
                compatibility_issues+=("$cmd command used without fallback")
            fi
        fi
    done
    
    # Check for proper path handling
    if grep -q "/tmp/" "$script" && ! grep -q "\$TMPDIR" "$script"; then
        compatibility_issues+=("hardcoded /tmp paths (consider \$TMPDIR)")
    fi
    
    if [[ ${#compatibility_issues[@]} -eq 0 ]]; then
        test_result "Cross-Platform" "PASS" "Good cross-platform compatibility"
    else
        test_result "Cross-Platform" "WARN" "Potential issues: ${compatibility_issues[*]}"
    fi
}

# Generate detailed report
generate_report() {
    log "INFO" "Generating validation report..."
    
    echo
    echo "=== SYNTAX VALIDATION REPORT ==="
    echo "Total Tests: $TOTAL_TESTS"
    echo "Passed: $PASSED_TESTS"
    echo "Failed: $FAILED_TESTS"
    echo "Success Rate: $(( (PASSED_TESTS * 100) / TOTAL_TESTS ))%"
    echo
    
    if [[ $FAILED_TESTS -eq 0 ]]; then
        log "INFO" "🎉 All syntax validation tests passed!"
        return 0
    else
        log "ERROR" "❌ $FAILED_TESTS test(s) failed. Check the log for details."
        return 1
    fi
}

# Main function
main() {
    log "INFO" "Starting RTSP-SSE Stream Script Syntax Validation"
    
    # Initialize test log
    mkdir -p "$(dirname "$TEST_LOG")"
    echo "Syntax Validation Log - $(date)" > "$TEST_LOG"
    
    # Check if target script exists
    if ! check_file_exists "$TARGET_SCRIPT" "Main script"; then
        log "ERROR" "Cannot proceed without main script"
        exit 1
    fi
    
    # Run all validation tests
    validate_shell_syntax "$TARGET_SCRIPT"
    run_shellcheck "$TARGET_SCRIPT"
    validate_script_structure "$TARGET_SCRIPT"
    check_security_issues "$TARGET_SCRIPT"
    check_cross_platform_compatibility "$TARGET_SCRIPT"
    
    # Validate configuration file if it exists
    if [[ -f "$CONFIG_FILE" ]]; then
        check_file_exists "$CONFIG_FILE" "Configuration file"
        validate_config_syntax "$CONFIG_FILE"
    else
        test_result "Config File" "WARN" "Configuration file not found (optional)"
    fi
    
    # Generate final report
    generate_report
}

# Run main function if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi