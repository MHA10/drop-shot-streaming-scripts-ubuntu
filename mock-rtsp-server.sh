#!/bin/bash

# Mock RTSP Server for Testing
# Ubuntu Linux Edition - No Real Camera Required

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RTSP_PORT=${RTSP_PORT:-8554}
HTTP_PORT=${HTTP_PORT:-8080}
PID_FILE="/tmp/mock-rtsp-server.pid"
LOG_FILE="$SCRIPT_DIR/mock-rtsp-server.log"
STREAM_NAME=${STREAM_NAME:-"test"}
VIDEO_RESOLUTION=${VIDEO_RESOLUTION:-"1920x1080"}
VIDEO_FPS=${VIDEO_FPS:-30}
VIDEO_BITRATE=${VIDEO_BITRATE:-"2M"}
AUDIO_BITRATE=${AUDIO_BITRATE:-"128k"}
STREAM_DURATION=${STREAM_DURATION:-3600}  # 1 hour default

# Logging functions
log() {
    local message="$1"
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $message"
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $message" >> "$LOG_FILE"
}

log_success() {
    local message="$1"
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] ✓${NC} $message"
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] SUCCESS: $message" >> "$LOG_FILE"
}

log_warning() {
    local message="$1"
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] ⚠${NC} $message"
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $message" >> "$LOG_FILE"
}

log_error() {
    local message="$1"
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ✗${NC} $message"
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $message" >> "$LOG_FILE"
}

# Check dependencies
check_dependencies() {
    log "Checking dependencies..."
    
    local missing_deps=()
    local deps=("ffmpeg" "curl" "ss" "kill")
    
    for dep in "${deps[@]}"; do
        if ! command -v "$dep" > /dev/null 2>&1; then
            missing_deps+=("$dep")
        fi
    done
    
    if [[ ${#missing_deps[@]} -gt 0 ]]; then
        log_error "Missing dependencies: ${missing_deps[*]}"
        log_error "Please run ubuntu-install.sh first"
        exit 1
    fi
    
    log_success "All dependencies available"
}

# Check if server is already running
check_running() {
    if [[ -f "$PID_FILE" ]]; then
        local pid=$(cat "$PID_FILE")
        if ps -p "$pid" > /dev/null 2>&1; then
            log_warning "Mock RTSP server is already running (PID: $pid)"
            echo "Use '$0 stop' to stop the server first"
            exit 1
        else
            log "Removing stale PID file"
            rm -f "$PID_FILE"
        fi
    fi
}

# Check port availability
check_ports() {
    log "Checking port availability..."
    
    if ss -tuln | grep -q ":$RTSP_PORT "; then
        log_error "RTSP port $RTSP_PORT is already in use"
        exit 1
    fi
    
    if ss -tuln | grep -q ":$HTTP_PORT "; then
        log_error "HTTP port $HTTP_PORT is already in use"
        exit 1
    fi
    
    log_success "Ports $RTSP_PORT (RTSP) and $HTTP_PORT (HTTP) are available"
}

# Generate test patterns
generate_test_pattern() {
    local pattern_type="$1"
    
    case "$pattern_type" in
        "color_bars")
            echo "smptebars=duration=$STREAM_DURATION:size=$VIDEO_RESOLUTION:rate=$VIDEO_FPS"
            ;;
        "test_src")
            echo "testsrc=duration=$STREAM_DURATION:size=$VIDEO_RESOLUTION:rate=$VIDEO_FPS"
            ;;
        "mandelbrot")
            echo "mandelbrot=duration=$STREAM_DURATION:size=$VIDEO_RESOLUTION:rate=$VIDEO_FPS"
            ;;
        "gradient")
            echo "gradients=duration=$STREAM_DURATION:size=$VIDEO_RESOLUTION:rate=$VIDEO_FPS"
            ;;
        "noise")
            echo "noise=duration=$STREAM_DURATION:size=$VIDEO_RESOLUTION:rate=$VIDEO_FPS"
            ;;
        *)
            echo "testsrc=duration=$STREAM_DURATION:size=$VIDEO_RESOLUTION:rate=$VIDEO_FPS"
            ;;
    esac
}

# Generate audio pattern
generate_audio_pattern() {
    local audio_type="$1"
    
    case "$audio_type" in
        "sine")
            echo "sine=frequency=1000:duration=$STREAM_DURATION"
            ;;
        "tone")
            echo "sine=frequency=440:duration=$STREAM_DURATION"
            ;;
        "silence")
            echo "anullsrc=duration=$STREAM_DURATION"
            ;;
        *)
            echo "sine=frequency=1000:duration=$STREAM_DURATION"
            ;;
    esac
}

# Start RTSP server with different stream types
start_rtsp_server() {
    local stream_type="${1:-test_src}"
    local audio_type="${2:-sine}"
    
    log "Starting Mock RTSP Server..."
    log "Configuration:"
    log "  RTSP Port: $RTSP_PORT"
    log "  HTTP Port: $HTTP_PORT"
    log "  Stream: rtsp://127.0.0.1:$RTSP_PORT/$STREAM_NAME"
    log "  Resolution: $VIDEO_RESOLUTION"
    log "  FPS: $VIDEO_FPS"
    log "  Video Bitrate: $VIDEO_BITRATE"
    log "  Audio Bitrate: $AUDIO_BITRATE"
    log "  Stream Type: $stream_type"
    log "  Audio Type: $audio_type"
    
    # Generate video and audio sources
    local video_source=$(generate_test_pattern "$stream_type")
    local audio_source=$(generate_audio_pattern "$audio_type")
    
    # Start FFmpeg RTSP server
    ffmpeg -re \
           -f lavfi -i "$video_source" \
           -f lavfi -i "$audio_source" \
           -c:v libx264 -preset ultrafast -tune zerolatency \
           -b:v "$VIDEO_BITRATE" -maxrate "$VIDEO_BITRATE" -bufsize "$((${VIDEO_BITRATE%M} * 2))M" \
           -c:a aac -b:a "$AUDIO_BITRATE" \
           -f rtsp -rtsp_transport tcp \
           "rtsp://127.0.0.1:$RTSP_PORT/$STREAM_NAME" \
           > "$LOG_FILE" 2>&1 &
    
    local ffmpeg_pid=$!
    echo $ffmpeg_pid > "$PID_FILE"
    
    # Wait for server to start
    sleep 3
    
    # Verify server is running
    if ps -p "$ffmpeg_pid" > /dev/null 2>&1; then
        log_success "Mock RTSP server started successfully (PID: $ffmpeg_pid)"
        
        # Test the stream
        if ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height \
                   "rtsp://127.0.0.1:$RTSP_PORT/$STREAM_NAME" > /dev/null 2>&1; then
            log_success "RTSP stream is accessible and valid"
        else
            log_warning "RTSP stream may not be immediately accessible (still starting up)"
        fi
        
        echo
        echo "Mock RTSP Server Information:"
        echo "  RTSP URL: rtsp://127.0.0.1:$RTSP_PORT/$STREAM_NAME"
        echo "  Status URL: http://127.0.0.1:$HTTP_PORT/status"
        echo "  Log file: $LOG_FILE"
        echo "  PID file: $PID_FILE"
        echo
        echo "Test the stream with:"
        echo "  ffplay rtsp://127.0.0.1:$RTSP_PORT/$STREAM_NAME"
        echo "  ffprobe rtsp://127.0.0.1:$RTSP_PORT/$STREAM_NAME"
        echo
        echo "Stop the server with:"
        echo "  $0 stop"
        
    else
        log_error "Failed to start Mock RTSP server"
        rm -f "$PID_FILE"
        exit 1
    fi
}

# Start HTTP status server
start_http_server() {
    log "Starting HTTP status server on port $HTTP_PORT..."
    
    # Create simple HTTP server using netcat (if available) or Python
    if command -v nc > /dev/null 2>&1; then
        # Use netcat for simple HTTP responses
        while true; do
            echo -e "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"status\":\"running\",\"rtsp_url\":\"rtsp://127.0.0.1:$RTSP_PORT/$STREAM_NAME\",\"timestamp\":\"$(date -Iseconds)\"}" | nc -l -p "$HTTP_PORT" -q 1
        done &
        
        local http_pid=$!
        echo $http_pid > "/tmp/mock-http-server.pid"
        log_success "HTTP status server started (PID: $http_pid)"
        
    elif command -v python3 > /dev/null 2>&1; then
        # Use Python for HTTP server
        python3 -c "
import http.server
import socketserver
import json
from datetime import datetime

class StatusHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/status':
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            status = {
                'status': 'running',
                'rtsp_url': f'rtsp://127.0.0.1:$RTSP_PORT/$STREAM_NAME',
                'timestamp': datetime.now().isoformat()
            }
            self.wfile.write(json.dumps(status).encode())
        else:
            self.send_response(404)
            self.end_headers()
    
    def log_message(self, format, *args):
        pass  # Suppress default logging

with socketserver.TCPServer(('', $HTTP_PORT), StatusHandler) as httpd:
    httpd.serve_forever()
" > /dev/null 2>&1 &
        
        local http_pid=$!
        echo $http_pid > "/tmp/mock-http-server.pid"
        log_success "HTTP status server started (PID: $http_pid)"
    else
        log_warning "No suitable HTTP server available (nc or python3 required)"
    fi
}

