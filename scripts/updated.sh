#!/bin/bash

# Enhanced Streaming Script with SSE Support for Raspberry Pi
# Maintains existing functionality while adding dynamic URL updates via SSE

set -e

# Configuration
SSE_ENDPOINT="${SSE_ENDPOINT:-"https://sse.dev/test?interval=5&jsonobj={
  "eventType": "start"/"stop",
  "cameraUrl": "full rtsp camera url",
  "streamKey": "youtube stream key"
}"}"
CONFIG_FILE="/tmp/stream_config.json"
SSE_PID_FILE="/tmp/sse_listener.pid"
FFMPEG_PID_FILE="/tmp/ffmpeg_stream.pid"
LOG_FILE="/tmp/stream.log"
STREAM_STATE_FILE="/tmp/stream_state.json"

# Default streaming parameters
DEFAULT_RTSP="rtsp://admin:ubnt%40966@192.168.10.111:554/cam/realmonitor?channel=1&subtype=1"
DEFAULT_RTMP="rtmp://a.rtmp.youtube.com/live2/pda4-j9yb-hhc9-6t6k-7phr"
FFMPEG_PARAMS="-rtsp_transport tcp -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -c:v libx264 -preset veryfast -b:v 4500k -maxrate 5000k -bufsize 10000k -vf scale=1920:1080 -c:a aac -b:a 128k -ar 44100 -f flv"

# Initialize configuration file with defaults
init_config() {
    echo "{\"rtsp_url\":\"$DEFAULT_RTSP\",\"rtmp_url\":\"$DEFAULT_RTMP\",\"restart_required\":false}" > "$CONFIG_FILE"
    echo "{\"should_stream\":false,\"event_type\":\"stop\"}" > "$STREAM_STATE_FILE"
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
                
                # Print SSE event data for debugging
                log_message "SSE Event Received: $json_data"
                
                # Extract new event format fields
                event_type=$(parse_json "$json_data" "eventType")
                camera_url=$(parse_json "$json_data" "cameraUrl")
                stream_key=$(parse_json "$json_data" "streamKey")
                
                log_message "Parsed - EventType: $event_type, CameraUrl: $camera_url, StreamKey: $stream_key"
                
                # Validate required fields
                if [[ -n "$event_type" && -n "$camera_url" && -n "$stream_key" ]]; then
                    # Construct RTMP URL from stream key
                    rtmp_url="rtmp://a.rtmp.youtube.com/live2/$stream_key"
                    
                    # Validate URLs
                    if validate_url "$camera_url" "rtsp" && validate_url "$rtmp_url" "rtmp"; then
                        log_message "Valid event - RTSP: $camera_url, RTMP: $rtmp_url, Action: $event_type"
                        
                        # Update configuration
                        echo "{\"rtsp_url\":\"$camera_url\",\"rtmp_url\":\"$rtmp_url\",\"restart_required\":true}" > "$CONFIG_FILE"
                        
                        # Update stream state based on event type
                        if [[ "$event_type" == "start" ]]; then
                            log_message "START event received - enabling streaming"
                            echo "{\"should_stream\":true,\"event_type\":\"start\"}" > "$STREAM_STATE_FILE"
                            touch "/tmp/restart_stream"
                        elif [[ "$event_type" == "stop" ]]; then
                            log_message "STOP event received - disabling streaming"
                            echo "{\"should_stream\":false,\"event_type\":\"stop\"}" > "$STREAM_STATE_FILE"
                            touch "/tmp/stop_stream"
                        else
                            log_message "Unknown event type: $event_type - ignoring"
                        fi
                    else
                        log_message "Invalid URLs - CameraUrl: $camera_url, StreamKey: $stream_key - ignoring update"
                    fi
                else
                    log_message "Missing required fields in SSE event - ignoring update"
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
    rm -f "/tmp/restart_stream" "/tmp/stop_stream" "$CONFIG_FILE" "$STREAM_STATE_FILE"
    
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
    # Check if streaming should be active
    should_stream=false
    if [ -f "$STREAM_STATE_FILE" ]; then
        state_config=$(cat "$STREAM_STATE_FILE")
        should_stream=$(parse_json_bool "$state_config" "should_stream")
        current_event=$(parse_json "$state_config" "event_type")
    fi
    
    if [[ "$should_stream" == "true" ]]; then
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
        
        # Monitor for restart/stop signals or FFmpeg exit
        while kill -0 "$ffmpeg_pid" 2>/dev/null; do
            if [ -f "/tmp/restart_stream" ]; then
                log_message "Restart signal received - stopping current stream"
                kill "$ffmpeg_pid" 2>/dev/null || true
                wait "$ffmpeg_pid" 2>/dev/null || true
                rm -f "/tmp/restart_stream"
                break
            elif [ -f "/tmp/stop_stream" ]; then
                log_message "Stop signal received - gracefully stopping stream"
                kill "$ffmpeg_pid" 2>/dev/null || true
                wait "$ffmpeg_pid" 2>/dev/null || true
                rm -f "/tmp/stop_stream"
                break
            fi
            sleep 1
        done
        
        # Check if FFmpeg exited normally or was killed
        if ! kill -0 "$ffmpeg_pid" 2>/dev/null; then
            wait "$ffmpeg_pid" 2>/dev/null || true
            # Only restart if we should still be streaming
            if [[ "$should_stream" == "true" ]]; then
                log_message "FFmpeg process ended - restarting in 5 seconds..."
                sleep 5
            else
                log_message "FFmpeg process ended - streaming disabled"
            fi
        fi
        
        rm -f "$FFMPEG_PID_FILE"
    else
        log_message "Streaming disabled - waiting for start event..."
        sleep 5
    fi
done
