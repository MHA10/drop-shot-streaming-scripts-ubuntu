# Dynamic Streaming System - Technical Architecture Document

## 1. Architecture Design

```mermaid
graph TD
    A[SSE Server] --> B[Node.js SSE Client]
    B --> C[Stream Manager Service]
    C --> D[FFmpeg Process Controller]
    D --> E[FFmpeg Instance]
    F[RTSP Camera] --> E
    E --> G[RTMP Destination]
    C --> H[Configuration Store]
    C --> I[Event Logger]
    J[Web Dashboard] --> K[Express API Server]
    K --> C
    K --> H
    K --> I

    subgraph "Frontend Layer"
        J
    end

    subgraph "Backend Services"
        B
        C
        K
    end

    subgraph "Data Layer"
        H
        I
    end

    subgraph "External Services"
        A
        F
        G
    end

    subgraph "Process Layer"
        D
        E
    end
```

## 2. Technology Description
- Frontend: React@18 + tailwindcss@3 + vite + socket.io-client
- Backend: Node.js@18 + Express@4 + eventsource + child_process
- Database: SQLite (for configuration and logs)
- Process Management: PM2 for service management
- Real-time Communication: Socket.io for dashboard updates

## 3. Route Definitions
| Route | Purpose |
|-------|---------|
| / | Dashboard home page, displays current stream status and controls |
| /configuration | Stream configuration page, URL management and SSE settings |
| /logs | Event logs and performance metrics display |
| /settings | System configuration and security settings |
| /api/stream/status | REST endpoint for current stream status |
| /api/stream/control | REST endpoint for manual stream control |
| /api/config | REST endpoint for configuration management |

## 4. API Definitions

### 4.1 Core API

**Stream Control**
```
POST /api/stream/start
```
Request:
| Param Name | Param Type | isRequired | Description |
|------------|------------|------------|-------------|
| rtsp_url | string | false | Override RTSP URL (optional) |
| rtmp_url | string | false | Override RTMP URL (optional) |

Response:
| Param Name | Param Type | Description |
|------------|------------|-------------|
| success | boolean | Operation status |
| stream_id | string | Unique stream identifier |
| message | string | Status message |

**Configuration Management**
```
PUT /api/config/urls
```
Request:
| Param Name | Param Type | isRequired | Description |
|------------|------------|------------|-------------|
| rtsp_url | string | true | RTSP input URL |
| rtmp_url | string | true | RTMP output URL |
| restart_stream | boolean | false | Auto-restart current stream |

Response:
| Param Name | Param Type | Description |
|------------|------------|-------------|
| success | boolean | Configuration update status |
| validated | boolean | URL validation result |
| errors | array | Validation error messages |

**SSE Event Format**
```json
{
  "event": "url_update",
  "data": {
    "rtsp_url": "rtsp://admin:password@192.168.1.100:554/stream",
    "rtmp_url": "rtmp://live.youtube.com/live2/stream-key",
    "timestamp": "2024-01-15T10:30:00Z",
    "restart_required": true
  }
}
```

## 5. Server Architecture Diagram

```mermaid
graph TD
    A[Express HTTP Server] --> B[SSE Client Service]
    A --> C[Stream Controller]
    A --> D[Configuration Manager]
    A --> E[WebSocket Handler]
    
    B --> F[EventSource Connection]
    C --> G[FFmpeg Process Manager]
    C --> H[Stream Validator]
    D --> I[SQLite Database]
    E --> J[Dashboard Clients]
    
    G --> K[Child Process Spawner]
    K --> L[FFmpeg Instance]
    
    subgraph "HTTP Layer"
        A
    end
    
    subgraph "Service Layer"
        B
        C
        D
        E
    end
    
    subgraph "Data Access Layer"
        H
        I
    end
    
    subgraph "Process Management"
        G
        K
        L
    end
```

## 6. Data Model

### 6.1 Data Model Definition

```mermaid
erDiagram
    STREAM_CONFIG ||--o{ STREAM_LOGS : generates
    STREAM_CONFIG ||--o{ URL_HISTORY : tracks
    SSE_EVENTS ||--o{ STREAM_LOGS : triggers

    STREAM_CONFIG {
        int id PK
        string rtsp_url
        string rtmp_url
        string ffmpeg_params
        boolean auto_restart
        datetime created_at
        datetime updated_at
    }
    
    STREAM_LOGS {
        int id PK
        int config_id FK
        string event_type
        string message
        string status
        datetime timestamp
    }
    
    URL_HISTORY {
        int id PK
        int config_id FK
        string old_rtsp_url
        string new_rtsp_url
        string old_rtmp_url
        string new_rtmp_url
        string change_source
        datetime changed_at
    }
    
    SSE_EVENTS {
        int id PK
        string event_type
        text event_data
        boolean processed
        datetime received_at
    }
```

### 6.2 Data Definition Language

**Stream Configuration Table**
```sql
-- Create stream_config table
CREATE TABLE stream_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rtsp_url TEXT NOT NULL,
    rtmp_url TEXT NOT NULL,
    ffmpeg_params TEXT DEFAULT '-c:v libx264 -preset veryfast -b:v 4500k -maxrate 5000k -bufsize 10000k -vf "scale=1920:1080" -c:a aac -b:a 128k -ar 44100 -f flv',
    auto_restart BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create stream_logs table
CREATE TABLE stream_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_id INTEGER,
    event_type TEXT NOT NULL,
    message TEXT,
    status TEXT CHECK (status IN ('success', 'error', 'warning', 'info')),
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (config_id) REFERENCES stream_config(id)
);

-- Create url_history table
CREATE TABLE url_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_id INTEGER,
    old_rtsp_url TEXT,
    new_rtsp_url TEXT,
    old_rtmp_url TEXT,
    new_rtmp_url TEXT,
    change_source TEXT CHECK (change_source IN ('sse', 'api', 'manual')),
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (config_id) REFERENCES stream_config(id)
);

-- Create sse_events table
CREATE TABLE sse_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    event_data TEXT,
    processed BOOLEAN DEFAULT 0,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX idx_stream_logs_timestamp ON stream_logs(timestamp DESC);
CREATE INDEX idx_url_history_changed_at ON url_history(changed_at DESC);
CREATE INDEX idx_sse_events_processed ON sse_events(processed, received_at);

-- Insert initial configuration
INSERT INTO stream_config (rtsp_url, rtmp_url) VALUES 
('rtsp://admin:ubnt%40966@192.168.10.111:554/cam/realmonitor?channel=1&subtype=1', 
'rtmp://a.rtmp.youtube.com/live2/pda4-j9yb-hhc9-6t6k-7phr');
```