#!/opt/homebrew/bin/bash

# Test Runner for RTSP-SSE Stream Script
# Orchestrates all testing components for comprehensive validation
# Compatible with macOS for development while targeting Linux deployment

# Require bash 4.0+ for associative arrays
if [[ ${BASH_VERSION%%.*} -lt 4 ]]; then
    echo "Error: This script requires Bash 4.0 or later for associative arrays" >&2
    echo "Current version: $BASH_VERSION" >&2
    exit 1
fi

set -euo pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Script configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEST_RUNNER_LOG="$SCRIPT_DIR/test-runner.log"
FINAL_REPORT_FILE="$SCRIPT_DIR/final-test-report.json"
FINAL_REPORT_HTML="$SCRIPT_DIR/final-test-report.html"

# Test script paths
SYNTAX_VALIDATOR="$SCRIPT_DIR/syntax-validator.sh"
CROSS_PLATFORM_CHECKER="$SCRIPT_DIR/cross-platform-checker.sh"
UNIT_TESTS="$SCRIPT_DIR/unit-tests.sh"
INTEGRATION_TESTS="$SCRIPT_DIR/integration-tests.sh"
PERFORMANCE_TOOLS="$SCRIPT_DIR/performance-tools.sh"
MOCK_SSE_SERVER="$SCRIPT_DIR/mock-sse-server.js"

# Test suite configuration
declare -A TEST_SUITES=(
    ["syntax"]="Syntax Validation and ShellCheck Analysis"
    ["cross_platform"]="Cross-Platform Compatibility Checks"
    ["unit"]="Unit Tests for Individual Functions"
    ["integration"]="Integration Test Scenarios"
    ["performance"]="Performance Benchmarking"
)

declare -A TEST_SCRIPTS=(
    ["syntax"]="$SYNTAX_VALIDATOR"
    ["cross_platform"]="$CROSS_PLATFORM_CHECKER"
    ["unit"]="$UNIT_TESTS"
    ["integration"]="$INTEGRATION_TESTS"
    ["performance"]="$PERFORMANCE_TOOLS"
)

# Test results storage
declare -A SUITE_RESULTS
declare -A SUITE_DETAILS
declare -A SUITE_DURATIONS
declare -i TOTAL_SUITES=0
declare -i PASSED_SUITES=0
declare -i FAILED_SUITES=0
declare -i SKIPPED_SUITES=0

# Configuration
VERBOSE="false"
PARALLEL="false"
STOP_ON_FAILURE="false"
SKIP_DEPENDENCIES="false"
GENERATE_HTML="true"
CLEANUP_AFTER="true"
TEST_TIMEOUT="300"  # 5 minutes per test suite

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
        "SKIP") color="$YELLOW" ;;
        "HEADER") color="$MAGENTA" ;;
    esac
    
    echo -e "${color}[$timestamp] [$level] $message${NC}"
    echo "[$timestamp] [$level] $message" >> "$TEST_RUNNER_LOG"
}

# Progress indicator
show_progress() {
    local current="$1"
    local total="$2"
    local test_name="$3"
    local percentage=$((current * 100 / total))
    
    printf "\r${CYAN}[%d/%d] (%d%%) Running: %s${NC}" "$current" "$total" "$percentage" "$test_name"
}

# Check dependencies
check_dependencies() {
    log "INFO" "Checking test dependencies..."
    
    local missing_deps=()
    
    # Check for required commands
    local required_commands=("bash" "node" "curl")
    for cmd in "${required_commands[@]}"; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            missing_deps+=("$cmd")
        fi
    done
    
    # Check for timeout command (Linux) or gtimeout (macOS)
    if ! command -v "timeout" >/dev/null 2>&1 && ! command -v "gtimeout" >/dev/null 2>&1; then
        missing_deps+=("timeout or gtimeout")
    fi
    
    # Check for test scripts
    for suite in "${!TEST_SCRIPTS[@]}"; do
        local script="${TEST_SCRIPTS[$suite]}"
        if [[ ! -f "$script" ]]; then
            missing_deps+=("$script")
        fi
    done
    
    # Check for Node.js and mock SSE server
    if [[ ! -f "$MOCK_SSE_SERVER" ]]; then
        missing_deps+=("$MOCK_SSE_SERVER")
    fi
    
    if [[ ${#missing_deps[@]} -gt 0 ]]; then
        log "ERROR" "Missing dependencies: ${missing_deps[*]}"
        return 1
    fi
    
    log "INFO" "All dependencies satisfied"
    return 0
}

# Run individual test suite
run_test_suite() {
    local suite_name="$1"
    local suite_description="$2"
    local script_path="$3"
    local suite_args="${4:-}"
    
    # Ensure suite_args is properly initialized
    suite_args="${suite_args:-}"
    
    ((TOTAL_SUITES++))
    
    log "HEADER" "Running $suite_description..."
    
    local start_time="$(date +%s)"
    local suite_log="$SCRIPT_DIR/${suite_name}-suite.log"
    local exit_code=0
    
    # Prepare command
    local cmd="bash '$script_path'"
    if [[ -n "$suite_args" ]]; then
        cmd="$cmd $suite_args"
    fi
    
    if [[ "$VERBOSE" == "true" ]]; then
        cmd="$cmd --verbose"
    fi
    
    # Run the test suite with timeout (use gtimeout on macOS, timeout on Linux)
    local timeout_cmd="timeout"
    if ! command -v "timeout" >/dev/null 2>&1 && command -v "gtimeout" >/dev/null 2>&1; then
        timeout_cmd="gtimeout"
    fi
    
    if "$timeout_cmd" "$TEST_TIMEOUT" bash -c "$cmd" > "$suite_log" 2>&1; then
        exit_code=0
    else
        exit_code=$?
    fi
    
    local end_time="$(date +%s)"
    local duration=$((end_time - start_time))
    SUITE_DURATIONS["$suite_name"]="$duration"
    
    # Process results
    if [[ $exit_code -eq 0 ]]; then
        ((PASSED_SUITES++))
        SUITE_RESULTS["$suite_name"]="PASS"
        SUITE_DETAILS["$suite_name"]="Completed successfully in ${duration}s"
        log "PASS" "✅ $suite_description (${duration}s)"
    elif [[ $exit_code -eq 124 ]]; then
        # Timeout
        ((FAILED_SUITES++))
        SUITE_RESULTS["$suite_name"]="TIMEOUT"
        SUITE_DETAILS["$suite_name"]="Test suite timed out after ${TEST_TIMEOUT}s"
        log "FAIL" "⏰ $suite_description - TIMEOUT (${TEST_TIMEOUT}s)"
    else
        ((FAILED_SUITES++))
        SUITE_RESULTS["$suite_name"]="FAIL"
        SUITE_DETAILS["$suite_name"]="Failed with exit code $exit_code after ${duration}s"
        log "FAIL" "❌ $suite_description - FAILED (exit: $exit_code, ${duration}s)"
        
        # Show last few lines of output for debugging
        if [[ "$VERBOSE" == "true" ]] && [[ -f "$suite_log" ]]; then
            echo
            log "DEBUG" "Last 10 lines of $suite_name output:"
            tail -10 "$suite_log" | while IFS= read -r line; do
                echo "  $line"
            done
            echo
        fi
    fi
    
    # Stop on failure if requested
    if [[ "$STOP_ON_FAILURE" == "true" ]] && [[ $exit_code -ne 0 ]]; then
        log "ERROR" "Stopping test execution due to failure in $suite_description"
        return $exit_code
    fi
    
    return 0
}

# Run test suites in parallel
run_parallel_tests() {
    log "INFO" "Running test suites in parallel..."
    
    local pids=()
    local suite_names=()
    
    # Start all test suites in background
    for suite in "${!TEST_SUITES[@]}"; do
        local description="${TEST_SUITES[$suite]}"
        local script="${TEST_SCRIPTS[$suite]}"
        
        if [[ ! -f "$script" ]]; then
            log "SKIP" "Skipping $description (script not found: $script)"
            ((SKIPPED_SUITES++))
            continue
        fi
        
        # Run in background
        run_test_suite "$suite" "$description" "$script" "" &
        pids+=("$!")
        suite_names+=("$suite")
    done
    
    # Wait for all to complete
    local failed_any=false
    for i in "${!pids[@]}"; do
        local pid="${pids[$i]}"
        local suite="${suite_names[$i]}"
        
        if wait "$pid"; then
            log "DEBUG" "Parallel suite $suite completed successfully"
        else
            log "ERROR" "Parallel suite $suite failed"
            failed_any=true
        fi
    done
    
    if [[ "$failed_any" == "true" ]]; then
        return 1
    fi
    
    return 0
}

# Run test suites sequentially
run_sequential_tests() {
    log "INFO" "Running test suites sequentially..."
    
    local current=0
    local total=${#TEST_SUITES[@]}
    
    for suite in "syntax" "cross_platform" "unit" "integration" "performance"; do
        if [[ -z "${TEST_SUITES[$suite]:-}" ]]; then
            continue
        fi
        
        ((current++))
        local description="${TEST_SUITES[$suite]}"
        local script="${TEST_SCRIPTS[$suite]}"
        
        show_progress "$current" "$total" "$description"
        echo  # New line after progress
        
        if [[ ! -f "$script" ]]; then
            log "SKIP" "Skipping $description (script not found: $script)"
            ((SKIPPED_SUITES++))
            continue
        fi
        
        # Special handling for different test types
        local suite_args=""
        case "$suite" in
            "integration")
                # Integration tests might need special setup
                suite_args="--skip-sse"  # Skip SSE tests if no server available
                ;;
            "performance")
                # Performance tests with shorter duration for CI
                suite_args="--quick"
                ;;
        esac
        
        if ! run_test_suite "$suite" "$description" "$script" "$suite_args"; then
            if [[ "$STOP_ON_FAILURE" == "true" ]]; then
                break
            fi
        fi
    done
}

# Generate JSON report
generate_json_report() {
    log "INFO" "Generating JSON test report..."
    
    local success_rate=0
    if [[ $TOTAL_SUITES -gt 0 ]]; then
        success_rate=$(( (PASSED_SUITES * 100) / TOTAL_SUITES ))
    fi
    
    local total_duration=0
    for duration in "${SUITE_DURATIONS[@]}"; do
        ((total_duration += duration))
    done
    
    cat > "$FINAL_REPORT_FILE" << EOF
{
  "test_execution": {
    "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "environment": {
      "os": "$(uname -s)",
      "arch": "$(uname -m)",
      "shell": "$SHELL",
      "node_version": "$(node --version 2>/dev/null || echo 'N/A')",
      "bash_version": "$BASH_VERSION"
    },
    "configuration": {
      "parallel": $PARALLEL,
      "verbose": $VERBOSE,
      "stop_on_failure": $STOP_ON_FAILURE,
      "test_timeout": $TEST_TIMEOUT
    },
    "summary": {
      "total_suites": $TOTAL_SUITES,
      "passed": $PASSED_SUITES,
      "failed": $FAILED_SUITES,
      "skipped": $SKIPPED_SUITES,
      "success_rate": $success_rate,
      "total_duration": $total_duration
    },
    "suite_results": {
EOF
    
    # Add individual suite results
    local first=true
    for suite in "${!SUITE_RESULTS[@]}"; do
        if [[ "$first" == "true" ]]; then
            first=false
        else
            echo "," >> "$FINAL_REPORT_FILE"
        fi
        
        local duration="${SUITE_DURATIONS[$suite]:-0}"
        
        echo -n "      \"$suite\": {" >> "$FINAL_REPORT_FILE"
        echo -n "\"result\": \"${SUITE_RESULTS[$suite]}\", " >> "$FINAL_REPORT_FILE"
        echo -n "\"details\": \"${SUITE_DETAILS[$suite]}\", " >> "$FINAL_REPORT_FILE"
        echo -n "\"duration\": $duration" >> "$FINAL_REPORT_FILE"
        echo -n "}" >> "$FINAL_REPORT_FILE"
    done
    
    cat >> "$FINAL_REPORT_FILE" << EOF

    }
  }
}
EOF
    
    log "INFO" "JSON report generated: $FINAL_REPORT_FILE"
}

# Generate HTML report
generate_html_report() {
    if [[ "$GENERATE_HTML" != "true" ]]; then
        return 0
    fi
    
    log "INFO" "Generating HTML test report..."
    
    local success_rate=0
    if [[ $TOTAL_SUITES -gt 0 ]]; then
        success_rate=$(( (PASSED_SUITES * 100) / TOTAL_SUITES ))
    fi
    
    cat > "$FINAL_REPORT_HTML" << EOF
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RTSP-SSE Stream Script - Test Report</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }
        .header h1 {
            margin: 0;
            font-size: 2.5em;
        }
        .header p {
            margin: 10px 0 0 0;
            opacity: 0.9;
        }
        .summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            padding: 30px;
            background: #f8f9fa;
        }
        .metric {
            text-align: center;
            padding: 20px;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .metric-value {
            font-size: 2em;
            font-weight: bold;
            margin-bottom: 5px;
        }
        .metric-label {
            color: #666;
            font-size: 0.9em;
        }
        .pass { color: #28a745; }
        .fail { color: #dc3545; }
        .skip { color: #ffc107; }
        .results {
            padding: 30px;
        }
        .suite {
            margin-bottom: 20px;
            border: 1px solid #e9ecef;
            border-radius: 8px;
            overflow: hidden;
        }
        .suite-header {
            padding: 15px 20px;
            font-weight: bold;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .suite-header.pass { background: #d4edda; color: #155724; }
        .suite-header.fail { background: #f8d7da; color: #721c24; }
        .suite-header.skip { background: #fff3cd; color: #856404; }
        .suite-details {
            padding: 15px 20px;
            background: #f8f9fa;
            border-top: 1px solid #e9ecef;
            font-family: monospace;
            font-size: 0.9em;
        }
        .status-badge {
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.8em;
            font-weight: bold;
        }
        .footer {
            padding: 20px 30px;
            background: #f8f9fa;
            border-top: 1px solid #e9ecef;
            text-align: center;
            color: #666;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🧪 Test Report</h1>
            <p>RTSP-SSE Stream Script - Comprehensive Testing Suite</p>
            <p>Generated on $(date)</p>
        </div>
        
        <div class="summary">
            <div class="metric">
                <div class="metric-value">$TOTAL_SUITES</div>
                <div class="metric-label">Total Suites</div>
            </div>
            <div class="metric">
                <div class="metric-value pass">$PASSED_SUITES</div>
                <div class="metric-label">Passed</div>
            </div>
            <div class="metric">
                <div class="metric-value fail">$FAILED_SUITES</div>
                <div class="metric-label">Failed</div>
            </div>
            <div class="metric">
                <div class="metric-value skip">$SKIPPED_SUITES</div>
                <div class="metric-label">Skipped</div>
            </div>
            <div class="metric">
                <div class="metric-value">$success_rate%</div>
                <div class="metric-label">Success Rate</div>
            </div>
        </div>
        
        <div class="results">
            <h2>Test Suite Results</h2>
EOF
    
    # Add individual suite results
    for suite in "syntax" "cross_platform" "unit" "integration" "performance"; do
        if [[ -z "${SUITE_RESULTS[$suite]:-}" ]]; then
            continue
        fi
        
        local result="${SUITE_RESULTS[$suite]}"
        local details="${SUITE_DETAILS[$suite]}"
        local description="${TEST_SUITES[$suite]}"
        local duration="${SUITE_DURATIONS[$suite]:-0}"
        
        local css_class=""
        local status_text=""
        case "$result" in
            "PASS")
                css_class="pass"
                status_text="✅ PASSED"
                ;;
            "FAIL")
                css_class="fail"
                status_text="❌ FAILED"
                ;;
            "TIMEOUT")
                css_class="fail"
                status_text="⏰ TIMEOUT"
                ;;
            *)
                css_class="skip"
                status_text="⏭️ SKIPPED"
                ;;
        esac
        
        cat >> "$FINAL_REPORT_HTML" << EOF
            <div class="suite">
                <div class="suite-header $css_class">
                    <span>$description</span>
                    <span class="status-badge">$status_text (${duration}s)</span>
                </div>
                <div class="suite-details">
                    $details
                </div>
            </div>
EOF
    done
    
    cat >> "$FINAL_REPORT_HTML" << EOF
        </div>
        
        <div class="footer">
            <p>Test execution completed on $(uname -s) $(uname -m)</p>
            <p>Generated by RTSP-SSE Stream Script Test Runner</p>
        </div>
    </div>
</body>
</html>
EOF
    
    log "INFO" "HTML report generated: $FINAL_REPORT_HTML"
}

# Display final summary
display_summary() {
    echo
    echo "==========================================="
    echo "         FINAL TEST RESULTS"
    echo "==========================================="
    echo
    
    local success_rate=0
    if [[ $TOTAL_SUITES -gt 0 ]]; then
        success_rate=$(( (PASSED_SUITES * 100) / TOTAL_SUITES ))
    fi
    
    echo "📊 Summary:"
    echo "   Total Suites: $TOTAL_SUITES"
    echo "   ✅ Passed: $PASSED_SUITES"
    echo "   ❌ Failed: $FAILED_SUITES"
    echo "   ⏭️  Skipped: $SKIPPED_SUITES"
    echo "   📈 Success Rate: $success_rate%"
    echo
    
    echo "📁 Reports:"
    echo "   📄 JSON: $FINAL_REPORT_FILE"
    if [[ "$GENERATE_HTML" == "true" ]]; then
        echo "   🌐 HTML: $FINAL_REPORT_HTML"
    fi
    echo "   📋 Log: $TEST_RUNNER_LOG"
    echo
    
    if [[ $FAILED_SUITES -eq 0 ]]; then
        log "PASS" "🎉 All test suites completed successfully!"
        return 0
    else
        log "FAIL" "💥 $FAILED_SUITES test suite(s) failed"
        return 1
    fi
}

# Cleanup function
cleanup() {
    if [[ "$CLEANUP_AFTER" == "true" ]]; then
        log "INFO" "Performing cleanup..."
        
        # Clean up individual test artifacts
        for suite in "${!TEST_SCRIPTS[@]}"; do
            local script="${TEST_SCRIPTS[$suite]}"
            if [[ -f "$script" ]]; then
                # Only call cleanup for scripts that support it
                case "$suite" in
                    "syntax"|"unit"|"integration"|"performance")
                        bash "$script" --cleanup-only 2>/dev/null || true
                        ;;
                    "cross_platform")
                        # Cross-platform checker doesn't support cleanup option
                        # Just remove its log files
                        rm -f "$SCRIPT_DIR/compatibility-check.log" 2>/dev/null || true
                        rm -f "$SCRIPT_DIR/compatibility-report.json" 2>/dev/null || true
                        ;;
                esac
            fi
        done
        
        # Clean up test runner artifacts
        rm -f "$SCRIPT_DIR"/*-suite.log 2>/dev/null || true
        
        log "INFO" "Cleanup completed"
    fi
}

# Show usage information
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Test Runner for RTSP-SSE Stream Script - Orchestrates all testing components

OPTIONS:
    --parallel            Run test suites in parallel (faster but less detailed output)
    --sequential          Run test suites sequentially (default, more detailed output)
    --verbose             Enable verbose output for all test suites
    --stop-on-failure     Stop execution on first test suite failure
    --skip-dependencies   Skip dependency checks
    --no-html             Don't generate HTML report
    --no-cleanup          Don't perform cleanup after tests
    --timeout=SECONDS     Set timeout for each test suite (default: 300)
    --suite=SUITE_NAME    Run only specific test suite
    --list-suites         List available test suites
    --cleanup-only        Only perform cleanup and exit
    --help                Show this help message

AVAILABLE TEST SUITES:
    syntax               Syntax validation and ShellCheck analysis
    cross_platform       Cross-platform compatibility checks
    unit                 Unit tests for individual functions
    integration          Integration test scenarios
    performance          Performance benchmarking

EXAMPLES:
    $0                           # Run all test suites sequentially
    $0 --parallel --verbose      # Run all suites in parallel with verbose output
    $0 --suite=unit              # Run only unit tests
    $0 --stop-on-failure         # Stop on first failure
    $0 --timeout=600             # Set 10-minute timeout per suite
    $0 --list-suites             # List available test suites

OUTPUT FILES:
    - Main log: $TEST_RUNNER_LOG
    - JSON report: $FINAL_REPORT_FILE
    - HTML report: $FINAL_REPORT_HTML
    - Individual suite logs: tests/*-suite.log

EOF
}

# Main function
main() {
    local specific_suite=""
    local list_suites="false"
    local cleanup_only="false"
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --parallel)
                PARALLEL="true"
                shift
                ;;
            --sequential)
                PARALLEL="false"
                shift
                ;;
            --verbose)
                VERBOSE="true"
                shift
                ;;
            --stop-on-failure)
                STOP_ON_FAILURE="true"
                shift
                ;;
            --skip-dependencies)
                SKIP_DEPENDENCIES="true"
                shift
                ;;
            --no-html)
                GENERATE_HTML="false"
                shift
                ;;
            --no-cleanup)
                CLEANUP_AFTER="false"
                shift
                ;;
            --timeout=*)
                TEST_TIMEOUT="${1#*=}"
                shift
                ;;
            --suite=*)
                specific_suite="${1#*=}"
                shift
                ;;
            --list-suites)
                list_suites="true"
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
    
    # Handle special modes
    if [[ "$list_suites" == "true" ]]; then
        echo "Available test suites:"
        for suite in "${!TEST_SUITES[@]}"; do
            echo "  $suite: ${TEST_SUITES[$suite]}"
        done
        exit 0
    fi
    
    if [[ "$cleanup_only" == "true" ]]; then
        cleanup
        log "INFO" "Cleanup completed"
        exit 0
    fi
    
    # Initialize
    log "HEADER" "Starting RTSP-SSE Stream Script Test Runner"
    echo "Test Runner Log - $(date)" > "$TEST_RUNNER_LOG"
    
    # Check dependencies
    if [[ "$SKIP_DEPENDENCIES" != "true" ]]; then
        if ! check_dependencies; then
            log "ERROR" "Dependency check failed"
            exit 1
        fi
    fi
    
    # Run specific suite if requested
    if [[ -n "$specific_suite" ]]; then
        if [[ -z "${TEST_SUITES[$specific_suite]:-}" ]]; then
            log "ERROR" "Unknown test suite: $specific_suite"
            log "INFO" "Available suites: ${!TEST_SUITES[*]}"
            exit 1
        fi
        
        local description="${TEST_SUITES[$specific_suite]}"
        local script="${TEST_SCRIPTS[$specific_suite]}"
        
        log "INFO" "Running specific test suite: $description"
        run_test_suite "$specific_suite" "$description" "$script" ""
        
        # Generate reports for single suite
        generate_json_report
        generate_html_report
        display_summary
        exit $?
    fi
    
    # Run all test suites
    if [[ "$PARALLEL" == "true" ]]; then
        run_parallel_tests
    else
        run_sequential_tests
    fi
    
    # Generate reports
    generate_json_report
    generate_html_report
    
    # Display final summary
    display_summary
}

# Run main function if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi