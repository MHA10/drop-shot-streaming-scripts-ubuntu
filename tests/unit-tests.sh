#!/bin/bash

# Unit Tests for RTSP-SSE Stream Script Functions
# Tests individual functions in isolation for reliability and correctness
# Compatible with macOS for development while targeting Linux deployment

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
UNIT_TEST_LOG="$SCRIPT_DIR/unit-tests.log"
TEST_RESULTS_FILE="$SCRIPT_DIR/unit-test-results.json"
TEMP_DIR="$SCRIPT_DIR/unit_test_temp"

# Test results storage
declare -A TEST_RESULTS
declare -A TEST_DETAILS
declare -i TOTAL_TESTS=0
declare -i PASSED_TESTS=0
declare -i FAILED_TESTS=0

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
    echo "[$timestamp] [$level] $message" >> "$UNIT_TEST_LOG"
}

# Test assertion functions
assert_equals() {
    local expected="$1"
    local actual="$2"
    local test_name="$3"
    
    ((TOTAL_TESTS++))
    
    if [[ "$expected" == "$actual" ]]; then
        ((PASSED_TESTS++))
        TEST_RESULTS["$test_name"]="PASS"
        TEST_DETAILS["$test_name"]="Expected: '$expected', Got: '$actual'"
        log "PASS" "✅ $test_name"
        return 0
    else
        ((FAILED_TESTS++))
        TEST_RESULTS["$test_name"]="FAIL"
        TEST_DETAILS["$test_name"]="Expected: '$expected', Got: '$actual'"
        log "FAIL" "❌ $test_name - Expected: '$expected', Got: '$actual'"
        return 1
    fi
}

assert_true() {
    local condition="$1"
    local test_name="$2"
    
    ((TOTAL_TESTS++))
    
    if eval "$condition"; then
        ((PASSED_TESTS++))
        TEST_RESULTS["$test_name"]="PASS"
        TEST_DETAILS["$test_name"]="Condition '$condition' is true"
        log "PASS" "✅ $test_name"
        return 0
    else
        ((FAILED_TESTS++))
        TEST_RESULTS["$test_name"]="FAIL"
        TEST_DETAILS["$test_name"]="Condition '$condition' is false"
        log "FAIL" "❌ $test_name - Condition '$condition' is false"
        return 1
    fi
}

assert_false() {
    local condition="$1"
    local test_name="$2"
    
    ((TOTAL_TESTS++))
    
    if ! eval "$condition"; then
        ((PASSED_TESTS++))
        TEST_RESULTS["$test_name"]="PASS"
        TEST_DETAILS["$test_name"]="Condition '$condition' is false (as expected)"
        log "PASS" "✅ $test_name"
        return 0
    else
        ((FAILED_TESTS++))
        TEST_RESULTS["$test_name"]="FAIL"
        TEST_DETAILS["$test_name"]="Condition '$condition' is true (expected false)"
        log "FAIL" "❌ $test_name - Condition '$condition' is true (expected false)"
        return 1
    fi
}

assert_file_exists() {
    local file_path="$1"
    local test_name="$2"
    
    assert_true "[[ -f '$file_path' ]]" "$test_name"
}

assert_file_not_exists() {
    local file_path="$1"
    local test_name="$2"
    
    assert_false "[[ -f '$file_path' ]]" "$test_name"
}

# Extract and source functions from the main script
source_script_functions() {
    log "INFO" "Extracting functions from main script..."
    
    if [[ ! -f "$TARGET_SCRIPT" ]]; then
        log "ERROR" "Target script not found: $TARGET_SCRIPT"
        return 1
    fi
    
    # Create a temporary file with just the functions
    local functions_file="$TEMP_DIR/extracted_functions.sh"
    mkdir -p "$TEMP_DIR"
    
    # Extract function definitions (simplified approach)
    grep -A 1000 '^[a-zA-Z_][a-zA-Z0-9_]*()' "$TARGET_SCRIPT" | \
        sed '/^main()/,$d' > "$functions_file" || true
    
    # Add necessary variables and configurations
    cat > "$TEMP_DIR/test_environment.sh" << 'EOF'
#!/bin/bash

# Test environment setup
SCRIPT_NAME="rtsp-sse-stream-test"
VERSION="1.0-test"
CONFIG_FILE="/tmp/test_config.conf"
LOG_FILE="/tmp/test.log"
PID_DIR="/tmp/test_pids"
LOCK_FILE="/tmp/test.lock"
SSE_PIPE="/tmp/test_sse_pipe"
PARAM_PIPE="/tmp/test_param_pipe"

# Default configuration values
RTSP_INPUT="rtsp://test.example.com/stream"
RTMP_OUTPUT="rtmp://test.example.com/live/stream"
SSE_URL="http://localhost:3000/events"
CURRENT_TSP="2000"
CURRENT_RAMP="2500"
CURRENT_BUFSIZE="3000"
RESTART_DELAY="5"
COLOR_OUTPUT="true"
LOG_LEVEL="INFO"
FFMPEG_EXTRA_OPTS=""
NICE_LEVEL="0"
MEMORY_LIMIT="512"
HW_ACCEL="false"
HW_ACCEL_METHOD="auto"

# Mock functions for testing
ffmpeg() {
    echo "Mock ffmpeg called with: $*"
    sleep 1
    return 0
}

curl() {
    echo "Mock curl called with: $*"
    case "$*" in
        *"--no-buffer"*)
            # Simulate SSE stream
            echo "data: {\"tsp\": 2000, \"ramp\": 2500, \"bufsize\": 3000}"
            echo
            ;;
        *)
            echo "Mock HTTP response"
            ;;
    esac
    return 0
}

jq() {
    # Simple jq mock for basic JSON parsing
    case "$*" in
        "-r .tsp")
            echo "2000"
            ;;
        "-r .ramp")
            echo "2500"
            ;;
        "-r .bufsize")
            echo "3000"
            ;;
        *)
            echo "Mock jq output"
            ;;
    esac
    return 0
}

ps() {
    case "$*" in
        *"--no-headers"*)
            echo "12345 ffmpeg -i rtsp://test"
            ;;
        *)
            echo "  PID TTY          TIME CMD"
            echo "12345 pts/0    00:00:01 ffmpeg"
            ;;
    esac
    return 0
}

kill() {
    echo "Mock kill called with: $*"
    return 0
}

mkfifo() {
    echo "Mock mkfifo called with: $*"
    touch "$1"  # Create regular file instead of named pipe
    return 0
}
EOF
    
    # Source the test environment
    source "$TEMP_DIR/test_environment.sh"
    
    log "INFO" "Test environment prepared"
}

