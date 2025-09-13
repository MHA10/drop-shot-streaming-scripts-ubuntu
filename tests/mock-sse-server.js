#!/usr/bin/env node

/**
 * Mock SSE Server for RTSP-SSE Stream Testing
 * Simulates Server-Sent Events endpoint for parameter updates
 * Compatible with Node.js for cross-platform testing
 */

const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');

// Server configuration
const DEFAULT_PORT = 3000;
const DEFAULT_HOST = 'localhost';

// Test scenarios for parameter updates
const TEST_SCENARIOS = {
  basic: {
    name: 'Basic Parameter Updates',
    events: [
      { delay: 1000, data: { tsp: '2000', ramp: '2500' } },
      { delay: 3000, data: { tsp: '3000', ramp: '3500' } },
      { delay: 5000, data: { tsp: '1500', ramp: '2000' } }
    ]
  },
  stress: {
    name: 'Stress Test - Rapid Updates',
    events: [
      { delay: 500, data: { tsp: '1000' } },
      { delay: 1000, data: { ramp: '1500' } },
      { delay: 1500, data: { tsp: '2000', ramp: '2500' } },
      { delay: 2000, data: { tsp: '3000' } },
      { delay: 2500, data: { ramp: '3500' } },
      { delay: 3000, data: { tsp: '2500', ramp: '3000' } }
    ]
  },
  edge_cases: {
    name: 'Edge Cases and Invalid Data',
    events: [
      { delay: 1000, data: { tsp: '0' } }, // Minimum value
      { delay: 2000, data: { tsp: '10000' } }, // High value
      { delay: 3000, data: { invalid: 'data' } }, // Invalid parameter
      { delay: 4000, data: { tsp: 'invalid' } }, // Invalid value type
      { delay: 5000, data: { tsp: '2000', ramp: '2500' } } // Valid recovery
    ]
  },
  realistic: {
    name: 'Realistic Streaming Scenario',
    events: [
      { delay: 2000, data: { tsp: '1500', ramp: '2000' } }, // Low quality start
      { delay: 10000, data: { tsp: '2500', ramp: '3000' } }, // Increase quality
      { delay: 20000, data: { tsp: '4000', ramp: '5000' } }, // High quality
      { delay: 30000, data: { tsp: '3000', ramp: '3500' } }, // Reduce due to bandwidth
      { delay: 40000, data: { tsp: '2000', ramp: '2500' } }  // Further reduction
    ]
  }
};

class MockSSEServer {
  constructor(options = {}) {
    this.port = options.port || DEFAULT_PORT;
    this.host = options.host || DEFAULT_HOST;
    this.scenario = options.scenario || 'basic';
    this.clients = new Set();
    this.server = null;
    this.eventTimeouts = [];
    this.isRunning = false;
    this.stats = {
      connections: 0,
      eventsSent: 0,
      startTime: null
    };
  }

  // Start the SSE server
  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`❌ Port ${this.port} is already in use`);
          reject(err);
        } else {
          console.error('❌ Server error:', err.message);
          reject(err);
        }
      });

      this.server.listen(this.port, this.host, () => {
        this.isRunning = true;
        this.stats.startTime = new Date();
        console.log(`🚀 Mock SSE Server started on http://${this.host}:${this.port}`);
        console.log(`📋 Running scenario: ${TEST_SCENARIOS[this.scenario].name}`);
        console.log(`📡 SSE endpoint: http://${this.host}:${this.port}/events`);
        console.log(`📊 Status page: http://${this.host}:${this.port}/status`);
        console.log('\n⏳ Waiting for SSE connections...');
        resolve();
      });
    });
  }

  // Stop the server
  stop() {
    return new Promise((resolve) => {
      if (!this.isRunning) {
        resolve();
        return;
      }

      // Clear all event timeouts
      this.eventTimeouts.forEach(timeout => clearTimeout(timeout));
      this.eventTimeouts = [];

      // Close all client connections
      this.clients.forEach(client => {
        try {
          client.end();
        } catch (err) {
          // Ignore errors when closing connections
        }
      });
      this.clients.clear();

      // Close the server
      this.server.close(() => {
        this.isRunning = false;
        console.log('\n🛑 Mock SSE Server stopped');
        resolve();
      });
    });
  }

  // Handle HTTP requests
  handleRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // Enable CORS for all requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cache-Control');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    switch (pathname) {
      case '/events':
        this.handleSSEConnection(req, res);
        break;
      case '/status':
        this.handleStatusRequest(req, res);
        break;
      case '/trigger':
        this.handleTriggerRequest(req, res, parsedUrl.query);
        break;
      case '/':
        this.handleRootRequest(req, res);
        break;
      default:
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
  }

  // Handle SSE connections
  handleSSEConnection(req, res) {
    console.log(`🔗 New SSE connection from ${req.connection.remoteAddress}`);
    this.stats.connections++;

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    // Send initial connection message
    this.sendSSEEvent(res, 'connected', { message: 'SSE connection established', scenario: this.scenario });

    // Add client to the set
    this.clients.add(res);

    // Start sending events for this scenario
    this.startScenario(res);

    // Handle client disconnect
    req.on('close', () => {
      console.log(`🔌 SSE connection closed`);
      this.clients.delete(res);
    });

    req.on('error', (err) => {
      console.log(`❌ SSE connection error: ${err.message}`);
      this.clients.delete(res);
    });
  }

  // Start sending events for the selected scenario
  startScenario(client) {
    const scenario = TEST_SCENARIOS[this.scenario];
    if (!scenario) {
      console.error(`❌ Unknown scenario: ${this.scenario}`);
      return;
    }

    console.log(`▶️  Starting scenario: ${scenario.name}`);

    scenario.events.forEach((event, index) => {
      const timeout = setTimeout(() => {
        if (this.clients.has(client)) {
          console.log(`📤 Sending event ${index + 1}/${scenario.events.length}:`, event.data);
          this.sendSSEEvent(client, 'parameter_update', event.data);
          this.stats.eventsSent++;
        }
      }, event.delay);

      this.eventTimeouts.push(timeout);
    });

    // Send completion event
    const completionTimeout = setTimeout(() => {
      if (this.clients.has(client)) {
        this.sendSSEEvent(client, 'scenario_complete', { 
          scenario: this.scenario,
          events_sent: scenario.events.length 
        });
        console.log(`✅ Scenario '${scenario.name}' completed`);
      }
    }, Math.max(...scenario.events.map(e => e.delay)) + 1000);

    this.eventTimeouts.push(completionTimeout);
  }

  // Send SSE event to client
  sendSSEEvent(client, eventType, data) {
    try {
      const eventData = JSON.stringify(data);
      client.write(`event: ${eventType}\n`);
      client.write(`data: ${eventData}\n\n`);
    } catch (err) {
      console.error(`❌ Error sending SSE event: ${err.message}`);
    }
  }

  // Handle status request
  handleStatusRequest(req, res) {
    const uptime = this.stats.startTime ? Date.now() - this.stats.startTime.getTime() : 0;
    const status = {
      server: {
        running: this.isRunning,
        uptime: Math.floor(uptime / 1000),
        host: this.host,
        port: this.port
      },
      scenario: {
        current: this.scenario,
        available: Object.keys(TEST_SCENARIOS)
      },
      stats: {
        ...this.stats,
        activeConnections: this.clients.size,
        startTime: this.stats.startTime ? this.stats.startTime.toISOString() : null
      }
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
  }

  // Handle manual trigger request
  handleTriggerRequest(req, res, query) {
    const { tsp, ramp } = query;
    
    if (!tsp && !ramp) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing tsp or ramp parameter' }));
      return;
    }

    const data = {};
    if (tsp) data.tsp = tsp;
    if (ramp) data.ramp = ramp;

    // Send to all connected clients
    this.clients.forEach(client => {
      this.sendSSEEvent(client, 'manual_trigger', data);
    });

    console.log(`🎯 Manual trigger sent:`, data);
    this.stats.eventsSent++;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data }));
  }

  // Handle root request with simple HTML interface
  handleRootRequest(req, res) {
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Mock SSE Server</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .container { max-width: 800px; }
        .endpoint { background: #f5f5f5; padding: 10px; margin: 10px 0; border-radius: 5px; }
        .scenario { background: #e8f4fd; padding: 15px; margin: 10px 0; border-radius: 5px; }
        button { background: #007cba; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; }
        button:hover { background: #005a87; }
        input { padding: 8px; margin: 5px; border: 1px solid #ccc; border-radius: 3px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Mock SSE Server</h1>
        <p>Server running on <strong>http://${this.host}:${this.port}</strong></p>
        
        <h2>📡 Endpoints</h2>
        <div class="endpoint">
            <strong>SSE Stream:</strong> <code>/events</code><br>
            <small>Connect your RTSP script to this endpoint</small>
        </div>
        <div class="endpoint">
            <strong>Status:</strong> <code>/status</code><br>
            <small>JSON status information</small>
        </div>
        <div class="endpoint">
            <strong>Manual Trigger:</strong> <code>/trigger?tsp=VALUE&ramp=VALUE</code><br>
            <small>Manually send parameter updates</small>
        </div>
        
        <h2>🎯 Manual Trigger</h2>
        <div>
            <input type="number" id="tsp" placeholder="TSP value" min="0" max="10000">
            <input type="number" id="ramp" placeholder="RAMP value" min="0" max="10000">
            <button onclick="sendTrigger()">Send Parameters</button>
        </div>
        
        <h2>📋 Current Scenario: ${TEST_SCENARIOS[this.scenario].name}</h2>
        <div class="scenario">
            <h3>Events:</h3>
            <ul>
                ${TEST_SCENARIOS[this.scenario].events.map((event, i) => 
                  `<li>After ${event.delay}ms: ${JSON.stringify(event.data)}</li>`
                ).join('')}
            </ul>
        </div>
        
        <h2>📊 Available Scenarios</h2>
        ${Object.entries(TEST_SCENARIOS).map(([key, scenario]) => 
          `<div class="scenario">
             <strong>${key}:</strong> ${scenario.name}<br>
             <small>${scenario.events.length} events</small>
           </div>`
        ).join('')}
    </div>
    
    <script>
        function sendTrigger() {
            const tsp = document.getElementById('tsp').value;
            const ramp = document.getElementById('ramp').value;
            
            if (!tsp && !ramp) {
                alert('Please enter at least one parameter value');
                return;
            }
            
            const params = new URLSearchParams();
            if (tsp) params.append('tsp', tsp);
            if (ramp) params.append('ramp', ramp);
            
            fetch('/trigger?' + params.toString())
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        alert('Parameters sent successfully!');
                    } else {
                        alert('Error: ' + data.error);
                    }
                })
                .catch(err => alert('Error: ' + err.message));
        }
    </script>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }
}

// CLI interface
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    scenario: 'basic'
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port':
      case '-p':
        options.port = parseInt(args[++i]) || DEFAULT_PORT;
        break;
      case '--host':
      case '-h':
        options.host = args[++i] || DEFAULT_HOST;
        break;
      case '--scenario':
      case '-s':
        options.scenario = args[++i] || 'basic';
        break;
      case '--help':
        showHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        showHelp();
        process.exit(1);
    }
  }

  return options;
}

