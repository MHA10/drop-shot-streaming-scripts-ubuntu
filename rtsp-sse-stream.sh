#!/bin/bash

# RTSP Streaming with SSE Integration Script
# Optimized for Raspberry Pi with minimal resource usage
# Author: SOLO Coding
# Version: 1.0

set -euo pipefail

# Color codes for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Default configuration
DEFAULT_RTSP_INPUT="rtsp://admin:ubnt%40966@192.168.10.111:554/cam/realmonitor?channel=1&subtype=1"
DEFAULT_RTMP_OUTPUT="rtmp://a.rtmp.youtube.com/live2/pda4-j9yb-hhc9-6t6k-7phr"
DEFAULT_SSE_URL=""
DEFAULT_LOG_LEVEL="info"
DEFAULT_RESTART_DELAY=5

# Global variables
RTSP_INPUT="$DEFAULT_RTSP_INPUT"
RTMP_OUTPUT="$DEFAULT_RTMP_OUTPUT"
SSE_URL="$DEFAULT_SSE_URL"
LOG_LEVEL="$DEFAULT_LOG_LEVEL"
RESTART_DELAY="$DEFAULT_RESTART_DELAY"
CONFIG_FILE=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/rtsp-sse-stream.log"
PID_DIR="/tmp/rtsp-sse-stream"
LOCK_FILE="/tmp/rtsp-sse-stream.lock"

# Current streaming parameters (can be updated via SSE)
CURRENT_TSP="1000"
CURRENT_RAMP="1500"
CURRENT_BUFSIZE="2000"

# Process IDs
FFMPEG_PID=""
SSE_CLIENT_PID=""
PARAM_MONITOR_PID=""
RUNNING=false

# Named pipes for IPC
SSE_PARAMS_PIPE="$PID_DIR/sse_params_pipe"
STREAM_CONTROL_PIPE="$PID_DIR/stream_control_pipe"
STATUS_PIPE="$PID_DIR/status_pipe"

# Logging function with color support
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
    
    # Log to console with color
    echo -e "${color}[$timestamp] [$level] $message${NC}"
    
    # Log to file without color
    echo "[$timestamp] [$level] $message" >> "$LOG_FILE"
}

# Display usage information
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

RTSP Streaming with SSE Integration Script

OPTIONS:
    --rtsp-input URL        RTSP input stream URL
    --rtmp-output URL       RTMP output stream URL
    --sse-url URL          SSE endpoint URL for parameter updates
    --config-file FILE     Path to JSON configuration file
    --log-level LEVEL      Logging level (debug, info, warn, error)
    --restart-delay SEC    Delay in seconds before restarting crashed stream
    --help                 Show this help message

EXAMPLES:
    $0 --sse-url "https://api.example.com/sse/stream-params"
    $0 --config-file "./config.json" --log-level debug
    $0 --rtsp-input "rtsp://camera.local/stream" --rtmp-output "rtmp://youtube.com/live/key"

EOF
}

# Parse command line arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --rtsp-input)
                RTSP_INPUT="$2"
                shift 2
                ;;
            --rtmp-output)
                RTMP_OUTPUT="$2"
                shift 2
                ;;
            --sse-url)
                SSE_URL="$2"
                shift 2
                ;;
            --config-file)
                CONFIG_FILE="$2"
                shift 2
                ;;
            --log-level)
                LOG_LEVEL="$2"
                shift 2
                ;;
            --restart-delay)
                RESTART_DELAY="$2"
                shift 2
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
}

