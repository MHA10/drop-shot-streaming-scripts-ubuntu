#!/usr/bin/env node
/**
 * Recorder: saves each court's camera video to disk while that court is live,
 * untouched, in 10-minute files, so the stats can be worked out after the matches.
 *
 * ── IN SIMPLE WORDS ──
 * For each court it runs one ffmpeg that copies the camera's picture straight
 * into files (no re-encoding, so it costs almost no processing power). It only
 * records while that court's live stream is on, so the disk is not filled by
 * empty courts overnight. A new file starts every 10 minutes, named by the box's
 * clock, e.g. court1-20261122-180000.mkv. If the camera drops or freezes, it
 * tries again. If the disk gets tight, it stops before the live stream or the
 * reels can run out of space. Everything it does is written down in plain text:
 *   STATUS.txt               one screen, every 10 s: look here first
 *   recordings/ledger.txt    one line per court, right now
 *   recordings/ledger-history.txt  everything that happened, in order
 *   recordings/health.csv    the box every minute: CPU, temperature, disk, streams
 *   recordings/<court>/ffmpeg.log  the camera connection's own warnings
 *
 * ── BUSINESS RULES ──
 * - Record during play, work out stats after (team meeting 2026-10-25; Hamza
 *   2026-11-21: analytics must run on the streamer box itself).
 * - Never affect the live stream or the highlight reels (Hamza 2026-11-21): this
 *   is its own process with its own camera connection; it only LOOKS at the
 *   process list to see whether a court is live, and touches nothing of the
 *   streamer, its settings, the reels buffer/folders or the ESP32 serial port.
 * - Full camera quality: the camera's own video, copied as-is (Hamza 2026-10-25).
 * - Stop recording when free disk falls below --min-free-gb (default 15 GB); start
 *   again only once 2 GB more than that is free.
 * - Clear logs for every stage (Hamza 2026-11-21: "first tournament, we need
 *   transparency of what went wrong if something goes sideways").
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - Only while live (--only-while-live): both cameras together write ~8.6 GB an
 *   hour; the Hello Padel box has ~72 GB above the floor, so recording around the
 *   clock would hit the floor in ~8 h and stop mid-tournament. "Live" = an ffmpeg
 *   sending to rtmp from this camera's address is running (the streamer's own),
 *   OR the match log says a match is being played on that court. Recording stops
 *   15 minutes after neither is true. When the venue's internet drops, the
 *   streamer's ffmpeg disappears while it retries, yet the match and the camera go
 *   on; a short grace would stop recording exactly then (review 2, 2026-11-21).
 * - Matroska (.mkv) files: a file cut off by a crash or power cut still plays up
 *   to the cut. An .mp4 cut off the same way cannot be opened at all.
 * - Video only (-map 0:v): stats need no sound, and some cameras send sound in
 *   formats .mkv copying can refuse, which would stop the video too.
 * - -c copy and nice 10: copying cost 3-4% of one core per camera on the box
 *   (measured 2026-11-21); the low priority means the live stream wins if busy.
 * - Files start on the clock's 10-minute marks and are named by the box's clock,
 *   the same clock match-log.mjs writes match times with.
 * - ffmpeg is stopped by writing "q" to its input, not by a signal: ffmpeg 8
 *   ignored SIGINT/SIGTERM for 15 s+ in tests (2026-11-21) and the force-kill that
 *   followed left the newest file unreadable.
 * - A frozen camera can keep its connection open while sending nothing, so ffmpeg
 *   never exits; if the newest file has not grown for 90 s it is restarted.
 * - One recorder per folder (.recorder.pid lock), and any ffmpeg still writing
 *   into this folder from a crashed run is stopped at start: two would both open
 *   the same clock-named file and wipe each other's video.
 * - Started by pm2, process.argv[1] is pm2's own wrapper, not this file; the
 *   "am I the program being run" check uses pm2's pm_exec_path too, or nothing
 *   would start (found in review 2026-11-21).
 * - Camera logins come from a separate env file (chmod 600, never in git); every
 *   line this program writes has the login masked (up to the LAST "@").
 *
 * ── DO NOT ──
 * - Do NOT point it at the streamer's folders (highlight buffer, reels, logs).
 * - Do NOT lower --min-free-gb to squeeze more hours in: a full disk can stop the
 *   live stream.
 * - Do NOT print process-list lines: the streamer's ffmpeg command holds the
 *   YouTube stream key. Only yes/no "is this court live" leaves that function.
 * - Do NOT print camera URLs unmasked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const RESUME_EXTRA_GB = 2;
const CHECK_EVERY_MS = 10_000;
const HEALTH_EVERY_MS = 60_000;
let STALL_MS = 90_000;
let LIVE_GRACE_MS = 15 * 60_000;
const BACKOFF_S = [5, 10, 30];
const FFMPEG_LOG_MAX = 20e6;
const MATCH_STATUS_STALE_MS = 120_000;
const FILE_QUIET_MS = 15_000; // a file unchanged this long (and not the newest) is finished

const pad = (n) => String(n).padStart(2, '0');
export function isoLocal(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
const hms = (ms) => isoLocal(ms).slice(11, 19);
const SECRETS = [];
/** Also hide this exact text wherever it appears (a camera login with "/", "?" or "#" in it). */
export function addSecret(x) {
  if (x && x.length >= 3 && !SECRETS.includes(x)) SECRETS.push(x);
}
/** rtsp://user:p@ss@host/... -> rtsp://***@host/... (the login ends at the LAST "@"), plus known logins. */
export const mask = (s) => {
  let out = String(s).replace(/\b([a-z][\w+.-]*:\/\/)[^\s/?#]*@/gi, '$1***@');
  for (const x of SECRETS) out = out.split(x).join('***');
  return out;
};
/** The login part of a camera address ("user:pass"), and the password alone. */
export function loginsOf(url) {
  const m = String(url).match(/^[a-z][\w+.-]*:\/\/(.*)@[^@]*$/i);
  if (!m) return [];
  const pass = m[1].includes(':') ? m[1].slice(m[1].indexOf(':') + 1) : '';
  return [m[1], pass].filter(Boolean);
}
const gb = (bytes) => (bytes / 1e9).toFixed(1);
const size = (bytes) => (bytes >= 1e9 ? `${gb(bytes)} GB` : `${Math.round(bytes / 1e6)} MB`);

export function freeBytes(dir) {
  const s = fs.statfsSync(dir);
  return s.bavail * s.bsize;
}

/** Only the named keys; surrounding spaces, Windows line ends, quotes and " # comments" removed. */
export function readEnvFile(file, keys) {
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m || !keys.includes(m[1])) continue;
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

/** The ffmpeg arguments for one court. Non-rtsp inputs (tests) are read at normal speed. */
export function ffmpegArgs(url, outDir, label, segmentS) {
  const input = /^rtsp:/i.test(url)
    ? ['-rtsp_transport', 'tcp', '-timeout', '10000000', '-i', url]
    : ['-re', '-i', url];
  return ['-hide_banner', '-loglevel', 'warning', ...input,
    '-map', '0:v', '-c', 'copy',
    '-f', 'segment', '-segment_time', String(segmentS), '-segment_atclocktime', '1',
    '-reset_timestamps', '1', '-strftime', '1', '-segment_format', 'matroska',
    path.join(outDir, `${label}-%Y%m%d-%H%M%S.mkv`)];
}

/** "@192.168.0.112" for rtsp://login@192.168.0.112:554/...: how this camera appears in the streamer's command. */
export function liveHintFor(url) {
  const m = String(url).match(/^[a-z][\w+.-]*:\/\/(?:[^\s/?#]*@)?([^\s/:?#]+)/i);
  return m ? `@${m[1]}` : null;
}

/**
 * Which courts are being streamed right now: an ffmpeg sending to rtmp(s) whose
 * command contains the court's camera address. Returns labels only; the lines
 * themselves hold stream keys and must not leave this function.
 */
export function liveScan(psText, hints, ownDir) {
  const live = new Set();
  let unmatched = 0;
  for (const raw of psText.split('\n')) {
    const line = raw.trim().replace(/^\d+\s+/, '');
    // The program itself must be ffmpeg (the streamer spawns "ffmpeg"); a shell or
    // script whose command line merely mentions these words does not count.
    if (!isFfmpeg(line) || !/rtmps?:\/\//.test(line) || line.includes(ownDir)) continue;
    let hit = false;
    for (const [label, hint] of hints) {
      if (hint && (line.includes(`${hint}:`) || line.includes(`${hint}/`))) { live.add(label); hit = true; }
    }
    if (!hit) unmatched++;
  }
  return { live, unmatched };
}
export const liveLabels = (psText, hints, ownDir) => liveScan(psText, hints, ownDir).live;

const isFfmpeg = (args) => /(^|\/)ffmpeg$/.test(args.split(/\s+/, 1)[0] ?? '');

function readPs() {
  // -ww: full lines even if COLUMNS is set; a cut line loses the rtmp address at its end.
  try { return execFileSync('ps', ['-ww', '-eo', 'pid=,args='], { encoding: 'utf8', maxBuffer: 16e6, timeout: 5_000 }); } catch { return null; }
}

class Court {
  constructor({ label, url, liveHint, root, segmentS, history }) {
    Object.assign(this, { label, url, liveHint, segmentS, history });
    this.dir = path.join(root, label);
    fs.mkdirSync(this.dir, { recursive: true });
    this.ffLog = path.join(this.dir, 'ffmpeg.log');
    this.proc = null;
    this.state = 'WAITING';
    this.tries = 0;
    this.retry = null;
    this.startedAt = null;
    this.live = false;
    this.liveSince = null;
    this.liveWhy = null;
    this.lastLiveAt = 0;
    this.stall = { key: null, since: 0 };
    this.closed = new Set(this.files());
  }

  files() {
    try { return fs.readdirSync(this.dir).filter((f) => f.endsWith('.mkv')).sort(); } catch { return []; }
  }

  /** The file being written: the most recently changed one (not the last by name: a clock
   *  set back would make an old name sort last and look frozen). */
  newest() {
    let best = null;
    for (const f of this.files()) {
      try {
        const st = fs.statSync(path.join(this.dir, f));
        if (!best || st.mtimeMs > best.mtimeMs) best = { name: f, bytes: st.size, mtimeMs: st.mtimeMs };
      } catch { /* deleted meanwhile */ }
    }
    return best;
  }

  ffmpegLog(text) {
    try {
      if (fs.existsSync(this.ffLog) && fs.statSync(this.ffLog).size > FFMPEG_LOG_MAX) fs.renameSync(this.ffLog, `${this.ffLog}.1`);
      const lines = mask(text).split('\n').filter((l) => l.trim()).map((l) => `${isoLocal(Date.now())}  ${l}`);
      if (lines.length) fs.appendFileSync(this.ffLog, lines.join('\n') + '\n');
    } catch { /* a full disk must not stop the recording logic */ }
  }

  start() {
    if (this.proc || this.retry) return;
    const args = ffmpegArgs(this.url, this.dir, this.label, this.segmentS);
    // stdin is a pipe only we write to: "q" on it is how ffmpeg is stopped cleanly.
    const proc = spawn('nice', ['-n', '10', 'ffmpeg', ...args], { stdio: ['pipe', 'ignore', 'pipe'] });
    proc.stdin.on('error', () => { /* ffmpeg already gone */ });
    this.proc = proc;
    this.state = 'RECORDING';
    this.startedAt = Date.now();
    this.stall = { key: null, since: Date.now() };
    this.history(`${this.label} RECORDING started (camera ${mask(this.url).replace(/\?.*$/, '')})`);
    let errTail = '';
    proc.stderr.on('data', (d) => {
      errTail = (errTail + d).slice(-600);
      this.ffmpegLog(String(d));
    });
    let finished = false;
    const finish = (code, sig, err) => {
      if (finished) return;
      finished = true;
      this.proc = null;
      const ranS = Math.round((Date.now() - this.startedAt) / 1000);
      if (this.state === 'STOPPING' || this.state === 'PAUSED-DISK') return;
      if (this.state === 'IDLE') {
        this.state = 'WAITING';
        return;
      }
      const why = this.state === 'STALLED' ? `no new video for ${STALL_MS / 1000} s (camera frozen?)`
        : err ? mask(err.message) : mask(errTail.trim().split('\n').pop() || `ffmpeg exited, code ${code ?? sig}`).slice(0, 200);
      if (ranS > 120) this.tries = 0;
      const wait = BACKOFF_S[Math.min(this.tries++, BACKOFF_S.length - 1)];
      this.state = 'RETRYING';
      this.history(`${this.label} recording INTERRUPTED after ${ranS}s (${why}); trying again in ${wait}s`);
      this.retry = setTimeout(() => {
        this.retry = null;
        if (this.state !== 'RETRYING') return;
        this.state = 'WAITING';
        if (this.live) this.start();
      }, wait * 1000);
    };
    proc.on('exit', (code, sig) => finish(code, sig, null));
    proc.on('error', (err) => finish(null, null, err));
  }

  stop(state) {
    this.state = state;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const proc = this.proc;
    if (!proc) {
      if (state === 'IDLE') this.state = 'WAITING';
      return;
    }
    // "q" makes ffmpeg finish the file properly; force-kill only if it did nothing in 10 s.
    try { proc.stdin.write('q'); proc.stdin.end(); } catch { /* already gone */ }
    const force = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 10_000);
    proc.once('exit', () => clearTimeout(force));
  }

  /** An ffmpeg left over from a crashed run would keep writing next to the new one: stop it. */
  killLeftovers(ps) {
    const mark = path.join(this.dir, `${this.label}-%Y%m%d-%H%M%S.mkv`);
    for (const line of (ps ?? '').split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m || Number(m[1]) === process.pid || !isFfmpeg(m[2]) || !m[2].includes(mark)) continue;
      this.history(`${this.label} stopping a leftover ffmpeg (pid ${m[1]}) from an earlier run`);
      try { process.kill(Number(m[1]), 'SIGKILL'); } catch { /* already gone */ }
    }
  }

  /** The camera froze but kept the connection: the newest file stopped growing. */
  checkStall(now) {
    if (this.state !== 'RECORDING' || !this.proc) return;
    const n = this.newest();
    const key = n ? `${n.name}:${n.bytes}` : 'none';
    if (key !== this.stall.key) {
      this.stall = { key, since: now };
    } else if (now - this.stall.since > STALL_MS) {
      this.history(`${this.label} no new video for ${Math.round((now - this.stall.since) / 1000)}s: restarting the camera connection`);
      this.stop('STALLED');
    }
  }

  /** Note files that are finished, with size and length. While ffmpeg runs, a file counts as
   *  finished only if it is not the last by name, not the most recently changed, and has not
   *  changed for FILE_QUIET_MS. Going by "most recently changed" alone was wrong on the box
   *  (ffmpeg 6.1.1, 2026-11-22): right after a new file opened, the old one still looked newer
   *  for a few seconds, so the brand-new file was logged "file done … length unreadable" and
   *  never reported again. */
  sweep() {
    const files = this.files();
    const newest = this.proc ? this.newest()?.name : null;
    const last = this.proc ? files[files.length - 1] : null;
    const quietMs = this.segmentS < 60 ? 3_000 : FILE_QUIET_MS;
    for (const f of files) {
      if (this.closed.has(f) || f === newest || f === last) continue;
      const full = path.join(this.dir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (this.proc && Date.now() - st.mtimeMs < quietMs) continue;
      this.closed.add(f);
      const bytes = st.size;
      execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', full], { timeout: 15_000 }, (err, out) => {
        const secs = Number(String(out).trim());
        const len = !err && Number.isFinite(secs) ? `${Math.floor(secs / 60)}m${pad(Math.round(secs % 60))}s` : 'length unreadable';
        this.history(`${this.label} file done: ${f} (${size(bytes)}, ${len})`);
      });
    }
  }

  summary() {
    let total = 0;
    let current = null;
    const files = this.files();
    for (const f of files) {
      try { total += fs.statSync(path.join(this.dir, f)).size; } catch { /* deleted meanwhile */ }
    }
    if (this.proc) current = this.newest();
    return { files: files.length, total, current };
  }
}

// ---- box health ---------------------------------------------------------------

let lastCpu = null;
function cpuBusyPct() {
  try {
    const f = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = f[3] + (f[4] || 0);
    const total = f.reduce((a, b) => a + b, 0);
    const prev = lastCpu;
    lastCpu = { idle, total };
    if (!prev || total === prev.total) return null;
    return Math.round(100 * (1 - (idle - prev.idle) / (total - prev.total)));
  } catch { return null; }
}
function tempC() {
  try {
    const zones = fs.readdirSync('/sys/class/thermal').filter((z) => z.startsWith('thermal_zone'));
    let max = null;
    for (const z of zones) {
      try {
        const v = Number(fs.readFileSync(`/sys/class/thermal/${z}/temp`, 'utf8')) / 1000;
        if (Number.isFinite(v) && (max === null || v > max)) max = v;
      } catch { /* a switched-off sensor */ }
    }
    return max === null ? null : Math.round(max);
  } catch { return null; }
}

// ---- the program ------------------------------------------------------------------

function parseArgs(argv) {
  const a = { cameras: [], envFile: '', out: '', minFreeGb: 15, segmentS: 600, forS: 0, onlyWhileLive: false,
    liveHints: new Map(), status: '', matchStatus: '' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
      return argv[++i];
    };
    if (k === '--camera') {
      const [label, envName] = v().split('=');
      if (!/^[a-z0-9_-]+$/i.test(label ?? '') || !envName) throw new Error(`--camera must be label=ENV_NAME, got "${argv[i]}"`);
      a.cameras.push({ label, envName });
    } else if (k === '--env-file') a.envFile = v();
    else if (k === '--out') a.out = v();
    else if (k === '--min-free-gb') a.minFreeGb = Number(v());
    else if (k === '--segment-s') a.segmentS = Number(v());
    else if (k === '--for') a.forS = Number(v());
    else if (k === '--only-while-live') a.onlyWhileLive = true;
    else if (k === '--live-hint') {
      const s = v();
      const at = s.indexOf('=');
      a.liveHints.set(s.slice(0, at), s.slice(at + 1));
    } else if (k === '--status') a.status = v();
    else if (k === '--live-grace-s') LIVE_GRACE_MS = Number(v()) * 1000;
    else if (k === '--stall-s') STALL_MS = Number(v()) * 1000;
    else if (k === '--match-status') a.matchStatus = v();
    else throw new Error(`unknown option ${k}`);
  }
  if (!a.cameras.length || !a.out) throw new Error('need --camera label=ENV_NAME (one per court) and --out <folder>');
  if (!(a.minFreeGb >= 0) || !(a.segmentS >= 2)) throw new Error('bad --min-free-gb or --segment-s');
  a.out = path.resolve(a.out);
  a.status = path.resolve(a.status || path.join(a.out, '..', 'STATUS.txt'));
  if (a.matchStatus) a.matchStatus = path.resolve(a.matchStatus);
  return a;
}

const USAGE = `usage: recorder.mjs --env-file cameras.env --camera court1=CAM_URL_COURT1 [--camera court2=CAM_URL_COURT2]
                   --out <folder> [--only-while-live] [--min-free-gb 15] [--segment-s 600]
                   [--status STATUS.txt] [--match-status matches/status.json] [--for <seconds>]
                   (tests: [--live-grace-s 120] [--stall-s 90] [--live-hint court1=@host])
cameras.env holds one line per camera: CAM_URL_COURT1=rtsp://user:pass@192.168.0.112:554/...`;

/** One recorder per folder: two would both write the same clock-named files. */
const bootId = () => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return ''; } };
/** Is that pid a recorder from this boot? After a power cut the old pid can belong to anything. */
function lockHeld(text) {
  const [pidText, boot = ''] = String(text).trim().split(/\s+/);
  const pid = Number(pidText);
  if (!(pid > 0) || pid === process.pid || boot !== bootId()) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('recorder.mjs'); } catch { return true; /* no /proc (macOS): trust the pid */ }
}
function takeLock(dir) {
  const lock = path.join(dir, '.recorder.pid');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, `${process.pid} ${bootId()}`, { flag: 'wx' });
      return lock;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const text = fs.readFileSync(lock, 'utf8');
      const pid = Number(text.trim().split(/\s+/)[0]);
      if (lockHeld(text)) {
        console.error(`another recorder (pid ${pid}) is already recording into ${dir}; not starting a second one`);
        process.exit(3);
      }
      fs.unlinkSync(lock); // left by a recorder that crashed
    }
  }
  throw new Error('could not take the recorder lock');
}

