#!/bin/bash

# Dry-Run Wrapper for RTSP-SSE Stream Script
# Simulates ffmpeg behavior without actual streaming for safe testing
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
DRY_RUN_LOG="$SCRIPT_DIR/dry-run.log"
MOCK_FFMPEG_SCRIPT="$SCRIPT_DIR/mock-ffmpeg.sh"
TEST_CONFIG="$SCRIPT_DIR/test-config.conf"

# Test configuration
TEST_RTSP_INPUT="rtsp://test.camera.local:554/stream"
TEST_RTMP_OUTPUT="rtmp://test.streaming.service/live/test_key"
TEST_SSE_URL="http://localhost:3000/events"
DRY_RUN_DURATION=30  # seconds

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
    echo "[$timestamp] [$level] $message" >> "$DRY_RUN_LOG"
}

# Create mock ffmpeg script
create_mock_ffmpeg() {
    log "INFO" "Creating mock ffmpeg script..."
    
    cat > "$MOCK_FFMPEG_SCRIPT" << 'EOF'
#!/bin/bash

# Mock FFmpeg for Dry-Run Testing
# Simulates ffmpeg behavior without actual streaming

set -euo pipefail

# Parse ffmpeg arguments to extract key information
INPUT_URL=""
OUTPUT_URL=""
BITRATE=""
MAXRATE=""
BUFSIZE=""
CODEC=""
HW_ACCEL=""

# Simple argument parsing
while [[ $# -gt 0 ]]; do
    case $1 in
        -i)
            INPUT_URL="$2"
            shift 2
            ;;
        -c:v)
            CODEC="$2"
            shift 2
            ;;
        -b:v)
            BITRATE="$2"
            shift 2
            ;;
        -maxrate)
            MAXRATE="$2"
            shift 2
            ;;
        -bufsize)
            BUFSIZE="$2"
            shift 2
            ;;
        rtmp://*)
            OUTPUT_URL="$1"
            shift
            ;;
        *)
            shift
            ;;
    esac
done

# Log the simulated ffmpeg execution
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [MOCK-FFMPEG] Starting simulation"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [MOCK-FFMPEG] Input: ${INPUT_URL:-'Not specified'}"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [MOCK-FFMPEG] Output: ${OUTPUT_URL:-'Not specified'}"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [MOCK-FFMPEG] Codec: ${CODEC:-'Not specified'}"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [MOCK-FFMPEG] Bitrate: ${BITRATE:-'Not specified'}"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [MOCK-FFMPEG] Max Rate: ${MAXRATE:-'Not specified'}"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [MOCK-FFMPEG] Buffer Size: ${BUFSIZE:-'Not specified'}"

# Simulate ffmpeg startup messages
echo "ffmpeg version 4.4.2 Copyright (c) 2000-2021 the FFmpeg developers"
echo "  built with Apple clang version 13.0.0 (clang-1300.0.29.30)"
echo "  configuration: --prefix=/usr/local --enable-gpl --enable-version3"
echo "Input #0, rtsp, from '${INPUT_URL}':"
echo "  Metadata:"
echo "    title           : Session streamed by \"testOnDemandRTSPServer\""
echo "  Duration: N/A, start: 0.000000, bitrate: N/A"
echo "    Stream #0:0: Video: h264 (High), yuv420p(progressive), 1920x1080, 25 fps, 25 tbr, 90k tbn, 50 tbc"
echo "    Stream #0:1: Audio: aac (LC), 48000 Hz, stereo, fltp"
echo "Stream mapping:"
echo "  Stream #0:0 -> #0:0 (h264 -> ${CODEC:-libx264})"
echo "  Stream #0:1 -> #0:1 (aac -> aac)"
echo "Press [q] to stop, [?] for help"

# Simulate streaming progress
START_TIME=$(date +%s)
FRAME_COUNT=0
BYTES_SENT=0

while true; do
    CURRENT_TIME=$(date +%s)
    ELAPSED=$((CURRENT_TIME - START_TIME))
    
    # Simulate frame processing
    FRAME_COUNT=$((FRAME_COUNT + 1))
    BYTES_SENT=$((BYTES_SENT + 1024 + RANDOM % 2048))
    
    # Calculate simulated bitrate
    if [[ $ELAPSED -gt 0 ]]; then
        CURRENT_BITRATE=$((BYTES_SENT * 8 / ELAPSED / 1000))
    else
        CURRENT_BITRATE=0
    fi
    
    # Output progress (similar to real ffmpeg)
    printf "\rframe=%5d fps=%2d q=%2d.0 size=%8dkB time=%02d:%02d:%02d.%02d bitrate=%4dkbits/s speed=%4.2fx" \
           $FRAME_COUNT \
           $((FRAME_COUNT / (ELAPSED + 1))) \
           $((23 + RANDOM % 5)) \
           $((BYTES_SENT / 1024)) \
           $((ELAPSED / 3600)) \
           $(((ELAPSED % 3600) / 60)) \
           $((ELAPSED % 60)) \
           $((RANDOM % 100)) \
           $CURRENT_BITRATE \
           $(echo "scale=2; $FRAME_COUNT / ($ELAPSED + 1) / 25" | bc -l 2>/dev/null || echo "1.00")
    
    # Check for termination signals
    if ! kill -0 $$ 2>/dev/null; then
        break
    fi
    
    # Simulate occasional warnings/errors for realism
    if [[ $((RANDOM % 100)) -lt 2 ]]; then
        echo
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [MOCK-FFMPEG] Warning: Simulated network congestion"
    fi
    
    sleep 1
done

echo
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [MOCK-FFMPEG] Simulation ended"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [MOCK-FFMPEG] Total frames: $FRAME_COUNT"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [MOCK-FFMPEG] Total bytes: $BYTES_SENT"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [MOCK-FFMPEG] Duration: ${ELAPSED}s"
EOF

    chmod +x "$MOCK_FFMPEG_SCRIPT"
    log "INFO" "Mock ffmpeg script created at: $MOCK_FFMPEG_SCRIPT"
}

# Create test configuration
create_test_config() {
    log "INFO" "Creating test configuration..."
    
    cat > "$TEST_CONFIG" << EOF
#!/bin/bash
# Test Configuration for Dry-Run Mode

# RTSP Input Configuration (simulated)
RTSP_INPUT="$TEST_RTSP_INPUT"

# RTMP Output Configuration (simulated)
RTMP_OUTPUT="$TEST_RTMP_OUTPUT"

# SSE Configuration
SSE_URL="$TEST_SSE_URL"

# Streaming Parameters
CURRENT_TSP="2000"
CURRENT_RAMP="2500"
CURRENT_BUFSIZE="3000"

# Process Management
RESTART_DELAY="3"

# Logging Configuration
COLOR_OUTPUT="true"
LOG_LEVEL="DEBUG"

# FFmpeg Additional Options
FFMPEG_EXTRA_OPTS="-threads 2 -tune zerolatency"

# Resource Optimization
NICE_LEVEL="5"
MEMORY_LIMIT="256"
HW_ACCEL="false"
HW_ACCEL_METHOD="auto"
EOF

    log "INFO" "Test configuration created at: $TEST_CONFIG"
}

# Setup dry-run environment
setup_dry_run_environment() {
    log "INFO" "Setting up dry-run environment..."
    
    # Create tests directory if it doesn't exist
    mkdir -p "$SCRIPT_DIR"
    
    # Initialize log file
    echo "Dry-Run Test Log - $(date)" > "$DRY_RUN_LOG"
    
    # Create mock ffmpeg
    create_mock_ffmpeg
    
    # Create test configuration
    create_test_config
    
    # Add mock ffmpeg to PATH temporarily
    export PATH="$SCRIPT_DIR:$PATH"
    
    log "INFO" "Dry-run environment setup complete"
}

