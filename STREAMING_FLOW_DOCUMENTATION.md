# Streaming Flow Documentation

## Overview

The `updated_input_streams.sh` script is a robust multi-stream management system that handles Server-Sent Events (SSE) to control FFmpeg streaming processes. It provides intelligent state management, automatic recovery from network interruptions, and graceful handling of system reboots.

## Architecture

### Core Components

1. **SSE Listener**: Maintains persistent connection to SSE endpoint
2. **Stream Registry**: JSON-based state management for active streams
3. **PID Manager**: Tracks and validates FFmpeg process IDs
4. **State Reconciliation Engine**: Handles differential state updates
5. **Boot Detection System**: Distinguishes between reboot and network loss
6. **Health Monitor**: Periodic validation of stream processes

### Data Flow

```
SSE Events → Event Parser → State Reconciliation → Stream Lifecycle → PID Management
     ↓              ↓              ↓                    ↓              ↓
Connection     Stream Actions   Differential      FFmpeg Control   Process
Management     (start/stop)     Updates          (start/stop)     Tracking
```

## Boot Detection Flow

### Detection Logic

```bash
# Boot detection using system uptime
detect_boot_scenario() {
    local boot_time=$(sysctl -n kern.boottime | awk '{print $4}' | tr -d ',')
    local current_time=$(date +%s)
    local uptime=$((current_time - boot_time))
    
    # If uptime < 300 seconds (5 minutes), consider it a fresh boot
    if [ $uptime -lt 300 ]; then
        return 0  # Boot scenario
    else
        return 1  # Internet loss scenario
    fi
}
```

### Scenario Handling

**Fresh Boot (Uptime < 5 minutes):**
- Clear all persistent state
- Remove orphaned processes
- Initialize clean registry
- Start fresh SSE connection

**Internet Loss (Uptime > 5 minutes):**
- Validate existing PIDs
- Preserve running streams
- Reconcile state with SSE events
- Resume monitoring

## State Management

### File Structure

```
/tmp/stream_system/
├── registry.json          # Current active streams
├── persistent_state.json  # Boot-persistent state
├── logs/
│   └── stream_system.log  # System logs
└── .boot_marker          # Boot detection marker
```

### State Types

**Temporary State (registry.json):**
- Active stream information
- Current PIDs
- Health check timestamps
- Cleared on system reboot

**Persistent State (persistent_state.json):**
- Stream configurations
- Expected state from SSE
- Survives system reboot
- Used for state reconciliation

## Stream Lifecycle

### Complete Flow

```
1. SSE Event Received
   ↓
2. Event Validation
   ↓
3. Stream ID Generation
   ↓
4. State Update (Registry + Persistent)
   ↓
5. FFmpeg Process Management
   ↓
6. PID Tracking
   ↓
7. Health Monitoring
```

### Stream Start Process

```bash
start_stream() {
    local stream_url="$1"
    local stream_id=$(generate_stream_id "$stream_url")
    
    # 1. Validate URL
    # 2. Check if already running
    # 3. Start FFmpeg process
    # 4. Capture PID
    # 5. Update registry
    # 6. Update persistent state
    # 7. Log action
}
```

### Stream Stop Process

```bash
stop_stream() {
    local stream_url="$1"
    
    # 1. Find stream by URL
    # 2. Terminate FFmpeg process
    # 3. Remove from registry
    # 4. Update persistent state
    # 5. Log action
}
```

## Reconnection Scenarios

### Internet Loss Recovery

```
1. SSE Connection Lost
   ↓
2. Retry Connection (exponential backoff)
   ↓
3. Connection Restored
   ↓
4. Validate Existing PIDs
   ↓
5. Receive SSE Events (latest state)
   ↓
6. State Reconciliation
   ↓
7. Apply Differential Changes
```

### Reboot Recovery

```
1. System Boot Detected
   ↓
2. Clear Temporary State
   ↓
3. Initialize Clean Registry
   ↓
4. Connect to SSE
   ↓
5. Receive Current State
   ↓
6. Start Required Streams
   ↓
7. Begin Health Monitoring
```