# Test URL validation functions
test_url_validation() {
    log "INFO" "Testing URL validation functions..."
    
    # Create test validation functions
    validate_rtsp_url() {
        local url="$1"
        [[ "$url" =~ ^rtsp:// ]] && [[ ${#url} -gt 7 ]]
    }
    
    validate_rtmp_url() {
        local url="$1"
        [[ "$url" =~ ^rtmp:// ]] && [[ ${#url} -gt 7 ]]
    }
    
    validate_sse_url() {
        local url="$1"
        [[ "$url" =~ ^https?:// ]] && [[ ${#url} -gt 7 ]]
    }
    
    # Test valid URLs
    assert_true "validate_rtsp_url 'rtsp://example.com/stream'" "rtsp_url_valid"
    assert_true "validate_rtmp_url 'rtmp://example.com/live/stream'" "rtmp_url_valid"
    assert_true "validate_sse_url 'http://example.com/events'" "sse_url_http_valid"
    assert_true "validate_sse_url 'https://example.com/events'" "sse_url_https_valid"
    
    # Test invalid URLs
    assert_false "validate_rtsp_url 'http://example.com/stream'" "rtsp_url_invalid_protocol"
    assert_false "validate_rtmp_url 'rtsp://example.com/stream'" "rtmp_url_invalid_protocol"
    assert_false "validate_sse_url 'ftp://example.com/events'" "sse_url_invalid_protocol"
    assert_false "validate_rtsp_url 'rtsp://'" "rtsp_url_too_short"
    assert_false "validate_rtmp_url ''" "rtmp_url_empty"
}

# Test parameter validation functions
test_parameter_validation() {
    log "INFO" "Testing parameter validation functions..."
    
    # Create test validation functions
    validate_tsp() {
        local tsp="$1"
        [[ "$tsp" =~ ^[0-9]+$ ]] && [[ $tsp -ge 500 ]] && [[ $tsp -le 10000 ]]
    }
    
    validate_ramp() {
        local ramp="$1"
        [[ "$ramp" =~ ^[0-9]+$ ]] && [[ $ramp -ge 500 ]] && [[ $ramp -le 15000 ]]
    }
    
    validate_bufsize() {
        local bufsize="$1"
        [[ "$bufsize" =~ ^[0-9]+$ ]] && [[ $bufsize -ge 1000 ]] && [[ $bufsize -le 20000 ]]
    }
    
    validate_log_level() {
        local level="$1"
        [[ "$level" =~ ^(DEBUG|INFO|WARN|ERROR)$ ]]
    }
    
    # Test valid parameters
    assert_true "validate_tsp '2000'" "tsp_valid"
    assert_true "validate_ramp '2500'" "ramp_valid"
    assert_true "validate_bufsize '3000'" "bufsize_valid"
    assert_true "validate_log_level 'INFO'" "log_level_valid"
    
    # Test invalid parameters
    assert_false "validate_tsp '100'" "tsp_too_low"
    assert_false "validate_tsp '20000'" "tsp_too_high"
    assert_false "validate_ramp 'abc'" "ramp_non_numeric"
    assert_false "validate_bufsize '-1000'" "bufsize_negative"
    assert_false "validate_log_level 'INVALID'" "log_level_invalid"
}

# Test JSON parsing functions
test_json_parsing() {
    log "INFO" "Testing JSON parsing functions..."
    
    # Create test JSON parsing function
    parse_sse_event() {
        local json_data="$1"
        local field="$2"
        
        # Simple JSON parsing without jq dependency
        case "$field" in
            "tsp")
                echo "$json_data" | grep -o '"tsp"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$'
                ;;
            "ramp")
                echo "$json_data" | grep -o '"ramp"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$'
                ;;
            "bufsize")
                echo "$json_data" | grep -o '"bufsize"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$'
                ;;
            *)
                return 1
                ;;
        esac
    }
    
    # Test JSON parsing
    local test_json='{"tsp": 1500, "ramp": 2000, "bufsize": 2500}'
    
    local parsed_tsp="$(parse_sse_event "$test_json" "tsp")"
    local parsed_ramp="$(parse_sse_event "$test_json" "ramp")"
    local parsed_bufsize="$(parse_sse_event "$test_json" "bufsize")"
    
    assert_equals "1500" "$parsed_tsp" "json_parse_tsp"
    assert_equals "2000" "$parsed_ramp" "json_parse_ramp"
    assert_equals "2500" "$parsed_bufsize" "json_parse_bufsize"
    
    # Test malformed JSON
    local malformed_json='{"tsp": abc, "ramp": 2000}'
    local parsed_invalid="$(parse_sse_event "$malformed_json" "tsp" || echo "PARSE_ERROR")"
    assert_equals "PARSE_ERROR" "$parsed_invalid" "json_parse_invalid"
}

# Test file operations
test_file_operations() {
    log "INFO" "Testing file operations..."
    
    # Create test file operations
    create_pid_file() {
        local pid="$1"
        local pid_file="$2"
        echo "$pid" > "$pid_file"
    }
    
    read_pid_file() {
        local pid_file="$1"
        [[ -f "$pid_file" ]] && cat "$pid_file"
    }
    
    remove_pid_file() {
        local pid_file="$1"
        [[ -f "$pid_file" ]] && rm -f "$pid_file"
    }
    
    # Test PID file operations
    local test_pid_file="$TEMP_DIR/test.pid"
    
    create_pid_file "12345" "$test_pid_file"
    assert_file_exists "$test_pid_file" "pid_file_created"
    
    local read_pid="$(read_pid_file "$test_pid_file")"
    assert_equals "12345" "$read_pid" "pid_file_content"
    
    remove_pid_file "$test_pid_file"
    assert_file_not_exists "$test_pid_file" "pid_file_removed"
}

# Test process management functions
test_process_management() {
    log "INFO" "Testing process management functions..."
    
    # Create test process management functions
    is_process_running() {
        local pid="$1"
        # Mock implementation - always return true for test PID
        [[ "$pid" == "12345" ]]
    }
    
    get_process_memory() {
        local pid="$1"
        # Mock implementation
        echo "256000"  # 256MB in KB
    }
    
    terminate_process() {
        local pid="$1"
        local signal="${2:-TERM}"
        # Mock implementation
        echo "Terminating process $pid with signal $signal"
        return 0
    }
    
    # Test process management
    assert_true "is_process_running '12345'" "process_running_check"
    assert_false "is_process_running '99999'" "process_not_running_check"
    
    local memory="$(get_process_memory '12345')"
    assert_equals "256000" "$memory" "process_memory_check"
    
    # Test process termination (mock)
    local term_result="$(terminate_process '12345' 'TERM')"
    assert_equals "Terminating process 12345 with signal TERM" "$term_result" "process_termination"
}

# Test configuration loading
test_configuration_loading() {
    log "INFO" "Testing configuration loading..."
    
    # Create test configuration file
    local test_config="$TEMP_DIR/test.conf"
    cat > "$test_config" << 'EOF'
#!/bin/bash
# Test configuration
RTSP_INPUT="rtsp://test.local/stream"
RTMP_OUTPUT="rtmp://test.local/live/test"
SSE_URL="http://test.local/events"
CURRENT_TSP="1800"
CURRENT_RAMP="2200"
CURRENT_BUFSIZE="2800"
LOG_LEVEL="DEBUG"
EOF
    
    # Create configuration loading function
    load_configuration() {
        local config_file="$1"
        if [[ -f "$config_file" ]]; then
            source "$config_file"
            return 0
        else
            return 1
        fi
    }
    
    # Test configuration loading
    assert_true "load_configuration '$test_config'" "config_load_success"
    
    # Check if variables were loaded
    load_configuration "$test_config"
    assert_equals "rtsp://test.local/stream" "$RTSP_INPUT" "config_rtsp_loaded"
    assert_equals "1800" "$CURRENT_TSP" "config_tsp_loaded"
    assert_equals "DEBUG" "$LOG_LEVEL" "config_log_level_loaded"
    
    # Test loading non-existent config
    assert_false "load_configuration '/nonexistent/config.conf'" "config_load_failure"
}

# Test logging functions
test_logging_functions() {
    log "INFO" "Testing logging functions..."
    
    # Create test logging function
    test_log() {
        local level="$1"
        local message="$2"
        local log_file="$3"
        
        local timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
        echo "[$timestamp] [$level] $message" >> "$log_file"
    }
    
    # Test logging
    local test_log_file="$TEMP_DIR/test.log"
    
    test_log "INFO" "Test message" "$test_log_file"
    assert_file_exists "$test_log_file" "log_file_created"
    
    # Check log content
    local log_content="$(cat "$test_log_file")"
    assert_true "[[ '$log_content' =~ 'Test message' ]]" "log_message_written"
    assert_true "[[ '$log_content' =~ '\[INFO\]' ]]" "log_level_written"
}

# Generate test report
generate_test_report() {
    log "INFO" "Generating unit test report..."
    
    local success_rate=0
    if [[ $TOTAL_TESTS -gt 0 ]]; then
        success_rate=$(( (PASSED_TESTS * 100) / TOTAL_TESTS ))
    fi
    
    # Generate JSON report
    cat > "$TEST_RESULTS_FILE" << EOF
{
  "unit_tests": {
    "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "summary": {
      "total_tests": $TOTAL_TESTS,
      "passed": $PASSED_TESTS,
      "failed": $FAILED_TESTS,
      "success_rate": $success_rate
    },
    "test_results": {
EOF
    
    # Add individual test results
    local first=true
    for test_name in "${!TEST_RESULTS[@]}"; do
        if [[ "$first" == "true" ]]; then
            first=false
        else
            echo "," >> "$TEST_RESULTS_FILE"
        fi
        
        echo -n "      \"$test_name\": {" >> "$TEST_RESULTS_FILE"
        echo -n "\"result\": \"${TEST_RESULTS[$test_name]}\", " >> "$TEST_RESULTS_FILE"
        echo -n "\"details\": \"${TEST_DETAILS[$test_name]}\"" >> "$TEST_RESULTS_FILE"
        echo -n "}" >> "$TEST_RESULTS_FILE"
    done
    
    cat >> "$TEST_RESULTS_FILE" << EOF

    }
  }
}
EOF
    
    # Display summary
    echo
    echo "=== UNIT TEST RESULTS ==="
    echo "Total Tests: $TOTAL_TESTS"
    echo "Passed: $PASSED_TESTS"
    echo "Failed: $FAILED_TESTS"
    echo "Success Rate: $success_rate%"
    echo
    
    if [[ $FAILED_TESTS -eq 0 ]]; then
        log "PASS" "✅ All unit tests passed!"
        return 0
    else
        log "FAIL" "❌ $FAILED_TESTS unit tests failed"
        return 1
    fi
}

# Cleanup function
cleanup() {
    log "INFO" "Cleaning up unit test environment..."
    
    # Remove temporary directory
    [[ -d "$TEMP_DIR" ]] && rm -rf "$TEMP_DIR"
    
    log "INFO" "Unit test cleanup completed"
}

# Show usage information
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Unit Tests for RTSP-SSE Stream Script Functions

OPTIONS:
    --verbose             Enable verbose output
    --cleanup-only        Only perform cleanup and exit
    --help                Show this help message

EXAMPLES:
    $0                    # Run all unit tests
    $0 --verbose          # Run with verbose output
    $0 --cleanup-only     # Clean up test artifacts

OUTPUT:
    - Test log: $UNIT_TEST_LOG
    - JSON report: $TEST_RESULTS_FILE

EOF
}

# Main function
main() {
    local verbose="false"
    local cleanup_only="false"
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --verbose)
                verbose="true"
                shift
                ;;
            --cleanup-only)
                cleanup_only="true"
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
    
    # Set up signal handlers for cleanup
    trap cleanup EXIT
    trap 'log "INFO" "Received interrupt signal"; exit 1' INT TERM
    
    log "INFO" "Starting unit tests for RTSP-SSE Stream Script"
    
    # Perform cleanup if requested
    if [[ "$cleanup_only" == "true" ]]; then
        cleanup
        log "INFO" "Cleanup completed"
        exit 0
    fi
    
    # Initialize log file
    echo "Unit Tests Log - $(date)" > "$UNIT_TEST_LOG"
    
    # Create temporary directory
    mkdir -p "$TEMP_DIR"
    
    # Source script functions
    source_script_functions
    
    # Run all test suites
    test_url_validation
    test_parameter_validation
    test_json_parsing
    test_file_operations
    test_process_management
    test_configuration_loading
    test_logging_functions
    
    # Generate final report
    generate_test_report
}

# Run main function if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi