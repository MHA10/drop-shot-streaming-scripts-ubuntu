// score-to-supabase.js — read live scores off the ESP32 (serial) and write them
// straight into the Supabase `score_board` row the stream overlay reads.
//
// ── IN SIMPLE WORDS ──
// The scoreboard hardware sends the current score to this box over USB. This
// script grabs each score and updates the matching court's row in Supabase. The
// stream overlay is already watching that row, so the moment the row changes,
// the on-screen score changes. This is the quick, direct path (box → Supabase),
// bypassing the backend — meant for getting a venue live fast (e.g. a tournament).
//
// ── BUSINESS RULES ──
// - One Supabase row per court, keyed by `court_id`. The ESP32's `courtId` is used
//   as the key unless you remap it (COURT_MAP), because the venue's Supabase row
//   ids may differ from the on-court ids.
// - It UPDATEs an EXISTING row (the overlay fires on UPDATE, not INSERT). If the
//   row for a court_id does not exist yet, the write hits 0 rows and is logged
//   loudly — that means: create the row in Supabase first (your manual step).
// - Columns written: red_score=scoreA, blue_score=scoreB, red_games=gamesA,
//   blue_games=gamesB. Matches SupabaseListener.extractScore() exactly.
//
// ── WHY IT'S BUILT THIS WAY (change at your peril) ──
// - Writes via Supabase's REST API with plain fetch (no npm install needed) so it
//   drops onto the box and runs. Use the SERVICE_ROLE key: row-level security will
//   silently reject an anon-key UPDATE (0 rows, no error) and the overlay never moves.
// - Identical consecutive scores are suppressed, so we don't spam writes / realtime
//   events for every duplicate heartbeat.
// - Health pings (heartbeat / log / button) are PRINTED to stdout so `pm2 logs`
//   shows whether the hardware chain is alive, but never written to Supabase.
//   This process owns the serial port, so it is the only place those packets can
//   be seen on a running box - the index.js harness cannot run beside it.
//   Set HEALTH_LOGS=0 to silence them.
//
// ── DO NOT ──
// - Do NOT run this at the same time as the main streamer app or the index.js test
//   harness: a serial port has ONE owner. Pick one reader.
// - Do NOT commit the SERVICE_ROLE key. Put it in the box's environment only.
//
// RUN:
//   SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_SERVICE_KEY=eyJ... \
//   node score-to-supabase.js
// OPTIONAL env:
//   SUPABASE_TABLE_NAME=score_board            (default score_board)
//   PORT_FILTER=599C0042731                    (restrict to one USB device)
//   COURT_MAP=CRT-001:uuid-a,CRT-002:uuid-b    (ESP courtId -> Supabase court_id UUID)
//   HEALTH_LOGS=0                              (don't print heartbeat/log/button packets)

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const fs = require('fs'); const path = require('path');

// Reuse THIS repo's own .env (repo root, two levels up) so the Supabase URL / key /
// table already configured for this box are picked up automatically — no separate
// setup. Shell env still wins over the file (only missing vars are filled).
for (const envPath of [path.join(__dirname, '.env'), path.join(__dirname, '..', '..', '.env'), path.join(process.cwd(), '.env')]) {
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env here — rely on shell env */ }
}

const BAUD_RATE = 115200;
const PORT_FILTER = process.env.PORT_FILTER || null;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';
const TABLE = process.env.SUPABASE_TABLE_NAME || 'score_board';
const HEALTH_LOGS = process.env.HEALTH_LOGS !== '0';
const COURT_MAP = Object.fromEntries(
  (process.env.COURT_MAP || '').split(',').map(s => s.trim()).filter(Boolean).map(p => p.split(':'))
);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[FATAL] Set SUPABASE_URL and a Supabase key (SUPABASE_ANON_KEY works; SUPABASE_SERVICE_KEY overrides).');
  process.exit(1);
}
if (!/^https:\/\//i.test(SUPABASE_URL)) {
  console.error(`[FATAL] SUPABASE_URL must be https:// — refusing to send the key over cleartext (${SUPABASE_URL}).`);
  process.exit(1);
}
console.log(`[SYSTEM] score-to-supabase → ${SUPABASE_URL} table=${TABLE}`);

const connectedPorts = new Map();
const lastByCourt = new Map(); // court_id -> fingerprint, to suppress identical repeats
const writeChain = new Map();  // court_id -> tail promise, to serialise writes per court

async function updateSupabase(courtIdRaw, scoreA, scoreB, gamesA, gamesB) {
  const court_id = COURT_MAP[courtIdRaw] || courtIdRaw;
  const fingerprint = `${scoreA}|${scoreB}|${gamesA}|${gamesB}`;
  if (lastByCourt.get(court_id) === fingerprint) return;         // no change → no write

  const body = { red_score: scoreA, blue_score: scoreB, red_games: gamesA, blue_games: gamesB };
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}?court_id=eq.${encodeURIComponent(court_id)}`;
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      redirect: 'error',                             // never follow a redirect with the key attached
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',            // so we can see how many rows matched
      },
      body: JSON.stringify(body),
    });
    const rows = res.ok ? await res.json().catch(() => []) : null;
    if (res.ok && Array.isArray(rows) && rows.length > 0) {
      lastByCourt.set(court_id, fingerprint);
      console.log(`[SUPABASE] court=${court_id} ${scoreA}-${scoreB} games=${gamesA}-${gamesB} ✓`);
    } else if (res.ok) {
      console.warn(`[SUPABASE] court=${court_id}: 0 rows updated — no such row. Create it in Supabase first (court_id="${court_id}").`);
    } else {
      console.error(`[SUPABASE] court=${court_id}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    }
  } catch (err) {
    console.error(`[SUPABASE] court=${court_id}: ${err.message}`);
  }
}

// Serialise writes per court so a slower older PATCH can't land after a newer one;
// different courts still write concurrently.
function enqueueUpdate(courtIdRaw, scoreA, scoreB, gamesA, gamesB) {
  const key = COURT_MAP[courtIdRaw] || courtIdRaw;
  const prev = writeChain.get(key) || Promise.resolve();
  const next = prev.then(() => updateSupabase(courtIdRaw, scoreA, scoreB, gamesA, gamesB)).catch(() => {});
  writeChain.set(key, next);
}

// Health pings: printed so `pm2 logs` shows whether each link in the chain is
// alive, never forwarded to Supabase. Which heartbeat sources are missing tells
// you where the chain is broken: no ARDUINO = Arduino<->ESP8266 wire; no ESP8266 =
// that court is off the mesh; no ESP32 = the USB link itself.
function logHealth(portPath, p) {
  const court = p.courtId ? ` court=${p.courtId}` : '';
  const node = p.nodeId ? ` node=${p.nodeId}` : '';
  switch (p.type) {
    case 'heartbeat': {
      // Optional link-quality fields added by newer firmware; printed only if present.
      const extra = ['peers', 'rootAgeMs', 'namesFp']
        .filter(k => p[k] != null).map(k => ` ${k}=${p[k]}`).join('');
      console.log(`[HEARTBEAT ${portPath}] source=${p.source}${court}${node}${extra}`);
      return true;
    }
    case 'log':
      console.log(`[LOG ${portPath}] [${p.level}] source=${p.source}${court}${node}: ${p.message}`);
      return true;
    case 'button':
      console.log(`[BUTTON ${portPath}]${court}${node} event=${p.event} seq=${p.seq}`);
      return true;
    default:
      return false;
  }
}

function onLine(portPath, rawLine) {
  let p;
  try { p = JSON.parse(rawLine); } catch { return; }              // ignore non-JSON noise
  if (!p || typeof p !== 'object') return;                        // guard null / non-object
  if (p.type !== 'score') {                                       // health pings: print, don't write
    if (HEALTH_LOGS) logHealth(portPath, p);
    return;
  }
  // require the fields to be present, but NOT numeric — tennis sends "AD", and the
  // firmware may send scores as strings; dropping those would freeze the overlay.
  if (p.courtId == null || [p.scoreA, p.scoreB, p.gamesA, p.gamesB].some(v => v == null)) return;
  console.log(`[SCORE ${portPath}] court=${p.courtId} mode=${p.mode} ${p.scoreA}-${p.scoreB} games=${p.gamesA}-${p.gamesB}`);
  enqueueUpdate(p.courtId, p.scoreA, p.scoreB, p.gamesA, p.gamesB);
}

function connect(portPath) {
  connectedPorts.set(portPath, null);
  const port = new SerialPort({ path: portPath, baudRate: BAUD_RATE, autoOpen: true });
  connectedPorts.set(portPath, port);
  const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));
  port.on('open', () => console.log(`[INFO] Port ${portPath} opened.`));
  parser.on('data', (line) => onLine(portPath, line));
  port.on('error', (e) => console.error(`[ERROR ${portPath}] ${e.message}`));
  port.on('close', () => { console.log(`[WARN] ${portPath} disconnected; rescanning.`); connectedPorts.delete(portPath); });
}

async function scan() {
  const ports = await SerialPort.list();
  const esp = ports.filter(p => {
    const filterOk = !PORT_FILTER || p.path.includes(PORT_FILTER) || (p.serialNumber && p.serialNumber.includes(PORT_FILTER));
    const knownChip = (p.manufacturer && /Silicon Labs|wch\.cn|QinHeng/.test(p.manufacturer)) || p.vendorId === '1a86';
    const pathHint = /usbserial|ttyUSB|ttyACM/.test(p.path);
    // Require a recognised ESP bridge chip. A bare tty path counts only when the user
    // narrowed to it with PORT_FILTER — so an unrelated serial device on a multi-device
    // box is never opened by name alone.
    return filterOk && (knownChip || (PORT_FILTER && pathHint));
  });
  if (esp.length === 0) { if (connectedPorts.size === 0) console.log('[SCAN] No ESP32 found; retrying in 5s...'); return; }
  for (const info of esp) if (!connectedPorts.has(info.path)) { console.log(`[SUCCESS] ESP32 on ${info.path}`); connect(info.path); }
}

(async function main() {
  console.log('[SYSTEM] Starting score-to-supabase forwarder...');
  for (;;) { await scan(); await new Promise(r => setTimeout(r, 5000)); }
})();
