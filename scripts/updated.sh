#!/bin/bash

# Enhanced Streaming Script with SSE Support for Raspberry Pi
# Maintains existing functionality while adding dynamic URL updates via SSE

set -e

# Configuration
SSE_ENDPOINT="${SSE_ENDPOINT:-http://localhost:3000/events}"
CONFIG_FILE="/tmp/stream_config.json"
SSE_PID_FILE="/tmp/sse_listener.pid"
FFMPEG_PID_FILE="/tmp/ffmpeg_stream.pid"
LOG_FILE="/tmp/stream.log"

# Default streaming parameters
DEFAULT_RTSP="rtsp://admin:ubnt%40966@192.168.10.111:554/cam/realmonitor?channel=1&subtype=1"
DEFAULT_RTMP="rtmp://a.rtmp.youtube.com/live2/pda4-j9yb-hhc9-6t6k-7phr"
FFMPEG_PARAMS="-rtsp_transport tcp -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -c:v libx264 -preset veryfast -b:v 4500k -maxrate 5000k -bufsize 10000k -vf scale=1920:1080 -c:a aac -b:a 128k -ar 44100 -f flv"

# Initialize configuration file with defaults
init_config() {
    echo "{\"rtsp_url\":\"$DEFAULT_RTSP\",\"rtmp_url\":\"$DEFAULT_RTMP\",\"restart_required\":false}" > "$CONFIG_FILE"
}

# Log function with timestamp
log_message() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Parse JSON using native bash (lightweight alternative to jq)
parse_json() {
    local json="$1"
    local key="$2"
    echo "$json" | sed -n "s/.*\"$key\":\"\([^\"]*\)\".*/\1/p"
}

# Parse JSON boolean
parse_json_bool() {
    local json="$1"
    local key="$2"
    echo "$json" | sed -n "s/.*\"$key\":\([^,}]*\).*/\1/p" | tr -d ' '
}

# Validate URL format
validate_url() {
    local url="$1"
    local protocol="$2"
    if [[ "$url" =~ ^${protocol}:// ]]; then
        return 0
    else
        return 1
    fi
}

# SSE listener function
sse_listener() {
    local retry_count=0
    local max_retries=5
    
    while true; do
        log_message "Starting SSE listener (attempt $((retry_count + 1)))"
        
        # Use curl with timeout and retry logic
        curl -N -s --connect-timeout 10 --max-time 0 \
             -H "Accept: text/event-stream" \
             -H "Cache-Control: no-cache" \
             "$SSE_ENDPOINT" 2>/dev/null | while IFS= read -r line; do
            
            # Parse SSE data lines
            if [[ "$line" =~ ^data:.*\{.*\} ]]; then
                json_data="${line#data: }"
                
                # Extract URLs from JSON
                rtsp_url=$(parse_json "$json_data" "rtsp_url")
                rtmp_url=$(parse_json "$json_data" "rtmp_url")
                restart_required=$(parse_json_bool "$json_data" "restart_required")
                
                # Validate URLs
                if validate_url "$rtsp_url" "rtsp" && validate_url "$rtmp_url" "rtmp"; then
                    log_message "Received valid URLs - RTSP: $rtsp_url, RTMP: $rtmp_url"
                    
                    # Update configuration
                    echo "{\"rtsp_url\":\"$rtsp_url\",\"rtmp_url\":\"$rtmp_url\",\"restart_required\":true}" > "$CONFIG_FILE"
                    
                    # Signal main process if restart required
                    if [[ "$restart_required" == "true" ]]; then
                        log_message "Restart required - signaling main process"
                        touch "/tmp/restart_stream"
                    fi
                else
                    log_message "Invalid URLs received - ignoring update"
                fi
            fi
        done
        
        # Handle connection failure
        retry_count=$((retry_count + 1))
        if [ $retry_count -ge $max_retries ]; then
            log_message "SSE connection failed after $max_retries attempts, using exponential backoff"
            sleep $((2 ** retry_count))
            retry_count=0
        else
            log_message "SSE connection lost, retrying in 5 seconds..."
            sleep 5
        fi
    done
}

# Cleanup function
cleanup() {
    log_message "Cleaning up processes..."
    
    # Kill SSE listener
    if [ -f "$SSE_PID_FILE" ]; then
        local sse_pid=$(cat "$SSE_PID_FILE")
        kill "$sse_pid" 2>/dev/null || true
        rm -f "$SSE_PID_FILE"
    fi
    
    # Kill FFmpeg
    if [ -f "$FFMPEG_PID_FILE" ]; then
        local ffmpeg_pid=$(cat "$FFMPEG_PID_FILE")
        kill "$ffmpeg_pid" 2>/dev/null || true
        rm -f "$FFMPEG_PID_FILE"
    fi
    
    # Clean up temp files
    rm -f "/tmp/restart_stream" "$CONFIG_FILE"
    
    exit 0
}

# Set up signal handlers
trap cleanup SIGTERM SIGINT

# Initialize
init_config
log_message "Starting enhanced streaming script with SSE support"

# Start SSE listener in background
sse_listener &
echo $! > "$SSE_PID_FILE"
log_message "SSE listener started with PID $(cat $SSE_PID_FILE)"

# Main streaming loop
while true; do
    # Read current configuration
    if [ -f "$CONFIG_FILE" ]; then
        config=$(cat "$CONFIG_FILE")
        current_rtsp=$(parse_json "$config" "rtsp_url")
        current_rtmp=$(parse_json "$config" "rtmp_url")
    else
        current_rtsp="$DEFAULT_RTSP"
        current_rtmp="$DEFAULT_RTMP"
    fi
    
    log_message "Starting stream with RTSP: ${current_rtsp:0:50}... RTMP: ${current_rtmp:0:50}..."
    
    # Start FFmpeg with current URLs
    ffmpeg $FFMPEG_PARAMS -i "$current_rtsp" "$current_rtmp" &
    ffmpeg_pid=$!
    echo $ffmpeg_pid > "$FFMPEG_PID_FILE"
    
    # Monitor for restart signal or FFmpeg exit
    while kill -0 "$ffmpeg_pid" 2>/dev/null; do
        if [ -f "/tmp/restart_stream" ]; then
            log_message "Restart signal received - stopping current stream"
            kill "$ffmpeg_pid" 2>/dev/null || true
            wait "$ffmpeg_pid" 2>/dev/null || true
            rm -f "/tmp/restart_stream"
            break
        fi
        sleep 1
    done
    
    # Check if FFmpeg exited normally or was killed
    if ! kill -0 "$ffmpeg_pid" 2>/dev/null; then
        wait "$ffmpeg_pid" 2>/dev/null || true
        log_message "FFmpeg process ended - restarting in 5 seconds..."
        sleep 5
    fi
    
    rm -f "$FFMPEG_PID_FILE"
done