## State Reconciliation Process

### Three-Phase Algorithm

**Phase 1: State Mapping**
```bash
# Build current state map (running streams)
current_streams=$(build_current_stream_map)

# Build expected state map (from SSE events)
expected_streams=$(build_expected_stream_map)
```

**Phase 2: Differential Analysis**
```bash
# Identify actions needed
streams_to_start=$(find_streams_to_start)
streams_to_stop=$(find_streams_to_stop)
streams_to_keep=$(find_streams_to_keep)
```

**Phase 3: Action Execution**
```bash
# Apply changes
stop_unwanted_streams
start_new_streams
validate_kept_streams
```

### Reconciliation Triggers

- SSE reconnection
- Boot detection
- Health check failures
- Manual intervention

## PID Management

### PID Lifecycle

```
1. FFmpeg Start → PID Capture
   ↓
2. Registry Update → PID Storage
   ↓
3. Health Check → PID Validation
   ↓
4. Process Death → PID Cleanup
   ↓
5. Registry Update → PID Removal
```

### Validation Logic

```bash
validate_pid() {
    local pid="$1"
    
    # Check if PID exists
    if ! kill -0 "$pid" 2>/dev/null; then
        return 1  # Invalid PID
    fi
    
    # Check if it's an FFmpeg process
    local process_name=$(ps -p "$pid" -o comm= 2>/dev/null)
    if [[ "$process_name" != "ffmpeg" ]]; then
        return 1  # Not FFmpeg
    fi
    
    return 0  # Valid PID
}
```

## Error Handling

### Recovery Mechanisms

**Connection Failures:**
- Exponential backoff retry
- Maximum retry attempts
- Graceful degradation

**Process Failures:**
- Automatic restart
- State cleanup
- Error logging

**State Corruption:**
- Registry validation
- Automatic repair
- Fallback to clean state

### Cleanup Procedures

```bash
cleanup() {
    log "INFO" "Starting cleanup procedure"
    
    # Stop SSE listener
    if [[ -n "$sse_pid" ]]; then
        kill "$sse_pid" 2>/dev/null
    fi
    
    # Stop all streams
    stop_all_streams
    
    # Clean temporary files
    rm -f "$TEMP_EVENT_FILE" "$EXPECTED_STREAMS_FILE"
    
    log "INFO" "Cleanup completed"
}
```

## Configuration

### Key Parameters

```bash
# SSE Configuration
SSE_ENDPOINT="http://localhost:3000/events"
SSE_RETRY_DELAY=5
SSE_MAX_RETRIES=10

# File Paths
STREAM_REGISTRY="/tmp/stream_system/registry.json"
PERSISTENT_STATE="/tmp/stream_system/persistent_state.json"
LOG_FILE="/tmp/stream_system/logs/stream_system.log"

# Timing
HEALTH_CHECK_INTERVAL=30
BOOT_DETECTION_THRESHOLD=300
CONNECTION_TIMEOUT=10
```

### Environment Variables

- `DEBUG`: Enable debug logging
- `SSE_ENDPOINT`: Override default SSE endpoint
- `LOG_LEVEL`: Set logging verbosity

## Logging

### Log Levels

- **INFO**: Normal operations
- **WARN**: Recoverable issues
- **ERROR**: Critical failures
- **DEBUG**: Detailed diagnostics

### Log Format

```
[TIMESTAMP] [LEVEL] [COMPONENT] MESSAGE
[2024-01-15 10:30:45] [INFO] [STREAM] Started stream for rtmp://example.com/live
[2024-01-15 10:30:46] [WARN] [SSE] Connection lost, retrying in 5 seconds
[2024-01-15 10:30:51] [ERROR] [PID] Invalid PID 12345 detected, cleaning up
```

### Troubleshooting Guide

**Common Issues:**

1. **Streams not starting:**
   - Check SSE connection
   - Verify FFmpeg installation
   - Review stream URL validity

2. **State inconsistency:**
   - Check registry.json format
   - Validate PID existence
   - Review reconciliation logs

