#!/bin/bash

# Ubuntu Environment Setup and Configuration Validation Script
# For RTSP-SSE Streaming System

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/rtsp-sse-stream.conf"
LOG_DIR="/var/log/rtsp-sse"
CONFIG_DIR="/etc/rtsp-sse"
USER_CONFIG_DIR="$HOME/.rtsp-sse"

# Logging functions
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] ✓${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] ⚠${NC} $1"
}

log_error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ✗${NC} $1"
}

# Check if script exists
check_main_script() {
    log "Checking main RTSP-SSE script..."
    
    if [[ -f "$SCRIPT_DIR/rtsp-sse-stream.sh" ]]; then
        log_success "Main script found: rtsp-sse-stream.sh"
        
        # Make it executable
        chmod +x "$SCRIPT_DIR/rtsp-sse-stream.sh"
        log_success "Script made executable"
    else
        log_error "Main script not found: rtsp-sse-stream.sh"
        log_error "Please ensure the main script is in the same directory"
        exit 1
    fi
}

# Validate dependencies
validate_dependencies() {
    log "Validating dependencies..."
    
    local errors=0
    local commands=("curl" "bash" "ffmpeg" "jq" "bc" "ps" "kill" "pgrep" "pkill")
    
    for cmd in "${commands[@]}"; do
        if command -v "$cmd" > /dev/null 2>&1; then
            log_success "$cmd is available"
        else
            log_error "$cmd is not available"
            ((errors++))
        fi
    done
    
    # Check FFmpeg capabilities
    if command -v ffmpeg > /dev/null 2>&1; then
        log "Checking FFmpeg capabilities..."
        
        # Check for RTSP support
        if ffmpeg -protocols 2>/dev/null | grep -q "rtsp"; then
            log_success "FFmpeg supports RTSP protocol"
        else
            log_warning "FFmpeg may not support RTSP protocol"
        fi
        
        # Check for common codecs
        local codecs=("h264" "h265" "aac" "mp3")
        for codec in "${codecs[@]}"; do
            if ffmpeg -codecs 2>/dev/null | grep -q "$codec"; then
                log_success "FFmpeg supports $codec codec"
            else
                log_warning "FFmpeg may not support $codec codec"
            fi
        done
    fi
    
    if [[ $errors -gt 0 ]]; then
        log_error "$errors dependencies are missing. Run ubuntu-install.sh first."
        exit 1
    fi
}

# Create configuration file
create_config() {
    log "Creating configuration file..."
    
    if [[ -f "$CONFIG_FILE" ]]; then
        log_warning "Configuration file already exists: $CONFIG_FILE"
        read -p "Overwrite existing configuration? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log "Keeping existing configuration"
            return
        fi
    fi
    
    # Get network interface for default IP
    local default_ip=$(ip route get 8.8.8.8 2>/dev/null | grep -oP 'src \K\S+' || echo "127.0.0.1")
    
    cat > "$CONFIG_FILE" << EOF
# RTSP-SSE Stream Configuration
# Ubuntu Linux Configuration

# RTSP Source Configuration
RTSP_URL="rtsp://admin:password@192.168.1.100:554/stream1"
RTSP_TIMEOUT=30
RTSP_RETRY_INTERVAL=5
RTSP_MAX_RETRIES=3

# SSE Server Configuration
SSE_SERVER_URL="http://$default_ip:3000/events"
SSE_RETRY_INTERVAL=5
SSE_MAX_RETRIES=3
SSE_TIMEOUT=30

# Stream Configuration
STREAM_RESOLUTION="1920x1080"
STREAM_FPS=30
STREAM_BITRATE="2M"
STREAM_CODEC="h264"
AUDIO_CODEC="aac"
AUDIO_BITRATE="128k"

# Output Configuration
OUTPUT_FORMAT="mp4"
OUTPUT_DIR="$HOME/streams"
SEGMENT_DURATION=10
MAX_SEGMENTS=6

# Hardware Acceleration (Ubuntu specific)
HW_ACCEL_ENABLED=true
HW_ACCEL_DEVICE="auto"
VAAPI_DEVICE="/dev/dri/renderD128"
NVENC_PRESET="fast"

# Performance Settings
MAX_CONCURRENT_STREAMS=4
BUFFER_SIZE="4M"
THREAD_COUNT=4
LOW_LATENCY_MODE=true

# Logging Configuration
LOG_LEVEL="INFO"
LOG_FILE="$LOG_DIR/rtsp-sse-stream.log"
LOG_MAX_SIZE="100M"
LOG_ROTATE_COUNT=5
DEBUG_MODE=false

# System Configuration
PID_FILE="/tmp/rtsp-sse-stream.pid"
LOCK_FILE="/tmp/rtsp-sse-stream.lock"
STATUS_FILE="/tmp/rtsp-sse-stream.status"

# Network Configuration
BIND_ADDRESS="0.0.0.0"
HTTP_PORT=8080
RTMP_PORT=1935
UDP_PORT_RANGE="10000-10100"

# Security Configuration
AUTH_ENABLED=false
AUTH_USERNAME="admin"
AUTH_PASSWORD="changeme"
SSL_ENABLED=false
SSL_CERT_PATH="/etc/ssl/certs/rtsp-sse.crt"
SSL_KEY_PATH="/etc/ssl/private/rtsp-sse.key"

# Ubuntu VM Optimizations
VM_OPTIMIZED=true
CPU_AFFINITY="0-3"
NICE_LEVEL=0
IONICE_CLASS=2
IONICE_LEVEL=4

# Monitoring Configuration
MONITORING_ENABLED=true
MONITORING_INTERVAL=30
ALERT_CPU_THRESHOLD=80
ALERT_MEMORY_THRESHOLD=80
ALERT_DISK_THRESHOLD=90
EOF
    
    log_success "Configuration file created: $CONFIG_FILE"
}

# Setup directories
setup_directories() {
    log "Setting up directories..."
    
    local dirs=(
        "$HOME/streams"
        "$HOME/streams/segments"
        "$HOME/streams/recordings"
        "$USER_CONFIG_DIR"
        "$USER_CONFIG_DIR/logs"
        "$USER_CONFIG_DIR/temp"
    )
    
    for dir in "${dirs[@]}"; do
        if [[ ! -d "$dir" ]]; then
            mkdir -p "$dir"
            log_success "Created directory: $dir"
        else
            log_success "Directory already exists: $dir"
        fi
    done
    
    # Set proper permissions
    chmod 755 "$HOME/streams"
    chmod 755 "$USER_CONFIG_DIR"
    
    log_success "Directory permissions set"
}

# Test network connectivity
test_network() {
    log "Testing network connectivity..."
    
    # Test internet connectivity
    if curl -s --connect-timeout 5 http://google.com > /dev/null; then
        log_success "Internet connectivity: OK"
    else
        log_warning "Internet connectivity: Limited or unavailable"
    fi
    
    # Test local network
    local gateway=$(ip route | grep default | awk '{print $3}' | head -n1)
    if [[ -n "$gateway" ]]; then
        if ping -c 1 -W 2 "$gateway" > /dev/null 2>&1; then
            log_success "Local network connectivity: OK (Gateway: $gateway)"
        else
            log_warning "Local network connectivity: Issues detected"
        fi
    fi
    
    # Check available ports
    local ports=("8080" "1935" "3000")
    for port in "${ports[@]}"; do
        if ss -tuln | grep -q ":$port "; then
            log_warning "Port $port is already in use"
        else
            log_success "Port $port is available"
        fi
    done
}

# Check system resources
check_system_resources() {
    log "Checking system resources..."
    
    # CPU information
    local cpu_cores=$(nproc)
    local cpu_usage=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)
    log_success "CPU: $cpu_cores cores, Current usage: ${cpu_usage}%"
    
    # Memory information
    local mem_total=$(free -h | awk '/^Mem:/ {print $2}')
    local mem_available=$(free -h | awk '/^Mem:/ {print $7}')
    log_success "Memory: $mem_total total, $mem_available available"
    
    # Disk space
    local disk_usage=$(df -h . | awk 'NR==2 {print $5}' | cut -d'%' -f1)
    local disk_available=$(df -h . | awk 'NR==2 {print $4}')
    log_success "Disk: $disk_available available, ${disk_usage}% used"
    
    # Check if running in VM
    if systemd-detect-virt > /dev/null 2>&1; then
        local virt_type=$(systemd-detect-virt)
        log_success "Virtualization detected: $virt_type"
    else
        log_success "Running on physical hardware"
    fi
    
    # Performance warnings
    if [[ $cpu_cores -lt 2 ]]; then
        log_warning "Low CPU core count. Consider increasing VM resources."
    fi
    
    if [[ ${cpu_usage%.*} -gt 80 ]]; then
        log_warning "High CPU usage detected. System may be under load."
    fi
    
    if [[ ${disk_usage} -gt 90 ]]; then
        log_warning "Low disk space. Consider cleaning up or expanding storage."
    fi
}

# Test hardware acceleration
test_hardware_acceleration() {
    log "Testing hardware acceleration..."
    
    # Test VAAPI (Intel/AMD)
    if [[ -e "/dev/dri/renderD128" ]]; then
        log_success "VAAPI device found: /dev/dri/renderD128"
        
        # Test VAAPI encoding
        if ffmpeg -f lavfi -i testsrc=duration=1:size=320x240:rate=1 -vaapi_device /dev/dri/renderD128 -vf 'format=nv12,hwupload' -c:v h264_vaapi -t 1 -f null - > /dev/null 2>&1; then
            log_success "VAAPI H.264 encoding: Available"
        else
            log_warning "VAAPI H.264 encoding: Not available"
        fi
    else
        log_warning "VAAPI device not found"
    fi
    
    # Test NVENC (NVIDIA)
    if command -v nvidia-smi > /dev/null 2>&1; then
        log_success "NVIDIA GPU detected"
        
        if ffmpeg -f lavfi -i testsrc=duration=1:size=320x240:rate=1 -c:v h264_nvenc -t 1 -f null - > /dev/null 2>&1; then
            log_success "NVENC H.264 encoding: Available"
        else
            log_warning "NVENC H.264 encoding: Not available"
        fi
    else
        log "NVIDIA GPU not detected"
    fi
    
    # Fallback to software encoding
    log_success "Software encoding always available as fallback"
}

# Create sample systemd service
create_systemd_service() {
    log "Creating systemd service configuration..."
    
    local service_content="[Unit]
Description=RTSP-SSE Stream Manager
After=network.target
Wants=network.target

[Service]
Type=simple
User=$USER
Group=$USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$SCRIPT_DIR/rtsp-sse-stream.sh
ExecReload=/bin/kill -HUP \$MAINPID
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rtsp-sse-stream

# Security settings
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$HOME/streams $LOG_DIR

# Resource limits
LimitNOFILE=65536
LimitNPROC=4096

[Install]
WantedBy=multi-user.target"
    
    echo "$service_content" > "$SCRIPT_DIR/rtsp-sse-stream.service"
    log_success "Systemd service file created: rtsp-sse-stream.service"
    
    echo
    log "To install the systemd service, run:"
    echo "  sudo cp rtsp-sse-stream.service /etc/systemd/system/"
    echo "  sudo systemctl daemon-reload"
    echo "  sudo systemctl enable rtsp-sse-stream"
    echo "  sudo systemctl start rtsp-sse-stream"
}

# Generate startup script
generate_startup_script() {
    log "Generating startup script..."
    
    cat > "$SCRIPT_DIR/start-rtsp-sse.sh" << 'EOF'
#!/bin/bash

# RTSP-SSE Stream Startup Script
# Ubuntu Linux Edition

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Starting RTSP-SSE Stream Manager..."
echo "Script directory: $SCRIPT_DIR"
echo

# Check if already running
if [[ -f "/tmp/rtsp-sse-stream.pid" ]]; then
    local pid=$(cat "/tmp/rtsp-sse-stream.pid")
    if ps -p "$pid" > /dev/null 2>&1; then
        echo "RTSP-SSE Stream Manager is already running (PID: $pid)"
        exit 1
    else
        echo "Removing stale PID file"
        rm -f "/tmp/rtsp-sse-stream.pid"
    fi
fi

# Start the main script
cd "$SCRIPT_DIR"
./rtsp-sse-stream.sh
EOF
    
    chmod +x "$SCRIPT_DIR/start-rtsp-sse.sh"
    log_success "Startup script created: start-rtsp-sse.sh"
}

# Main setup function
main() {
    echo "======================================"
    echo "  RTSP-SSE Environment Setup"
    echo "  Ubuntu Linux Configuration"
    echo "======================================"
    echo
    
    check_main_script
    validate_dependencies
    create_config
    setup_directories
    test_network
    check_system_resources
    test_hardware_acceleration
    create_systemd_service
    generate_startup_script
    
    echo
    echo "======================================"
    log_success "Environment setup completed successfully!"
    echo
    echo "Configuration file: $CONFIG_FILE"
    echo "Log directory: $LOG_DIR"
    echo "Stream directory: $HOME/streams"
    echo
    echo "Next steps:"
    echo "1. Edit $CONFIG_FILE to match your setup"
    echo "2. Run: ./ubuntu-test.sh to test the system"
    echo "3. Run: ./start-rtsp-sse.sh to start streaming"
    echo "4. Check logs in: $LOG_DIR/rtsp-sse-stream.log"
    echo
}

# Run main function
main "$@"