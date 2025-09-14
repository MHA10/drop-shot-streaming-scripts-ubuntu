#!/bin/bash

# Multi-Stream Management Script with SSE Support for Raspberry Pi
# Handles multiple concurrent streams with robust PID management and state persistence

set -e

# Configuration
# SSE endpoint - can be overridden via SSE_ENDPOINT environment variable
SSE_ENDPOINT="${SSE_ENDPOINT:-https://029a7de6bd15.ngrok-free.app/events}"
# Use /var/tmp for persistent storage that survives reboots
PERSISTENT_STATE_DIR="/var/tmp/stream_registry"
STREAM_REGISTRY_DIR="/tmp/stream_registry"
SSE_PID_FILE="/tmp/sse_listener.pid"
FFMPEG_PID_FILE="/tmp/ffmpeg.pid"
LOG_FILE="/tmp/stream_script.log"
CONFIG_FILE="/tmp/stream_config.json"
STREAM_STATE_FILE="/tmp/stream_state.json"
STREAM_REGISTRY_FILE="/tmp/stream_registry.json"
HEALTH_CHECK_INTERVAL=30
# Boot detection file
BOOT_MARKER_FILE="/var/tmp/stream_script_boot_marker"
LAST_BOOT_TIME_FILE="/var/tmp/last_boot_time"

# Default streaming parameters
FFMPEG_PARAMS="-rtsp_transport tcp -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -c:v libx264 -preset veryfast -b:v 4500k -maxrate 5000k -bufsize 10000k -vf scale=1920:1080 -c:a aac -b:a 128k -ar 44100 -f flv"

# Boot detection functions
detect_boot_scenario() {
    local current_boot_time=$(sysctl -n kern.boottime | awk '{print $4}' | tr -d ',')
    local stored_boot_time=""
    
    if [[ -f "$LAST_BOOT_TIME_FILE" ]]; then
        stored_boot_time=$(cat "$LAST_BOOT_TIME_FILE")
    fi
    
    # Store current boot time
    echo "$current_boot_time" > "$LAST_BOOT_TIME_FILE"
    
    if [[ "$current_boot_time" != "$stored_boot_time" ]]; then
        log_message "Boot scenario detected - PIDs will be invalid (boot time changed: $stored_boot_time -> $current_boot_time)"
        return 0  # Boot detected
    else
        log_message "Internet loss scenario detected - PIDs may still be valid (boot time unchanged: $current_boot_time)"
        return 1  # No boot, internet loss
    fi
}

# PID validation functions
validate_pid() {
    local pid="$1"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        return 0  # PID is valid
    else
        return 1  # PID is invalid
    fi
}

# Validate all PIDs in persistent state
validate_persistent_state() {
    local valid_count=0
    local invalid_count=0
    
    if [[ -f "$PERSISTENT_STATE_DIR/active_streams.list" ]]; then
        while IFS= read -r stream_id; do
            if [[ -n "$stream_id" ]]; then
                local persistent_state_file="$PERSISTENT_STATE_DIR/states/$stream_id.json"
                if [[ -f "$persistent_state_file" ]]; then
                    local pid=$(parse_json "$(cat "$persistent_state_file")" "pid")
                    if validate_pid "$pid"; then
                        ((valid_count++))
                        log_message "Stream $stream_id PID $pid is still valid"
                    else
                        ((invalid_count++))
                        log_message "Stream $stream_id PID $pid is invalid - will be cleaned"
                    fi
                fi
            fi
        done < "$PERSISTENT_STATE_DIR/active_streams.list"
    fi
    
    log_message "PID validation complete: $valid_count valid, $invalid_count invalid"
    return $invalid_count
}

# Initialize stream management system
init_stream_system() {
    # Create both temporary and persistent registry directories
    mkdir -p "$STREAM_REGISTRY_DIR"
    mkdir -p "$PERSISTENT_STATE_DIR/states"
    
    # Initialize empty stream registry
    echo '{}' > "$STREAM_REGISTRY_FILE"
    
    # Initialize active streams list
    touch "$STREAM_REGISTRY_DIR/active_streams.list"
    touch "$PERSISTENT_STATE_DIR/active_streams.list"
    
    # Detect boot vs internet loss scenario
    if detect_boot_scenario; then
        log_message "Boot detected - clearing all persistent state and starting fresh"
        clear_persistent_state
    else
        log_message "Internet loss detected - validating existing PIDs"
        validate_persistent_state
        restore_valid_streams
    fi
    
    # Clean up any orphaned processes from previous runs
    cleanup_orphaned_processes
    
    log_message "Stream management system initialized"
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

# Generate unique stream ID from RTSP URL and stream key
generate_stream_id() {
    local rtsp_url="$1"
    local stream_key="$2"
    echo "${rtsp_url}_${stream_key}" | md5sum | cut -d' ' -f1 | head -c 8
}

# Get stream state file path
get_stream_state_file() {
    local stream_id="$1"
    echo "$STREAM_REGISTRY_DIR/stream_${stream_id}.json"
}

# Create stream state file (both temporary and persistent)
create_stream_state() {
    local stream_id="$1"
    local rtsp_url="$2"
    local rtmp_url="$3"
    local pid="$4"
    local status="$5"
    local start_time=$(date '+%Y-%m-%d %H:%M:%S')
    
    local state_file=$(get_stream_state_file "$stream_id")
    local persistent_state_file="$PERSISTENT_STATE_DIR/states/$stream_id.json"
    
    local state_content=$(cat << EOF
{
    "stream_id": "$stream_id",
    "rtsp_url": "$rtsp_url",
    "rtmp_url": "$rtmp_url",
    "pid": $pid,
    "status": "$status",
    "start_time": "$start_time",
    "last_health_check": "$start_time"
}
EOF
)
    
    # Write to both temporary and persistent state
    echo "$state_content" > "$state_file"
    echo "$state_content" > "$persistent_state_file"
}

# Update stream registry (both temporary and persistent)
update_stream_registry() {
    local stream_id="$1"
    local action="$2"  # add or remove
    
    # Update temporary registry
    if [[ "$action" == "add" ]]; then
        if ! grep -q "^$stream_id$" "$STREAM_REGISTRY_DIR/active_streams.list" 2>/dev/null; then
            echo "$stream_id" >> "$STREAM_REGISTRY_DIR/active_streams.list"
        fi
        # Also update persistent registry
        if ! grep -q "^$stream_id$" "$PERSISTENT_STATE_DIR/active_streams.list" 2>/dev/null; then
            echo "$stream_id" >> "$PERSISTENT_STATE_DIR/active_streams.list"
        fi
    elif [[ "$action" == "remove" ]]; then
        # Remove from temporary registry
        if [[ -f "$STREAM_REGISTRY_DIR/active_streams.list" ]]; then
            grep -v "^$stream_id$" "$STREAM_REGISTRY_DIR/active_streams.list" > "$STREAM_REGISTRY_DIR/active_streams.list.tmp" || true
            mv "$STREAM_REGISTRY_DIR/active_streams.list.tmp" "$STREAM_REGISTRY_DIR/active_streams.list"
        fi
        # Remove from persistent registry
        if [[ -f "$PERSISTENT_STATE_DIR/active_streams.list" ]]; then
            grep -v "^$stream_id$" "$PERSISTENT_STATE_DIR/active_streams.list" > "$PERSISTENT_STATE_DIR/active_streams.list.tmp" || true
            mv "$PERSISTENT_STATE_DIR/active_streams.list.tmp" "$PERSISTENT_STATE_DIR/active_streams.list"
        fi
        # Remove persistent state file
        rm -f "$PERSISTENT_STATE_DIR/states/$stream_id.json"
    fi
}

# Check if stream is active
is_stream_active() {
    local stream_id="$1"
    local state_file=$(get_stream_state_file "$stream_id")
    
    if [[ -f "$state_file" ]]; then
        local pid=$(parse_json "$(cat "$state_file")" "pid")
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

# Clear persistent state (used after boot detection)
clear_persistent_state() {
    log_message "Clearing persistent state due to boot detection"
    
    # Remove all persistent state files
    rm -rf "$PERSISTENT_STATE_DIR/states"/*
    rm -f "$PERSISTENT_STATE_DIR/active_streams.list"
    
    # Recreate directories
    mkdir -p "$PERSISTENT_STATE_DIR/states"
    touch "$PERSISTENT_STATE_DIR/active_streams.list"
    
    log_message "Persistent state cleared"
}

# Restore valid streams from persistent state
restore_valid_streams() {
    log_message "Restoring valid streams from persistent state"
    
    local restored_count=0
    
    if [[ -f "$PERSISTENT_STATE_DIR/active_streams.list" ]]; then
        while IFS= read -r stream_id; do
            if [[ -n "$stream_id" ]]; then
                local persistent_state_file="$PERSISTENT_STATE_DIR/states/$stream_id.json"
                if [[ -f "$persistent_state_file" ]]; then
                    local state_content=$(cat "$persistent_state_file")
                    local pid=$(parse_json "$state_content" "pid")
                    
                    if validate_pid "$pid"; then
                        # Copy to temporary state
                        local temp_state_file=$(get_stream_state_file "$stream_id")
                        cp "$persistent_state_file" "$temp_state_file"
                        update_stream_registry "$stream_id" "add"
                        ((restored_count++))
                        log_message "Restored stream $stream_id with valid PID $pid"
                    else
                        # Remove invalid persistent state
                        rm -f "$persistent_state_file"
                        log_message "Removed invalid persistent state for stream $stream_id"
                    fi
                fi
            fi
        done < "$PERSISTENT_STATE_DIR/active_streams.list"
        
        # Update persistent registry to remove invalid entries
        if [[ -f "$STREAM_REGISTRY_DIR/active_streams.list" ]]; then
            cp "$STREAM_REGISTRY_DIR/active_streams.list" "$PERSISTENT_STATE_DIR/active_streams.list"
        fi
    fi
    
    log_message "Restored $restored_count valid streams from persistent state"
}

# Cleanup orphaned processes
cleanup_orphaned_processes() {
    log_message "Cleaning up orphaned processes..."
    
    if [[ -f "$STREAM_REGISTRY_DIR/active_streams.list" ]]; then
        while IFS= read -r stream_id; do
            if [[ -n "$stream_id" ]]; then
                local state_file=$(get_stream_state_file "$stream_id")
                if [[ -f "$state_file" ]]; then
                    local pid=$(parse_json "$(cat "$state_file")" "pid")
                    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
                        log_message "Cleaning up orphaned stream: $stream_id (PID: $pid)"
                        rm -f "$state_file"
                        update_stream_registry "$stream_id" "remove"
                    fi
                fi
            fi
        done < "$STREAM_REGISTRY_DIR/active_streams.list"
    fi
}

# Start a new stream
start_stream() {
    local rtsp_url="$1"
    local rtmp_url="$2"
    local stream_key="$3"
    
    local stream_id=$(generate_stream_id "$rtsp_url" "$stream_key")
    
    # Check if stream is already active
    if is_stream_active "$stream_id"; then
        log_message "Stream $stream_id is already active - skipping start"
        return 0
    fi
    
    log_message "Starting stream $stream_id: RTSP=${rtsp_url:0:50}... RTMP=${rtmp_url:0:50}..."
    
    # Start FFmpeg process
    ffmpeg $FFMPEG_PARAMS -i "$rtsp_url" "$rtmp_url" &
    local ffmpeg_pid=$!
    
    # Create stream state file
    create_stream_state "$stream_id" "$rtsp_url" "$rtmp_url" "$ffmpeg_pid" "running"
    
    # Add to registry
    update_stream_registry "$stream_id" "add"
    
    log_message "Stream $stream_id started with PID $ffmpeg_pid"
    return 0
}

# Stop a specific stream (remove both temporary and persistent state)
stop_stream() {
    local stream_id="$1"
    
    local state_file=$(get_stream_state_file "$stream_id")
    local persistent_state_file="$PERSISTENT_STATE_DIR/states/$stream_id.json"
    
    if [[ ! -f "$state_file" ]] && [[ ! -f "$persistent_state_file" ]]; then
        log_message "Stream $stream_id not found - already stopped"
        return 0
    fi
    
    # Try to get PID from either state file
    local pid=""
    if [[ -f "$state_file" ]]; then
        local state_content=$(cat "$state_file")
        pid=$(parse_json "$state_content" "pid")
    elif [[ -f "$persistent_state_file" ]]; then
        local state_content=$(cat "$persistent_state_file")
        pid=$(parse_json "$state_content" "pid")
    fi
    
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        log_message "Stopping stream $stream_id (PID: $pid)"
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi
    
    # Clean up both state files and registry
    rm -f "$state_file"
    rm -f "$persistent_state_file"
    update_stream_registry "$stream_id" "remove"
    
    log_message "Stream $stream_id stopped"
}

# Stop stream by URLs (for compatibility with SSE events)
stop_stream_by_urls() {
    local rtsp_url="$1"
    local stream_key="$2"
    
    local stream_id=$(generate_stream_id "$rtsp_url" "$stream_key")
    stop_stream "$stream_id"
}

# Health check for all active streams
health_check_streams() {
    if [[ ! -f "$STREAM_REGISTRY_DIR/active_streams.list" ]]; then
        return 0
    fi
    
    while IFS= read -r stream_id; do
        if [[ -n "$stream_id" ]]; then
            local state_file=$(get_stream_state_file "$stream_id")
            if [[ -f "$state_file" ]]; then
                local pid=$(parse_json "$(cat "$state_file")" "pid")
                if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
                    log_message "Stream $stream_id (PID: $pid) has died - cleaning up"
                    rm -f "$state_file"
                    update_stream_registry "$stream_id" "remove"
                else
                    # Update last health check time
                    local current_time=$(date '+%Y-%m-%d %H:%M:%S')
                    local state_content=$(cat "$state_file")
                    echo "$state_content" | sed "s/\"last_health_check\": \"[^\"]*\"/\"last_health_check\": \"$current_time\"/" > "$state_file"
                fi
            fi
        fi
    done < "$STREAM_REGISTRY_DIR/active_streams.list"
}

# State reconciliation - compare current streams with new SSE events
declare -A expected_streams
declare -A current_streams

# Start state reconciliation process
start_state_reconciliation() {
    log_message "Starting state reconciliation - preparing to compare current vs new state"
    
    # Clear expected streams array
    unset expected_streams
    declare -gA expected_streams
    
    # Build current streams map
    unset current_streams
    declare -gA current_streams
    
    if [[ -f "$STREAM_REGISTRY_DIR/active_streams.list" ]]; then
        while IFS= read -r stream_id; do
            if [[ -n "$stream_id" ]]; then
                current_streams["$stream_id"]=1
            fi
        done < "$STREAM_REGISTRY_DIR/active_streams.list"
    fi
    
    log_message "Current active streams: ${#current_streams[@]}"
}

# Add expected stream to reconciliation
add_expected_stream() {
    local rtsp_url="$1"
    local stream_key="$2"
    local stream_id=$(generate_stream_id "$rtsp_url" "$stream_key")
    
    expected_streams["$stream_id"]=1
    log_message "Added expected stream: $stream_id"
}

# Complete state reconciliation - apply differential changes
complete_state_reconciliation() {
    log_message "Completing state reconciliation - applying differential changes"
    
    local streams_to_stop=()
    local streams_to_keep=()
    local streams_to_start=()
    
    # Find streams to stop (in current but not in expected)
    for stream_id in "${!current_streams[@]}"; do
        if [[ -z "${expected_streams[$stream_id]:-}" ]]; then
            streams_to_stop+=("$stream_id")
        else
            streams_to_keep+=("$stream_id")
        fi
    done
    
    # Find streams to start (in expected but not in current)
    for stream_id in "${!expected_streams[@]}"; do
        if [[ -z "${current_streams[$stream_id]:-}" ]]; then
            streams_to_start+=("$stream_id")
        fi
    done
    
    # Log reconciliation summary
    log_message "State reconciliation summary:"
    log_message "  - Streams to stop: ${#streams_to_stop[@]}"
    log_message "  - Streams to keep: ${#streams_to_keep[@]}"
    log_message "  - Streams to start: ${#streams_to_start[@]}"
    
    # Stop streams that are no longer needed
    for stream_id in "${streams_to_stop[@]}"; do
        log_message "Stopping stream $stream_id (no longer in expected state)"
        stop_stream "$stream_id"
    done
    
    # Keep existing streams (just log)
    for stream_id in "${streams_to_keep[@]}"; do
        log_message "Keeping stream $stream_id (matches expected state)"
    done
    
    log_message "State reconciliation completed - ready for new stream starts"
}

# Clear all streams (legacy function - now smarter)
clear_all_streams() {
    log_message "Smart clearing - only removing invalid/stale streams"
    
    local cleared_count=0
    local kept_count=0
    
    if [[ -f "$STREAM_REGISTRY_DIR/active_streams.list" ]]; then
        while IFS= read -r stream_id; do
            if [[ -n "$stream_id" ]]; then
                local state_file=$(get_stream_state_file "$stream_id")
                if [[ -f "$state_file" ]]; then
                    local state_content=$(cat "$state_file")
                    local pid=$(parse_json "$state_content" "pid")
                    
                    # Only clear streams with invalid PIDs
                    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
                        log_message "Clearing stream $stream_id (PID $pid is invalid)"
                        rm -f "$state_file"
                        rm -f "$PERSISTENT_STATE_DIR/states/$stream_id.json"
                        update_stream_registry "$stream_id" "remove"
                        ((cleared_count++))
                    else
                        log_message "Keeping stream $stream_id (PID $pid is still valid)"
                        ((kept_count++))
                    fi
                fi
            fi
        done < "$STREAM_REGISTRY_DIR/active_streams.list"
    fi
    
    log_message "Smart clear completed: $cleared_count cleared, $kept_count kept"
}

# SSE listener function with state reconciliation
sse_listener() {
    local retry_count=0
    local max_retries=5
    local connection_lost=false
    local first_connection=true
    local sse_events_received=false
    
    while true; do
        log_message "Starting SSE listener (attempt $((retry_count + 1)))"
        
        # Handle reconnection scenarios
        if [[ "$connection_lost" == "true" ]]; then
            log_message "SSE reconnection detected - starting state reconciliation"
            start_state_reconciliation
            connection_lost=false
            sse_events_received=false
        elif [[ "$first_connection" == "false" ]]; then
            # Any connection after the first is considered a reconnection
            log_message "SSE reconnection detected - starting state reconciliation"
            start_state_reconciliation
            sse_events_received=false
        fi
        
        first_connection=false
        
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
                
                # Extract event format fields
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
                        
                        # Handle stream lifecycle based on event type
                        if [[ "$event_type" == "start" ]]; then
                            log_message "START event received - adding to expected streams"
                            
                            # If this is a reconnection, add to expected streams for reconciliation
                             if [[ "$sse_events_received" == "false" ]] && [[ "$first_connection" == "false" ]]; then
                                 add_expected_stream "$camera_url" "$stream_key"
                                 # Store stream details for later use
                                 local stream_id=$(generate_stream_id "$camera_url" "$stream_key")
                                 local temp_state_file="$PERSISTENT_STATE_DIR/states/$stream_id.json"
                                 mkdir -p "$(dirname "$temp_state_file")"
                                 cat > "$temp_state_file" << EOF
{
    "stream_id": "$stream_id",
    "rtsp_url": "$camera_url",
    "rtmp_url": "$rtmp_url",
    "stream_key": "$stream_key",
    "status": "expected"
}
EOF
                             else
                                 # Normal operation - start stream directly
                                 start_stream "$camera_url" "$rtmp_url" "$stream_key"
                             fi
                        elif [[ "$event_type" == "stop" ]]; then
                            log_message "STOP event received"
                            
                            # For stop events, we don't add to expected streams
                            # If not in reconciliation mode, stop directly
                            if [[ "$sse_events_received" == "true" ]] || [[ "$first_connection" == "true" ]]; then
                                stop_stream_by_urls "$camera_url" "$stream_key"
                            fi
                        else
                            log_message "Unknown event type: $event_type - ignoring"
                        fi
                        
                        # Mark that we've received SSE events
                        sse_events_received=true
                    else
                        log_message "Invalid URLs - CameraUrl: $camera_url, StreamKey: $stream_key - ignoring update"
                    fi
                else
                    log_message "Missing required fields in SSE event - ignoring update"
                fi
            fi
        done
        
        # Complete state reconciliation if we were in reconciliation mode
        if [[ "$sse_events_received" == "true" ]] && [[ "$first_connection" == "false" ]]; then
            log_message "SSE stream ended - completing state reconciliation"
            complete_state_reconciliation
            
            # Start new streams that were in expected but not current
            for stream_id in "${!expected_streams[@]}"; do
                if [[ -z "${current_streams[$stream_id]:-}" ]]; then
                    # Extract stream details from stream_id to start the stream
                    local state_file="$PERSISTENT_STATE_DIR/states/$stream_id.json"
                    if [[ -f "$state_file" ]]; then
                        local state_content=$(cat "$state_file")
                        local rtsp_url=$(parse_json "$state_content" "rtsp_url")
                        local rtmp_url=$(parse_json "$state_content" "rtmp_url")
                        local stream_key=$(parse_json "$state_content" "stream_key")
                        
                        if [[ -n "$rtsp_url" && -n "$rtmp_url" && -n "$stream_key" ]]; then
                            log_message "Starting new expected stream: $stream_id"
                            start_stream "$rtsp_url" "$rtmp_url" "$stream_key"
                        fi
                    fi
                fi
            done
        fi
        
        # Handle connection failure
        connection_lost=true
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

# Main function with multi-stream support
main() {
    log_message "Starting multi-stream script with SSE support"
    
    # Initialize stream system
    init_stream_system
    
    # Start SSE listener in background
    sse_listener &
    echo $! > "$SSE_PID_FILE"
    log_message "SSE listener started with PID $(cat "$SSE_PID_FILE")"
    
    # Main monitoring loop
    while true; do
        # Perform health checks on all active streams
        health_check_streams
        
        # Wait before next health check
        sleep "$HEALTH_CHECK_INTERVAL"
    done
}

# Set up signal handlers for graceful shutdown
trap cleanup SIGTERM SIGINT

# Run main function
main