# Validate prerequisites
validate_prerequisites() {
    log "INFO" "Validating prerequisites..."
    
    # Check if target script exists
    if [[ ! -f "$TARGET_SCRIPT" ]]; then
        log "ERROR" "Target script not found: $TARGET_SCRIPT"
        return 1
    fi
    
    # Check if script is executable
    if [[ ! -x "$TARGET_SCRIPT" ]]; then
        log "WARN" "Target script is not executable, making it executable..."
        chmod +x "$TARGET_SCRIPT"
    fi
    
    # Check for required commands
    local required_commands=("bash" "curl" "bc")
    for cmd in "${required_commands[@]}"; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            log "ERROR" "Required command not found: $cmd"
            return 1
        fi
    done
    
    log "INFO" "Prerequisites validation passed"
    return 0
}

# Run dry-run test
run_dry_run_test() {
    local test_duration="$1"
    local use_sse="$2"
    
    log "INFO" "Starting dry-run test (duration: ${test_duration}s, SSE: $use_sse)"
    
    # Prepare arguments for the target script
    local script_args=(
        "--rtsp-input" "$TEST_RTSP_INPUT"
        "--rtmp-output" "$TEST_RTMP_OUTPUT"
        "--log-level" "debug"
        "--restart-delay" "3"
    )
    
    # Add SSE URL if requested
    if [[ "$use_sse" == "true" ]]; then
        script_args+=("--sse-url" "$TEST_SSE_URL")
    fi
    
    # Start the script in background
    log "INFO" "Executing: $TARGET_SCRIPT ${script_args[*]}"
    "$TARGET_SCRIPT" "${script_args[@]}" &
    local script_pid=$!
    
    log "INFO" "Script started with PID: $script_pid"
    
    # Monitor the script for the specified duration
    local start_time=$(date +%s)
    local end_time=$((start_time + test_duration))
    
    while [[ $(date +%s) -lt $end_time ]]; do
        if ! kill -0 "$script_pid" 2>/dev/null; then
            log "WARN" "Script terminated unexpectedly"
            break
        fi
        
        # Log progress
        local elapsed=$(($(date +%s) - start_time))
        log "DEBUG" "Test progress: ${elapsed}s / ${test_duration}s"
        
        sleep 5
    done
    
    # Stop the script gracefully
    if kill -0 "$script_pid" 2>/dev/null; then
        log "INFO" "Sending SIGTERM to script (PID: $script_pid)"
        kill -TERM "$script_pid" 2>/dev/null
        
        # Wait for graceful shutdown
        local count=0
        while kill -0 "$script_pid" 2>/dev/null && [[ $count -lt 10 ]]; do
            sleep 1
            ((count++))
        done
        
        # Force kill if still running
        if kill -0 "$script_pid" 2>/dev/null; then
            log "WARN" "Force killing script (PID: $script_pid)"
            kill -KILL "$script_pid" 2>/dev/null
        fi
    fi
    
    log "INFO" "Dry-run test completed"
}

# Analyze test results
analyze_results() {
    log "INFO" "Analyzing test results..."
    
    # Check if log file exists and has content
    if [[ ! -f "$DRY_RUN_LOG" ]]; then
        log "ERROR" "Test log file not found"
        return 1
    fi
    
    # Count different types of log entries
    local error_count=$(grep -c "\[ERROR\]" "$DRY_RUN_LOG" || true)
    local warn_count=$(grep -c "\[WARN\]" "$DRY_RUN_LOG" || true)
    local info_count=$(grep -c "\[INFO\]" "$DRY_RUN_LOG" || true)
    local debug_count=$(grep -c "\[DEBUG\]" "$DRY_RUN_LOG" || true)
    
    # Check for specific events
    local ffmpeg_starts=$(grep -c "Starting ffmpeg" "$DRY_RUN_LOG" || true)
    local sse_connections=$(grep -c "SSE connection" "$DRY_RUN_LOG" || true)
    local parameter_updates=$(grep -c "parameter update" "$DRY_RUN_LOG" || true)
    
    echo
    echo "=== DRY-RUN TEST RESULTS ==="
    echo "Log Entries:"
    echo "  Errors: $error_count"
    echo "  Warnings: $warn_count"
    echo "  Info: $info_count"
    echo "  Debug: $debug_count"
    echo
    echo "Events Detected:"
    echo "  FFmpeg Starts: $ffmpeg_starts"
    echo "  SSE Connections: $sse_connections"
    echo "  Parameter Updates: $parameter_updates"
    echo
    
    # Determine test result
    if [[ $error_count -eq 0 ]]; then
        log "INFO" "✅ Dry-run test PASSED - No errors detected"
        return 0
    else
        log "ERROR" "❌ Dry-run test FAILED - $error_count errors detected"
        echo "Recent errors:"
        grep "\[ERROR\]" "$DRY_RUN_LOG" | tail -5
        return 1
    fi
}

# Cleanup function
cleanup() {
    log "INFO" "Cleaning up dry-run environment..."
    
    # Remove mock ffmpeg script
    [[ -f "$MOCK_FFMPEG_SCRIPT" ]] && rm -f "$MOCK_FFMPEG_SCRIPT"
    
    # Remove test configuration
    [[ -f "$TEST_CONFIG" ]] && rm -f "$TEST_CONFIG"
    
    # Kill any remaining processes
    pkill -f "mock-ffmpeg" 2>/dev/null || true
    pkill -f "rtsp-sse-stream" 2>/dev/null || true
    
    log "INFO" "Cleanup completed"
}

# Show usage information
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Dry-Run Wrapper for RTSP-SSE Stream Script Testing

OPTIONS:
    --duration SECONDS     Test duration in seconds (default: $DRY_RUN_DURATION)
    --with-sse            Enable SSE testing (requires mock SSE server)
    --no-sse              Disable SSE testing (default)
    --cleanup-only        Only perform cleanup and exit
    --help                Show this help message

EXAMPLES:
    $0                           # Basic 30-second test without SSE
    $0 --duration 60 --with-sse  # 60-second test with SSE
    $0 --cleanup-only            # Clean up previous test artifacts

NOTE:
    For SSE testing, start the mock SSE server first:
    node tests/mock-sse-server.js --port 3000

EOF
}

# Main function
main() {
    local test_duration="$DRY_RUN_DURATION"
    local use_sse="false"
    local cleanup_only="false"
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --duration)
                test_duration="$2"
                shift 2
                ;;
            --with-sse)
                use_sse="true"
                shift
                ;;
            --no-sse)
                use_sse="false"
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
    
    log "INFO" "Starting RTSP-SSE Stream Script Dry-Run Test"
    
    # Perform cleanup if requested
    if [[ "$cleanup_only" == "true" ]]; then
        cleanup
        log "INFO" "Cleanup completed"
        exit 0
    fi
    
    # Validate prerequisites
    if ! validate_prerequisites; then
        log "ERROR" "Prerequisites validation failed"
        exit 1
    fi
    
    # Setup environment
    setup_dry_run_environment
    
    # Check SSE server if SSE testing is enabled
    if [[ "$use_sse" == "true" ]]; then
        log "INFO" "Checking SSE server availability..."
        if ! curl -s --connect-timeout 5 "$TEST_SSE_URL" >/dev/null 2>&1; then
            log "WARN" "SSE server not available at $TEST_SSE_URL"
            log "WARN" "Start the mock SSE server: node tests/mock-sse-server.js"
            use_sse="false"
        else
            log "INFO" "SSE server is available"
        fi
    fi
    
    # Run the dry-run test
    if run_dry_run_test "$test_duration" "$use_sse"; then
        # Analyze results
        analyze_results
    else
        log "ERROR" "Dry-run test execution failed"
        exit 1
    fi
}

# Run main function if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi