// DropShot scoreboard serial test harness.
//
// Talks to an ESP32 leader over USB serial using the JSON protocol
// documented in STREAMER_INTEGRATION.md (repo root of the Arduino project).
// Auto-detects/reconnects to the ESP32 exactly like the original scratch
// version of this tool did; adds JSON-aware logging of uplink traffic
// (score/heartbeat/log) and a stdin REPL for sending downlink "names"
// commands, so the full reverse path (streamer -> ESP32 -> mesh -> ESP8266
// -> Arduino) can be exercised from a desk before the real streamer exists.

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const readline = require('readline');

const BAUD_RATE = 115200;

// Optional: restrict to ports whose path contains this substring, e.g.
// PORT_FILTER=599C0042731 node index.js
// Useful when other USB-serial devices (ESP8266 debug, Arduino FTDI) are
// attached that this harness must not open or write to.
const PORT_FILTER = process.env.PORT_FILTER || null;

const connectedPorts = new Map(); // portPath -> SerialPort

async function scanAndConnect() {
  const ports = await SerialPort.list();

  const espPorts = ports.filter(p =>
    // Linux exposes the serial number as a field rather than in the path, so
    // match the filter against either.
    (!PORT_FILTER || p.path.includes(PORT_FILTER) ||
      (p.serialNumber && p.serialNumber.includes(PORT_FILTER))) &&
    ((p.manufacturer && (
      p.manufacturer.includes('Silicon Labs') ||
      p.manufacturer.includes('wch.cn') ||
      p.manufacturer.includes('QinHeng')
    )) ||
    // On Linux the WCH bridge reports the bare USB vendor ID instead of a name.
    p.vendorId === '1a86' ||
    p.path.includes('usbserial') ||
    p.path.includes('ttyUSB') ||
    p.path.includes('ttyACM'))
  );

  if (espPorts.length === 0) {
    if (connectedPorts.size === 0) {
      console.log('[SCAN] No ESP32 devices found. Retrying in 5 seconds...');
    }
    return;
  }

  for (const portInfo of espPorts) {
    const portPath = portInfo.path;
    if (connectedPorts.has(portPath)) continue;

    console.log(`[SUCCESS] Auto-detected new ESP32 on port: ${portPath}`);
    connectToDevice(portPath);
  }
}

function logUplinkLine(portPath, rawLine) {
  let parsed;
  try {
    parsed = JSON.parse(rawLine);
  } catch (e) {
    console.log(`[RAW ${portPath}] ${rawLine}`);
    return;
  }

  const prefix = `[${(parsed.type || 'unknown').toUpperCase()} ${portPath}]`;
  switch (parsed.type) {
    case 'score':
      console.log(`${prefix} court=${parsed.courtId} node=${parsed.nodeId} mode=${parsed.mode} ${parsed.scoreA}-${parsed.scoreB} games=${parsed.gamesA}-${parsed.gamesB}`);
      break;
    case 'heartbeat':
      console.log(`${prefix} source=${parsed.source}${parsed.courtId ? ' court=' + parsed.courtId : ''}${parsed.nodeId ? ' node=' + parsed.nodeId : ''}`);
      break;
    case 'log':
      console.log(`${prefix} [${parsed.level}] source=${parsed.source}${parsed.courtId ? ' court=' + parsed.courtId : ''}: ${parsed.message}`);
      break;
    default:
      console.log(`${prefix} ${rawLine}`);
  }
}

function connectToDevice(portPath) {
  connectedPorts.set(portPath, null); // reserve immediately to avoid a double-connect race

  const port = new SerialPort({
    path: portPath,
    baudRate: BAUD_RATE,
    autoOpen: true
  });

  connectedPorts.set(portPath, port);

  const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

  port.on('open', () => {
    console.log(`[INFO] Port ${portPath} opened successfully.`);
  });

  parser.on('data', (rawLine) => {
    logUplinkLine(portPath, rawLine);
  });

  port.on('error', (err) => {
    console.error(`[ERROR ${portPath}] Serial port issue: `, err.message);
  });

  port.on('close', () => {
    console.log(`[WARNING] Device on ${portPath} disconnected. Resuming background scan...`);
    connectedPorts.delete(portPath);
  });
}

// Sends a downlink JSON payload (one line) to every currently connected
// ESP32. Fine for a desk test rig with a single device attached; if more
// than one is connected it just fans out to all of them.
function sendDownlink(obj) {
  const line = JSON.stringify(obj);
  if (connectedPorts.size === 0) {
    console.log('[REPL] No ESP32 connected - nothing to send.');
    return;
  }
  for (const [portPath, port] of connectedPorts) {
    if (!port) continue;
    port.write(line + '\n');
    console.log(`[SENT ${portPath}] ${line}`);
  }
}

function printHelp() {
  console.log(`
Commands:
  names <courtId> <sideA> :: <sideB>   Send names for a court, e.g.
                                        names CRT-001 JOHN & MIKE :: ALEX & SAM
  clear <courtId>                      Clear names for a court (reverts board
                                        to its current/default flow)
  {"type":"names",...}                 Send raw JSON as-is
  help                                 Show this message
`);
}

function handleReplLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  if (trimmed === 'help') {
    printHelp();
    return;
  }

  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      sendDownlink(obj);
    } catch (e) {
      console.log(`[REPL] Invalid JSON: ${e.message}`);
    }
    return;
  }

  const clearMatch = trimmed.match(/^clear\s+(\S+)$/i);
  if (clearMatch) {
    sendDownlink({ type: 'names', courtId: clearMatch[1], sideA: null, sideB: null });
    return;
  }

  const namesMatch = trimmed.match(/^names\s+(\S+)\s+(.+?)\s*::\s*(.+)$/i);
  if (namesMatch) {
    const [, courtId, sideA, sideB] = namesMatch;
    sendDownlink({ type: 'names', courtId, sideA, sideB });
    return;
  }

  console.log(`[REPL] Unrecognized command. Type "help" for usage.`);
}

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

async function backgroundScanLoop() {
  do {
    await scanAndConnect();
    await delay(5000);
  } while (true);
}

function startRepl() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  printHelp();
  rl.on('line', handleReplLine);
}

async function main() {
  console.log('[SYSTEM] Starting DropShot scoreboard serial test harness...');
  startRepl();
  await backgroundScanLoop();
}

main();
