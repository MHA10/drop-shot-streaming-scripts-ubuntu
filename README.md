# RTSP SSE Streaming Script

A robust shell script for Raspberry Pi that manages RTSP streaming with Server-Sent Events (SSE) integration for dynamic parameter adjustment.

## Features

- **RTSP to RTMP Streaming**: Convert RTSP input streams to RTMP output with FFmpeg
- **Server-Sent Events Integration**: Listen to SSE endpoints for real-time parameter updates
- **Dynamic Parameter Adjustment**: Update TSP (bitrate) and RAMP (max bitrate) without interrupting streams
- **Hardware Acceleration**: Automatic detection and use of Raspberry Pi hardware encoders
- **Auto-restart**: Automatic FFmpeg process restart on crashes with configurable delay
- **Resource Optimization**: CPU priority and memory limit controls for Raspberry Pi
- **Signal Handling**: Graceful shutdown and configuration reload via signals
- **Named Pipes**: Efficient inter-process communication
- **Comprehensive Logging**: Color-coded logging with multiple levels

## Requirements

- **Operating System**: Linux (tested on Raspberry Pi OS)
- **Dependencies**:
  - `ffmpeg` (with hardware acceleration support for optimal performance)
  - `curl` (for SSE client functionality)
  - `jq` (optional, for advanced JSON configuration parsing)
  - `bash` 4.0 or higher

### Installing Dependencies

```bash
# On Raspberry Pi OS / Debian / Ubuntu
sudo apt update
sudo apt install ffmpeg curl jq

# Verify FFmpeg hardware acceleration support
ffmpeg -encoders | grep h264
```

## Installation

1. **Download the script**:
   ```bash
   wget https://raw.githubusercontent.com/your-repo/rtsp-sse-stream.sh
   chmod +x rtsp-sse-stream.sh
   ```

2. **Create configuration file**:
   ```bash
   cp rtsp-sse-stream.conf.example rtsp-sse-stream.conf
   ```

3. **Edit configuration** to match your setup:
   ```bash
   nano rtsp-sse-stream.conf
   ```

## Configuration

### Basic Configuration

Edit `rtsp-sse-stream.conf` with your settings:

```bash
# RTSP Input (your camera or stream source)
RTSP_INPUT="rtsp://192.168.1.100:8554/stream"

# RTMP Output (streaming destination)
RTMP_OUTPUT="rtmp://live.twitch.tv/live/YOUR_STREAM_KEY"

# SSE Endpoint (for dynamic parameter updates)
SSE_URL="http://192.168.1.200:3000/events"

# Initial streaming parameters
CURRENT_TSP="2500"      # Video bitrate in kbps
CURRENT_RAMP="3000"     # Maximum bitrate in kbps
CURRENT_BUFSIZE="4000"  # Buffer size in kbps
```

### Hardware Acceleration

```bash
# Enable hardware acceleration (recommended for Raspberry Pi)
HW_ACCEL="true"
HW_ACCEL_METHOD="auto"  # auto, h264_v4l2m2m, h264_omx

# Resource optimization
NICE_LEVEL="10"         # CPU priority (higher = lower priority)
MEMORY_LIMIT="512"      # Memory limit in MB
FFMPEG_THREADS="2"      # Number of encoding threads
```

### Advanced Configuration

```bash
# Additional FFmpeg options
FFMPEG_EXTRA_OPTS="-tune zerolatency -preset ultrafast"

# SSE connection settings
SSE_TIMEOUT="30"
SSE_RETRY_ATTEMPTS="3"
SSE_RETRY_DELAY="5"

# Process management
RESTART_DELAY="5"       # Delay before restarting crashed FFmpeg
```

## Usage

### Basic Usage

```bash
# Start streaming with default configuration
./rtsp-sse-stream.sh

# Start with custom configuration file
./rtsp-sse-stream.sh -c /path/to/custom.conf

# Start with command-line parameters
./rtsp-sse-stream.sh -i "rtsp://camera:8554/stream" -o "rtmp://server/live/key"
```

### Command-Line Options

