#!/bin/bash

# Mock SSE Server for Testing RTSP-SSE Stream Integration
# Ubuntu Linux Edition

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
SSE_PORT=${SSE_PORT:-3000}
SSE_HOST=${SSE_HOST:-"0.0.0.0"}
PID_FILE="/tmp/mock-sse-server.pid"
LOG_FILE="$SCRIPT_DIR/mock-sse-server.log"
STREAM_ENDPOINT=${STREAM_ENDPOINT:-"/stream"}
STATUS_ENDPOINT=${STATUS_ENDPOINT:-"/status"}
HEALTH_ENDPOINT=${HEALTH_ENDPOINT:-"/health"}
CORS_ORIGIN=${CORS_ORIGIN:-"*"}
MAX_CONNECTIONS=${MAX_CONNECTIONS:-100}
HEARTBEAT_INTERVAL=${HEARTBEAT_INTERVAL:-30}
CONNECTION_TIMEOUT=${CONNECTION_TIMEOUT:-300}

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
    
    # Check for Node.js
    if ! command -v node > /dev/null 2>&1; then
        missing_deps+=("node")
    fi
    
    # Check for npm
    if ! command -v npm > /dev/null 2>&1; then
        missing_deps+=("npm")
    fi
    
    # Check for curl
    if ! command -v curl > /dev/null 2>&1; then
        missing_deps+=("curl")
    fi
    
    # Check for ss (netstat alternative)
    if ! command -v ss > /dev/null 2>&1; then
        missing_deps+=("ss")
    fi
    
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
            log_warning "Mock SSE server is already running (PID: $pid)"
            echo "Use '$0 stop' to stop the server first"
            exit 1
        else
            log "Removing stale PID file"
            rm -f "$PID_FILE"
        fi
    fi
}

# Check port availability
check_port() {
    log "Checking port availability..."
    
    if ss -tuln | grep -q ":$SSE_PORT "; then
        log_error "Port $SSE_PORT is already in use"
        exit 1
    fi
    
    log_success "Port $SSE_PORT is available"
}

# Create Node.js SSE server
create_sse_server() {
    local server_file="$SCRIPT_DIR/mock-sse-server.js"
    
    log "Creating Node.js SSE server..."
    
    cat > "$server_file" << 'EOF'
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

// Configuration from environment
const config = {
    port: process.env.SSE_PORT || 3000,
    host: process.env.SSE_HOST || '0.0.0.0',
    streamEndpoint: process.env.STREAM_ENDPOINT || '/stream',
    statusEndpoint: process.env.STATUS_ENDPOINT || '/status',
    healthEndpoint: process.env.HEALTH_ENDPOINT || '/health',
    corsOrigin: process.env.CORS_ORIGIN || '*',
    maxConnections: parseInt(process.env.MAX_CONNECTIONS) || 100,
    heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL) || 30,
    connectionTimeout: parseInt(process.env.CONNECTION_TIMEOUT) || 300
};

// Server state
const state = {
    connections: new Set(),
    startTime: new Date(),
    totalConnections: 0,
    currentConnections: 0,
    messagesReceived: 0,
    messagesSent: 0,
    lastActivity: new Date()
};

// Logging function
function log(level, message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    console.log(logMessage);
    
    // Also log to file if LOG_FILE is set
    if (process.env.LOG_FILE) {
        fs.appendFileSync(process.env.LOG_FILE, logMessage + '\n');
    }
}

// CORS headers
function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// SSE headers
function setSseHeaders(res) {
    setCorsHeaders(res);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
}

// Send SSE message
function sendSseMessage(res, data, event = 'message', id = null) {
    try {
        if (id) {
            res.write(`id: ${id}\n`);
        }
        if (event) {
            res.write(`event: ${event}\n`);
        }
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        state.messagesSent++;
        state.lastActivity = new Date();
        return true;
    } catch (error) {
        log('error', `Failed to send SSE message: ${error.message}`);
        return false;
    }
}

