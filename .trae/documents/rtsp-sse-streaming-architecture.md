# RTSP Streaming with SSE Integration - Technical Architecture Document

## 1. Architecture Design

```mermaid
graph TD
    A[Bash Shell Script] --> B[FFmpeg Process Manager]
    A --> C[SSE Client Module]
    A --> D[Parameter Controller]
    
    B --> E[RTSP Input Stream]
    B --> F[RTMP Output Stream]
    
    C --> G[SSE Endpoint]
    C --> H[cURL SSE Client]
    
    D --> I[Named Pipes/FIFOs]
    D --> J[Signal Handlers]
    
    subgraph "Core Script Layer"
        A
        D
    end
    
    subgraph "Process Management Layer"
        B
        I
        J
    end
    
    subgraph "Network Layer"
        C
        H
    end
    
    subgraph "External Services"
        E
        F
        G
    end
```

## 2. Technology Description
- Frontend: None (Command-line interface)
- Backend: Bash Shell Script + Native Linux Tools
- Core Tools: FFmpeg, cURL, Named Pipes (mkfifo), Process Control (kill, trap)
- System: Linux (Raspberry Pi OS)

## 3. Route Definitions
| Route | Purpose |
|-------|---------|
| /start | Initialize streaming script with configuration parameters |
| /stop | Gracefully terminate all processes and cleanup resources |
| /status | Display current streaming status and SSE connection state |
| /config | Show current configuration and parameter values |
| /logs | Access streaming logs and error messages |

## 4. API Definitions

### 4.1 Core API

SSE Endpoint Communication
```
GET /sse/stream-params
```

Expected SSE Data Format:
| Param Name | Param Type | isRequired | Description |
|------------|------------|------------|-------------|
| event | string | true | Event type identifier (e.g., "parameter-update") |
| data | string | true | JSON string containing TSP and RAMP values |

SSE Data Structure:
```json
{
  "TSP": 4500,
  "RAMP": 5000,
  "timestamp": "2024-01-15T10:30:00Z"
}
```

Script Command Interface
```
bash rtsp-sse-stream.sh [OPTIONS]
```

Command Line Parameters:
| Param Name | Param Type | isRequired | Description |
|------------|------------|------------|-------------|
| --sse-url | string | true | SSE endpoint URL for parameter updates |
| --rtsp-input | string | true | RTSP input stream URL |
| --rtmp-output | string | true | RTMP output stream URL |
| --config-file | string | false | Path to configuration file |
| --log-level | string | false | Logging verbosity (debug, info, warn, error) |

## 5. Server Architecture Diagram

```mermaid
graph TD
    A[Main Script Process] --> B[Stream Manager]
    A --> C[SSE Listener]
    A --> D[Parameter Controller]
    A --> E[Log Manager]
    
    B --> F[FFmpeg Process]
    B --> G[Process Monitor]
    
    C --> H[cURL SSE Client]
    C --> I[Data Parser]
    
    D --> J[Parameter Validator]
    D --> K[Signal Handler]
    
    subgraph "Process Layer"
        A
        E
    end
    
    subgraph "Stream Management"
        B
        F
        G
    end
    
    subgraph "SSE Integration"
        C
        H
        I
    end
    
    subgraph "Control Layer"
        D
        J
        K
    end
```

## 6. Data Model

### 6.1 Data Model Definition

```mermaid
erDiagram
    STREAM_CONFIG {
        string rtsp_input
        string rtmp_output
        string sse_endpoint
        int video_bitrate
        int max_bitrate
        int buffer_size
        string video_codec
        string audio_codec
    }
    
    SSE_PARAMETERS {
        int TSP
        int RAMP
        timestamp received_at
        boolean applied
    }
    
    STREAM_STATUS {
        string status
        timestamp started_at
        int restart_count
        timestamp last_restart
        boolean sse_connected
    }
    
    LOG_ENTRY {
        timestamp created_at
        string level
        string message
        string component
    }
    
    STREAM_CONFIG ||--o{ SSE_PARAMETERS : receives
    STREAM_CONFIG ||--|| STREAM_STATUS : has
    STREAM_STATUS ||--o{ LOG_ENTRY : generates
```

### 6.2 Data Definition Language

Configuration File Structure (JSON)
```json
{
  "stream_config": {
    "rtsp_input": "rtsp://admin:ubnt%40966@192.168.10.111:554/cam/realmonitor?channel=1&subtype=1",
    "rtmp_output": "rtmp://a.rtmp.youtube.com/live2/pda4-j9yb-hhc9-6t6k-7phr",
    "sse_endpoint": "https://api.example.com/sse/stream-params",
    "video_settings": {
      "codec": "libx264",
      "preset": "veryfast",
      "bitrate": "4500k",
      "maxrate": "5000k",
      "bufsize": "10000k",
      "scale": "1920:1080"
    },
    "audio_settings": {
      "codec": "aac",
      "bitrate": "128k",
      "sample_rate": "44100"
    }
  },
  "sse_config": {
    "reconnect_interval": 5,
    "max_retries": 10,
    "timeout": 30
  },
  "logging": {
    "level": "info",
    "file": "/var/log/rtsp-sse-stream.log",
    "max_size": "10MB",
    "rotate_count": 5
  }
}
```

Named Pipe Structure
```bash
# Create named pipes for inter-process communication
mkfifo /tmp/sse_params_pipe
mkfifo /tmp/stream_control_pipe
mkfifo /tmp/status_pipe

# Parameter update format through pipe
echo "TSP:4500,RAMP:5000,timestamp:$(date -Iseconds)" > /tmp/sse_params_pipe

# Stream control commands
echo "RESTART" > /tmp/stream_control_pipe
echo "STOP" > /tmp/stream_control_pipe
echo "UPDATE_PARAMS" > /tmp/stream_control_pipe

# Status reporting format
echo "STATUS:running,UPTIME:3600,RESTARTS:2,SSE:connected" > /tmp/status_pipe
```

Process Management Structure
```bash
# PID file management
echo $FFMPEG_PID > /var/run/rtsp-stream.pid
echo $SSE_CLIENT_PID > /var/run/sse-client.pid

# Signal handling for graceful shutdown
trap 'cleanup_and_exit' SIGTERM SIGINT
trap 'restart_stream' SIGUSR1
trap 'reload_config' SIGUSR2

# Lock file to prevent multiple instances
flock -n /var/lock/rtsp-sse-stream.lock || exit 1
```