3. **High resource usage:**
   - Monitor FFmpeg processes
   - Check for orphaned streams
   - Review health check frequency

## Flow Diagrams

### Main System Flow

```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐
│   System    │───▶│ Boot         │───▶│ Initialize  │
│   Start     │    │ Detection    │    │ Registry    │
└─────────────┘    └──────────────┘    └─────────────┘
                           │                    │
                           ▼                    ▼
                   ┌──────────────┐    ┌─────────────┐
                   │ Internet     │    │ Fresh       │
                   │ Loss         │    │ Boot        │
                   └──────────────┘    └─────────────┘
                           │                    │
                           ▼                    ▼
                   ┌──────────────┐    ┌─────────────┐
                   │ Validate     │    │ Clean       │
                   │ PIDs         │    │ Start       │
                   └──────────────┘    └─────────────┘
                           │                    │
                           └────────┬───────────┘
                                    ▼
                           ┌─────────────┐
                           │ SSE         │
                           │ Listener    │
                           └─────────────┘
                                    │
                                    ▼
                           ┌─────────────┐
                           │ Health      │
                           │ Monitor     │
                           └─────────────┘
```

### State Reconciliation Flow

```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐
│ SSE Events  │───▶│ Build        │───▶│ Build       │
│ Received    │    │ Expected     │    │ Current     │
└─────────────┘    │ State Map    │    │ State Map   │
                   └──────────────┘    └─────────────┘
                           │                    │
                           └────────┬───────────┘
                                    ▼
                           ┌─────────────┐
                           │ Compare     │
                           │ States      │
                           └─────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
            ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
            │ Streams     │ │ Streams     │ │ Streams     │
            │ to Start    │ │ to Stop     │ │ to Keep     │
            └─────────────┘ └─────────────┘ └─────────────┘
                    │               │               │
                    └───────────────┼───────────────┘
                                    ▼
                           ┌─────────────┐
                           │ Apply       │
                           │ Changes     │
                           └─────────────┘
```

## Usage Examples

### Normal Operation

```bash
# Start the system
./updated_input_streams.sh

# Expected log output:
# [INFO] [INIT] Stream system initialized
# [INFO] [SSE] Connected to SSE endpoint
# [INFO] [HEALTH] Health monitor started
```

### After Network Loss

```bash
# System automatically recovers:
# [WARN] [SSE] Connection lost, retrying...
# [INFO] [SSE] Reconnected to SSE endpoint
# [INFO] [RECONCILE] Starting state reconciliation
# [INFO] [RECONCILE] Reconciliation completed: 2 kept, 1 started, 0 stopped
```

### After System Reboot

```bash
# Fresh start detected:
# [INFO] [BOOT] Fresh boot detected (uptime: 45 seconds)
# [INFO] [INIT] Clearing persistent state
# [INFO] [SSE] Connected to SSE endpoint
# [INFO] [STREAM] Started 3 streams from SSE events
```

### Manual Debugging

```bash
# Check registry status
cat /tmp/stream_system/registry.json

# Monitor logs in real-time
tail -f /tmp/stream_system/logs/stream_system.log

# Check running FFmpeg processes
ps aux | grep ffmpeg
```

## File Structure

```
streaming-script-solo/
├── scripts/
│   └── updated_input_streams.sh    # Main script
├── server.js                       # SSE test server
├── package.json                    # Node.js dependencies
├── public/
│   └── index.html                  # Test interface
└── /tmp/stream_system/             # Runtime directory
    ├── registry.json               # Active streams
    ├── persistent_state.json       # Persistent state
    ├── logs/
    │   └── stream_system.log       # System logs
    └── .boot_marker               # Boot detection
```

## Performance Considerations

- **Memory Usage**: Registry size scales with stream count
- **CPU Usage**: Health checks run every 30 seconds
- **Disk I/O**: Logs rotate automatically
- **Network**: SSE connection maintained continuously

## Security Notes

- Temporary files in `/tmp` are world-readable
- No authentication on SSE endpoint
- FFmpeg processes run with script user privileges
- Consider firewall rules for production deployment