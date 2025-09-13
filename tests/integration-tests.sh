#!/bin/bash

# Integration Tests for RTSP-SSE Stream Script
# Tests complete workflows and component interactions
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
INTEGRATION_TEST_LOG="$SCRIPT_DIR/integration-tests.log"
TEST_RESULTS_FILE="$SCRIPT_DIR/integration-test-results.json"
TEMP_DIR="$SCRIPT_DIR/integration_test_temp"
MOCK_SSE_SERVER="$SCRIPT_DIR/mock-sse-server.js"
DRY_RUN_WRAPPER="$SCRIPT_DIR/dry-run-wrapper.sh"

# Test configuration
TEST_CONFIG_FILE="$TEMP_DIR/test_config.conf"
TEST_LOG_FILE="$TEMP_DIR/test_stream.log"
TEST_PID_DIR="$TEMP_DIR/pids"
TEST_LOCK_FILE="$TEMP_DIR/test_stream.lock"
TEST_SSE_PIPE="$TEMP_DIR/sse_pipe"
TEST_PARAM_PIPE="$TEMP_DIR/param_pipe"
MOCK_SSE_PORT="3001"
MOCK_SSE_URL="http://localhost:$MOCK_SSE_PORT/events"

# Test results storage
declare -A TEST_RESULTS
declare -A TEST_DETAILS
declare -i TOTAL_TESTS=0
declare -i PASSED_TESTS=0
declare -i FAILED_TESTS=0

# Process tracking
MOCK_SSE_PID=""
STREAM_SCRIPT_PID=""

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
    echo "[$timestamp] [$level] $message" >> "$INTEGRATION_TEST_LOG"
}

# Test assertion functions
assert_integration_test() {
    local test_name="$1"
    local test_function="$2"
    local expected_result="${3:-0}"  # Default to success (0)
    
    ((TOTAL_TESTS++))
    
    log "INFO" "Running integration test: $test_name"
    
    local start_time="$(date +%s)"
    local result=0
    
    # Run the test function
    if $test_function; then
        result=0
    else
        result=1
    fi
    
    local end_time="$(date +%s)"
    local duration=$((end_time - start_time))
    
    if [[ $result -eq $expected_result ]]; then
        ((PASSED_TESTS++))
        TEST_RESULTS["$test_name"]="PASS"
        TEST_DETAILS["$test_name"]="Test completed in ${duration}s"
        log "PASS" "✅ $test_name (${duration}s)"
        return 0
    else
        ((FAILED_TESTS++))
        TEST_RESULTS["$test_name"]="FAIL"
        TEST_DETAILS["$test_name"]="Test failed after ${duration}s (expected: $expected_result, got: $result)"
        log "FAIL" "❌ $test_name - Expected: $expected_result, Got: $result (${duration}s)"
        return 1
    fi
}

# Setup test environment
setup_test_environment() {
    log "INFO" "Setting up integration test environment..."
    
    # Create temporary directories
    mkdir -p "$TEMP_DIR" "$TEST_PID_DIR"
    
    # Create test configuration file
    cat > "$TEST_CONFIG_FILE" << EOF
#!/bin/bash
# Integration Test Configuration

# Stream configuration
RTSP_INPUT="rtsp://test.example.com:554/live/stream"
RTMP_OUTPUT="rtmp://test.example.com:1935/live/test_stream"
SSE_URL="$MOCK_SSE_URL"

# Stream parameters
CURRENT_TSP="2000"
CURRENT_RAMP="2500"
CURRENT_BUFSIZE="3000"

# Process management
RESTART_DELAY="2"
MAX_RESTART_ATTEMPTS="3"

# File paths
PID_DIR="$TEST_PID_DIR"
LOG_FILE="$TEST_LOG_FILE"
LOCK_FILE="$TEST_LOCK_FILE"
SSE_PIPE="$TEST_SSE_PIPE"
PARAM_PIPE="$TEST_PARAM_PIPE"

# Logging
COLOR_OUTPUT="true"
LOG_LEVEL="DEBUG"

# FFmpeg options
FFMPEG_EXTRA_OPTS="-preset ultrafast -tune zerolatency"
NICE_LEVEL="0"
MEMORY_LIMIT="256"

# Hardware acceleration
HW_ACCEL="false"
HW_ACCEL_METHOD="auto"
EOF
    
    # Make scripts executable
    chmod +x "$TARGET_SCRIPT" 2>/dev/null || true
    chmod +x "$DRY_RUN_WRAPPER" 2>/dev/null || true
    
    log "INFO" "Test environment setup completed"
}

# Start mock SSE server
start_mock_sse_server() {
    log "INFO" "Starting mock SSE server on port $MOCK_SSE_PORT..."
    
    if [[ ! -f "$MOCK_SSE_SERVER" ]]; then
        log "ERROR" "Mock SSE server not found: $MOCK_SSE_SERVER"
        return 1
    fi
    
    # Start the mock SSE server in background
    node "$MOCK_SSE_SERVER" --port="$MOCK_SSE_PORT" --scenario="integration" > "$TEMP_DIR/mock_sse.log" 2>&1 &
    MOCK_SSE_PID=$!
    
    # Wait for server to start
    sleep 2
    
    # Check if server is running
    if kill -0 "$MOCK_SSE_PID" 2>/dev/null; then
        log "INFO" "Mock SSE server started with PID: $MOCK_SSE_PID"
        return 0
    else
        log "ERROR" "Failed to start mock SSE server"
        return 1
    fi
}

# Stop mock SSE server
stop_mock_sse_server() {
    if [[ -n "$MOCK_SSE_PID" ]] && kill -0 "$MOCK_SSE_PID" 2>/dev/null; then
        log "INFO" "Stopping mock SSE server (PID: $MOCK_SSE_PID)..."
        kill "$MOCK_SSE_PID" 2>/dev/null || true
        wait "$MOCK_SSE_PID" 2>/dev/null || true
        MOCK_SSE_PID=""
    fi
}

# Test 1: Configuration Loading and Validation
test_configuration_loading() {
    log "DEBUG" "Testing configuration loading and validation..."
    
    # Test with valid configuration
    if bash "$DRY_RUN_WRAPPER" --config="$TEST_CONFIG_FILE" --validate-only > "$TEMP_DIR/config_test.log" 2>&1; then
        log "DEBUG" "Configuration validation passed"
        return 0
    else
        log "ERROR" "Configuration validation failed"
        cat "$TEMP_DIR/config_test.log"
        return 1
    fi
}

# Test 2: SSE Connection and Parameter Reception
test_sse_connection() {
    log "DEBUG" "Testing SSE connection and parameter reception..."
    
    # Start mock SSE server if not running
    if [[ -z "$MOCK_SSE_PID" ]] || ! kill -0 "$MOCK_SSE_PID" 2>/dev/null; then
        start_mock_sse_server || return 1
    fi
    
    # Test SSE connection using curl
    local sse_test_output="$TEMP_DIR/sse_test.log"
    timeout 10 curl -s --no-buffer "$MOCK_SSE_URL" > "$sse_test_output" 2>&1 &
    local curl_pid=$!
    
    sleep 3
    kill "$curl_pid" 2>/dev/null || true
    wait "$curl_pid" 2>/dev/null || true
    
    # Check if we received SSE events
    if grep -q "data:" "$sse_test_output"; then
        log "DEBUG" "SSE connection test passed"
        return 0
    else
        log "ERROR" "SSE connection test failed"
        cat "$sse_test_output"
        return 1
    fi
}

# Test 3: Dry-run Stream Startup
test_dry_run_startup() {
    log "DEBUG" "Testing dry-run stream startup..."
    
    # Run the script in dry-run mode
    local dry_run_output="$TEMP_DIR/dry_run_startup.log"
    
    timeout 15 bash "$DRY_RUN_WRAPPER" --config="$TEST_CONFIG_FILE" --test-duration=10 > "$dry_run_output" 2>&1
    local exit_code=$?
    
    # Check if dry-run completed successfully
    if [[ $exit_code -eq 0 ]] && grep -q "Dry-run test completed successfully" "$dry_run_output"; then
        log "DEBUG" "Dry-run startup test passed"
        return 0
    else
        log "ERROR" "Dry-run startup test failed (exit code: $exit_code)"
        tail -20 "$dry_run_output"
        return 1
    fi
}

# Test 4: Parameter Update Workflow
test_parameter_updates() {
    log "DEBUG" "Testing parameter update workflow..."
    
    # Start mock SSE server with parameter updates
    start_mock_sse_server || return 1
    
    # Run dry-run with parameter monitoring
    local param_test_output="$TEMP_DIR/param_update_test.log"
    
    timeout 20 bash "$DRY_RUN_WRAPPER" --config="$TEST_CONFIG_FILE" --test-duration=15 --enable-sse > "$param_test_output" 2>&1
    local exit_code=$?
    
    # Check if parameter updates were processed
    if [[ $exit_code -eq 0 ]] && grep -q "Parameter update received" "$param_test_output"; then
        log "DEBUG" "Parameter update test passed"
        return 0
    else
        log "ERROR" "Parameter update test failed (exit code: $exit_code)"
        tail -20 "$param_test_output"
        return 1
    fi
}

# Test 5: Signal Handling and Graceful Shutdown
test_signal_handling() {
    log "DEBUG" "Testing signal handling and graceful shutdown..."
    
    # Start the script in background
    bash "$DRY_RUN_WRAPPER" --config="$TEST_CONFIG_FILE" --test-duration=30 > "$TEMP_DIR/signal_test.log" 2>&1 &
    local script_pid=$!
    
    sleep 5
    
    # Send SIGTERM to test graceful shutdown
    if kill -TERM "$script_pid" 2>/dev/null; then
        # Wait for graceful shutdown
        local shutdown_timeout=10
        local count=0
        
        while kill -0 "$script_pid" 2>/dev/null && [[ $count -lt $shutdown_timeout ]]; do
            sleep 1
            ((count++))
        done
        
        if ! kill -0 "$script_pid" 2>/dev/null; then
            log "DEBUG" "Signal handling test passed (graceful shutdown)"
            return 0
        else
            # Force kill if still running
            kill -KILL "$script_pid" 2>/dev/null || true
            log "ERROR" "Signal handling test failed (no graceful shutdown)"
            return 1
        fi
    else
        log "ERROR" "Signal handling test failed (could not send signal)"
        return 1
    fi
}

# Test 6: Lock File Management
test_lock_file_management() {
    log "DEBUG" "Testing lock file management..."
    
    # Remove any existing lock file
    rm -f "$TEST_LOCK_FILE"
    
    # Start first instance
    bash "$DRY_RUN_WRAPPER" --config="$TEST_CONFIG_FILE" --test-duration=10 > "$TEMP_DIR/lock_test1.log" 2>&1 &
    local first_pid=$!
    
    sleep 2
    
    # Try to start second instance (should fail due to lock)
    local second_output="$TEMP_DIR/lock_test2.log"
    bash "$DRY_RUN_WRAPPER" --config="$TEST_CONFIG_FILE" --test-duration=5 > "$second_output" 2>&1
    local second_exit_code=$?
    
    # Wait for first instance to complete
    wait "$first_pid" 2>/dev/null || true
    
    # Check if second instance was properly rejected
    if [[ $second_exit_code -ne 0 ]] && grep -q "already running" "$second_output"; then
        log "DEBUG" "Lock file management test passed"
        return 0
    else
        log "ERROR" "Lock file management test failed"
        cat "$second_output"
        return 1
    fi
}

