#!/usr/bin/env node
/**
 * Match log: notes every team-name and score change on each court, and turns
 * them into a list of matches (who played, when it started, when it ended).
 *
 * ── IN SIMPLE WORDS ──
 * Each court has one scoreboard row in Supabase (`score_board`): the two team
 * names and the score. When staff start a match, the backend writes the team
 * names there; every point updates the score. Supabase pushes each change to
 * anyone listening, the same way the scoreboard on the stream gets it. This
 * program listens, writes every change to a file with the box's time, and
 * keeps a plain list of matches next to it. The stats steps then cut the day's
 * recording into matches using that list.
 *
 * ── BUSINESS RULES ──
 * - Source is ONLY the Supabase `score_board` row (decision 2026-11-21, tournament
 *   eve: "minimum changes, Supabase update it is"). No backend, streamer or
 *   dropshot-score change is needed for this to work.
 * - A match STARTS at its first point after new team names appear; the minutes
 *   between "names set" and the first point are warm-up and are left out.
 * - A match ENDS 1 minute after its last point. The backend's "end match" does
 *   not touch `score_board` (ds-backend live-scoring endMatch), so the next
 *   match's names, names being cleared, or the log stopping close it.
 * - Names changed again within 2 minutes with no point in between = a typo fix,
 *   not a new match.
 * - Same names, but the score goes back down after 5+ minutes without a point =
 *   probably a new match (a new set has a shorter break). Marked "check".
 * - Anything guessed is marked "check" in matches.txt for a person to confirm.
 *   Nothing is lost by a wrong guess: the full video is recorded regardless.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - Listens to Supabase's pushed updates instead of asking every few seconds
 *   (Hamza, 2026-11-21: "polling will be an extra burden"). Pushes can be missed
 *   while the connection is down, so the two rows are read ONCE after every
 *   (re)connect; without that read, a match that started during a network blip
 *   would be missing until its next point.
 * - Times are the box's own clock, the same clock the recorder names its files
 *   with. Using Supabase's commit time instead would put the match cuts out of
 *   step with the video by however far the box clock drifts.
 * - events.jsonl is only ever added to, one line per change, flushed to disk
 *   each time; matches.txt/json are rebuilt from it. After a crash or power cut
 *   the list rebuilds itself from the file, and nothing in memory is needed.
 * - Plain Node 22 (built-in WebSocket and fetch), no packages: it installs by
 *   copying one file, and cannot break or be broken by the streamer's packages.
 *
 * ── DO NOT ──
 * - Do NOT write to Supabase from here. This is a reader; the scoreboard on the
 *   stream and the backend's own listener react to every write to that row.
 * - Do NOT print or log SUPABASE_ANON_KEY (it is read from the box's .env).
 * - Do NOT start it with the streamer's pm2 name or folder; it runs as its own
 *   process so stopping it can never touch the live stream or the reels.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const CORRECTION_MS = 2 * 60_000;
export const END_PAD_MS = 60_000;
export const NEW_MATCH_GAP_MS = 5 * 60_000;
export const IDLE_END_MS = 15 * 60_000;
const HEARTBEAT_MS = 25_000;
const DEAD_AFTER_MS = 60_000;
const JOIN_TIMEOUT_MS = 15_000;
const ALIVE_EVERY_MS = 10 * 60_000;
const BACKOFF_S = [1, 2, 5, 10, 30];
const FIELDS = ['red_team', 'blue_team', 'red_score', 'blue_score', 'red_games', 'blue_games', 'mode'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- time ----------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
/** Box-local time with its offset, e.g. 2026-11-22T18:02:40+05:00. */
export function isoLocal(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
const hms = (ms) => isoLocal(ms).slice(11, 19);
const day = (ms) => isoLocal(ms).slice(0, 10);

// ---- one scoreboard row ----------------------------------------------------

/** The fields we track, with empty names as null and every value as text. */
export function snapOf(row) {
  const s = {};
  for (const f of FIELDS) {
    const v = row[f];
    s[f] = v === null || v === undefined ? null : String(v).replace(/[\r\n\t]+/g, ' ').trim();
    if ((f === 'red_team' || f === 'blue_team') && s[f] === '') s[f] = null;
  }
  return s;
}
const teamsKey = (s) => `${s.red_team ?? ''}\u0000${s.blue_team ?? ''}`;
const scoreKey = (s) => `${s.red_score}|${s.blue_score}|${s.red_games}|${s.blue_games}|${s.mode}`;
const hasTeams = (s) => !!(s.red_team || s.blue_team);
const num = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};
/** True when nothing has been played: 0/00 points and 0 games (or Americano's "|"). */
export function isZero(s) {
  return num(s.red_score) === 0 && num(s.blue_score) === 0 && num(s.red_games) === 0 && num(s.blue_games) === 0;
}
// How far into the match the score is. Standard: games won. Americano hides the
// games ("|") and counts points instead. Only used to see the score go DOWN.
const progress = (s) => (s.mode === 'americano' ? num(s.red_score) + num(s.blue_score) : num(s.red_games) + num(s.blue_games));
const scoreText = (s) => (s.mode === 'americano' ? `points ${s.red_score ?? '-'}-${s.blue_score ?? '-'}` :
  `games ${s.red_games ?? '-'}-${s.blue_games ?? '-'}, points ${s.red_score ?? '-'}-${s.blue_score ?? '-'}`);

// ---- events -> matches (pure, so it can be tested and rebuilt from disk) ----

/**
 * Turn the event list into matches per court. Events: {ms, kind, court, ...row}
 * with kind ROW (a court's row as pushed or read), START/STOP (this program),
 * LIVE/LOST (the Supabase connection) and ALIVE (still running).
 */
export function deriveMatches(events, nowMs = Date.now()) {
  const gaps = [];
  let lostAt = null;
  let lastMs = null;
  let started = false;
  const courts = new Map();
  const C = (label, id) => {
    if (!courts.has(label)) courts.set(label, { id, cur: null, prev: null, done: [] });
    return courts.get(label);
  };
  const open = (snap, ms) => ({ red_team: snap.red_team, blue_team: snap.blue_team, setAt: ms, namedAt: ms,
    firstPoint: null, lastPoint: null, last: snap, closedAt: null, checks: new Set(), notes: new Set() });
  const close = (c, ms) => {
    if (!c.cur) return;
    c.cur.closedAt = ms;
    c.done.push(c.cur);
    c.cur = null;
  };
  const point = (m, ms, snap) => {
    if (m.firstPoint === null) m.firstPoint = ms;
    m.lastPoint = ms;
    m.last = snap;
  };

  for (const e of events) {
    if (e.kind === 'START') {
      // Not listening between the last thing we heard (or the connection loss
      // that was still open when it stopped) and this start.
      if (lostAt !== null) gaps.push([lostAt, e.ms]);
      else if (started && lastMs !== null && e.ms - lastMs > DEAD_AFTER_MS) gaps.push([lastMs, e.ms]);
      started = true;
      lostAt = null;
    } else if (e.kind === 'LOST') {
      if (lostAt === null) lostAt = e.ms;
    } else if (e.kind === 'LIVE') {
      if (lostAt !== null) gaps.push([lostAt, e.ms]);
      lostAt = null;
    } else if (e.kind === 'ROW') {
      const c = C(e.court, e.court_id);
      const snap = snapOf(e);
      const prev = c.prev;
      c.prev = snap;
      if (prev === null) {
        // First sight of this court: it may already be mid-match. (A restart
        // is not a first sight: the row carries on from the last one in the
        // file, so a pm2 restart mid-match does not split the match in two.)
        if (hasTeams(snap) || !isZero(snap)) {
          c.cur = open(snap, e.ms);
          if (!isZero(snap)) {
            point(c.cur, e.ms, snap);
            c.cur.checks.add('the log started during this match, so its real start is earlier');
          }
          if (!hasTeams(snap)) c.cur.checks.add('no team names');
        }
        lastMs = e.ms;
        continue;
      }
      if (teamsKey(snap) !== teamsKey(prev)) {
        const m = c.cur;
        if (!hasTeams(snap)) {
          close(c, e.ms);
        } else if (m && m.firstPoint === null && e.ms - m.namedAt <= CORRECTION_MS) {
          m.red_team = snap.red_team;
          m.blue_team = snap.blue_team;
          m.namedAt = e.ms;
          m.notes.add('team names corrected before play');
        } else if (m && !hasTeams(m) && m.lastPoint !== null && e.ms - m.lastPoint < NEW_MATCH_GAP_MS) {
          // Play started before anyone set the names: they belong to this match.
          m.red_team = snap.red_team;
          m.blue_team = snap.blue_team;
          m.checks.delete('no team names');
          m.notes.add('team names set after play started');
        } else {
          close(c, e.ms);
          c.cur = open(snap, e.ms);
        }
      }
      if (scoreKey(snap) !== scoreKey(prev) && !isZero(snap)) {
        if (!c.cur) {
          c.cur = open(snap, e.ms);
          c.cur.checks.add('no team names');
        } else if (c.cur.lastPoint !== null && progress(snap) < progress(c.cur.last) &&
                   e.ms - c.cur.lastPoint >= NEW_MATCH_GAP_MS) {
          const { red_team, blue_team } = c.cur;
          close(c, e.ms);
          c.cur = open({ ...snap, red_team, blue_team }, e.ms);
          c.cur.checks.add('same team names: a new match guessed from the score going back down after a long pause');
          if (!red_team && !blue_team) c.cur.checks.add('no team names');
        }
        point(c.cur, e.ms, snap);
      }
    }
    lastMs = e.ms;
  }
  if (lostAt !== null) gaps.push([lostAt, null]);

  const out = [];
  for (const [label, c] of courts) {
    const all = [...c.done, ...(c.cur ? [c.cur] : [])];
    let n = 0;
    for (const m of all) {
      if (m.firstPoint === null && !hasTeams(m)) continue;
      const startMs = m.firstPoint ?? m.setAt;
      let endMs = null;
      let endReason = null;
      const checks = [...m.checks];
      if (m.closedAt !== null) {
        endMs = m.lastPoint !== null ? Math.min(m.lastPoint + END_PAD_MS, m.closedAt) : m.closedAt;
        endReason = 'closed';
      } else if (m.lastPoint !== null && nowMs - m.lastPoint > IDLE_END_MS && lostAt === null) {
        // Still the court's latest match, but nothing scored for a long time (the
        // last match of the day): over at its last point. Not while the connection
        // is down: the points may be happening, just not reaching us.
        endMs = m.lastPoint + END_PAD_MS;
        endReason = 'idle';
        checks.push('no next match yet: ended by its last point');
      }
      if (m.firstPoint === null) {
        checks.push(m.closedAt === null ? 'no points yet' :
          'no scores: start and end are when the names were set and changed, so warm-up is included');
      }
      for (const [a, b] of gaps) {
        if (a < (endMs ?? nowMs) && (b ?? nowMs) > startMs) {
          checks.push(`the log was not listening ${hms(a)}–${b === null ? 'now' : hms(b)}`);
        }
      }
      out.push({
        id: `${label}-${m.setAt}`, court: label, court_id: c.id, n: ++n,
        state: endMs !== null ? 'ended' : m.firstPoint === null ? 'set' : 'playing', end_reason: endReason,
        start: isoLocal(startMs), end: endMs === null ? null : isoLocal(endMs), startMs, endMs,
        playing: endMs === null,
        last_point: m.lastPoint === null ? null : isoLocal(m.lastPoint),
        red_team: m.red_team, blue_team: m.blue_team,
        final: { red_score: m.last.red_score, blue_score: m.last.blue_score, red_games: m.last.red_games,
          blue_games: m.last.blue_games, mode: m.last.mode },
        checks, notes: [...m.notes],
      });
    }
  }
  return out;
}

export function matchesText(matches, nowMs = Date.now()) {
  const lines = [
    `Matches from the scoreboard (box clock). Updated ${isoLocal(nowMs).replace('T', ' ')}`,
    'A match starts at its first point after the team names are set, and ends 1 minute after its last point.',
    'Lines marked "check" were guessed: look at the video before trusting them.',
  ];
  const byCourt = new Map();
  for (const m of matches) (byCourt.get(m.court) ?? byCourt.set(m.court, []).get(m.court)).push(m);
  for (const [court, ms] of byCourt) {
    lines.push('', `${court}  (${ms[0].court_id})`);
    for (const m of ms) {
      const mins = Math.round(((m.endMs ?? nowMs) - m.startMs) / 60_000);
      const when = `${day(m.startMs)} ${hms(m.startMs)} → ${m.state === 'set' ? 'waiting for the first point' : m.playing ? 'playing' : hms(m.endMs)}`;
      const teams = `"${m.red_team ?? '?'}" (red) vs "${m.blue_team ?? '?'}" (blue)`;
      lines.push(`  ${String(m.n).padStart(2)}  ${when}  (${mins} min)  ${teams}  ${m.playing ? 'now' : 'final'}: ${scoreText(m.final)}`);
      for (const x of m.notes) lines.push(`        note: ${x}`);
      for (const x of m.checks) lines.push(`        check: ${x}`);
    }
  }
  if (!byCourt.size) lines.push('', '(no matches yet)');
  return lines.join('\n') + '\n';
}

// ---- files ------------------------------------------------------------------

export class EventLog {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'events.jsonl');
    this.events = [];
    let text = '';
    if (fs.existsSync(this.file)) {
      text = fs.readFileSync(this.file, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { this.events.push(JSON.parse(line)); } catch { /* a line cut off by a power cut: skip it */ }
      }
    }
    this.fd = fs.openSync(this.file, 'a');
    // A line cut off mid-write has no newline; without this the next line would
    // be glued onto it and both would be lost.
    if (text && !text.endsWith('\n')) fs.writeSync(this.fd, '\n');
  }

  /** Last row we saw per court label, so a restart does not repeat old changes. */
  lastRows() {
    const m = new Map();
    for (const e of this.events) if (e.kind === 'ROW') m.set(e.court, snapOf(e));
    return m;
  }

  add(e) {
    const full = { t: isoLocal(e.ms), ...e };
    this.events.push(full);
    try {
      fs.writeSync(this.fd, JSON.stringify(full) + '\n');
      fs.fsyncSync(this.fd);
    } catch (err) {
      // Disk full or similar: keep going in memory; the next write retries.
      console.error(`[match-log] could not write events.jsonl: ${err.message}`);
    }
  }

  rebuild(nowMs = Date.now()) {
    const matches = deriveMatches(this.events, nowMs);
    for (const [name, body] of [['matches.json', JSON.stringify(matches, null, 1) + '\n'], ['matches.txt', matchesText(matches, nowMs)]]) {
      const tmp = path.join(this.dir, `.${name}.tmp`);
      try {
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, path.join(this.dir, name));
      } catch (err) {
        console.error(`[match-log] could not write ${name}: ${err.message}`);
      }
    }
    return matches;
  }

  close() {
    try { fs.closeSync(this.fd); } catch { /* already closed */ }
  }
}

// ---- Supabase ---------------------------------------------------------------

/**
 * Read only SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_TABLE_NAME from an .env
 * file; surrounding spaces, Windows line ends, quotes and " # comments" removed.
 */
export function readEnvFile(file) {
  const want = new Set(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_TABLE_NAME']);
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*)$/);
    if (!m || !want.has(m[1])) continue;
    let v = m[2].trim();
    if (/^['"]/.test(v)) {
      const end = v.indexOf(v[0], 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else {
      v = v.replace(/\s+#.*$/, '');
    }
    out[m[1]] = v.trim();
  }
  return out;
}

/** One read of the courts' rows (REST). Throws on failure. */
export async function readRows({ url, key, table, courtIds }) {
  const q = `${url}/rest/v1/${encodeURIComponent(table)}?select=court_id,${FIELDS.join(',')}` +
    `&court_id=in.(${courtIds.join(',')})`;
  const res = await fetch(q, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Supabase's pushed-update feed (its realtime protocol, version 1.0.0) for the
 * given courts' rows. Calls onRow(row) for each change, onLive() once joined,
 * onConfirmed() when Supabase says the row subscription is active, and
 * onLost(reason) when the connection drops; reconnects by itself.
 */
export class Feed {
  constructor({ url, key, table, courtIds, onRow, onLive, onLost, onConfirmed }) {
    Object.assign(this, { url, key, table, courtIds, onRow, onLive, onLost, onConfirmed });
    this.ws = null;
    this.ref = 0;
    this.tries = 0;
    this.stopped = false;
    this.timers = [];
  }

  start() { this.connect(); }

  stop() {
    this.stopped = true;
    this.clearTimers();
    try { this.ws?.close(); } catch { /* already closed */ }
  }

  clearTimers() {
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
    this.timers = [];
  }

  send(msg) {
    try { this.ws.send(JSON.stringify(msg)); } catch { /* closing; the close handler reconnects */ }
  }

  connect() {
    if (this.stopped) return;
    const wsUrl = `${this.url.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(this.key)}&vsn=1.0.0`;
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      this.dropped(`could not open: ${err.message}`);
      return;
    }
    this.ws = ws;
    this.joined = false;
    this.lastReply = Date.now();
    const topic = 'realtime:match-log';
    const joinRef = String(++this.ref);
    let closedOnce = false;
    const done = (why) => {
      if (closedOnce) return;
      closedOnce = true;
      this.clearTimers();
      try { ws.close(); } catch { /* already closed */ }
      this.dropped(why);
    };

    // Counts from the connect, not from "open": a server that accepts the
    // connection but never answers would otherwise hold us for minutes.
    this.timers.push(setTimeout(() => { if (!this.joined) done('no answer to the join'); }, JOIN_TIMEOUT_MS));
    ws.addEventListener('open', () => {
      this.send({
        topic, event: 'phx_join', ref: joinRef, join_ref: joinRef,
        payload: {
          config: {
            broadcast: { ack: false, self: false },
            presence: { key: '', enabled: false },
            postgres_changes: this.courtIds.map((id) => ({ event: '*', schema: 'public', table: this.table, filter: `court_id=eq.${id}` })),
            private: false,
          },
          access_token: this.key,
        },
      });
      this.timers.push(setInterval(() => {
        if (Date.now() - this.lastReply > DEAD_AFTER_MS) return done('no heartbeat answer for 60 s');
        this.send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++this.ref) });
      }, HEARTBEAT_MS));
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      this.lastReply = Date.now();
      const { event, payload } = msg;
      if (event === 'phx_reply' && msg.topic === topic && msg.ref === joinRef) {
        if (payload?.status === 'ok') {
          this.joined = true;
          // The wait between retries is only reset once the subscription is
          // confirmed (or has held for a minute): Supabase accepts the join first
          // and refuses the subscription after, and resetting here would retry
          // every second all day (found in review 2026-11-21).
          this.timers.push(setTimeout(() => { this.tries = 0; }, 60_000));
          this.onLive();
        } else {
          done(`join refused: ${JSON.stringify(payload?.response ?? payload).slice(0, 200)}`);
        }
      } else if (event === 'system' && payload?.status === 'error') {
        done(`Supabase said: ${String(payload.message ?? '').slice(0, 200)}`);
      } else if (event === 'system' && payload?.status === 'ok' && payload?.extension === 'postgres_changes') {
        this.tries = 0;
        this.onConfirmed?.();
      } else if ((event === 'phx_error' || event === 'phx_close') && msg.topic === topic) {
        done(`channel ${event}`);
      } else if (event === 'postgres_changes') {
        const rec = payload?.data?.record;
        if (rec && this.courtIds.includes(rec.court_id)) this.onRow(rec);
      }
    });
    ws.addEventListener('close', () => done('connection closed'));
    ws.addEventListener('error', () => done('connection error'));
  }

  dropped(why) {
    if (this.stopped) return;
    this.onLost(why);
    const wait = BACKOFF_S[Math.min(this.tries, BACKOFF_S.length - 1)];
    this.tries++;
    this.timers.push(setTimeout(() => this.connect(), wait * 1000));
  }
}

// ---- the program ------------------------------------------------------------

function parseArgs(argv) {
  const a = { courts: [], once: false, forS: 0, envFile: '', out: '' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
      return argv[++i];
    };
    if (k === '--env-file') a.envFile = v();
    else if (k === '--out') a.out = v();
    else if (k === '--court') {
      const [label, id] = v().split('=');
      if (!label || !UUID.test(id ?? '')) throw new Error(`--court must be label=<court uuid>, got "${argv[i]}"`);
      a.courts.push({ label, id: id.toLowerCase() });
    } else if (k === '--once') a.once = true;
    else if (k === '--for') a.forS = Number(v());
    else throw new Error(`unknown option ${k}`);
  }
  if (!a.courts.length) throw new Error('give at least one --court label=<court uuid>');
  if (!a.once && !a.out) throw new Error('--out <folder> is needed');
  return a;
}

const USAGE = `usage: match-log.mjs --env-file <.env> --court court1=<uuid> [--court court2=<uuid>] --out <folder>
       match-log.mjs --env-file <.env> --court court1=<uuid> --once     (read the rows once and print them)
       add --for <seconds> to stop by itself (for tests)`;

async function main() {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
  }
  const env = { ...(a.envFile ? readEnvFile(a.envFile) : {}) };
  for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_TABLE_NAME']) if (process.env[k]) env[k] = process.env[k];
  const url = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_ANON_KEY || '';
  const table = env.SUPABASE_TABLE_NAME || 'score_board';
  if (!/^https?:\/\//.test(url) || !key) {
    console.error('SUPABASE_URL and SUPABASE_ANON_KEY are needed (in --env-file or the environment).');
    process.exit(2);
  }
  const byId = new Map(a.courts.map((c) => [c.id, c.label]));
  const courtIds = a.courts.map((c) => c.id);

  if (a.once) {
    try {
      const rows = await readRows({ url, key, table, courtIds });
      for (const r of rows) {
        const s = snapOf(r);
        console.log(`${byId.get(r.court_id)}  red_team=${JSON.stringify(s.red_team)} blue_team=${JSON.stringify(s.blue_team)}  ${scoreText(s)}  mode=${s.mode}`);
      }
      if (rows.length !== courtIds.length) console.log(`(asked for ${courtIds.length} courts, Supabase has ${rows.length})`);
      process.exit(0);
    } catch (err) {
      console.error(`read failed: ${err.message}`);
      process.exit(1);
    }
  }

  const log = new EventLog(a.out);
  const last = log.lastRows();
  const histFile = path.join(a.out, 'history.txt');
  const say = (ms, msg) => {
    const line = `${isoLocal(ms).replace('T', ' ')}  ${msg}`;
    console.log(line);
    try { fs.appendFileSync(histFile, line + '\n'); } catch (err) { console.error(`[match-log] could not write history.txt: ${err.message}`); }
  };

  // ---- what the matches look like now, announced in history.txt as they change
  const known = new Map(); // match id -> state ('set' | 'playing' | 'ended')
  for (const m of deriveMatches(log.events)) known.set(m.id, m.state);
  const teamsOf = (m) => `"${m.red_team ?? '?'}" (red) vs "${m.blue_team ?? '?'}" (blue)`;
  let current = [];
  const rebuild = () => {
    current = log.rebuild();
    for (const m of current) {
      const before = known.get(m.id);
      if (before === m.state) continue;
      known.set(m.id, m.state);
      const checks = m.checks.length ? `  [check: ${m.checks.join('; ')}]` : '';
      const at = (iso) => iso.slice(11, 19);
      if (m.state === 'set') say(Date.now(), `${m.court}  next match set up: ${teamsOf(m)} (waiting for the first point)`);
      else if (m.state === 'playing' && before === 'ended') say(Date.now(), `${m.court}  MATCH ${m.n} RESUMED: a point came after a long pause, so it had not ended (${teamsOf(m)})`);
      else if (m.state === 'playing') say(Date.now(), `${m.court}  MATCH ${m.n} STARTED at ${at(m.start)}: ${teamsOf(m)}${checks}`);
      else if (m.last_point === null) say(Date.now(), `${m.court}  match set up but no point was played (names changed or cleared): ${teamsOf(m)}${checks}`);
      else if (m.end_reason === 'idle') say(Date.now(), `${m.court}  MATCH ${m.n} PROBABLY ENDED at ${at(m.end)} (no point for 15 min; started ${at(m.start)}): ${teamsOf(m)}, last score ${scoreText(m.final)}`);
      else say(Date.now(), `${m.court}  MATCH ${m.n} ENDED at ${at(m.end)} (started ${at(m.start)}): ${teamsOf(m)}, final ${scoreText(m.final)}${checks}`);
    }
    writeStatus();
  };
  let rebuildTimer = null;
  const rebuildSoon = () => {
    if (rebuildTimer) return;
    rebuildTimer = setTimeout(() => { rebuildTimer = null; rebuild(); }, 1_000);
  };

  // ---- status.json, read by the recorder for STATUS.txt
  const supa = { state: 'connecting', sinceMs: Date.now() };
  const lastChange = new Map();
  const writeStatus = () => {
    const courts = {};
    for (const { label } of a.courts) {
      const ms = current.filter((m) => m.court === label);
      const m = ms[ms.length - 1];
      const row = last.get(label);
      const when = lastChange.has(label) ? ` (last change ${isoLocal(lastChange.get(label)).slice(11, 19)})` : '';
      let text;
      if (m && m.state !== 'ended') {
        text = `match ${m.n} ${m.state === 'set' ? 'set up, no point yet' : `playing since ${m.start.slice(11, 19)}`}: ${teamsOf(m)}, ${scoreText(row ?? m.final)}${when}`;
      } else {
        text = `no match on${m ? ` (last: match ${m.n} ended ${m.end.slice(11, 19)})` : ''}${row ? `; scoreboard: ${scoreText(row)}` : ''}${when}`;
      }
      courts[label] = { text, state: m && m.state !== 'ended' ? m.state : 'none', matches: ms.length };
    }
    const body = JSON.stringify({ updatedMs: Date.now(), updated: isoLocal(Date.now()), supabase: supa, courts }, null, 1);
    try {
      fs.writeFileSync(path.join(a.out, '.status.json.tmp'), body + '\n');
      fs.renameSync(path.join(a.out, '.status.json.tmp'), path.join(a.out, 'status.json'));
    } catch (err) { console.error(`[match-log] could not write status.json: ${err.message}`); }
  };

  // A read sent before a push arrived can return an older row than that push;
  // it must not undo it (found in review 2026-11-21).
  const lastPushAt = new Map();
  const takeRow = (row, how, readSentAt = 0) => {
    const label = byId.get(String(row.court_id).toLowerCase());
    if (!label) return;
    if (how === 'read' && (lastPushAt.get(label) ?? 0) > readSentAt) return;
    if (how === 'push') lastPushAt.set(label, Date.now());
    const snap = snapOf(row);
    const prev = last.get(label);
    if (prev && teamsKey(prev) === teamsKey(snap) && scoreKey(prev) === scoreKey(snap)) return;
    last.set(label, snap);
    const ms = Date.now();
    lastChange.set(label, ms);
    log.add({ ms, kind: 'ROW', how, court: label, court_id: row.court_id, ...snap });
    const what = !prev || teamsKey(prev) !== teamsKey(snap)
      ? `team names: ${JSON.stringify(snap.red_team)} (red) vs ${JSON.stringify(snap.blue_team)} (blue), ${scoreText(snap)}`
      : `score: ${scoreText(snap)}`;
    say(ms, `${label}  ${what}${how === 'read' ? '  (read after connecting)' : ''}`);
    rebuildSoon();
  };

  let catching = false;
  let again = false;
  const catchUp = async () => {
    if (catching) { again = true; return; }
    catching = true;
    try {
      for (const wait of [0, 5, 30]) {
        if (wait) await new Promise((r) => setTimeout(r, wait * 1000));
        const sentAt = Date.now();
        try {
          const rows = await readRows({ url, key, table, courtIds });
          for (const r of rows) takeRow(r, 'read', sentAt);
          const missing = courtIds.filter((id) => !rows.some((r) => String(r.court_id).toLowerCase() === id));
          if (missing.length) say(Date.now(), `WARNING: Supabase has no scoreboard row for ${missing.map((id) => byId.get(id)).join(', ')}`);
          return;
        } catch (err) {
          say(Date.now(), `read of the rows failed (${err.message}); pushed changes still arrive`);
        }
      }
    } finally {
      catching = false;
      if (again) { again = false; catchUp(); }
    }
  };

  log.add({ ms: Date.now(), kind: 'START', courts: Object.fromEntries(byId) });
  say(Date.now(), `match-log started (pid ${process.pid}): ${a.courts.map((c) => `${c.label}=${c.id}`).join(', ')} → ${a.out}`);
  rebuild();

  let liveSaid = false;
  const feed = new Feed({
    url, key, table, courtIds,
    onRow: (row) => takeRow(row, 'push'),
    onConfirmed: () => {
      supa.state = 'listening';
      supa.sinceMs = Date.now();
      say(Date.now(), 'Supabase confirmed it will send changes to these courts');
      writeStatus();
      // Changes between the join and this confirmation were neither read nor pushed.
      catchUp();
    },
    onLive: () => {
      log.add({ ms: Date.now(), kind: 'LIVE' });
      say(Date.now(), 'connected to Supabase');
      liveSaid = true;
      catchUp();
    },
    onLost: (why) => {
      if (liveSaid || !log.events.length || log.events[log.events.length - 1].kind !== 'LOST') {
        log.add({ ms: Date.now(), kind: 'LOST', why });
      }
      if (supa.state !== 'lost') { supa.state = 'lost'; supa.sinceMs = Date.now(); }
      liveSaid = false;
      say(Date.now(), `Supabase connection LOST (${why}); reconnecting`);
      writeStatus();
    },
  });
  feed.start();

  const alive = setInterval(() => { log.add({ ms: Date.now(), kind: 'ALIVE' }); rebuild(); }, ALIVE_EVERY_MS);
  const statusTimer = setInterval(writeStatus, 30_000);
  const stop = (sig, code = 0) => {
    clearInterval(alive);
    clearInterval(statusTimer);
    feed.stop();
    log.add({ ms: Date.now(), kind: 'STOP', why: sig });
    supa.state = 'stopped';
    supa.sinceMs = Date.now();
    rebuild();
    log.close();
    say(Date.now(), `match-log stopped (${sig})`);
    process.exit(code);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error(err);
    say(Date.now(), `match-log hit an error (${err?.message ?? err}); stopping so pm2 restarts it`);
    stop('error', 1);
  });
  if (a.forS > 0) setTimeout(() => stop(`--for ${a.forS}s`), a.forS * 1000);
}

// pm2 runs this file through its own wrapper, so argv[1] is not this file there
// (found in review 2026-11-21: without this, nothing starts under pm2).
const entry = process.env.pm_exec_path || process.argv[1] || '';
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
if (entry && pathToFileURL(real(entry)).href === pathToFileURL(real(fileURLToPath(import.meta.url))).href) main();
