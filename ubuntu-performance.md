# Performance Monitoring and Optimization Guide

This guide provides comprehensive performance monitoring and optimization strategies for the RTSP-SSE streaming system on Ubuntu Linux.

## Table of Contents

1. [Performance Monitoring Tools](#performance-monitoring-tools)
2. [System Resource Monitoring](#system-resource-monitoring)
3. [Network Performance Monitoring](#network-performance-monitoring)
4. [FFmpeg Optimization](#ffmpeg-optimization)
5. [Hardware Acceleration](#hardware-acceleration)
6. [Memory Optimization](#memory-optimization)
7. [CPU Optimization](#cpu-optimization)
8. [Storage Optimization](#storage-optimization)
9. [Network Optimization](#network-optimization)
10. [Automated Performance Scripts](#automated-performance-scripts)
11. [Performance Benchmarking](#performance-benchmarking)
12. [Scaling Strategies](#scaling-strategies)

## Performance Monitoring Tools

### Essential Monitoring Tools Installation

```bash
#!/bin/bash
# Install performance monitoring tools

sudo apt update
sudo apt install -y \
    htop \
    iotop \
    iftop \
    nload \
    bmon \
    sysstat \
    nethogs \
    dstat \
    glances \
    stress-ng \
    sysbench

# Install additional tools
sudo apt install -y \
    perf-tools-unstable \
    linux-tools-common \
    linux-tools-generic

echo "Performance monitoring tools installed successfully"
```

### Real-time Monitoring Dashboard

```bash
#!/bin/bash
# Create a comprehensive monitoring dashboard

cat > monitor-dashboard.sh << 'EOF'
#!/bin/bash

# Function to display system overview
show_system_overview() {
    clear
    echo "=== RTSP-SSE Streaming System Performance Dashboard ==="
    echo "Timestamp: $(date)"
    echo
    
    # System load
    echo "=== System Load ==="
    uptime
    echo
    
    # Memory usage
    echo "=== Memory Usage ==="
    free -h
    echo
    
    # CPU usage
    echo "=== CPU Usage (5 second average) ==="
    top -bn1 | grep "Cpu(s)" | awk '{print $2 $3 $4 $5 $6 $7 $8}'
    echo
    
    # Disk usage
    echo "=== Disk Usage ==="
    df -h | grep -E '^/dev/'
    echo
    
    # Network interfaces
    echo "=== Network Interfaces ==="
    ip -s link show | grep -E '^[0-9]+:|RX:|TX:' | head -20
    echo
    
    # Active RTSP/SSE processes
    echo "=== Active Streaming Processes ==="
    ps aux | grep -E '(ffmpeg|rtsp|sse|node)' | grep -v grep
    echo
    
    # Network connections
    echo "=== Active Network Connections ==="
    ss -tuln | grep -E ':(554|3000|1935)'
    echo
}

# Function to monitor FFmpeg performance
monitor_ffmpeg() {
    echo "=== FFmpeg Process Monitoring ==="
    
    # Find FFmpeg processes
    FFMPEG_PIDS=$(pgrep ffmpeg)
    
    if [ -n "$FFMPEG_PIDS" ]; then
        for pid in $FFMPEG_PIDS; do
            echo "FFmpeg PID: $pid"
            
            # CPU and memory usage
            ps -p $pid -o pid,ppid,cmd,%mem,%cpu,etime
            
            # File descriptors
            echo "Open file descriptors: $(ls /proc/$pid/fd 2>/dev/null | wc -l)"
            
            # Memory details
            if [ -f "/proc/$pid/status" ]; then
                grep -E "VmRSS|VmSize|VmPeak" /proc/$pid/status
            fi
            
            echo "---"
        done
    else
        echo "No FFmpeg processes found"
    fi
    echo
}

# Function to monitor network performance
monitor_network() {
    echo "=== Network Performance ==="
    
    # Interface statistics
    cat /proc/net/dev | grep -E '(eth|wlan|enp)' | while read line; do
        interface=$(echo $line | cut -d: -f1 | tr -d ' ')
        rx_bytes=$(echo $line | awk '{print $2}')
        tx_bytes=$(echo $line | awk '{print $10}')
        
        echo "$interface: RX=$(numfmt --to=iec $rx_bytes)B TX=$(numfmt --to=iec $tx_bytes)B"
    done
    
    # Connection states
    echo
    echo "TCP Connection States:"
    ss -s
    echo
}

# Main monitoring loop
if [ "$1" = "--continuous" ]; then
    while true; do
        show_system_overview
        monitor_ffmpeg
        monitor_network
        echo "Press Ctrl+C to stop monitoring"
        sleep 5
    done
else
    show_system_overview
    monitor_ffmpeg
    monitor_network
fi
EOF

chmod +x monitor-dashboard.sh
echo "Monitoring dashboard created: ./monitor-dashboard.sh"
```

## System Resource Monitoring

### CPU Monitoring

```bash
#!/bin/bash
# CPU performance monitoring script

cat > monitor-cpu.sh << 'EOF'
#!/bin/bash

echo "=== CPU Performance Monitoring ==="

# CPU information
echo "CPU Information:"
lscpu | grep -E "Model name|CPU\(s\)|Thread|Core|Socket"
echo

# Current CPU usage
echo "Current CPU Usage:"
top -bn1 | grep "Cpu(s)"
echo

# Per-core usage
echo "Per-Core CPU Usage:"
mpstat -P ALL 1 1 | grep -E "CPU|Average"
echo

# CPU frequency
echo "CPU Frequency:"
cat /proc/cpuinfo | grep "cpu MHz" | head -4
echo

# Load average
echo "Load Average:"
cat /proc/loadavg
echo

# Top CPU consuming processes
echo "Top CPU Consuming Processes:"
ps aux --sort=-%cpu | head -10
echo

# FFmpeg specific CPU usage
echo "FFmpeg CPU Usage:"
ps aux | grep ffmpeg | grep -v grep | awk '{print "PID: " $2 ", CPU: " $3 "%, MEM: " $4 "%, CMD: " $11}'
EOF

chmod +x monitor-cpu.sh
```

### Memory Monitoring

```bash
#!/bin/bash
# Memory performance monitoring script

cat > monitor-memory.sh << 'EOF'
#!/bin/bash

echo "=== Memory Performance Monitoring ==="

# Memory overview
echo "Memory Overview:"
free -h
echo

# Detailed memory information
echo "Detailed Memory Information:"
cat /proc/meminfo | grep -E "MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree"
echo

# Memory usage by process
echo "Top Memory Consuming Processes:"
ps aux --sort=-%mem | head -10
echo

# FFmpeg memory usage
echo "FFmpeg Memory Usage:"
ps aux | grep ffmpeg | grep -v grep | awk '{print "PID: " $2 ", MEM: " $4 "%, RSS: " $6 "KB, CMD: " $11}'
echo

# Memory fragmentation
echo "Memory Fragmentation:"
cat /proc/buddyinfo
echo

# Swap usage
echo "Swap Usage:"
cat /proc/swaps
echo

# Memory pressure (if available)
if [ -f "/proc/pressure/memory" ]; then
    echo "Memory Pressure:"
    cat /proc/pressure/memory
    echo
fi
EOF

chmod +x monitor-memory.sh
```

### Storage I/O Monitoring

```bash
#!/bin/bash
# Storage I/O monitoring script

cat > monitor-storage.sh << 'EOF'
#!/bin/bash

echo "=== Storage I/O Performance Monitoring ==="

# Disk usage
echo "Disk Usage:"
df -h
echo

# I/O statistics
echo "I/O Statistics:"
iostat -x 1 1
echo

# Per-process I/O
echo "Top I/O Processes:"
if command -v iotop >/dev/null 2>&1; then
    iotop -b -n 1 | head -15
else
    echo "iotop not available, install with: sudo apt install iotop"
fi
echo

# Disk I/O by device
echo "Disk I/O by Device:"
cat /proc/diskstats | awk '{print $3, $4, $8}' | column -t
echo

# File system performance
echo "File System Performance:"
for fs in $(df --output=target | grep -E '^/' | head -5); do
    echo "Testing $fs:"
    time dd if=/dev/zero of="$fs/test_file" bs=1M count=100 2>&1 | grep -E "copied|MB/s"
    rm -f "$fs/test_file"
done
EOF

chmod +x monitor-storage.sh
```

## Network Performance Monitoring

### Network Monitoring Script

```bash
#!/bin/bash
# Network performance monitoring script

cat > monitor-network.sh << 'EOF'
#!/bin/bash

echo "=== Network Performance Monitoring ==="

# Network interfaces
echo "Network Interfaces:"
ip addr show | grep -E "inet |mtu"
echo

# Network statistics
echo "Network Statistics:"
cat /proc/net/dev | column -t
echo

# Active connections
echo "Active Network Connections:"
ss -tuln | grep -E "LISTEN|ESTAB"
echo

# Bandwidth usage
echo "Bandwidth Usage (5 second sample):"
if command -v vnstat >/dev/null 2>&1; then
    vnstat -i eth0 -l
else
    echo "vnstat not available, showing interface stats:"
    cat /sys/class/net/*/statistics/rx_bytes | paste <(ls /sys/class/net/*/statistics/rx_bytes | cut -d/ -f5) -
fi
echo

# Network latency test
echo "Network Latency Test:"
ping -c 4 8.8.8.8 | tail -1
echo

# RTSP/SSE specific connections
echo "RTSP/SSE Connections:"
ss -tuln | grep -E ":(554|3000|1935)"
netstat -an | grep -E ":(554|3000|1935)" | wc -l | xargs echo "Total connections:"
echo

# Network errors
echo "Network Errors:"
cat /proc/net/dev | awk 'NR>2 {print $1, "RX_errors:", $4, "TX_errors:", $12}' | column -t
EOF

chmod +x monitor-network.sh
```

### Bandwidth Testing

```bash
#!/bin/bash
# Bandwidth testing script

cat > test-bandwidth.sh << 'EOF'
#!/bin/bash

echo "=== Network Bandwidth Testing ==="

# Internal bandwidth test
echo "Internal Bandwidth Test:"
dd if=/dev/zero bs=1M count=1000 2>&1 | grep "MB/s"
echo

# Network throughput test (requires iperf3)
if command -v iperf3 >/dev/null 2>&1; then
    echo "Network Throughput Test (requires iperf3 server):"
    echo "To test, run on server: iperf3 -s"
    echo "Then run: iperf3 -c SERVER_IP"
else
    echo "Install iperf3 for network throughput testing: sudo apt install iperf3"
fi
echo

# HTTP download speed test
echo "HTTP Download Speed Test:"
wget -O /dev/null http://speedtest.wdc01.softlayer.com/downloads/test100.zip 2>&1 | grep -E "MB/s|KB/s"
echo

# RTSP stream bandwidth test
echo "RTSP Stream Bandwidth Test:"
echo "Use: ffmpeg -i rtsp://source -t 10 -f null - 2>&1 | grep bitrate"
EOF

chmod +x test-bandwidth.sh
```

## FFmpeg Optimization

### FFmpeg Performance Tuning

```bash
#!/bin/bash
# FFmpeg optimization configuration

cat > optimize-ffmpeg.sh << 'EOF'
#!/bin/bash

echo "=== FFmpeg Optimization Guide ==="

# Test FFmpeg performance with different settings
test_ffmpeg_performance() {
    local input="$1"
    local output_base="$2"
    
    echo "Testing FFmpeg performance with input: $input"
    
    # Test different presets
    for preset in ultrafast superfast veryfast faster fast medium; do
        echo "Testing preset: $preset"
        output="${output_base}_${preset}.mp4"
        
        time ffmpeg -y -i "$input" -c:v libx264 -preset "$preset" -t 30 "$output" 2>&1 | \
            grep -E "frame=|fps=|bitrate=|time="
        
        if [ -f "$output" ]; then
            size=$(du -h "$output" | cut -f1)
            echo "Output size: $size"
            rm "$output"
        fi
        echo "---"
    done
}

# Hardware acceleration test
test_hardware_acceleration() {
    echo "Testing Hardware Acceleration:"
    
    # List available hardware accelerators
    echo "Available hardware accelerators:"
    ffmpeg -hwaccels
    echo
    
    # Test VAAPI (Intel)
    if [ -e /dev/dri/renderD128 ]; then
        echo "Testing VAAPI acceleration:"
        ffmpeg -vaapi_device /dev/dri/renderD128 -f lavfi -i testsrc=duration=10:size=1280x720:rate=30 \
            -vf 'format=nv12,hwupload' -c:v h264_vaapi -t 5 test_vaapi.mp4 2>&1 | \
            grep -E "frame=|fps="
        rm -f test_vaapi.mp4
    fi
    
    # Test NVENC (NVIDIA)
    if command -v nvidia-smi >/dev/null 2>&1; then
        echo "Testing NVENC acceleration:"
        ffmpeg -f lavfi -i testsrc=duration=10:size=1280x720:rate=30 \
            -c:v h264_nvenc -t 5 test_nvenc.mp4 2>&1 | \
            grep -E "frame=|fps="
        rm -f test_nvenc.mp4
    fi
}

# Optimal settings generator
generate_optimal_settings() {
    local cpu_cores=$(nproc)
    local total_mem=$(free -m | awk 'NR==2{print $2}')
    
    echo "Generating optimal FFmpeg settings:"
    echo "CPU Cores: $cpu_cores"
    echo "Total Memory: ${total_mem}MB"
    echo
    
    # Calculate optimal thread count
    local threads=$((cpu_cores - 1))
    [ $threads -lt 1 ] && threads=1
    
    # Calculate buffer size based on memory
    local buffer_size="1M"
    if [ $total_mem -lt 2048 ]; then
        buffer_size="512k"
    elif [ $total_mem -gt 8192 ]; then
        buffer_size="2M"
    fi
    
    echo "Recommended settings:"
    echo "THREADS=$threads"
    echo "BUFFER_SIZE=$buffer_size"
    echo "VIDEO_PRESET=fast"
    echo "VIDEO_TUNE=zerolatency"
    
    if [ $total_mem -lt 1024 ]; then
        echo "VIDEO_BITRATE=500k"
        echo "AUDIO_BITRATE=64k"
    elif [ $total_mem -lt 4096 ]; then
        echo "VIDEO_BITRATE=1M"
        echo "AUDIO_BITRATE=128k"
    else
        echo "VIDEO_BITRATE=2M"
        echo "AUDIO_BITRATE=192k"
    fi
}

# Main execution
case "$1" in
    "test")
        if [ -n "$2" ]; then
            test_ffmpeg_performance "$2" "test_output"
        else
            echo "Usage: $0 test <input_file>"
        fi
        ;;
    "hwaccel")
        test_hardware_acceleration
        ;;
    "settings")
        generate_optimal_settings
        ;;
    *)
        echo "Usage: $0 {test|hwaccel|settings}"
        echo "  test <input>  - Test different encoding presets"
        echo "  hwaccel       - Test hardware acceleration"
        echo "  settings      - Generate optimal settings"
        ;;
esac
EOF

chmod +x optimize-ffmpeg.sh
```

## Hardware Acceleration

### Hardware Acceleration Setup

```bash
#!/bin/bash
# Hardware acceleration setup script

cat > setup-hwaccel.sh << 'EOF'
#!/bin/bash

echo "=== Hardware Acceleration Setup ==="

# Detect hardware
detect_hardware() {
    echo "Detecting available hardware:"
    
    # CPU information
    echo "CPU: $(lscpu | grep 'Model name' | cut -d: -f2 | xargs)"
    
    # GPU detection
    if command -v lspci >/dev/null 2>&1; then
        echo "GPU(s):"
        lspci | grep -i vga
        lspci | grep -i nvidia
    fi
    
    # Check for Intel Quick Sync
    if lspci | grep -i intel | grep -i vga >/dev/null; then
        echo "Intel GPU detected - Quick Sync may be available"
    fi
    
    # Check for NVIDIA
    if lspci | grep -i nvidia >/dev/null; then
        echo "NVIDIA GPU detected"
        if command -v nvidia-smi >/dev/null 2>&1; then
            nvidia-smi --query-gpu=name,driver_version --format=csv,noheader
        fi
    fi
    
    # Check for AMD
    if lspci | grep -i amd | grep -i vga >/dev/null; then
        echo "AMD GPU detected"
    fi
    echo
}

# Setup Intel VAAPI
setup_intel_vaapi() {
    echo "Setting up Intel VAAPI:"
    
    # Install VAAPI drivers
    sudo apt install -y vainfo intel-media-va-driver-non-free
    
    # Check VAAPI status
    if command -v vainfo >/dev/null 2>&1; then
        echo "VAAPI Information:"
        vainfo
    fi
    
    # Set environment variables
    echo "export LIBVA_DRIVER_NAME=iHD" >> ~/.bashrc
    echo "export LIBVA_DRIVERS_PATH=/usr/lib/x86_64-linux-gnu/dri" >> ~/.bashrc
    
    echo "Intel VAAPI setup complete"
    echo
}

# Setup NVIDIA NVENC
setup_nvidia_nvenc() {
    echo "Setting up NVIDIA NVENC:"
    
    # Check if NVIDIA drivers are installed
    if ! command -v nvidia-smi >/dev/null 2>&1; then
        echo "Installing NVIDIA drivers..."
        sudo apt install -y nvidia-driver-470
        echo "Reboot required after NVIDIA driver installation"
    fi
    
    # Install CUDA toolkit (optional)
    echo "To install CUDA toolkit:"
    echo "wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2004/x86_64/cuda-ubuntu2004.pin"
    echo "sudo mv cuda-ubuntu2004.pin /etc/apt/preferences.d/cuda-repository-pin-600"
    echo "wget https://developer.download.nvidia.com/compute/cuda/11.4.0/local_installers/cuda-repo-ubuntu2004-11-4-local_11.4.0-470.42.01-1_amd64.deb"
    echo "sudo dpkg -i cuda-repo-ubuntu2004-11-4-local_11.4.0-470.42.01-1_amd64.deb"
    echo "sudo apt-key add /var/cuda-repo-ubuntu2004-11-4-local/7fa2af80.pub"
    echo "sudo apt update"
    echo "sudo apt install -y cuda"
    
    echo "NVIDIA NVENC setup instructions provided"
    echo
}

# Test hardware acceleration
test_acceleration() {
    echo "Testing hardware acceleration:"
    
    # Create test input
    ffmpeg -f lavfi -i testsrc=duration=10:size=1920x1080:rate=30 -t 5 test_input.mp4 2>/dev/null
    
    # Test software encoding
    echo "Testing software encoding:"
    time ffmpeg -y -i test_input.mp4 -c:v libx264 -preset fast test_sw.mp4 2>&1 | grep "frame="
    
    # Test VAAPI (Intel)
    if [ -e /dev/dri/renderD128 ]; then
        echo "Testing VAAPI encoding:"
        time ffmpeg -y -vaapi_device /dev/dri/renderD128 -i test_input.mp4 \
            -vf 'format=nv12,hwupload' -c:v h264_vaapi test_vaapi.mp4 2>&1 | grep "frame="
    fi
    
    # Test NVENC (NVIDIA)
    if command -v nvidia-smi >/dev/null 2>&1; then
        echo "Testing NVENC encoding:"
        time ffmpeg -y -i test_input.mp4 -c:v h264_nvenc test_nvenc.mp4 2>&1 | grep "frame="
    fi
    
    # Cleanup
    rm -f test_input.mp4 test_sw.mp4 test_vaapi.mp4 test_nvenc.mp4
    
    echo "Hardware acceleration testing complete"
}

# Main execution
case "$1" in
    "detect")
        detect_hardware
        ;;
    "intel")
        setup_intel_vaapi
        ;;
    "nvidia")
        setup_nvidia_nvenc
        ;;
    "test")
        test_acceleration
        ;;
    *)
        echo "Usage: $0 {detect|intel|nvidia|test}"
        echo "  detect  - Detect available hardware"
        echo "  intel   - Setup Intel VAAPI"
        echo "  nvidia  - Setup NVIDIA NVENC"
        echo "  test    - Test hardware acceleration"
        ;;
esac
EOF

chmod +x setup-hwaccel.sh
```

## Memory Optimization

### Memory Optimization Script

```bash
#!/bin/bash
# Memory optimization script

cat > optimize-memory.sh << 'EOF'
#!/bin/bash

echo "=== Memory Optimization ==="

# Current memory status
show_memory_status() {
    echo "Current Memory Status:"
    free -h
    echo
    
    echo "Memory Usage by Process:"
    ps aux --sort=-%mem | head -10
    echo
    
    echo "Swap Usage:"
    swapon --show
    echo
}

# Optimize system memory settings
optimize_system_memory() {
    echo "Optimizing system memory settings:"
    
    # Adjust swappiness
    echo "Setting swappiness to 10 (default: 60):"
    sudo sysctl vm.swappiness=10
    echo "vm.swappiness=10" | sudo tee -a /etc/sysctl.conf
    
    # Adjust cache pressure
    echo "Setting vfs_cache_pressure to 50 (default: 100):"
    sudo sysctl vm.vfs_cache_pressure=50
    echo "vm.vfs_cache_pressure=50" | sudo tee -a /etc/sysctl.conf
    
    # Adjust dirty ratio
    echo "Setting dirty_ratio to 15 (default: 20):"
    sudo sysctl vm.dirty_ratio=15
    echo "vm.dirty_ratio=15" | sudo tee -a /etc/sysctl.conf
    
    echo "Memory optimization applied"
    echo
}

# Setup swap file
setup_swap() {
    local swap_size="$1"
    [ -z "$swap_size" ] && swap_size="2G"
    
    echo "Setting up ${swap_size} swap file:"
    
    # Check if swap already exists
    if swapon --show | grep -q "/swapfile"; then
        echo "Swap file already exists"
        return
    fi
    
    # Create swap file
    sudo fallocate -l "$swap_size" /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    
    # Make permanent
    if ! grep -q "/swapfile" /etc/fstab; then
        echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab
    fi
    
    echo "Swap file setup complete"
    echo
}

# Memory cleanup
cleanup_memory() {
    echo "Cleaning up memory:"
    
    # Clear page cache
    echo "Clearing page cache:"
    sudo sync
    echo 1 | sudo tee /proc/sys/vm/drop_caches
    
    # Clear dentries and inodes
    echo "Clearing dentries and inodes:"
    echo 2 | sudo tee /proc/sys/vm/drop_caches
    
    # Clear all caches
    echo "Clearing all caches:"
    echo 3 | sudo tee /proc/sys/vm/drop_caches
    
    echo "Memory cleanup complete"
    echo
}

# Monitor memory usage
monitor_memory_usage() {
    echo "Monitoring memory usage (press Ctrl+C to stop):"
    
    while true; do
        clear
        echo "=== Memory Usage Monitor ==="
        date
        echo
        
        free -h
        echo
        
        echo "Top Memory Consumers:"
        ps aux --sort=-%mem | head -5
        echo
        
        echo "FFmpeg Memory Usage:"
        ps aux | grep ffmpeg | grep -v grep | awk '{print "PID: " $2 ", MEM: " $4 "%, RSS: " $6 "KB"}'
        echo
        
        sleep 2
    done
}

# Generate memory optimization config
generate_memory_config() {
    local total_mem=$(free -m | awk 'NR==2{print $2}')
    
    echo "Generating memory optimization configuration:"
    echo "Total Memory: ${total_mem}MB"
    echo
    
    # Calculate optimal buffer sizes
    if [ $total_mem -lt 1024 ]; then
        echo "# Low memory system (<1GB)"
        echo "BUFFER_SIZE=256k"
        echo "MAX_MUXING_QUEUE_SIZE=1024"
        echo "THREADS=1"
    elif [ $total_mem -lt 2048 ]; then
        echo "# Medium memory system (1-2GB)"
        echo "BUFFER_SIZE=512k"
        echo "MAX_MUXING_QUEUE_SIZE=2048"
        echo "THREADS=2"
    elif [ $total_mem -lt 4096 ]; then
        echo "# Good memory system (2-4GB)"
        echo "BUFFER_SIZE=1M"
        echo "MAX_MUXING_QUEUE_SIZE=4096"
        echo "THREADS=4"
    else
        echo "# High memory system (>4GB)"
        echo "BUFFER_SIZE=2M"
        echo "MAX_MUXING_QUEUE_SIZE=8192"
        echo "THREADS=8"
    fi
    
    echo
    echo "Recommended FFmpeg options:"
    echo "-max_muxing_queue_size \$MAX_MUXING_QUEUE_SIZE"
    echo "-threads \$THREADS"
    echo "-bufsize \$BUFFER_SIZE"
}

# Main execution
case "$1" in
    "status")
        show_memory_status
        ;;
    "optimize")
        optimize_system_memory
        ;;
    "swap")
        setup_swap "$2"
        ;;
    "cleanup")
        cleanup_memory
        ;;
    "monitor")
        monitor_memory_usage
        ;;
    "config")
        generate_memory_config
        ;;
    *)
        echo "Usage: $0 {status|optimize|swap|cleanup|monitor|config}"
        echo "  status   - Show current memory status"
        echo "  optimize - Apply memory optimizations"
        echo "  swap     - Setup swap file (optional size, default 2G)"
        echo "  cleanup  - Clean memory caches"
        echo "  monitor  - Monitor memory usage"
        echo "  config   - Generate memory optimization config"
        ;;
esac
EOF

chmod +x optimize-memory.sh
```

## CPU Optimization

### CPU Optimization Script

```bash
#!/bin/bash
# CPU optimization script

cat > optimize-cpu.sh << 'EOF'
#!/bin/bash

echo "=== CPU Optimization ==="

# Show CPU information
show_cpu_info() {
    echo "CPU Information:"
    lscpu
    echo
    
    echo "Current CPU Governor:"
    cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor 2>/dev/null | sort | uniq -c
    echo
    
    echo "CPU Frequencies:"
    cat /proc/cpuinfo | grep "cpu MHz" | head -4
    echo
    
    echo "Load Average:"
    cat /proc/loadavg
    echo
}

# Set CPU governor
set_cpu_governor() {
    local governor="$1"
    [ -z "$governor" ] && governor="performance"
    
    echo "Setting CPU governor to: $governor"
    
    # Install cpufrequtils if not available
    if ! command -v cpufreq-set >/dev/null 2>&1; then
        sudo apt install -y cpufrequtils
    fi
    
    # Set governor for all CPUs
    for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
        if [ -w "$cpu" ]; then
            echo "$governor" | sudo tee "$cpu"
        fi
    done
    
    echo "CPU governor set to: $governor"
    echo
}

# Optimize CPU for streaming
optimize_for_streaming() {
    echo "Optimizing CPU for streaming:"
    
    # Set performance governor
    set_cpu_governor "performance"
    
    # Disable CPU idle states (if needed)
    echo "Disabling deep CPU sleep states:"
    sudo cpupower idle-set -D 2 2>/dev/null || echo "cpupower not available"
    
    # Set CPU affinity for critical processes
    echo "Setting CPU affinity for streaming processes:"
    
    # Find FFmpeg processes and set affinity
    for pid in $(pgrep ffmpeg); do
        echo "Setting CPU affinity for FFmpeg PID: $pid"
        taskset -cp 0-$(($(nproc)-1)) $pid 2>/dev/null || true
    done
    
    echo "CPU optimization for streaming complete"
    echo
}

# Monitor CPU performance
monitor_cpu_performance() {
    echo "Monitoring CPU performance (press Ctrl+C to stop):"
    
    while true; do
        clear
        echo "=== CPU Performance Monitor ==="
        date
        echo
        
        # Overall CPU usage
        top -bn1 | grep "Cpu(s)" | awk '{print "CPU Usage: " $2 " user, " $4 " system, " $8 " idle"}'
        echo
        
        # Load average
        echo "Load Average: $(cat /proc/loadavg | cut -d' ' -f1-3)"
        echo
        
        # Per-core usage
        echo "Per-Core Usage:"
        mpstat -P ALL 1 1 | grep "Average" | grep -v "all"
        echo
        
        # Top CPU processes
        echo "Top CPU Processes:"
        ps aux --sort=-%cpu | head -5 | awk '{print $2, $3, $11}'
        echo
        
        # FFmpeg specific
        echo "FFmpeg CPU Usage:"
        ps aux | grep ffmpeg | grep -v grep | awk '{print "PID: " $2 ", CPU: " $3 "%"}'
        echo
        
        sleep 2
    done
}

# Generate CPU optimization config
generate_cpu_config() {
    local cpu_cores=$(nproc)
    local cpu_threads=$(lscpu | grep "Thread(s) per core" | awk '{print $4}')
    local total_threads=$((cpu_cores * cpu_threads))
    
    echo "Generating CPU optimization configuration:"
    echo "CPU Cores: $cpu_cores"
    echo "Threads per Core: $cpu_threads"
    echo "Total Threads: $total_threads"
    echo
    
    # Calculate optimal thread allocation
    local ffmpeg_threads=$((total_threads - 1))
    [ $ffmpeg_threads -lt 1 ] && ffmpeg_threads=1
    [ $ffmpeg_threads -gt 16 ] && ffmpeg_threads=16
    
    echo "Recommended settings:"
    echo "FFMPEG_THREADS=$ffmpeg_threads"
    echo "CPU_GOVERNOR=performance"
    
    # Encoding preset based on CPU power
    if [ $total_threads -ge 8 ]; then
        echo "VIDEO_PRESET=medium"
    elif [ $total_threads -ge 4 ]; then
        echo "VIDEO_PRESET=fast"
    else
        echo "VIDEO_PRESET=ultrafast"
    fi
    
    echo
    echo "FFmpeg command line options:"
    echo "-threads $ffmpeg_threads"
    echo "-preset \$VIDEO_PRESET"
    echo "-tune zerolatency"
}

# Stress test CPU
stress_test_cpu() {
    local duration="$1"
    [ -z "$duration" ] && duration="60"
    
    echo "Running CPU stress test for ${duration} seconds:"
    
    # Install stress-ng if not available
    if ! command -v stress-ng >/dev/null 2>&1; then
        sudo apt install -y stress-ng
    fi
    
    # Run stress test
    stress-ng --cpu $(nproc) --timeout ${duration}s --metrics-brief
    
    echo "CPU stress test complete"
}

# Main execution
case "$1" in
    "info")
        show_cpu_info
        ;;
    "governor")
        set_cpu_governor "$2"
        ;;
    "optimize")
        optimize_for_streaming
        ;;
    "monitor")
        monitor_cpu_performance
        ;;
    "config")
        generate_cpu_config
        ;;
    "stress")
        stress_test_cpu "$2"
        ;;
    *)
        echo "Usage: $0 {info|governor|optimize|monitor|config|stress}"
        echo "  info      - Show CPU information"
        echo "  governor  - Set CPU governor (performance|powersave|ondemand)"
        echo "  optimize  - Optimize CPU for streaming"
        echo "  monitor   - Monitor CPU performance"
        echo "  config    - Generate CPU optimization config"
        echo "  stress    - Run CPU stress test (optional duration in seconds)"
        ;;
esac
EOF

chmod +x optimize-cpu.sh
```

## Automated Performance Scripts

### Complete Performance Optimization

```bash
#!/bin/bash
# Complete performance optimization script

cat > optimize-all.sh << 'EOF'
#!/bin/bash

echo "=== Complete RTSP-SSE Performance Optimization ==="

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo "Warning: Running as root. Some optimizations may not be necessary."
fi

# System information
echo "System Information:"
echo "OS: $(lsb_release -d | cut -f2)"
echo "Kernel: $(uname -r)"
echo "CPU: $(lscpu | grep 'Model name' | cut -d: -f2 | xargs)"
echo "Memory: $(free -h | awk 'NR==2{print $2}')"
echo "Disk: $(df -h / | awk 'NR==2{print $2}')"
echo

# 1. Update system
echo "1. Updating system packages..."
sudo apt update && sudo apt upgrade -y
echo

# 2. Install performance tools
echo "2. Installing performance monitoring tools..."
sudo apt install -y htop iotop iftop nload sysstat nethogs dstat glances
echo

# 3. Optimize memory
echo "3. Optimizing memory settings..."
sudo sysctl vm.swappiness=10
sudo sysctl vm.vfs_cache_pressure=50
sudo sysctl vm.dirty_ratio=15
echo "vm.swappiness=10" | sudo tee -a /etc/sysctl.conf
echo "vm.vfs_cache_pressure=50" | sudo tee -a /etc/sysctl.conf
echo "vm.dirty_ratio=15" | sudo tee -a /etc/sysctl.conf
echo

# 4. Optimize CPU
echo "4. Optimizing CPU settings..."
if command -v cpufreq-set >/dev/null 2>&1; then
    for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
        if [ -w "$cpu" ]; then
            echo "performance" | sudo tee "$cpu"
        fi
    done
else
    sudo apt install -y cpufrequtils
fi
echo

# 5. Optimize network
echo "5. Optimizing network settings..."
sudo sysctl net.core.rmem_max=134217728
sudo sysctl net.core.wmem_max=134217728
sudo sysctl net.ipv4.tcp_rmem="4096 87380 134217728"
sudo sysctl net.ipv4.tcp_wmem="4096 65536 134217728"
echo "net.core.rmem_max=134217728" | sudo tee -a /etc/sysctl.conf
echo "net.core.wmem_max=134217728" | sudo tee -a /etc/sysctl.conf
echo "net.ipv4.tcp_rmem=4096 87380 134217728" | sudo tee -a /etc/sysctl.conf
echo "net.ipv4.tcp_wmem=4096 65536 134217728" | sudo tee -a /etc/sysctl.conf
echo

# 6. Setup swap if needed
echo "6. Checking swap configuration..."
if ! swapon --show | grep -q "/swapfile"; then
    echo "Creating 2GB swap file..."
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab
else
    echo "Swap already configured"
fi
echo

# 7. Optimize for streaming
echo "7. Applying streaming-specific optimizations..."
# Increase file descriptor limits
echo "* soft nofile 65536" | sudo tee -a /etc/security/limits.conf
echo "* hard nofile 65536" | sudo tee -a /etc/security/limits.conf

# Optimize scheduler
echo "mq-deadline" | sudo tee /sys/block/*/queue/scheduler 2>/dev/null || true
echo

# 8. Generate optimized configuration
echo "8. Generating optimized configuration..."
cat > rtsp-sse-optimized.conf << 'CONF'
# Optimized RTSP-SSE Configuration
# Generated by performance optimization script

# System resources
CPU_CORES=$(nproc)
TOTAL_MEMORY=$(free -m | awk 'NR==2{print $2}')

# FFmpeg optimization
FFMPEG_THREADS=$((CPU_CORES - 1))
[ $FFMPEG_THREADS -lt 1 ] && FFMPEG_THREADS=1

# Memory-based settings
if [ $TOTAL_MEMORY -lt 1024 ]; then
    BUFFER_SIZE="256k"
    VIDEO_BITRATE="500k"
    AUDIO_BITRATE="64k"
    VIDEO_PRESET="ultrafast"
elif [ $TOTAL_MEMORY -lt 2048 ]; then
    BUFFER_SIZE="512k"
    VIDEO_BITRATE="1M"
    AUDIO_BITRATE="128k"
    VIDEO_PRESET="veryfast"
elif [ $TOTAL_MEMORY -lt 4096 ]; then
    BUFFER_SIZE="1M"
    VIDEO_BITRATE="2M"
    AUDIO_BITRATE="192k"
    VIDEO_PRESET="fast"
else
    BUFFER_SIZE="2M"
    VIDEO_BITRATE="3M"
    AUDIO_BITRATE="256k"
    VIDEO_PRESET="medium"
fi

# Network optimization
TCP_BUFFER_SIZE="1M"
MAX_MUXING_QUEUE_SIZE="4096"

# Streaming settings
VIDEO_TUNE="zerolatency"
KEYINT="60"
SCENECUT="0"

echo "Optimized configuration generated: rtsp-sse-optimized.conf"
CONF
echo

# 9. Create monitoring script
echo "9. Creating performance monitoring script..."
cat > monitor-performance.sh << 'MONITOR'
#!/bin/bash
# Performance monitoring for RTSP-SSE streaming

while true; do
    clear
    echo "=== RTSP-SSE Performance Monitor ==="
    date
    echo
    
    # System load
    echo "Load Average: $(cat /proc/loadavg | cut -d' ' -f1-3)"
    
    # Memory usage
    echo "Memory: $(free -h | awk 'NR==2{printf "Used: %s/%s (%.1f%%)", $3, $2, $3/$2*100}')"
    
    # CPU usage
    echo "CPU: $(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)% used"
    
    # Network
    echo "Network: $(cat /proc/net/dev | awk 'NR>2 {rx+=$2; tx+=$10} END {printf "RX: %.1fMB TX: %.1fMB", rx/1024/1024, tx/1024/1024}')"
    
    # Active processes
    echo
    echo "Active Streaming Processes:"
    ps aux | grep -E '(ffmpeg|rtsp|sse)' | grep -v grep | awk '{printf "%-8s %5s %5s %s\n", $2, $3"%", $4"%", $11}'
    
    echo
    echo "Press Ctrl+C to stop monitoring"
    sleep 5
done
MONITOR

chmod +x monitor-performance.sh
echo

echo "=== Performance Optimization Complete ==="
echo "Generated files:"
echo "  - rtsp-sse-optimized.conf (optimized configuration)"
echo "  - monitor-performance.sh (performance monitoring)"
echo
echo "Next steps:"
echo "1. Reboot system to apply all optimizations"
echo "2. Use optimized configuration in your streaming setup"
echo "3. Run ./monitor-performance.sh to monitor performance"
echo "4. Test streaming performance with your RTSP sources"
EOF

chmod +x optimize-all.sh
```

## Performance Benchmarking

### Benchmarking Script

```bash
#!/bin/bash
# Performance benchmarking script

cat > benchmark-performance.sh << 'EOF'
#!/bin/bash

echo "=== RTSP-SSE Performance Benchmark ==="

# Create benchmark results directory
mkdir -p benchmark_results
BENCH_DIR="benchmark_results/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BENCH_DIR"

echo "Benchmark results will be saved to: $BENCH_DIR"
echo

# System information
echo "Collecting system information..."
cat > "$BENCH_DIR/system_info.txt" << INFO
System Information - $(date)
================================

OS: $(lsb_release -d | cut -f2)
Kernel: $(uname -r)
CPU: $(lscpu | grep 'Model name' | cut -d: -f2 | xargs)
CPU Cores: $(nproc)
Memory: $(free -h | awk 'NR==2{print $2}')
Disk: $(df -h / | awk 'NR==2{print $2 " (" $5 " used)"}')

CPU Details:
$(lscpu)

Memory Details:
$(free -h)

Disk Details:
$(df -h)

Network Interfaces:
$(ip addr show)
INFO

# CPU benchmark
echo "Running CPU benchmark..."
if command -v sysbench >/dev/null 2>&1; then
    echo "CPU Benchmark (sysbench):" > "$BENCH_DIR/cpu_benchmark.txt"
    sysbench cpu --threads=$(nproc) run >> "$BENCH_DIR/cpu_benchmark.txt" 2>&1
else
    echo "Installing sysbench..."
    sudo apt install -y sysbench
    echo "CPU Benchmark (sysbench):" > "$BENCH_DIR/cpu_benchmark.txt"
    sysbench cpu --threads=$(nproc) run >> "$BENCH_DIR/cpu_benchmark.txt" 2>&1
fi

# Memory benchmark
echo "Running memory benchmark..."
echo "Memory Benchmark (sysbench):" > "$BENCH_DIR/memory_benchmark.txt"
sysbench memory --threads=$(nproc) run >> "$BENCH_DIR/memory_benchmark.txt" 2>&1

# Disk I/O benchmark
echo "Running disk I/O benchmark..."
echo "Disk I/O Benchmark:" > "$BENCH_DIR/disk_benchmark.txt"
dd if=/dev/zero of="$BENCH_DIR/test_file" bs=1M count=1000 2>&1 | grep -E "copied|MB/s" >> "$BENCH_DIR/disk_benchmark.txt"
rm -f "$BENCH_DIR/test_file"

# Network benchmark (internal)
echo "Running network benchmark..."
echo "Network Benchmark (internal):" > "$BENCH_DIR/network_benchmark.txt"
iperf3 -s -D -p 5201 2>/dev/null
sleep 2
iperf3 -c localhost -p 5201 -t 10 >> "$BENCH_DIR/network_benchmark.txt" 2>&1
pkill iperf3

# FFmpeg encoding benchmark
echo "Running FFmpeg encoding benchmark..."
echo "FFmpeg Encoding Benchmark:" > "$BENCH_DIR/ffmpeg_benchmark.txt"

# Create test video
ffmpeg -f lavfi -i testsrc=duration=60:size=1920x1080:rate=30 -pix_fmt yuv420p test_input.mp4 2>/dev/null

# Test different presets
for preset in ultrafast superfast veryfast faster fast medium; do
    echo "Testing preset: $preset" >> "$BENCH_DIR/ffmpeg_benchmark.txt"
    
    start_time=$(date +%s.%N)
    ffmpeg -y -i test_input.mp4 -c:v libx264 -preset "$preset" -t 30 "test_${preset}.mp4" 2>&1 | \
        grep -E "frame=|fps=|bitrate=" >> "$BENCH_DIR/ffmpeg_benchmark.txt"
    end_time=$(date +%s.%N)
    
    duration=$(echo "$end_time - $start_time" | bc)
    echo "Encoding time: ${duration}s" >> "$BENCH_DIR/ffmpeg_benchmark.txt"
    
    if [ -f "test_${preset}.mp4" ]; then
        size=$(du -h "test_${preset}.mp4" | cut -f1)
        echo "Output size: $size" >> "$BENCH_DIR/ffmpeg_benchmark.txt"
        rm "test_${preset}.mp4"
    fi
    
    echo "---" >> "$BENCH_DIR/ffmpeg_benchmark.txt"
done

rm -f test_input.mp4

# Hardware acceleration test
echo "Testing hardware acceleration..."
echo "Hardware Acceleration Test:" > "$BENCH_DIR/hwaccel_benchmark.txt"

# List available accelerators
echo "Available hardware accelerators:" >> "$BENCH_DIR/hwaccel_benchmark.txt"
ffmpeg -hwaccels >> "$BENCH_DIR/hwaccel_benchmark.txt" 2>&1
echo >> "$BENCH_DIR/hwaccel_benchmark.txt"

# Test VAAPI if available
if [ -e /dev/dri/renderD128 ]; then
    echo "Testing VAAPI acceleration:" >> "$BENCH_DIR/hwaccel_benchmark.txt"
    ffmpeg -f lavfi -i testsrc=duration=30:size=1920x1080:rate=30 \
        -vaapi_device /dev/dri/renderD128 -vf 'format=nv12,hwupload' \
        -c:v h264_vaapi -t 10 test_vaapi.mp4 2>&1 | \
        grep -E "frame=|fps=" >> "$BENCH_DIR/hwaccel_benchmark.txt"
    rm -f test_vaapi.mp4
fi

# Test NVENC if available
if command -v nvidia-smi >/dev/null 2>&1; then
    echo "Testing NVENC acceleration:" >> "$BENCH_DIR/hwaccel_benchmark.txt"
    ffmpeg -f lavfi -i testsrc=duration=30:size=1920x1080:rate=30 \
        -c:v h264_nvenc -t 10 test_nvenc.mp4 2>&1 | \
        grep -E "frame=|fps=" >> "$BENCH_DIR/hwaccel_benchmark.txt"
    rm -f test_nvenc.mp4
fi

# Streaming simulation test
echo "Running streaming simulation..."
echo "Streaming Simulation Test:" > "$BENCH_DIR/streaming_benchmark.txt"

# Start mock RTSP server
if [ -f "mock-rtsp-server.sh" ]; then
    ./mock-rtsp-server.sh start
    sleep 5
    
    # Test RTSP to SSE conversion
    echo "Testing RTSP to SSE conversion:" >> "$BENCH_DIR/streaming_benchmark.txt"
    timeout 30 ffmpeg -i rtsp://localhost:8554/test -f mpegts -c:v libx264 -preset fast \
        -tune zerolatency -c:a aac -b:v 1M -b:a 128k - 2>&1 | \
        grep -E "frame=|fps=|bitrate=" >> "$BENCH_DIR/streaming_benchmark.txt"
    
    ./mock-rtsp-server.sh stop
fi

# Generate summary report
echo "Generating summary report..."
cat > "$BENCH_DIR/summary_report.txt" << SUMMARY
RTSP-SSE Performance Benchmark Summary
=====================================
Date: $(date)
System: $(lsb_release -d | cut -f2)
CPU: $(lscpu | grep 'Model name' | cut -d: -f2 | xargs)
Memory: $(free -h | awk 'NR==2{print $2}')

Benchmark Results:

1. CPU Performance:
$(grep "events per second" "$BENCH_DIR/cpu_benchmark.txt" | tail -1)

2. Memory Performance:
$(grep "MiB/sec" "$BENCH_DIR/memory_benchmark.txt" | tail -1)

3. Disk I/O Performance:
$(grep "MB/s" "$BENCH_DIR/disk_benchmark.txt")

4. Network Performance:
$(grep "Mbits/sec" "$BENCH_DIR/network_benchmark.txt" | tail -1)

5. FFmpeg Encoding Performance:
Best performing preset: $(grep -B1 "fps=" "$BENCH_DIR/ffmpeg_benchmark.txt" | grep "Testing" | head -1 | cut -d: -f2)

6. Hardware Acceleration:
$(if [ -e /dev/dri/renderD128 ]; then echo "VAAPI: Available"; else echo "VAAPI: Not available"; fi)
$(if command -v nvidia-smi >/dev/null 2>&1; then echo "NVENC: Available"; else echo "NVENC: Not available"; fi)

Recommendations:
- Use $(if [ $(free -m | awk 'NR==2{print $2}') -lt 2048 ]; then echo "ultrafast"; elif [ $(free -m | awk 'NR==2{print $2}') -lt 4096 ]; then echo "veryfast"; else echo "fast"; fi) preset for optimal performance
- Allocate $(if [ $(free -m | awk 'NR==2{print $2}') -lt 2048 ]; then echo "1-2"; elif [ $(free -m | awk 'NR==2{print $2}') -lt 4096 ]; then echo "2-4"; else echo "4-8"; fi) threads for FFmpeg
- Use $(if [ $(free -m | awk 'NR==2{print $2}') -lt 1024 ]; then echo "512k"; elif [ $(free -m | awk 'NR==2{print $2}') -lt 4096 ]; then echo "1M"; else echo "2M"; fi) buffer size
SUMMARY

echo "=== Benchmark Complete ==="
echo "Results saved to: $BENCH_DIR"
echo "Summary report: $BENCH_DIR/summary_report.txt"
echo
echo "View summary:"
cat "$BENCH_DIR/summary_report.txt"
EOF

chmod +x benchmark-performance.sh
```

This comprehensive performance monitoring and optimization guide provides:

1. **Monitoring Tools**: Installation and setup of essential performance monitoring tools
2. **System Resource Monitoring**: Scripts for CPU, memory, storage, and network monitoring
3. **FFmpeg Optimization**: Performance tuning and hardware acceleration setup
4. **Memory Optimization**: Memory management and optimization strategies
5. **CPU Optimization**: CPU governor settings and performance tuning
6. **Automated Scripts**: Complete optimization and monitoring automation
7. **Benchmarking**: Comprehensive performance testing and reporting

All scripts are designed to work specifically on Ubuntu Linux and provide detailed performance insights for the RTSP-SSE streaming system.