function main() {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
  }
  const names = a.cameras.map((c) => c.envName);
  const env = a.envFile ? readEnvFile(a.envFile, names) : {};
  for (const n of names) if (process.env[n]) env[n] = process.env[n];
  const missing = names.filter((n) => !env[n]);
  if (missing.length) {
    console.error(`no camera address for ${missing.join(', ')} (in --env-file or the environment)`);
    process.exit(2);
  }
  for (const n of names) for (const x of loginsOf(env[n])) addSecret(x);
  fs.mkdirSync(a.out, { recursive: true });
  const lock = takeLock(a.out);
  const histFile = path.join(a.out, 'ledger-history.txt');
  const history = (msg) => {
    const line = `${isoLocal(Date.now())}  ${mask(msg)}`;
    console.log(line);
    try { fs.appendFileSync(histFile, line + '\n'); } catch (err) { console.error(`could not write history: ${err.message}`); }
  };
  const courts = a.cameras.map((c) => new Court({
    label: c.label, url: env[c.envName], liveHint: a.liveHints.get(c.label) ?? liveHintFor(env[c.envName]),
    root: a.out, segmentS: a.segmentS, history,
  }));
  const hints = courts.map((c) => [c.label, c.liveHint]);

  const healthFile = path.join(a.out, 'health.csv');
  if (!fs.existsSync(healthFile)) {
    fs.writeFileSync(healthFile, ['time', 'cpu_busy_pct', 'load1', 'temp_c', 'mem_free_gb', 'disk_free_gb',
      ...courts.flatMap((c) => [`${c.label}_live`, `${c.label}_recording`, `${c.label}_file_mb`])].join(',') + '\n');
  }
  let health = { cpu: null, temp: null };
  const sampleHealth = (free) => {
    health = { cpu: cpuBusyPct(), temp: tempC() };
    const row = [isoLocal(Date.now()), health.cpu ?? '', os.loadavg()[0].toFixed(2), health.temp ?? '',
      (os.freemem() / 1e9).toFixed(1), Number.isFinite(free) ? gb(free) : '',
      ...courts.flatMap((c) => {
        const s = c.summary();
        return [c.live ? 1 : 0, c.state === 'RECORDING' ? 1 : 0, s.current ? Math.round(s.current.bytes / 1e6) : ''];
      })];
    try { fs.appendFileSync(healthFile, row.join(',') + '\n'); } catch { /* disk full: the pause logic handles it */ }
  };

  const readMatchStatus = () => {
    if (!a.matchStatus) return null;
    try { return JSON.parse(fs.readFileSync(a.matchStatus, 'utf8')); } catch { return { missing: true }; }
  };

  const writeStatus = (free, ms) => {
    const now = Date.now();
    const warn = [];
    const L = [`DropShot tournament recording. Updated ${isoLocal(now)}`,
      `Box: CPU ${health.cpu ?? '?'}% busy, load ${os.loadavg()[0].toFixed(1)}, ${health.temp ?? '?'} °C, free disk ${Number.isFinite(free) ? gb(free) : '?'} GB (recording stops below ${a.minFreeGb} GB)`,
      '', `Recording${a.onlyWhileLive ? ' (only while a court is live)' : ''}`];
    for (const c of courts) {
      const s = c.summary();
      const live = !a.onlyWhileLive ? '' : c.live ? `live since ${hms(c.liveSince)} (${c.liveWhy})` : 'not live';
      const file = s.current ? `file ${s.current.name} (${size(s.current.bytes)})` : '-';
      L.push(`  ${c.label.padEnd(7)} ${c.state.padEnd(11)} ${live.padEnd(26)} ${file.padEnd(48)} ${s.files} files so far, ${size(s.total)}`);
      if (c.live && c.state !== 'RECORDING') warn.push(`${c.label} is live but ${c.state === 'PAUSED-DISK' ? 'recording is paused: disk too full' : `not recording (${c.state})`}`);
    }
    if (ms) {
      L.push('');
      if (ms.missing) {
        L.push('Match log: no status file yet');
        warn.push('match log has not written its status (is ds-match-log running?)');
      } else {
        const age = now - (ms.updatedMs ?? 0);
        L.push(`Match log (updated ${hms(ms.updatedMs)}): Supabase ${ms.supabase?.state ?? '?'} since ${ms.supabase?.sinceMs ? hms(ms.supabase.sinceMs) : '?'}`);
        for (const [label, c] of Object.entries(ms.courts ?? {})) L.push(`  ${label.padEnd(7)} ${c?.text ?? '?'}`);
        if (age > MATCH_STATUS_STALE_MS) warn.push(`match log: no update since ${hms(ms.updatedMs)} (is ds-match-log running?)`);
        if (ms.supabase?.state !== 'listening') warn.push(`match log is not connected to Supabase (${ms.supabase?.state ?? '?'})`);
      }
    }
    if (Number.isFinite(free) && free < (a.minFreeGb + 10) * 1e9) warn.push(`free disk is ${gb(free)} GB: recording stops at ${a.minFreeGb} GB`);
    if (health.temp !== null && health.temp >= 85) warn.push(`box is hot: ${health.temp} °C`);
    if (unmatched > 0) warn.push(`${unmatched} live stream(s) on this box use a camera that is not in cameras.env`);
    L.push('', 'Warnings', ...(warn.length ? warn.map((w) => `  ! ${w}`) : ['  (none)']));
    L.push('', `Details: ${a.out}/ledger-history.txt, health.csv, <court>/ffmpeg.log${a.matchStatus ? `; ${path.dirname(a.matchStatus)}/history.txt, matches.txt` : ''}`);
    try {
      fs.writeFileSync(`${a.status}.tmp`, L.join('\n') + '\n');
      fs.renameSync(`${a.status}.tmp`, a.status);
    } catch (err) { console.error(`could not write ${a.status}: ${err.message}`); }
  };

  const writeBoard = (free) => {
    const lines = [`Recorder status, ${isoLocal(Date.now())}. Free disk ${Number.isFinite(free) ? gb(free) : '?'} GB (stops below ${a.minFreeGb} GB).`,
      'court    state        files  total GB  current file'];
    for (const c of courts) {
      const s = c.summary();
      lines.push(`${c.label.padEnd(8)} ${c.state.padEnd(12)} ${String(s.files).padStart(5)}  ${gb(s.total).padStart(8)}  ${s.current?.name ?? '-'}`);
    }
    try {
      fs.writeFileSync(path.join(a.out, '.ledger.txt.tmp'), lines.join('\n') + '\n');
      fs.renameSync(path.join(a.out, '.ledger.txt.tmp'), path.join(a.out, 'ledger.txt'));
    } catch (err) { console.error(`could not write ledger.txt: ${err.message}`); }
  };

  let lastHealth = 0;
  let unmatched = 0;
  const check = () => {
    const now = Date.now();
    let free = Infinity;
    try { free = freeBytes(a.out); } catch { /* unknown: do not pause on it */ }
    const ps = a.onlyWhileLive ? readPs() : null;
    const scan = ps === null ? null : liveScan(ps, hints, a.out);
    if (scan && scan.unmatched !== unmatched) {
      if (scan.unmatched > 0) history(`WARNING: ${scan.unmatched} live stream(s) on this box use a camera that is not in cameras.env`);
      unmatched = scan.unmatched;
    }
    // A match being played (per the match log, if its status is fresh) also counts
    // as live: the stream can drop with the venue's internet while play goes on.
    const ms = readMatchStatus();
    const msFresh = ms && !ms.missing && now - (ms.updatedMs ?? 0) <= MATCH_STATUS_STALE_MS;
    for (const c of courts) {
      try {
        if (!a.onlyWhileLive) { c.live = true; c.liveWhy = 'always'; }
        else {
          const was = c.live;
          const stream = scan ? scan.live.has(c.label) : was && c.liveWhy === 'stream';
          const match = !!(msFresh && ms.courts?.[c.label]?.state === 'playing');
          c.live = stream || match;
          const why = stream ? 'stream' : match ? 'match being played' : null;
          if (c.live && !was) { c.liveSince = now; history(`${c.label} is LIVE (${why})`); }
          else if (c.live && why !== c.liveWhy) history(`${c.label} still live, now because: ${why}`);
          if (!c.live && was) history(`${c.label} is no longer live: no stream and no match being played (recording stops after ${Math.round(LIVE_GRACE_MS / 1000)} s unless it comes back)`);
          c.liveWhy = why;
        }
        if (c.live) c.lastLiveAt = now;

        if (free < a.minFreeGb * 1e9 && !['PAUSED-DISK', 'STOPPING'].includes(c.state)) {
          history(`${c.label} PAUSED: free disk ${gb(free)} GB is below ${a.minFreeGb} GB`);
          c.stop('PAUSED-DISK');
        } else if (c.state === 'PAUSED-DISK' && !c.proc && free >= (a.minFreeGb + RESUME_EXTRA_GB) * 1e9) {
          history(`${c.label} free disk back to ${gb(free)} GB: recording may start again`);
          c.state = 'WAITING';
        }

        if (c.state === 'WAITING' && c.live) c.start();
        else if (a.onlyWhileLive && ['RECORDING', 'RETRYING'].includes(c.state) && !c.live && now - c.lastLiveAt > LIVE_GRACE_MS) {
          history(`${c.label} not live for ${Math.round(LIVE_GRACE_MS / 1000)} s: recording STOPPED (waiting for the next stream or match)`);
          c.stop('IDLE');
        }
        c.checkStall(now);
        c.sweep();
      } catch (err) {
        history(`${c.label} check failed (${err.message}); carrying on`);
      }
    }
    // Reports must never take the recording down with them.
    try { if (now - lastHealth >= HEALTH_EVERY_MS) { lastHealth = now; sampleHealth(free); } } catch (err) { console.error(`health: ${err.message}`); }
    try { writeBoard(free); } catch (err) { console.error(`ledger: ${err.message}`); }
    try { writeStatus(free, ms); } catch (err) { console.error(`status: ${err.message}`); }
  };

  history(`recorder started (pid ${process.pid}): ${courts.map((c) => `${c.label} ${a.onlyWhileLive ? `(live when the streamer sends ${c.liveHint ?? '?'})` : ''}`).join(', ')} → ${a.out}, ${a.segmentS}s files, stops below ${a.minFreeGb} GB free`);
  if (a.onlyWhileLive) {
    for (const c of courts) {
      if (!c.liveHint) history(`WARNING: ${c.label} has no camera address to look for, so it can never be seen as live and will NOT record`);
    }
  }
  const ps0 = readPs();
  for (const c of courts) c.killLeftovers(ps0);
  cpuBusyPct();
  check();
  const timer = setInterval(check, a.segmentS < 60 ? 2_000 : CHECK_EVERY_MS);

  let stopping = false;
  const stop = (why, code = 0) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    for (const c of courts) c.stop('STOPPING');
    const waitAll = Promise.all(courts.map((c) => (c.proc ? new Promise((r) => c.proc.once('exit', r)) : null)));
    const force = setTimeout(() => { for (const c of courts) c.proc?.kill('SIGKILL'); }, 12_000);
    waitAll.then(() => {
      clearTimeout(force);
      for (const c of courts) { c.sweep(); c.state = 'STOPPED'; }
      let free = Infinity;
      try { free = freeBytes(a.out); } catch { /* keep Infinity */ }
      try { fs.unlinkSync(lock); } catch { /* already gone */ }
      try { writeBoard(free); writeStatus(free, readMatchStatus()); } catch { /* reports only */ }
      history(`recorder stopped (${why})`);
      // Let the last ffprobe "file done" lines land.
      setTimeout(() => process.exit(code), 1500);
    });
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error(mask(err?.stack ?? err));
    history(`recorder hit an error (${mask(err?.message ?? err)}); stopping the cameras cleanly`);
    stop('error', 1);
  });
  if (a.forS > 0) setTimeout(() => stop(`--for ${a.forS}s`), a.forS * 1000);
}

// pm2 runs this file through its own wrapper, so argv[1] is not this file there.
const entry = process.env.pm_exec_path || process.argv[1] || '';
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
if (entry && pathToFileURL(real(entry)).href === pathToFileURL(real(fileURLToPath(import.meta.url))).href) main();