# Load configuration from JSON file
load_config() {
    if [[ -n "$CONFIG_FILE" && -f "$CONFIG_FILE" ]]; then
        log "INFO" "Loading configuration from $CONFIG_FILE"
        
        # Check if jq is available for JSON parsing
        if command -v jq >/dev/null 2>&1; then
            RTSP_INPUT=$(jq -r '.stream_config.rtsp_input // "'$DEFAULT_RTSP_INPUT'"' "$CONFIG_FILE")
            RTMP_OUTPUT=$(jq -r '.stream_config.rtmp_output // "'$DEFAULT_RTMP_OUTPUT'"' "$CONFIG_FILE")
            SSE_URL=$(jq -r '.stream_config.sse_endpoint // "'$DEFAULT_SSE_URL'"' "$CONFIG_FILE")
            LOG_LEVEL=$(jq -r '.logging.level // "'$DEFAULT_LOG_LEVEL'"' "$CONFIG_FILE")
            RESTART_DELAY=$(jq -r '.sse_config.reconnect_interval // '$DEFAULT_RESTART_DELAY'' "$CONFIG_FILE")
            
            # Load video parameters
            CURRENT_TSP=$(jq -r '.stream_config.video_settings.bitrate // "4500k"' "$CONFIG_FILE" | sed 's/k$//')
            CURRENT_RAMP=$(jq -r '.stream_config.video_settings.maxrate // "5000k"' "$CONFIG_FILE" | sed 's/k$//')
            CURRENT_BUFSIZE=$(jq -r '.stream_config.video_settings.bufsize // "10000k"' "$CONFIG_FILE" | sed 's/k$//')
            
            # Load hardware acceleration settings
            HW_ACCEL=$(jq -r '.hardware.enable_hw_accel // false' "$CONFIG_FILE")
            HW_ACCEL_METHOD=$(jq -r '.hardware.hw_accel_method // "auto"' "$CONFIG_FILE")
            FFMPEG_THREADS=$(jq -r '.hardware.ffmpeg_threads // 2' "$CONFIG_FILE")
            NICE_LEVEL=$(jq -r '.hardware.nice_level // empty' "$CONFIG_FILE")
            MEMORY_LIMIT=$(jq -r '.hardware.memory_limit_mb // empty' "$CONFIG_FILE")
            FFMPEG_EXTRA_OPTS=$(jq -r '.stream_config.ffmpeg_extra_opts // empty' "$CONFIG_FILE")
        else
            log "WARN" "jq not available, using basic config parsing"
            # Basic parsing without jq (fallback)
            if grep -q '"rtsp_input"' "$CONFIG_FILE"; then
                RTSP_INPUT=$(grep '"rtsp_input"' "$CONFIG_FILE" | cut -d'"' -f4)
            fi
            if grep -q '"rtmp_output"' "$CONFIG_FILE"; then
                RTMP_OUTPUT=$(grep '"rtmp_output"' "$CONFIG_FILE" | cut -d'"' -f4)
            fi
            # Set defaults for hardware settings when jq is not available
            HW_ACCEL="false"
            HW_ACCEL_METHOD="auto"
            FFMPEG_THREADS="2"
        fi
        
        log "INFO" "Configuration loaded successfully"
    fi
}