# Test 7: Configuration Reload
test_configuration_reload() {
    log "DEBUG" "Testing configuration reload functionality..."
    
    # Create initial config
    local reload_config="$TEMP_DIR/reload_test.conf"
    cp "$TEST_CONFIG_FILE" "$reload_config"
    
    # Start script with reload config
    bash "$DRY_RUN_WRAPPER" --config="$reload_config" --test-duration=15 > "$TEMP_DIR/reload_test.log" 2>&1 &
    local script_pid=$!
    
    sleep 3
    
    # Modify configuration
    sed -i.bak 's/CURRENT_TSP="2000"/CURRENT_TSP="1800"/' "$reload_config" 2>/dev/null || \
    sed -i '' 's/CURRENT_TSP="2000"/CURRENT_TSP="1800"/' "$reload_config" 2>/dev/null || true
    
    # Send SIGHUP to reload config
    if kill -HUP "$script_pid" 2>/dev/null; then
        sleep 2
        
        # Check if config was reloaded
        if grep -q "Configuration reloaded" "$TEMP_DIR/reload_test.log"; then
            kill -TERM "$script_pid" 2>/dev/null || true
            wait "$script_pid" 2>/dev/null || true
            log "DEBUG" "Configuration reload test passed"
            return 0
        else
            kill -TERM "$script_pid" 2>/dev/null || true
            wait "$script_pid" 2>/dev/null || true
            log "ERROR" "Configuration reload test failed (no reload message)"
            return 1
        fi
    else
        log "ERROR" "Configuration reload test failed (could not send SIGHUP)"
        return 1
    fi
}

# Test 8: Error Recovery and Restart
test_error_recovery() {
    log "DEBUG" "Testing error recovery and restart functionality..."
    
    # Create a config that will cause controlled failures
    local error_config="$TEMP_DIR/error_test.conf"
    cp "$TEST_CONFIG_FILE" "$error_config"
    
    # Run with error simulation
    local error_output="$TEMP_DIR/error_recovery_test.log"
    timeout 20 bash "$DRY_RUN_WRAPPER" --config="$error_config" --test-duration=15 --simulate-errors > "$error_output" 2>&1
    local exit_code=$?
    
    # Check if error recovery was attempted
    if grep -q "Attempting restart" "$error_output" || grep -q "Error recovery" "$error_output"; then
        log "DEBUG" "Error recovery test passed"
        return 0
    else
        log "ERROR" "Error recovery test failed"
        tail -20 "$error_output"
        return 1
    fi
}

# Test 9: Resource Management
test_resource_management() {
    log "DEBUG" "Testing resource management (memory, CPU)..."
    
    # Run with resource monitoring
    local resource_output="$TEMP_DIR/resource_test.log"
    
    timeout 15 bash "$DRY_RUN_WRAPPER" --config="$TEST_CONFIG_FILE" --test-duration=10 --monitor-resources > "$resource_output" 2>&1
    local exit_code=$?
    
    # Check if resource monitoring was active
    if [[ $exit_code -eq 0 ]] && (grep -q "Memory usage" "$resource_output" || grep -q "Resource monitoring" "$resource_output"); then
        log "DEBUG" "Resource management test passed"
        return 0
    else
        log "ERROR" "Resource management test failed"
        tail -10 "$resource_output"
        return 1
    fi
}

# Test 10: End-to-End Workflow
test_end_to_end_workflow() {
    log "DEBUG" "Testing complete end-to-end workflow..."
    
    # Start mock SSE server
    start_mock_sse_server || return 1
    
    # Run complete workflow test
    local e2e_output="$TEMP_DIR/e2e_test.log"
    
    timeout 30 bash "$DRY_RUN_WRAPPER" --config="$TEST_CONFIG_FILE" --test-duration=20 --enable-sse --full-workflow > "$e2e_output" 2>&1
    local exit_code=$?
    
    # Check if all components worked together
    local success_indicators=(
        "Configuration loaded"
        "SSE connection established"
        "Stream started"
        "Parameter monitoring active"
    )
    
    local indicators_found=0
    for indicator in "${success_indicators[@]}"; do
        if grep -q "$indicator" "$e2e_output"; then
            ((indicators_found++))
        fi
    done
    
    if [[ $exit_code -eq 0 ]] && [[ $indicators_found -ge 2 ]]; then
        log "DEBUG" "End-to-end workflow test passed ($indicators_found/4 indicators found)"
        return 0
    else
        log "ERROR" "End-to-end workflow test failed (exit: $exit_code, indicators: $indicators_found/4)"
        tail -30 "$e2e_output"
        return 1
    fi
}

# Generate integration test report
generate_integration_report() {
    log "INFO" "Generating integration test report..."
    
    local success_rate=0
    if [[ $TOTAL_TESTS -gt 0 ]]; then
        success_rate=$(( (PASSED_TESTS * 100) / TOTAL_TESTS ))
    fi
    
    # Generate JSON report
    cat > "$TEST_RESULTS_FILE" << EOF
{
  "integration_tests": {
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
    echo "=== INTEGRATION TEST RESULTS ==="
    echo "Total Tests: $TOTAL_TESTS"
    echo "Passed: $PASSED_TESTS"
    echo "Failed: $FAILED_TESTS"
    echo "Success Rate: $success_rate%"
    echo
    
    if [[ $FAILED_TESTS -eq 0 ]]; then
        log "PASS" "✅ All integration tests passed!"
        return 0
    else
        log "FAIL" "❌ $FAILED_TESTS integration tests failed"
        return 1
    fi
}

# Cleanup function
cleanup() {
    log "INFO" "Cleaning up integration test environment..."
    
    # Stop mock SSE server
    stop_mock_sse_server
    
    # Kill any remaining test processes
    if [[ -n "$STREAM_SCRIPT_PID" ]] && kill -0 "$STREAM_SCRIPT_PID" 2>/dev/null; then
        kill "$STREAM_SCRIPT_PID" 2>/dev/null || true
        wait "$STREAM_SCRIPT_PID" 2>/dev/null || true
    fi
    
    # Remove lock files
    rm -f "$TEST_LOCK_FILE" 2>/dev/null || true
    
    # Clean up named pipes
    rm -f "$TEST_SSE_PIPE" "$TEST_PARAM_PIPE" 2>/dev/null || true
    
    # Remove temporary directory (optional, keep for debugging)
    # [[ -d "$TEMP_DIR" ]] && rm -rf "$TEMP_DIR"
    
    log "INFO" "Integration test cleanup completed"
}

# Show usage information
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Integration Tests for RTSP-SSE Stream Script

OPTIONS:
    --verbose             Enable verbose output
    --cleanup-only        Only perform cleanup and exit
    --test=TEST_NAME      Run specific test only
    --skip-sse            Skip tests requiring SSE server
    --help                Show this help message

AVAILABLE TESTS:
    config_loading        Configuration loading and validation
    sse_connection        SSE connection and parameter reception
    dry_run_startup       Dry-run stream startup
    parameter_updates     Parameter update workflow
    signal_handling       Signal handling and graceful shutdown
    lock_management       Lock file management
    config_reload         Configuration reload functionality
    error_recovery        Error recovery and restart
    resource_management   Resource management
    end_to_end           Complete end-to-end workflow

EXAMPLES:
    $0                           # Run all integration tests
    $0 --test=config_loading     # Run specific test
    $0 --skip-sse                # Skip SSE-dependent tests
    $0 --cleanup-only            # Clean up test artifacts

OUTPUT:
    - Test log: $INTEGRATION_TEST_LOG
    - JSON report: $TEST_RESULTS_FILE
    - Temp files: $TEMP_DIR/

EOF
}

# Main function
main() {
    local verbose="false"
    local cleanup_only="false"
    local specific_test=""
    local skip_sse="false"
    
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
            --test=*)
                specific_test="${1#*=}"
                shift
                ;;
            --skip-sse)
                skip_sse="true"
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
    
    log "INFO" "Starting integration tests for RTSP-SSE Stream Script"
    
    # Perform cleanup if requested
    if [[ "$cleanup_only" == "true" ]]; then
        cleanup
        log "INFO" "Cleanup completed"
        exit 0
    fi
    
    # Initialize log file
    echo "Integration Tests Log - $(date)" > "$INTEGRATION_TEST_LOG"
    
    # Setup test environment
    setup_test_environment
    
    # Check dependencies
    if [[ ! -f "$TARGET_SCRIPT" ]]; then
        log "ERROR" "Target script not found: $TARGET_SCRIPT"
        exit 1
    fi
    
    if [[ ! -f "$DRY_RUN_WRAPPER" ]]; then
        log "ERROR" "Dry-run wrapper not found: $DRY_RUN_WRAPPER"
        exit 1
    fi
    
    # Run specific test if requested
    if [[ -n "$specific_test" ]]; then
        case "$specific_test" in
            "config_loading")
                assert_integration_test "Configuration Loading" "test_configuration_loading"
                ;;
            "sse_connection")
                if [[ "$skip_sse" == "false" ]]; then
                    assert_integration_test "SSE Connection" "test_sse_connection"
                else
                    log "INFO" "Skipping SSE connection test"
                fi
                ;;
            "dry_run_startup")
                assert_integration_test "Dry-run Startup" "test_dry_run_startup"
                ;;
            "parameter_updates")
                if [[ "$skip_sse" == "false" ]]; then
                    assert_integration_test "Parameter Updates" "test_parameter_updates"
                else
                    log "INFO" "Skipping parameter updates test"
                fi
                ;;
            "signal_handling")
                assert_integration_test "Signal Handling" "test_signal_handling"
                ;;
            "lock_management")
                assert_integration_test "Lock Management" "test_lock_file_management"
                ;;
            "config_reload")
                assert_integration_test "Config Reload" "test_configuration_reload"
                ;;
            "error_recovery")
                assert_integration_test "Error Recovery" "test_error_recovery"
                ;;
            "resource_management")
                assert_integration_test "Resource Management" "test_resource_management"
                ;;
            "end_to_end")
                if [[ "$skip_sse" == "false" ]]; then
                    assert_integration_test "End-to-End Workflow" "test_end_to_end_workflow"
                else
                    log "INFO" "Skipping end-to-end test"
                fi
                ;;
            *)
                log "ERROR" "Unknown test: $specific_test"
                usage
                exit 1
                ;;
        esac
    else
        # Run all integration tests
        assert_integration_test "Configuration Loading" "test_configuration_loading"
        
        if [[ "$skip_sse" == "false" ]]; then
            assert_integration_test "SSE Connection" "test_sse_connection"
        fi
        
        assert_integration_test "Dry-run Startup" "test_dry_run_startup"
        
        if [[ "$skip_sse" == "false" ]]; then
            assert_integration_test "Parameter Updates" "test_parameter_updates"
        fi
        
        assert_integration_test "Signal Handling" "test_signal_handling"
        assert_integration_test "Lock Management" "test_lock_file_management"
        assert_integration_test "Config Reload" "test_configuration_reload"
        assert_integration_test "Error Recovery" "test_error_recovery"
        assert_integration_test "Resource Management" "test_resource_management"
        
        if [[ "$skip_sse" == "false" ]]; then
            assert_integration_test "End-to-End Workflow" "test_end_to_end_workflow"
        fi
    fi
    
    # Generate final report
    generate_integration_report
}

# Run main function if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi