# Ubuntu Troubleshooting Guide for RTSP-SSE Streaming System

This guide covers common issues and solutions when running the RTSP-SSE streaming script on Ubuntu Linux, particularly in VM environments.

## Table of Contents

1. [Installation Issues](#installation-issues)
2. [Configuration Problems](#configuration-problems)
3. [Network and Connectivity Issues](#network-and-connectivity-issues)
4. [Performance Problems](#performance-problems)
5. [VM-Specific Issues](#vm-specific-issues)
6. [FFmpeg Issues](#ffmpeg-issues)
7. [Permission and Security Issues](#permission-and-security-issues)
8. [Service and Process Issues](#service-and-process-issues)
9. [Debugging Tools and Commands](#debugging-tools-and-commands)
10. [Common Error Messages](#common-error-messages)

## Installation Issues

### FFmpeg Installation Problems

**Problem**: FFmpeg not found or missing codecs
```bash
ffmpeg: command not found
# or
Unknown encoder 'libx264'
```

**Solutions**:
```bash
# Update package list
sudo apt update

# Install FFmpeg with all codecs
sudo apt install -y ffmpeg

# For older Ubuntu versions, add universe repository
sudo add-apt-repository universe
sudo apt update
sudo apt install -y ffmpeg

# Verify installation
ffmpeg -version
ffmpeg -encoders | grep libx264
```

**Alternative**: Build FFmpeg from source if needed:
```bash
# Install build dependencies
sudo apt install -y build-essential yasm cmake libtool libc6 libc6-dev unzip wget libnuma1 libnuma-dev

# Download and build (example for basic build)
wget https://ffmpeg.org/releases/ffmpeg-4.4.tar.xz
tar -xf ffmpeg-4.4.tar.xz
cd ffmpeg-4.4
./configure --enable-gpl --enable-libx264
make -j$(nproc)
sudo make install
```

### Node.js Installation Issues

**Problem**: Node.js version conflicts or missing

**Solutions**:
```bash
# Install Node.js via NodeSource repository
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version
npm --version

# Alternative: Use snap
sudo snap install node --classic
```

### Missing System Dependencies

**Problem**: Various system tools missing

**Solution**:
```bash
# Install essential tools
sudo apt install -y curl wget git build-essential software-properties-common
sudo apt install -y net-tools iproute2 procps htop
```

## Configuration Problems

### Configuration File Not Found

**Problem**: `rtsp-sse-stream.conf` not found or invalid paths

**Solutions**:
```bash
# Check current directory
pwd
ls -la rtsp-sse-stream.conf

# Create default configuration if missing
cp rtsp-sse-stream.conf.example rtsp-sse-stream.conf

# Fix path issues in script
sed -i 's|~/|'$HOME'/|g' rtsp-sse-stream.sh
```

### Invalid Configuration Values

**Problem**: Configuration validation fails

**Debug steps**:
```bash
# Check configuration syntax
bash -n rtsp-sse-stream.sh

# Validate configuration file
./ubuntu-setup.sh validate-config

# Check for hidden characters
cat -A rtsp-sse-stream.conf
```

**Common fixes**:
```bash
# Remove Windows line endings
sed -i 's/\r$//' rtsp-sse-stream.conf

# Fix quotes and escaping
sed -i 's/"/\"/g' rtsp-sse-stream.conf
```

## Network and Connectivity Issues

### RTSP Connection Failures

**Problem**: Cannot connect to RTSP source
```
Connection to tcp://192.168.1.100:554 failed
```

**Debugging steps**:
```bash
# Test network connectivity
ping 192.168.1.100

# Test port connectivity
telnet 192.168.1.100 554
# or
nc -zv 192.168.1.100 554

# Check firewall
sudo ufw status
sudo iptables -L

# Test with FFmpeg directly
ffmpeg -i rtsp://192.168.1.100:554/stream -t 5 -f null -
```

**Solutions**:
```bash
# Configure firewall
sudo ufw allow out 554
sudo ufw allow out 1935

# For VM environments, check NAT/bridge settings
# Ensure VM network adapter is in bridge mode for external access
```

### SSE Server Connection Issues

**Problem**: Cannot reach SSE server

**Debugging**:
```bash
# Test SSE server locally
curl -v http://localhost:3000/health

# Test from external machine
curl -v http://VM_IP:3000/health

# Check if service is listening
sudo netstat -tlnp | grep :3000
# or
sudo ss -tlnp | grep :3000
```

**Solutions**:
```bash
# Ensure SSE server binds to all interfaces
export SSE_HOST="0.0.0.0"
./mock-sse-server.sh start

# Configure firewall
sudo ufw allow 3000
```

### DNS Resolution Issues

**Problem**: Cannot resolve hostnames

**Solutions**:
```bash
# Check DNS configuration
cat /etc/resolv.conf

# Test DNS resolution
nslookup google.com
dig google.com

# Use IP addresses instead of hostnames in configuration
# Replace camera.local with actual IP address
```

## Performance Problems

### High CPU Usage

**Problem**: FFmpeg consuming too much CPU

**Solutions**:
```bash
# Use hardware acceleration if available
ffmpeg -hwaccels  # List available hardware accelerators

# For Intel systems
ffmpeg -vaapi_device /dev/dri/renderD128 -i input -vf 'format=nv12,hwupload' -c:v h264_vaapi output

# Reduce encoding quality/bitrate
# Edit rtsp-sse-stream.conf:
VIDEO_BITRATE="1M"  # Reduce from 2M
VIDEO_PRESET="ultrafast"  # Use fastest preset
```

### Memory Issues

**Problem**: Out of memory errors

**Debugging**:
```bash
# Monitor memory usage
free -h
top -p $(pgrep ffmpeg)

# Check swap usage
swapon --show
```

**Solutions**:
```bash
# Add swap space
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Reduce buffer sizes in configuration
BUFFER_SIZE="512k"  # Reduce from 1M
```

### Network Bandwidth Issues

**Problem**: Stream stuttering or dropping

**Solutions**:
```bash
# Monitor network usage
iftop
# or
nload

# Reduce bitrate
VIDEO_BITRATE="500k"
AUDIO_BITRATE="64k"

# Use adaptive bitrate
ffmpeg -i input -b:v 1M -maxrate 1.5M -bufsize 2M output
```

## VM-Specific Issues

### Hardware Acceleration Not Available

**Problem**: No GPU acceleration in VM

**Solutions**:
```bash
# Check available devices
ls -la /dev/dri/

# For VirtualBox, enable 3D acceleration
# VM Settings > Display > Enable 3D Acceleration

# For VMware, install VMware Tools
sudo apt install open-vm-tools

# Use software encoding with optimized settings
VIDEO_PRESET="ultrafast"
VIDEO_TUNE="zerolatency"
```

### Shared Folder Issues

**Problem**: Cannot access shared folders

**Solutions**:
```bash
# For VirtualBox
sudo usermod -a -G vboxsf $USER
# Logout and login again

# For VMware
sudo mount -t fuse.vmhgfs-fuse .host:/ /mnt/hgfs -o allow_other
```

### Clock Synchronization

**Problem**: Time drift causing timestamp issues

**Solutions**:
```bash
# Install and configure NTP
sudo apt install ntp
sudo systemctl enable ntp
sudo systemctl start ntp

# For VirtualBox
sudo VBoxService --timesync-set-threshold 1000

# Check time synchronization
timedatectl status
```

## FFmpeg Issues

### Codec Not Found

**Problem**: Unsupported codec errors

**Solutions**:
```bash
# List available codecs
ffmpeg -codecs | grep h264
ffmpeg -encoders | grep h264

# Install additional codecs
sudo apt install ubuntu-restricted-extras

# Use alternative codecs
# Replace libx264 with libx264rgb or software encoding
```

### RTSP Protocol Issues

**Problem**: RTSP stream connection problems

**Solutions**:
```bash
# Try different RTSP transport
ffmpeg -rtsp_transport tcp -i rtsp://source
ffmpeg -rtsp_transport udp -i rtsp://source

# Increase timeout values
ffmpeg -timeout 30000000 -i rtsp://source

# Use different RTSP options
ffmpeg -rtsp_flags prefer_tcp -i rtsp://source
```

### Audio/Video Sync Issues

**Problem**: Audio and video out of sync

**Solutions**:
```bash
# Add audio delay
ffmpeg -i input -itsoffset 0.5 -i input -map 0:v -map 1:a output

# Use async filter
ffmpeg -i input -af "aresample=async=1" output

# Disable audio if not needed
ffmpeg -i input -an output
```

## Permission and Security Issues

### File Permission Errors

**Problem**: Cannot write to log files or directories

**Solutions**:
```bash
# Fix script permissions
chmod +x rtsp-sse-stream.sh
chmod +x ubuntu-*.sh
chmod +x mock-*.sh

# Create log directory with proper permissions
sudo mkdir -p /var/log/rtsp-sse
sudo chown $USER:$USER /var/log/rtsp-sse

# Fix configuration file permissions
chmod 644 rtsp-sse-stream.conf
```

### SELinux/AppArmor Issues

**Problem**: Security policies blocking execution

**Solutions**:
```bash
# Check SELinux status (if applicable)
getenforce

# Check AppArmor status
sudo aa-status

# Temporarily disable if needed
sudo aa-complain /usr/bin/ffmpeg

# Create custom profile if needed
sudo aa-genprof ffmpeg
```

### Firewall Blocking Connections

**Problem**: UFW or iptables blocking traffic

**Solutions**:
```bash
# Check UFW status
sudo ufw status verbose

# Allow required ports
sudo ufw allow 554   # RTSP
sudo ufw allow 3000  # SSE Server
sudo ufw allow 1935  # RTMP (if used)

# Check iptables
sudo iptables -L -n

# Temporarily disable firewall for testing
sudo ufw disable
# Remember to re-enable: sudo ufw enable
```

## Service and Process Issues

### Process Not Starting

**Problem**: Script fails to start or exits immediately

**Debugging**:
```bash
# Run script in debug mode
bash -x rtsp-sse-stream.sh

# Check for syntax errors
bash -n rtsp-sse-stream.sh

# Run with verbose logging
LOG_LEVEL="DEBUG" ./rtsp-sse-stream.sh
```

### Process Hanging

**Problem**: Script hangs or becomes unresponsive

**Solutions**:
```bash
# Find hanging processes
ps aux | grep ffmpeg
ps aux | grep rtsp-sse

# Kill hanging processes
pkill -f rtsp-sse-stream
pkill ffmpeg

# Use timeout for commands
timeout 30 ffmpeg -i input output
```

### Systemd Service Issues

**Problem**: Service fails to start or restart

**Debugging**:
```bash
# Check service status
sudo systemctl status rtsp-sse-stream

# View service logs
sudo journalctl -u rtsp-sse-stream -f

# Check service file
sudo systemctl cat rtsp-sse-stream

# Reload service configuration
sudo systemctl daemon-reload
sudo systemctl restart rtsp-sse-stream
```

## Debugging Tools and Commands

### System Information

```bash
# System information
uname -a
lsb_release -a
free -h
df -h

# CPU information
lscpu
cat /proc/cpuinfo

# Memory information
cat /proc/meminfo

# Network interfaces
ip addr show
ifconfig
```

### Process Monitoring

```bash
# Real-time process monitoring
top
htop

# Process tree
pstree

# Specific process monitoring
watch -n 1 'ps aux | grep ffmpeg'

# Resource usage
iostat 1
vmstat 1
```

### Network Debugging

```bash
# Network connections
netstat -tulpn
ss -tulpn

# Network traffic
tcpdump -i any port 554
wireshark  # GUI tool

# Bandwidth monitoring
iftop
nload
bmon
```

### Log Analysis

```bash
# Follow logs in real-time
tail -f /var/log/rtsp-sse-stream.log

# Search for errors
grep -i error /var/log/rtsp-sse-stream.log
grep -i "failed\|error\|exception" /var/log/rtsp-sse-stream.log

# System logs
sudo journalctl -f
sudo journalctl -u rtsp-sse-stream
```

## Common Error Messages

### "No such file or directory"

**Cause**: Missing files or incorrect paths

**Solutions**:
```bash
# Check file existence
ls -la rtsp-sse-stream.sh
which ffmpeg

# Fix path issues
export PATH="$PATH:/usr/local/bin"

# Use absolute paths in configuration
FFMPEG_PATH="/usr/bin/ffmpeg"
```

### "Permission denied"

**Cause**: Insufficient permissions

**Solutions**:
```bash
# Make script executable
chmod +x rtsp-sse-stream.sh

# Fix ownership
sudo chown $USER:$USER rtsp-sse-stream.sh

# Run with sudo if needed (not recommended for normal operation)
sudo ./rtsp-sse-stream.sh
```

### "Address already in use"

**Cause**: Port conflict

**Solutions**:
```bash
# Find process using port
sudo lsof -i :3000
sudo netstat -tulpn | grep :3000

# Kill process using port
sudo kill -9 PID

# Use different port
export SSE_PORT=3001
```

### "Connection refused"

**Cause**: Service not running or firewall blocking

**Solutions**:
```bash
# Check if service is running
sudo systemctl status rtsp-sse-stream

# Start service
sudo systemctl start rtsp-sse-stream

# Check firewall
sudo ufw status
sudo ufw allow PORT
```

### "Codec not found"

**Cause**: Missing FFmpeg codecs

**Solutions**:
```bash
# Install full FFmpeg
sudo apt install ffmpeg

# Check available codecs
ffmpeg -codecs | grep h264

# Use alternative codec
# Change libx264 to libx264rgb in configuration
```

### "Out of memory"

**Cause**: Insufficient RAM or memory leak

**Solutions**:
```bash
# Add swap space
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Reduce buffer sizes
BUFFER_SIZE="256k"

# Monitor memory usage
watch -n 1 free -h
```

## Getting Help

### Collecting Debug Information

When reporting issues, collect this information:

```bash
#!/bin/bash
# Debug information collection script

echo "=== System Information ==="
uname -a
lsb_release -a
free -h
df -h

echo "\n=== FFmpeg Information ==="
ffmpeg -version
ffmpeg -hwaccels

echo "\n=== Network Information ==="
ip addr show
ss -tulpn | grep -E ':(554|3000|1935)'

echo "\n=== Process Information ==="
ps aux | grep -E '(ffmpeg|rtsp|sse)'

echo "\n=== Log Files ==="
ls -la *.log
tail -20 rtsp-sse-stream.log 2>/dev/null || echo "No log file found"

echo "\n=== Configuration ==="
cat rtsp-sse-stream.conf 2>/dev/null || echo "No config file found"

echo "\n=== Service Status ==="
sudo systemctl status rtsp-sse-stream 2>/dev/null || echo "Service not configured"
```

### Support Resources

- Check project documentation and README
- Review configuration examples
- Test with mock servers first
- Use minimal configuration for initial testing
- Enable debug logging for detailed troubleshooting

### Emergency Recovery

If the system becomes unresponsive:

```bash
# Kill all related processes
sudo pkill -f rtsp-sse
sudo pkill ffmpeg
sudo pkill node

# Reset network if needed
sudo systemctl restart networking

# Clear temporary files
rm -f /tmp/*.pid
rm -f /tmp/rtsp-*

# Restart services
sudo systemctl restart rtsp-sse-stream
```

This troubleshooting guide should help resolve most common issues encountered when running the RTSP-SSE streaming system on Ubuntu Linux in VM environments.