# Validate configuration parameters
validate_config() {
    log "INFO" "Validating configuration..."
    
    # Validate RTSP input
    if [[ ! "$RTSP_INPUT" =~ ^rtsp:// ]]; then
        log "ERROR" "Invalid RTSP input URL: $RTSP_INPUT"
        exit 1
    fi
    
    # Validate RTMP output
    if [[ ! "$RTMP_OUTPUT" =~ ^rtmp:// ]]; then
        log "ERROR" "Invalid RTMP output URL: $RTMP_OUTPUT"
        exit 1
    fi
    
    # Validate SSE URL if provided
    if [[ -n "$SSE_URL" && ! "$SSE_URL" =~ ^https?:// ]]; then
        log "ERROR" "Invalid SSE URL: $SSE_URL"
        exit 1
    fi
    
    # Validate log level
    case "$LOG_LEVEL" in
        debug|info|warn|error) ;;
        *) log "ERROR" "Invalid log level: $LOG_LEVEL"; exit 1 ;;
    esac
    
    # Validate restart delay
    if ! [[ "$RESTART_DELAY" =~ ^[0-9]+$ ]] || [[ "$RESTART_DELAY" -lt 1 ]]; then
        log "ERROR" "Invalid restart delay: $RESTART_DELAY"
        exit 1
    fi
    
    log "INFO" "Configuration validation passed"
}

# Initialize directories and named pipes
init_environment() {
    log "INFO" "Initializing environment..."
    
    # Create PID directory
    mkdir -p "$PID_DIR"
    
    # Create named pipes for IPC
    [[ ! -p "$SSE_PARAMS_PIPE" ]] && mkfifo "$SSE_PARAMS_PIPE"
    [[ ! -p "$STREAM_CONTROL_PIPE" ]] && mkfifo "$STREAM_CONTROL_PIPE"
    [[ ! -p "$STATUS_PIPE" ]] && mkfifo "$STATUS_PIPE"
    
    log "INFO" "Environment initialized"
}

# Signal handlers for graceful shutdown
cleanup() {
    log "INFO" "Received shutdown signal, cleaning up..."
    
    # Set running flag to false
    RUNNING=false
    
    # Stop all background processes gracefully
    if [[ -n "$FFMPEG_PID" ]] && kill -0 "$FFMPEG_PID" 2>/dev/null; then
        log "INFO" "Stopping FFmpeg process (PID: $FFMPEG_PID)"
        kill -TERM "$FFMPEG_PID" 2>/dev/null
        
        # Wait up to 10 seconds for graceful shutdown
        local count=0
        while kill -0 "$FFMPEG_PID" 2>/dev/null && [[ $count -lt 10 ]]; do
            sleep 1
            ((count++))
        done
        
        # Force kill if still running
        if kill -0 "$FFMPEG_PID" 2>/dev/null; then
            log "WARN" "Force killing FFmpeg process"
            kill -KILL "$FFMPEG_PID" 2>/dev/null
        fi
    fi
    
    if [[ -n "$SSE_CLIENT_PID" ]] && kill -0 "$SSE_CLIENT_PID" 2>/dev/null; then
        log "INFO" "Stopping SSE client process (PID: $SSE_CLIENT_PID)"
        kill -TERM "$SSE_CLIENT_PID" 2>/dev/null
        sleep 2
        kill -KILL "$SSE_CLIENT_PID" 2>/dev/null
    fi
    
    if [[ -n "$PARAM_MONITOR_PID" ]] && kill -0 "$PARAM_MONITOR_PID" 2>/dev/null; then
        log "INFO" "Stopping parameter monitor process (PID: $PARAM_MONITOR_PID)"
        kill -TERM "$PARAM_MONITOR_PID" 2>/dev/null
        sleep 2
        kill -KILL "$PARAM_MONITOR_PID" 2>/dev/null
    fi
    
    # Remove named pipes
    rm -f "$SSE_PARAMS_PIPE" "$STREAM_CONTROL_PIPE" "$STATUS_PIPE"
    
    # Remove PID directory
    rmdir "$PID_DIR" 2>/dev/null || true
    
    # Remove lock file
    rm -f "$LOCK_FILE"
    
    log "INFO" "Cleanup completed successfully"
    exit 0
}

# Handle SIGUSR1 for parameter reload
reload_config() {
    log "INFO" "Received reload signal, reloading configuration..."
    
    # Re-source configuration if file exists
    if [[ -f "$CONFIG_FILE" ]]; then
        load_config
        validate_config
        log "INFO" "Configuration reloaded from: $CONFIG_FILE"
    fi
    
    # Restart FFmpeg with new configuration
    restart_ffmpeg
}

# Handle SIGUSR2 for status report
status_report() {
    log "INFO" "=== STATUS REPORT ==="
    log "INFO" "Running: $RUNNING"
    log "INFO" "FFmpeg PID: ${FFMPEG_PID:-'Not running'}"
    log "INFO" "SSE Client PID: ${SSE_CLIENT_PID:-'Not running'}"
    log "INFO" "Parameter Monitor PID: ${PARAM_MONITOR_PID:-'Not running'}"
    log "INFO" "Current TSP: ${CURRENT_TSP}k"
    log "INFO" "Current RAMP: ${CURRENT_RAMP}k"
    log "INFO" "Current Buffer Size: ${CURRENT_BUFSIZE}k"
    log "INFO" "RTSP Input: $RTSP_INPUT"
    log "INFO" "RTMP Output: $RTMP_OUTPUT"
    log "INFO" "SSE URL: ${SSE_URL:-'Not configured'}"
    log "INFO" "==================="
}

# Set up signal handlers
trap cleanup SIGTERM SIGINT SIGQUIT
trap reload_config SIGUSR1
trap status_report SIGUSR2

# Check for existing instance
check_lock() {
    if [[ -f "$LOCK_FILE" ]]; then
        local existing_pid=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
        if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
            log "ERROR" "Another instance is already running (PID: $existing_pid)"
            exit 1
        else
            log "WARN" "Removing stale lock file"
            rm -f "$LOCK_FILE"
        fi
    fi
    
    # Create lock file
    echo $$ > "$LOCK_FILE"
}

# Main function
main() {
    log "INFO" "Starting RTSP-SSE Stream Manager v1.0"
    
    # Parse command line arguments
    parse_args "$@"
    
    # Load configuration
    load_config
    
    # Validate configuration
    validate_config
    
    # Check for existing instance
    check_lock
    
    # Initialize environment
    init_environment
    
    log "INFO" "Configuration:"
    log "INFO" "  RTSP Input: $RTSP_INPUT"
    log "INFO" "  RTMP Output: $RTMP_OUTPUT"
    log "INFO" "  SSE URL: ${SSE_URL:-'Not configured'}"
    log "INFO" "  Log Level: $LOG_LEVEL"
    log "INFO" "  Restart Delay: ${RESTART_DELAY}s"
    
    # Start SSE client if URL is provided
    if [[ -n "$SSE_URL" ]]; then
        log "INFO" "Starting SSE client..."
        sse_client "$SSE_URL" "$SSE_PARAMS_PIPE" &
        SSE_CLIENT_PID=$!
        
        # Start parameter monitor
        monitor_parameters "$SSE_PARAMS_PIPE" &
        PARAM_MONITOR_PID=$!
    fi
    
    # Start main streaming loop
    RUNNING=true
    streaming_loop
    
    log "INFO" "Script execution completed"
}

# SSE client functionality using curl
sse_client() {
    local sse_url="$1"
    local pipe_path="$2"
    
    log "INFO" "Starting SSE client for URL: $sse_url"
    
    # Create named pipe if it doesn't exist
    if [[ ! -p "$pipe_path" ]]; then
        mkfifo "$pipe_path" || {
            log "ERROR" "Failed to create named pipe: $pipe_path"
            return 1
        }
    fi
    
    # Start SSE connection with curl
    while true; do
        log "INFO" "Connecting to SSE endpoint..."
        
        curl -N -H "Accept: text/event-stream" \
             -H "Cache-Control: no-cache" \
             --connect-timeout 10 \
             --max-time 0 \
             --retry 3 \
             --retry-delay 5 \
             "$sse_url" 2>/dev/null | while IFS= read -r line; do
            
            # Skip empty lines and comments
            [[ -z "$line" || "$line" =~ ^[[:space:]]*$ ]] && continue
            
            # Process SSE data lines
            if [[ "$line" =~ ^data:[[:space:]]*(.*) ]]; then
                local data="${BASH_REMATCH[1]}"
                
                # Parse JSON data for TSP and RAMP parameters
                if command -v jq >/dev/null 2>&1; then
                    parse_sse_data_jq "$data" "$pipe_path"
                else
                    parse_sse_data_manual "$data" "$pipe_path"
                fi
            fi
        done
        
        # If curl exits, wait before reconnecting
        log "WARN" "SSE connection lost, reconnecting in 5 seconds..."
        sleep 5
    done
}

# Parse SSE data using jq (if available)
parse_sse_data_jq() {
    local data="$1"
    local pipe_path="$2"
    
    # Extract TSP and RAMP parameters using jq
    local tsp=$(echo "$data" | jq -r '.tsp // empty' 2>/dev/null)
    local ramp=$(echo "$data" | jq -r '.ramp // empty' 2>/dev/null)
    
    if [[ -n "$tsp" || -n "$ramp" ]]; then
        local params=""
        [[ -n "$tsp" ]] && params="tsp=$tsp"
        [[ -n "$ramp" ]] && params="${params:+$params }ramp=$ramp"
        
        log "INFO" "Received parameters: $params"
        echo "$params" > "$pipe_path" &
    fi
}

# Parse SSE data manually (fallback when jq is not available)
parse_sse_data_manual() {
    local data="$1"
    local pipe_path="$2"
    
    # Simple regex-based parsing for JSON-like data
    local tsp ramp params=""
    
    # Extract TSP parameter
    if [[ "$data" =~ \"tsp\"[[:space:]]*:[[:space:]]*\"?([^,}\"]+)\"? ]]; then
        tsp="${BASH_REMATCH[1]}"
        params="tsp=$tsp"
    fi
    
    # Extract RAMP parameter
    if [[ "$data" =~ \"ramp\"[[:space:]]*:[[:space:]]*\"?([^,}\"]+)\"? ]]; then
        ramp="${BASH_REMATCH[1]}"
        params="${params:+$params }ramp=$ramp"
    fi
    
    if [[ -n "$params" ]]; then
        log "INFO" "Received parameters: $params"
        echo "$params" > "$pipe_path" &
    fi
}

# Monitor parameters from named pipe
monitor_parameters() {
    local pipe_path="$1"
    
    log "INFO" "Starting parameter monitoring from pipe: $pipe_path"
    
    # Create named pipe if it doesn't exist
    if [[ ! -p "$pipe_path" ]]; then
        mkfifo "$pipe_path" || {
            log "ERROR" "Failed to create named pipe: $pipe_path"
            return 1
        }
    fi
    
    # Monitor the pipe for parameter updates
    while true; do
        if read -r params < "$pipe_path"; then
            [[ -n "$params" ]] && process_parameter_update "$params"
        fi
    done
}

# Process parameter updates
process_parameter_update() {
    local params="$1"
    
    log "INFO" "Processing parameter update: $params"
    
    # Parse individual parameters
    local tsp ramp
    
    # Extract TSP value
    if [[ "$params" =~ tsp=([^[:space:]]+) ]]; then
        tsp="${BASH_REMATCH[1]}"
    fi
    
    # Extract RAMP value
    if [[ "$params" =~ ramp=([^[:space:]]+) ]]; then
        ramp="${BASH_REMATCH[1]}"
    fi
    
    # Update ffmpeg parameters if needed
    update_ffmpeg_parameters "$tsp" "$ramp"
}

# Update ffmpeg parameters dynamically
update_ffmpeg_parameters() {
    local new_tsp="$1"
    local new_ramp="$2"
    local updated=false
    
    # Update TSP if provided and different
    if [[ -n "$new_tsp" && "$new_tsp" != "$CURRENT_TSP" ]]; then
        log "INFO" "Updating TSP: $CURRENT_TSP -> $new_tsp"
        CURRENT_TSP="$new_tsp"
        updated=true
    fi
    
    # Update RAMP if provided and different
    if [[ -n "$new_ramp" && "$new_ramp" != "$CURRENT_RAMP" ]]; then
        log "INFO" "Updating RAMP: $CURRENT_RAMP -> $new_ramp"
        CURRENT_RAMP="$new_ramp"
        updated=true
    fi
    
    # Restart ffmpeg with new parameters if any were updated
    if [[ "$updated" == true ]]; then
        restart_ffmpeg
    fi
}

# Restart ffmpeg with current parameters
restart_ffmpeg() {
    log "INFO" "Restarting ffmpeg with updated parameters..."
    
    # Stop current ffmpeg process if running
    if [[ -n "$FFMPEG_PID" ]] && kill -0 "$FFMPEG_PID" 2>/dev/null; then
        log "INFO" "Stopping current ffmpeg process (PID: $FFMPEG_PID)"
        kill "$FFMPEG_PID" 2>/dev/null
        wait "$FFMPEG_PID" 2>/dev/null
    fi
    
    # Start new ffmpeg process
    start_ffmpeg
}

# Detect hardware acceleration capabilities
detect_hw_accel() {
    if [[ "$HW_ACCEL" != "true" ]]; then
        echo ""
        return
    fi
    
    local hw_method="$HW_ACCEL_METHOD"
    
    if [[ "$hw_method" == "auto" ]]; then
        # Auto-detect hardware acceleration
        if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q "h264_v4l2m2m"; then
            hw_method="h264_v4l2m2m"
        elif ffmpeg -hide_banner -encoders 2>/dev/null | grep -q "h264_omx"; then
            hw_method="h264_omx"
        else
            hw_method=""
        fi
    fi
    
    # Verify the selected method is available
    if [[ -n "$hw_method" ]] && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q "$hw_method"; then
        echo "$hw_method"
    else
        echo ""
    fi
}

# Start ffmpeg process
start_ffmpeg() {
    local ffmpeg_cmd="ffmpeg -i '$RTSP_INPUT'"
    local hw_encoder
    
    # Detect hardware acceleration
    hw_encoder=$(detect_hw_accel)
    
    if [[ -n "$hw_encoder" ]]; then
        log "INFO" "Using hardware encoder: $hw_encoder"
        ffmpeg_cmd="$ffmpeg_cmd -c:v $hw_encoder"
        
        # Hardware-specific optimizations
        case "$hw_encoder" in
            "h264_v4l2m2m")
                ffmpeg_cmd="$ffmpeg_cmd -num_output_buffers 32 -num_capture_buffers 16"
                ;;
            "h264_omx")
                ffmpeg_cmd="$ffmpeg_cmd -zerocopy 1"
                ;;
        esac
    else
        log "INFO" "Using software encoder: libx264"
        ffmpeg_cmd="$ffmpeg_cmd -c:v libx264 -preset ultrafast"
        
        # Add threading for software encoding
        local threads="${FFMPEG_THREADS:-2}"
        ffmpeg_cmd="$ffmpeg_cmd -threads $threads"
    fi
    
    # Add bitrate and buffer settings
    ffmpeg_cmd="$ffmpeg_cmd -b:v ${CURRENT_TSP}k -maxrate ${CURRENT_RAMP}k -bufsize ${CURRENT_BUFSIZE}k"
    
    # Add audio encoding
    ffmpeg_cmd="$ffmpeg_cmd -c:a aac -b:a 128k"
    
    # Add output format and destination
    ffmpeg_cmd="$ffmpeg_cmd -f flv '$RTMP_OUTPUT'"
    
    # Add additional options
    [[ -n "$FFMPEG_EXTRA_OPTS" ]] && ffmpeg_cmd="$ffmpeg_cmd $FFMPEG_EXTRA_OPTS"
    
    # Overwrite output files
    ffmpeg_cmd="$ffmpeg_cmd -y"
    
    log "INFO" "Starting ffmpeg with TSP: ${CURRENT_TSP}k, RAMP: ${CURRENT_RAMP}k"
    [[ -n "$hw_encoder" ]] && log "INFO" "Hardware acceleration: $hw_encoder"
    
    # Apply nice level for process priority
    local nice_cmd=""
    if [[ -n "$NICE_LEVEL" ]] && [[ "$NICE_LEVEL" =~ ^-?[0-9]+$ ]]; then
        nice_cmd="nice -n $NICE_LEVEL"
    fi
    
    # Start ffmpeg in background with optional nice level
    if [[ -n "$nice_cmd" ]]; then
        eval "$nice_cmd $ffmpeg_cmd" &
    else
        eval "$ffmpeg_cmd" &
    fi
    
    FFMPEG_PID=$!
    
    log "INFO" "FFmpeg started with PID: $FFMPEG_PID"
    
    # Apply memory limit if specified (Linux only)
    if [[ -n "$MEMORY_LIMIT" ]] && [[ "$MEMORY_LIMIT" -gt 0 ]] && command -v prlimit >/dev/null 2>&1; then
        local memory_bytes=$((MEMORY_LIMIT * 1024 * 1024))
        prlimit --pid="$FFMPEG_PID" --as="$memory_bytes" 2>/dev/null || true
        log "INFO" "Applied memory limit: ${MEMORY_LIMIT}MB"
    fi
}

# Main streaming loop with auto-restart
streaming_loop() {
    log "INFO" "Starting streaming loop..."
    
    while [[ "$RUNNING" == true ]]; do
        # Start ffmpeg if not running
        if [[ -z "$FFMPEG_PID" ]] || ! kill -0 "$FFMPEG_PID" 2>/dev/null; then
            log "INFO" "FFmpeg not running, starting..."
            start_ffmpeg
        fi
        
        # Wait for ffmpeg process
        if [[ -n "$FFMPEG_PID" ]]; then
            if ! wait "$FFMPEG_PID"; then
                log "WARN" "FFmpeg process crashed, restarting in ${RESTART_DELAY} seconds..."
                sleep "$RESTART_DELAY"
                FFMPEG_PID=""
            fi
        fi
        
        # Small delay to prevent tight loop
        sleep 1
    done
}

# Run main function if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi