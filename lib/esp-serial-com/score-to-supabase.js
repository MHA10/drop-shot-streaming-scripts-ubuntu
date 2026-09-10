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

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const fs = require('fs'); const path = require('path');

// Reuse THIS repo's own .env (repo root, two levels up) so the Supabase URL / key /
// table already configured for this box are picked up automatically — no separate
// setup. Shell env still wins over the file (only missing vars are filled).
for (const envPath of [path.join(__dirname, '..', '..', '.env'), path.join(process.cwd(), '.env')]) {
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

function onLine(portPath, rawLine) {
  let p;
  try { p = JSON.parse(rawLine); } catch { return; }              // ignore non-JSON noise
  if (!p || typeof p !== 'object' || p.type !== 'score') return;  // guard null / non-object / other packet types
  if (p.courtId == null || [p.scoreA, p.scoreB, p.gamesA, p.gamesB].some(v => typeof v !== 'number')) return;
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