// Broadcast to all connections
function broadcast(data, event = 'message') {
    const message = {
        timestamp: new Date().toISOString(),
        ...data
    };
    
    const deadConnections = [];
    
    for (const connection of state.connections) {
        if (!sendSseMessage(connection.res, message, event, Date.now())) {
            deadConnections.push(connection);
        }
    }
    
    // Clean up dead connections
    deadConnections.forEach(conn => {
        state.connections.delete(conn);
        state.currentConnections--;
        log('info', `Removed dead connection from ${conn.ip}`);
    });
}

// Handle SSE stream endpoint
function handleStream(req, res) {
    const clientIp = req.connection.remoteAddress || req.socket.remoteAddress;
    
    // Check connection limit
    if (state.currentConnections >= config.maxConnections) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Maximum connections reached' }));
        log('warning', `Connection rejected from ${clientIp}: max connections reached`);
        return;
    }
    
    // Set SSE headers
    setSseHeaders(res);
    res.writeHead(200);
    
    // Create connection object
    const connection = {
        res,
        ip: clientIp,
        startTime: new Date(),
        lastPing: new Date()
    };
    
    // Add to connections
    state.connections.add(connection);
    state.totalConnections++;
    state.currentConnections++;
    
    log('info', `New SSE connection from ${clientIp} (${state.currentConnections}/${config.maxConnections})`);
    
    // Send welcome message
    sendSseMessage(res, {
        type: 'welcome',
        message: 'Connected to Mock SSE Server',
        connectionId: Date.now(),
        serverInfo: {
            startTime: state.startTime,
            version: '1.0.0'
        }
    }, 'connect');
    
    // Set up heartbeat
    const heartbeatInterval = setInterval(() => {
        if (!sendSseMessage(res, {
            type: 'heartbeat',
            timestamp: new Date().toISOString()
        }, 'ping')) {
            clearInterval(heartbeatInterval);
        } else {
            connection.lastPing = new Date();
        }
    }, config.heartbeatInterval * 1000);
    
    // Handle connection close
    req.on('close', () => {
        clearInterval(heartbeatInterval);
        state.connections.delete(connection);
        state.currentConnections--;
        log('info', `SSE connection closed from ${clientIp}`);
    });
    
    // Handle connection timeout
    const timeoutInterval = setInterval(() => {
        const now = new Date();
        const timeSinceLastPing = now - connection.lastPing;
        
        if (timeSinceLastPing > config.connectionTimeout * 1000) {
            log('warning', `Connection timeout for ${clientIp}`);
            res.end();
            clearInterval(timeoutInterval);
            clearInterval(heartbeatInterval);
        }
    }, 60000); // Check every minute
    
    req.on('close', () => {
        clearInterval(timeoutInterval);
    });
}

// Handle status endpoint
function handleStatus(req, res) {
    setCorsHeaders(res);
    res.setHeader('Content-Type', 'application/json');
    
    const uptime = Date.now() - state.startTime.getTime();
    const status = {
        status: 'running',
        uptime: Math.floor(uptime / 1000),
        connections: {
            current: state.currentConnections,
            total: state.totalConnections,
            max: config.maxConnections
        },
        messages: {
            received: state.messagesReceived,
            sent: state.messagesSent
        },
        lastActivity: state.lastActivity,
        config: {
            port: config.port,
            host: config.host,
            endpoints: {
                stream: config.streamEndpoint,
                status: config.statusEndpoint,
                health: config.healthEndpoint
            }
        },
        timestamp: new Date().toISOString()
    };
    
    res.writeHead(200);
    res.end(JSON.stringify(status, null, 2));
}

// Handle health endpoint
function handleHealth(req, res) {
    setCorsHeaders(res);
    res.setHeader('Content-Type', 'application/json');
    
    const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        checks: {
            server: 'ok',
            connections: state.currentConnections < config.maxConnections ? 'ok' : 'warning',
            memory: process.memoryUsage().heapUsed < 100 * 1024 * 1024 ? 'ok' : 'warning' // 100MB threshold
        }
    };
    
    const isHealthy = Object.values(health.checks).every(check => check === 'ok');
    
    res.writeHead(isHealthy ? 200 : 503);
    res.end(JSON.stringify(health, null, 2));
}

// Handle POST requests (for receiving stream data)
function handlePost(req, res) {
    let body = '';
    
    req.on('data', chunk => {
        body += chunk.toString();
    });
    
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            state.messagesReceived++;
            
            // Broadcast the received data to all SSE connections
            broadcast({
                type: 'stream_data',
                data: data,
                receivedAt: new Date().toISOString()
            }, 'data');
            
            setCorsHeaders(res);
            res.setHeader('Content-Type', 'application/json');
            res.writeHead(200);
            res.end(JSON.stringify({ 
                status: 'received', 
                connections: state.currentConnections,
                timestamp: new Date().toISOString()
            }));
            
            log('info', `Received and broadcasted data to ${state.currentConnections} connections`);
            
        } catch (error) {
            log('error', `Failed to parse POST data: ${error.message}`);
            setCorsHeaders(res);
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
    });
}

// Main request handler
function handleRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    
    log('debug', `${req.method} ${pathname} from ${req.connection.remoteAddress}`);
    
    // Handle OPTIONS for CORS
    if (req.method === 'OPTIONS') {
        setCorsHeaders(res);
        res.writeHead(200);
        res.end();
        return;
    }
    
    // Route requests
    if (pathname === config.streamEndpoint && req.method === 'GET') {
        handleStream(req, res);
    } else if (pathname === config.streamEndpoint && req.method === 'POST') {
        handlePost(req, res);
    } else if (pathname === config.statusEndpoint && req.method === 'GET') {
        handleStatus(req, res);
    } else if (pathname === config.healthEndpoint && req.method === 'GET') {
        handleHealth(req, res);
    } else if (pathname === '/' && req.method === 'GET') {
        // Serve a simple HTML page for testing
        setCorsHeaders(res);
        res.setHeader('Content-Type', 'text/html');
        res.writeHead(200);
        res.end(`
<!DOCTYPE html>
<html>
<head>
    <title>Mock SSE Server</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .container { max-width: 800px; }
        .endpoint { background: #f5f5f5; padding: 10px; margin: 10px 0; border-radius: 5px; }
        .log { background: #000; color: #0f0; padding: 10px; height: 300px; overflow-y: scroll; font-family: monospace; }
        button { padding: 10px 20px; margin: 5px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Mock SSE Server</h1>
        <p>Server is running on port ${config.port}</p>
        
        <h2>Endpoints:</h2>
        <div class="endpoint">
            <strong>SSE Stream:</strong> <a href="${config.streamEndpoint}">${config.streamEndpoint}</a>
        </div>
        <div class="endpoint">
            <strong>Status:</strong> <a href="${config.statusEndpoint}">${config.statusEndpoint}</a>
        </div>
        <div class="endpoint">
            <strong>Health:</strong> <a href="${config.healthEndpoint}">${config.healthEndpoint}</a>
        </div>
        
        <h2>Test SSE Connection:</h2>
        <button onclick="startSSE()">Start SSE</button>
        <button onclick="stopSSE()">Stop SSE</button>
        <button onclick="clearLog()">Clear Log</button>
        
        <div id="log" class="log"></div>
        
        <script>
            let eventSource = null;
            const log = document.getElementById('log');
            
            function addLog(message) {
                const timestamp = new Date().toLocaleTimeString();
                log.innerHTML += timestamp + ': ' + message + '\\n';
                log.scrollTop = log.scrollHeight;
            }
            
            function startSSE() {
                if (eventSource) {
                    eventSource.close();
                }
                
                eventSource = new EventSource('${config.streamEndpoint}');
                
                eventSource.onopen = function() {
                    addLog('SSE connection opened');
                };
                
                eventSource.onmessage = function(event) {
                    addLog('Message: ' + event.data);
                };
                
                eventSource.addEventListener('connect', function(event) {
                    addLog('Connected: ' + event.data);
                });
                
                eventSource.addEventListener('ping', function(event) {
                    addLog('Ping: ' + event.data);
                });
                
                eventSource.addEventListener('data', function(event) {
                    addLog('Data: ' + event.data);
                });
                
                eventSource.onerror = function(event) {
                    addLog('SSE error occurred');
                };
            }
            
            function stopSSE() {
                if (eventSource) {
                    eventSource.close();
                    eventSource = null;
                    addLog('SSE connection closed');
                }
            }
            
            function clearLog() {
                log.innerHTML = '';
            }
        </script>
    </div>
</body>
</html>
        `);
    } else {
        // 404 Not Found
        setCorsHeaders(res);
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not Found' }));
    }
}

// Create and start server
const server = http.createServer(handleRequest);

// Handle server errors
server.on('error', (error) => {
    log('error', `Server error: ${error.message}`);
    process.exit(1);
});

// Start server
server.listen(config.port, config.host, () => {
    log('info', `Mock SSE Server started on http://${config.host}:${config.port}`);
    log('info', `SSE endpoint: http://${config.host}:${config.port}${config.streamEndpoint}`);
    log('info', `Status endpoint: http://${config.host}:${config.port}${config.statusEndpoint}`);
    log('info', `Health endpoint: http://${config.host}:${config.port}${config.healthEndpoint}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    log('info', 'Received SIGINT, shutting down gracefully');
    server.close(() => {
        log('info', 'Server closed');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    log('info', 'Received SIGTERM, shutting down gracefully');
    server.close(() => {
        log('info', 'Server closed');
        process.exit(0);
    });
});

// Send periodic test messages
setInterval(() => {
    if (state.currentConnections > 0) {
        broadcast({
            type: 'test_message',
            message: 'Periodic test message from Mock SSE Server',
            connectionCount: state.currentConnections,
            uptime: Math.floor((Date.now() - state.startTime.getTime()) / 1000)
        }, 'test');
    }
}, 60000); // Every minute
EOF

    log_success "Node.js SSE server created: $server_file"
}

# Start the SSE server
start_server() {
    log "Starting Mock SSE Server..."
    
    # Create the Node.js server file
    create_sse_server
    
    # Set environment variables
    export SSE_PORT="$SSE_PORT"
    export SSE_HOST="$SSE_HOST"
    export STREAM_ENDPOINT="$STREAM_ENDPOINT"
    export STATUS_ENDPOINT="$STATUS_ENDPOINT"
    export HEALTH_ENDPOINT="$HEALTH_ENDPOINT"
    export CORS_ORIGIN="$CORS_ORIGIN"
    export MAX_CONNECTIONS="$MAX_CONNECTIONS"
    export HEARTBEAT_INTERVAL="$HEARTBEAT_INTERVAL"
    export CONNECTION_TIMEOUT="$CONNECTION_TIMEOUT"
    export LOG_FILE="$LOG_FILE"
    
    # Start the server
    cd "$SCRIPT_DIR"
    node mock-sse-server.js > "$LOG_FILE" 2>&1 &
    
    local server_pid=$!
    echo $server_pid > "$PID_FILE"
    
    # Wait for server to start
    sleep 3
    
    # Verify server is running
    if ps -p "$server_pid" > /dev/null 2>&1; then
        # Test if server is responding
        if curl -s "http://127.0.0.1:$SSE_PORT$HEALTH_ENDPOINT" > /dev/null 2>&1; then
            log_success "Mock SSE server started successfully (PID: $server_pid)"
            
            echo
            echo "Mock SSE Server Information:"
            echo "  Server URL: http://127.0.0.1:$SSE_PORT"
            echo "  SSE Stream: http://127.0.0.1:$SSE_PORT$STREAM_ENDPOINT"
            echo "  Status API: http://127.0.0.1:$SSE_PORT$STATUS_ENDPOINT"
            echo "  Health Check: http://127.0.0.1:$SSE_PORT$HEALTH_ENDPOINT"
            echo "  Log file: $LOG_FILE"
            echo "  PID file: $PID_FILE"
            echo
            echo "Test the server with:"
            echo "  curl http://127.0.0.1:$SSE_PORT$STATUS_ENDPOINT"
            echo "  curl http://127.0.0.1:$SSE_PORT$HEALTH_ENDPOINT"
            echo
            echo "Test SSE stream with:"
            echo "  curl -N http://127.0.0.1:$SSE_PORT$STREAM_ENDPOINT"
            echo
            echo "Send test data with:"
            echo "  curl -X POST -H 'Content-Type: application/json' -d '{\"test\": \"data\"}' http://127.0.0.1:$SSE_PORT$STREAM_ENDPOINT"
            echo
            echo "Web interface: http://127.0.0.1:$SSE_PORT"
            echo
            echo "Stop the server with:"
            echo "  $0 stop"
            
        else
            log_warning "Server started but not responding to health checks yet"
        fi
    else
        log_error "Failed to start Mock SSE server"
        rm -f "$PID_FILE"
        exit 1
    fi
}

# Stop the server
stop_server() {
    log "Stopping Mock SSE Server..."
    
    local stopped=false
    
    if [[ -f "$PID_FILE" ]]; then
        local pid=$(cat "$PID_FILE")
        if ps -p "$pid" > /dev/null 2>&1; then
            kill "$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null
            log_success "SSE server stopped (PID: $pid)"
            stopped=true
        fi
        rm -f "$PID_FILE"
    fi
    
    # Kill any remaining Node.js processes running our server
    pkill -f "mock-sse-server.js" 2>/dev/null || true
    
    # Clean up server file
    if [[ -f "$SCRIPT_DIR/mock-sse-server.js" ]]; then
        rm -f "$SCRIPT_DIR/mock-sse-server.js"
        log "Cleaned up server file"
    fi
    
    if [[ "$stopped" == "true" ]]; then
        log_success "Mock SSE server stopped successfully"
    else
        log_warning "No running server found"
    fi
}

# Show server status
show_status() {
    echo "Mock SSE Server Status:"
    echo "======================"
    
    if [[ -f "$PID_FILE" ]]; then
        local pid=$(cat "$PID_FILE")
        if ps -p "$pid" > /dev/null 2>&1; then
            echo -e "Status: ${GREEN}Running${NC} (PID: $pid)"
            echo "Server URL: http://127.0.0.1:$SSE_PORT"
            
            # Test server accessibility
            if curl -s "http://127.0.0.1:$SSE_PORT$HEALTH_ENDPOINT" > /dev/null 2>&1; then
                echo -e "Health: ${GREEN}Healthy${NC}"
                
                # Get detailed status
                local status_response=$(curl -s "http://127.0.0.1:$SSE_PORT$STATUS_ENDPOINT" 2>/dev/null)
                if [[ -n "$status_response" ]]; then
                    echo "Server Details:"
                    echo "$status_response" | jq . 2>/dev/null || echo "$status_response"
                fi
            else
                echo -e "Health: ${RED}Not Responding${NC}"
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
    
    echo
    echo "Configuration:"
    echo "  Port: $SSE_PORT"
    echo "  Host: $SSE_HOST"
    echo "  Stream Endpoint: $STREAM_ENDPOINT"
    echo "  Status Endpoint: $STATUS_ENDPOINT"
    echo "  Health Endpoint: $HEALTH_ENDPOINT"
    echo "  Max Connections: $MAX_CONNECTIONS"
    echo
    echo "Log file: $LOG_FILE"
    if [[ -f "$LOG_FILE" ]]; then
        echo "Log size: $(du -h "$LOG_FILE" | cut -f1)"
        echo "Last 3 log entries:"
        tail -n 3 "$LOG_FILE" 2>/dev/null || echo "  (no recent entries)"
    fi
}

# Test the SSE server
test_server() {
    log "Testing Mock SSE Server..."
    
    if [[ ! -f "$PID_FILE" ]]; then
        log_error "Mock SSE server is not running"
        echo "Start the server first with: $0 start"
        exit 1
    fi
    
    local pid=$(cat "$PID_FILE")
    if ! ps -p "$pid" > /dev/null 2>&1; then
        log_error "Mock SSE server is not running (stale PID)"
        rm -f "$PID_FILE"
        exit 1
    fi
    
    local base_url="http://127.0.0.1:$SSE_PORT"
    
    echo "Testing SSE server: $base_url"
    echo
    
    # Test health endpoint
    log "Testing health endpoint..."
    if curl -s "$base_url$HEALTH_ENDPOINT" | jq . > /dev/null 2>&1; then
        log_success "Health endpoint is accessible"
    else
        log_error "Health endpoint is not accessible"
        exit 1
    fi
    
    # Test status endpoint
    log "Testing status endpoint..."
    if curl -s "$base_url$STATUS_ENDPOINT" | jq . > /dev/null 2>&1; then
        log_success "Status endpoint is accessible"
    else
        log_error "Status endpoint is not accessible"
        exit 1
    fi
    
    # Test SSE stream (brief connection)
    log "Testing SSE stream endpoint..."
    if timeout 5 curl -N -s "$base_url$STREAM_ENDPOINT" | head -n 5 > /dev/null 2>&1; then
        log_success "SSE stream endpoint is accessible"
    else
        log_warning "SSE stream endpoint may not be immediately accessible"
    fi
    
    # Test POST endpoint
    log "Testing POST endpoint..."
    local test_data='{"test": "data", "timestamp": "'$(date -Iseconds)'"}'
    if curl -s -X POST -H "Content-Type: application/json" -d "$test_data" "$base_url$STREAM_ENDPOINT" | jq . > /dev/null 2>&1; then
        log_success "POST endpoint is accessible"
    else
        log_error "POST endpoint is not accessible"
        exit 1
    fi
    
    echo
    log_success "All tests passed successfully"
    
    echo
    echo "Server URLs:"
    echo "  Main: $base_url"
    echo "  SSE Stream: $base_url$STREAM_ENDPOINT"
    echo "  Status: $base_url$STATUS_ENDPOINT"
    echo "  Health: $base_url$HEALTH_ENDPOINT"
}

# Show usage information
show_usage() {
    echo "Mock SSE Server for Testing RTSP-SSE Integration"
    echo "Usage: $0 [COMMAND]"
    echo
    echo "Commands:"
    echo "  start                    Start the mock SSE server"
    echo "  stop                     Stop the mock SSE server"
    echo "  restart                  Restart the mock SSE server"
    echo "  status                   Show server status"
    echo "  test                     Test the SSE server endpoints"
    echo "  help                     Show this help message"
    echo
    echo "Environment Variables:"
    echo "  SSE_PORT                 Server port (default: 3000)"
    echo "  SSE_HOST                 Server host (default: 0.0.0.0)"
    echo "  STREAM_ENDPOINT          SSE stream endpoint (default: /stream)"
    echo "  STATUS_ENDPOINT          Status endpoint (default: /status)"
    echo "  HEALTH_ENDPOINT          Health endpoint (default: /health)"
    echo "  CORS_ORIGIN              CORS origin (default: *)"
    echo "  MAX_CONNECTIONS          Maximum connections (default: 100)"
    echo "  HEARTBEAT_INTERVAL       Heartbeat interval in seconds (default: 30)"
    echo "  CONNECTION_TIMEOUT       Connection timeout in seconds (default: 300)"
    echo
    echo "Examples:"
    echo "  $0 start                 Start with default settings"
    echo "  SSE_PORT=4000 $0 start   Start on custom port"
    echo "  $0 test                  Test all endpoints"
    echo
    echo "Integration with RTSP-SSE Script:"
    echo "  Configure your rtsp-sse-stream.conf with:"
    echo "    SSE_SERVER_URL=http://127.0.0.1:$SSE_PORT$STREAM_ENDPOINT"
    echo
}

# Main function
main() {
    local command="${1:-help}"
    
    case "$command" in
        "start")
            check_dependencies
            check_running
            check_port
            start_server
            ;;
        "stop")
            stop_server
            ;;
        "restart")
            stop_server
            sleep 2
            check_dependencies
            check_port
            start_server
            ;;
        "status")
            show_status
            ;;
        "test")
            test_server
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