```bash
./rtsp-sse-stream.sh [OPTIONS]

Options:
  -i, --input URL          RTSP input URL
  -o, --output URL         RTMP output URL
  -s, --sse-url URL        SSE endpoint URL
  -c, --config FILE        Configuration file path
  -t, --tsp BITRATE        Initial TSP (video bitrate) in kbps
  -r, --ramp BITRATE       Initial RAMP (max bitrate) in kbps
  -d, --delay SECONDS      Restart delay in seconds
  -p, --pidfile FILE       PID file path
  -l, --logfile FILE       Log file path
  -v, --verbose            Enable verbose logging
  -h, --help               Show help message
```

### Signal Handling

```bash
# Get the process ID
PID=$(cat /tmp/rtsp-sse-stream.pid)

# Graceful shutdown
kill -TERM $PID

# Reload configuration
kill -USR1 $PID

# Status report
kill -USR2 $PID
```

### Running as a Service

Create a systemd service file `/etc/systemd/system/rtsp-sse-stream.service`:

```ini
[Unit]
Description=RTSP SSE Streaming Service
After=network.target

[Service]
Type=forking
User=pi
Group=pi
WorkingDirectory=/home/pi/streaming
ExecStart=/home/pi/streaming/rtsp-sse-stream.sh -c /home/pi/streaming/rtsp-sse-stream.conf
ExecReload=/bin/kill -USR1 $MAINPID
PIDFile=/tmp/rtsp-sse-stream.pid
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable rtsp-sse-stream
sudo systemctl start rtsp-sse-stream

# Check status
sudo systemctl status rtsp-sse-stream

# View logs
sudo journalctl -u rtsp-sse-stream -f
```

## SSE Integration

### SSE Event Format

The script expects SSE events in the following format:

```
data: {"tsp": 2000, "ramp": 2500}

data: {"tsp": 1500}

data: {"ramp": 3000}
```

### Example SSE Server (Node.js)

```javascript
const express = require('express');
const app = express();

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Send parameter updates
  const sendUpdate = (params) => {
    res.write(`data: ${JSON.stringify(params)}\n\n`);
  };

  // Example: Send updates every 30 seconds
  const interval = setInterval(() => {
    const params = {
      tsp: Math.floor(Math.random() * 2000) + 1000,  // 1000-3000 kbps
      ramp: Math.floor(Math.random() * 1000) + 2000  // 2000-3000 kbps
    };
    sendUpdate(params);
  }, 30000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

app.listen(3000, () => {
  console.log('SSE server running on port 3000');
});
```

## Monitoring and Troubleshooting

### Log Files

```bash
# View real-time logs
tail -f /var/log/rtsp-sse-stream.log

# Check for errors
grep ERROR /var/log/rtsp-sse-stream.log

# Monitor FFmpeg output
ps aux | grep ffmpeg
```

### Common Issues

1. **FFmpeg not found**:
   ```bash
   sudo apt install ffmpeg
   ```

2. **Hardware acceleration not working**:
   ```bash
   # Check available encoders
   ffmpeg -encoders | grep h264
   
   # Disable hardware acceleration in config
   HW_ACCEL="false"
   ```

3. **SSE connection issues**:
   ```bash
   # Test SSE endpoint manually
   curl -N -H "Accept: text/event-stream" http://your-sse-server/events
   ```

4. **Permission issues**:
   ```bash
   # Ensure script is executable
   chmod +x rtsp-sse-stream.sh
   
   # Check file permissions
   ls -la rtsp-sse-stream.*
   ```

### Performance Optimization

1. **For Raspberry Pi 4**:
   ```bash
   HW_ACCEL="true"
   HW_ACCEL_METHOD="h264_v4l2m2m"
   NICE_LEVEL="5"
   MEMORY_LIMIT="1024"
   ```

2. **For Raspberry Pi 3**:
   ```bash
   HW_ACCEL="true"
   HW_ACCEL_METHOD="h264_omx"
   NICE_LEVEL="10"
   MEMORY_LIMIT="512"
   FFMPEG_THREADS="2"
   ```

3. **For older Raspberry Pi models**:
   ```bash
   HW_ACCEL="false"
   NICE_LEVEL="15"
   MEMORY_LIMIT="256"
   FFMPEG_THREADS="1"
   CURRENT_TSP="1000"  # Lower bitrate
   ```

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Support

For issues and questions:
- Check the troubleshooting section above
- Review the log files for error messages
- Open an issue on GitHub with detailed information about your setup and the problem