function showHelp() {
  console.log(`
Mock SSE Server for RTSP-SSE Stream Testing

Usage: node mock-sse-server.js [options]

Options:
  -p, --port <number>     Server port (default: ${DEFAULT_PORT})
  -h, --host <string>     Server host (default: ${DEFAULT_HOST})
  -s, --scenario <name>   Test scenario (default: basic)
  --help                  Show this help message

Available scenarios:
${Object.entries(TEST_SCENARIOS).map(([key, scenario]) => 
  `  ${key.padEnd(12)} ${scenario.name}`
).join('\n')}

Examples:
  node mock-sse-server.js
  node mock-sse-server.js --port 8080 --scenario stress
  node mock-sse-server.js --host 0.0.0.0 --scenario realistic
`);
}

// Main execution
if (require.main === module) {
  const options = parseArgs();
  
  // Validate scenario
  if (!TEST_SCENARIOS[options.scenario]) {
    console.error(`❌ Unknown scenario: ${options.scenario}`);
    console.error(`Available scenarios: ${Object.keys(TEST_SCENARIOS).join(', ')}`);
    process.exit(1);
  }
  
  const server = new MockSSEServer(options);
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    await server.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    await server.stop();
    process.exit(0);
  });
  
  // Start the server
  server.start().catch((err) => {
    console.error('❌ Failed to start server:', err.message);
    process.exit(1);
  });
}

module.exports = MockSSEServer;