# Stop the server
stop_server() {
    log "Stopping Mock RTSP Server..."
    
    local stopped=false
    
    # Stop RTSP server
    if [[ -f "$PID_FILE" ]]; then
        local pid=$(cat "$PID_FILE")
        if ps -p "$pid" > /dev/null 2>&1; then
            kill "$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null
            log_success "RTSP server stopped (PID: $pid)"
            stopped=true
        fi
        rm -f "$PID_FILE"
    fi
    
    # Stop HTTP server
    if [[ -f "/tmp/mock-http-server.pid" ]]; then
        local http_pid=$(cat "/tmp/mock-http-server.pid")
        if ps -p "$http_pid" > /dev/null 2>&1; then
            kill "$http_pid" 2>/dev/null || kill -9 "$http_pid" 2>/dev/null
            log_success "HTTP server stopped (PID: $http_pid)"
            stopped=true
        fi
        rm -f "/tmp/mock-http-server.pid"
    fi
    
    # Kill any remaining FFmpeg processes
    pkill -f "rtsp://127.0.0.1:$RTSP_PORT" 2>/dev/null || true
    
    if [[ "$stopped" == "true" ]]; then
        log_success "Mock RTSP server stopped successfully"
    else
        log_warning "No running server found"
    fi
}

# Show server status
show_status() {
    echo "Mock RTSP Server Status:"
    echo "========================"
    
    if [[ -f "$PID_FILE" ]]; then
        local pid=$(cat "$PID_FILE")
        if ps -p "$pid" > /dev/null 2>&1; then
            echo -e "Status: ${GREEN}Running${NC} (PID: $pid)"
            echo "RTSP URL: rtsp://127.0.0.1:$RTSP_PORT/$STREAM_NAME"
            
            # Test stream accessibility
            if ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height \
                       "rtsp://127.0.0.1:$RTSP_PORT/$STREAM_NAME" > /dev/null 2>&1; then
                echo -e "Stream: ${GREEN}Accessible${NC}"
            else
                echo -e "Stream: ${RED}Not Accessible${NC}"
            fi
            
            # Show resource usage
            local cpu_usage=$(ps -p "$pid" -o %cpu --no-headers 2>/dev/null || echo "N/A")
            local mem_usage=$(ps -p "$pid" -o %mem --no-headers 2>/dev/null || echo "N/A")
            echo "CPU Usage: ${cpu_usage}%"
            echo "Memory Usage: ${mem_usage}%"
            
        else
            echo -e "Status: ${RED}Not Running${NC} (stale PID file)"
            rm -f "$PID_FILE"
        fi
    else
        echo -e "Status: ${RED}Not Running${NC}"
    fi
    
    # Check HTTP server
    if [[ -f "/tmp/mock-http-server.pid" ]]; then
        local http_pid=$(cat "/tmp/mock-http-server.pid")
        if ps -p "$http_pid" > /dev/null 2>&1; then
            echo -e "HTTP Status: ${GREEN}Running${NC} (PID: $http_pid)"
            echo "Status URL: http://127.0.0.1:$HTTP_PORT/status"
        else
            echo -e "HTTP Status: ${RED}Not Running${NC}"
            rm -f "/tmp/mock-http-server.pid"
        fi
    else
        echo -e "HTTP Status: ${RED}Not Running${NC}"
    fi
    
    echo
    echo "Log file: $LOG_FILE"
    if [[ -f "$LOG_FILE" ]]; then
        echo "Log size: $(du -h "$LOG_FILE" | cut -f1)"
        echo "Last 3 log entries:"
        tail -n 3 "$LOG_FILE" 2>/dev/null || echo "  (no recent entries)"
    fi
}

# Show usage information
show_usage() {
    echo "Mock RTSP Server for Testing"
    echo "Usage: $0 [COMMAND] [OPTIONS]"
    echo
    echo "Commands:"
    echo "  start [PATTERN] [AUDIO]  Start the mock RTSP server"
    echo "  stop                     Stop the mock RTSP server"
    echo "  restart [PATTERN] [AUDIO] Restart the mock RTSP server"
    echo "  status                   Show server status"
    echo "  test                     Test the RTSP stream"
    echo "  help                     Show this help message"
    echo
    echo "Video Patterns:"
    echo "  color_bars              SMPTE color bars (default)"
    echo "  test_src                Test source with moving objects"
    echo "  mandelbrot              Mandelbrot fractal animation"
    echo "  gradient                Color gradients"
    echo "  noise                   Random noise pattern"
    echo
    echo "Audio Patterns:"
    echo "  sine                    1000Hz sine wave (default)"
    echo "  tone                    440Hz tone"
    echo "  silence                 Silent audio"
    echo
    echo "Environment Variables:"
    echo "  RTSP_PORT               RTSP server port (default: 8554)"
    echo "  HTTP_PORT               HTTP status port (default: 8080)"
    echo "  STREAM_NAME             Stream name (default: test)"
    echo "  VIDEO_RESOLUTION        Video resolution (default: 1920x1080)"
    echo "  VIDEO_FPS               Video frame rate (default: 30)"
    echo "  VIDEO_BITRATE           Video bitrate (default: 2M)"
    echo "  AUDIO_BITRATE           Audio bitrate (default: 128k)"
    echo "  STREAM_DURATION         Stream duration in seconds (default: 3600)"
    echo
    echo "Examples:"
    echo "  $0 start                Start with default test pattern"
    echo "  $0 start color_bars     Start with SMPTE color bars"
    echo "  $0 start mandelbrot tone Start with Mandelbrot and 440Hz tone"
    echo "  RTSP_PORT=9554 $0 start Start on custom port"
    echo
}

# Test the RTSP stream
test_stream() {
    log "Testing RTSP stream..."
    
    if [[ ! -f "$PID_FILE" ]]; then
        log_error "Mock RTSP server is not running"
        echo "Start the server first with: $0 start"
        exit 1
    fi
    
    local pid=$(cat "$PID_FILE")
    if ! ps -p "$pid" > /dev/null 2>&1; then
        log_error "Mock RTSP server is not running (stale PID)"
        rm -f "$PID_FILE"
        exit 1
    fi
    
    local rtsp_url="rtsp://127.0.0.1:$RTSP_PORT/$STREAM_NAME"
    
    echo "Testing RTSP stream: $rtsp_url"
    echo
    
    # Test with ffprobe
    log "Testing with ffprobe..."
    if ffprobe -v quiet -print_format json -show_streams "$rtsp_url" 2>/dev/null; then
        log_success "Stream is accessible and valid"
    else
        log_error "Stream is not accessible"
        exit 1
    fi
    
    echo
    
    # Test playback (if ffplay is available)
    if command -v ffplay > /dev/null 2>&1; then
        echo "You can test playback with:"
        echo "  ffplay '$rtsp_url'"
    fi
    
    # Test recording
    echo "You can test recording with:"
    echo "  ffmpeg -i '$rtsp_url' -t 10 -c copy test_recording.mp4"
    
    echo
    log_success "Stream test completed successfully"
}

# Main function
main() {
    local command="${1:-help}"
    local pattern="${2:-test_src}"
    local audio="${3:-sine}"
    
    case "$command" in
        "start")
            check_dependencies
            check_running
            check_ports
            start_rtsp_server "$pattern" "$audio"
            start_http_server
            ;;
        "stop")
            stop_server
            ;;
        "restart")
            stop_server
            sleep 2
            check_dependencies
            check_ports
            start_rtsp_server "$pattern" "$audio"
            start_http_server
            ;;
        "status")
            show_status
            ;;
        "test")
            test_stream
            ;;
        "help"|"--help"|"-h")
            show_usage
            ;;
        *)
            echo "Unknown command: $command"
            echo "Use '$0 help' for usage information"
            exit 1
            ;;
    esac
}

# Handle script interruption
trap 'stop_server; exit 1' INT TERM

# Run main function
main "$@"