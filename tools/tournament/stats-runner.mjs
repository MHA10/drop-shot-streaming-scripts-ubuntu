#!/usr/bin/env node
/**
 * Works out player stats for each recorded match on the streamer box, only while the box is free.
 *
 * ── IN SIMPLE WORDS ──
 * The recorder saves the courts' camera video and the match log writes down when each
 * match started and ended. This program waits until the box has nothing else to do (no
 * court streaming, no match being played, no reel being made), then takes the next
 * finished match, cuts its video out of the recordings and runs the stats steps on it
 * (stats/run_job.py). The moment a court goes live it freezes that work in place and
 * carries on when the box is free again, so streams and reels never wait for stats.
 * Everything it does is written down: STATS.txt (a board to read first),
 * stats-out/ledger.txt (one line per match), stats-out/history.txt (every change) and
 * stats-out/resources.csv (every minute while a job exists: what the job and the box use).
 *
 * ── BUSINESS RULES ──
 * - Stats are made after play, on the box itself (team meeting 2026-10-25: live stats
 *   reached 86 °C; tournament 2026-11-22: "analytics must run on the streamer box").
 * - "Free" = no court live, no match being played, no reel or other ffmpeg work, box
 *   under 90 °C, and that for 5 minutes in a row (Hamza 2026-11-22: "when both courts
 *   are free of streams so we have resources").
 * - One job per match from matches/matches.json. A recording with no match in it at all
 *   (scores and names never reached Supabase) becomes one job for the whole recording,
 *   so nothing recorded is left unprocessed.
 * - Video is never deleted here.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - Pause = SIGSTOP to the job's whole process group (python and its ffmpeg); resume =
 *   SIGCONT. Killing instead would throw away up to 10 minutes of people-finding each
 *   time a court goes live.
 * - Any ffmpeg that isn't ours or the camera preview counts as busy. The reels run
 *   ffmpeg and python reframe_ball.py at low priority; listing their exact paths would
 *   miss a step added later and slow a reel down.
 * - A job left over from a crashed run (frozen or not) is killed at start: a frozen
 *   job holds ~1.5 GB of memory forever. run_job.py's step markers make the re-run
 *   cheap.
 * - Under pm2, argv[1] is pm2's own wrapper: the "am I the program" check uses
 *   pm_exec_path (same as the recorder; found in review 2026-11-21).
 *
 * ── DO NOT ──
 * - Don't start a job while anything is busy, and don't shorten FREE_FOR_MS without
 *   thinking about a stream that stops for 2 minutes and starts again.
 * - Don't print ps lines: the streamer's command holds the camera login and stream keys.
 * - Don't delete recordings from here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readEnvFile, liveHintFor, liveScan, addSecret, loginsOf } from './recorder.mjs';

let CHECK_MS = 10_000;
let FREE_FOR_MS = 5 * 60_000;
const SCAN_MS = 60_000;
const MATCH_STATUS_STALE_MS = 120_000;
const START_PAD_MS = 30_000; // players are on court a little before the first point
const SESSION_GAP_S = 60; // files further apart than this belong to different recordings
// Stats only run while nothing is streaming, so the limit is about the processor, not the
// streams: the i5-6600 slows itself at 100 °C. 80 was tried on the box (2026-11-22): its
// hottest sensor reached 83 under the people finder and the job kept pausing and resuming.
const MAX_TEMP_C = 90;
// Stats files share the disk with the recordings; the recorder stops at 15 GB free because a
// full disk can stop the live stream. Stats freeze 10 GB above that (review 2026-11-22).
const MIN_FREE_GB = 25;
const RECORDING_CHUNK_MS = 90 * 60_000; // a whole-recording job is cut into pieces this long (memory: review 2026-11-22)

const pad = (n) => String(n).padStart(2, '0');
export function isoLocal(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const hm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const stamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };
const mins = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/** court1-20261122-201000.mkv -> its start time (box clock), or null. */
export function fileStartMs(name) {
  const m = name.match(/-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.mkv$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}

const isFfmpeg = (args) => /(^|\/)ffmpeg$/.test(args.split(/\s+/, 1)[0] ?? '');

/**
 * Why the box is busy right now (empty = free). ps lines never leave this function:
 * only court labels and fixed words do.
 */
export function busyReasons({ ps, hints, ownMarks = [], ignore = [], matchStatus = null, nowMs = Date.now(), tempC = null, freeGB = null }) {
  const why = [];
  const { live } = liveScan(ps, hints, '\0');
  for (const l of live) why.push(`${l} live`);
  if (matchStatus && nowMs - (matchStatus.updatedMs ?? 0) < MATCH_STATUS_STALE_MS) {
    for (const [label, c] of Object.entries(matchStatus.courts ?? {})) {
      if (c?.state === 'playing') why.push(`${label} match being played`);
    }
  }
  for (const raw of ps.split('\n')) {
    const line = raw.trim().replace(/^\d+\s+/, '');
    if (!line) continue;
    const reel = /reframe_ball/.test(line);
    if (!isFfmpeg(line) && !reel) continue;
    const streams = /rtmps?:\/\//.test(line);
    // the preview/own-work exception never covers something that streams out (review 2026-11-22)
    if (!streams && (ownMarks.some((m) => m && line.includes(m)) || ignore.some((m) => m && line.includes(m)))) continue;
    if (/rtmps?:\/\//.test(line) && live.size) continue; // already said: a court is live
    if (line.includes('/recordings/')) why.push('the recorder is still recording');
    else if (reel) why.push('a reel is being made');
    else why.push('another ffmpeg is running (reel or stream work)');
  }
  if (tempC !== null && tempC >= MAX_TEMP_C) why.push(`box hot (${MAX_TEMP_C} °C or more)`); // fixed words: a changing number would log a line per degree
  if (freeGB !== null && freeGB < MIN_FREE_GB) why.push(`disk low (under ${MIN_FREE_GB} GB free)`);
  return [...new Set(why)];
}

/**
 * Recording files of one court, grouped into recordings (sessions): [{startMs, endMs, files:[{name, startMs, durS}]}].
 * durOf(name) gives a file's length in seconds (null = unreadable, left out).
 */
export function sessionsOf(names, durOf) {
  const files = [];
  for (const name of [...names].sort()) {
    const startMs = fileStartMs(name);
    const durS = startMs === null ? null : durOf(name);
    if (startMs !== null && durS) files.push({ name, startMs, durS });
  }
  files.sort((x, y) => x.startMs - y.startMs);
  const out = [];
  for (const f of files) {
    const s = out.at(-1);
    if (s && f.startMs - s.endMs <= SESSION_GAP_S * 1000) {
      s.files.push(f);
      s.endMs = Math.max(s.endMs, f.startMs + f.durS * 1000);
    } else {
      out.push({ startMs: f.startMs, endMs: f.startMs + f.durS * 1000, files: [f] });
    }
  }
  return out;
}

/** The ffconcat list for [ws, we] over these files (absolute paths), and how many seconds it holds. */
export function concatFor(dir, files, ws, we) {
  let body = 'ffconcat version 1.0\n';
  let held = 0;
  for (const f of files) {
    const fe = f.startMs + f.durS * 1000;
    if (fe <= ws || f.startMs >= we) continue;
    const inS = Math.max(0, (ws - f.startMs) / 1000);
    const outS = Math.min(f.durS, (we - f.startMs) / 1000);
    if (outS - inS < 1) continue;
    body += `file '${path.join(dir, f.name).replace(/'/g, "'\\''")}'\n`;
    if (inS > 0.05) body += `inpoint ${inS.toFixed(2)}\n`;
    if (outS < f.durS - 0.05) body += `outpoint ${outS.toFixed(2)}\n`;
    // The part of this file that is used. ffmpeg 6 (the box) only knows the list's total
    // length, and can only jump to a moment in it, when every file says this (2026-11-22:
    // without it ffprobe said "N/A" and the first step failed).
    body += `duration ${(outS - inS).toFixed(2)}\n`;
    held += outS - inS;
  }
  return { body, heldS: held };
}

const teamsOf = (m) => (m.red_team || m.blue_team ? `${m.red_team || '?'} vs ${m.blue_team || '?'}` : 'no team names');

/**
 * Jobs from the match log plus the recordings. Matches end when the match log says so;
 * a match still open on a court whose recording has finished (the last match of the day
 * when no scores came) ends with that recording. Recordings with no match in them become
 * one whole-recording job. nowMs only decides whether a recording has finished.
 */
export function planJobs({ matches, sessionsByCourt, live = new Set(), nowMs = Date.now() }) {
  const jobs = [];
  const covered = new Map();
  for (const m of matches) {
    if (!m.startMs) continue;
    const sessions = sessionsByCourt.get(m.court) ?? [];
    const ws = m.startMs - START_PAD_MS;
    let we = m.endMs ?? null;
    let endNote = null;
    if (we === null) {
      // still open in the match log: only if its court is off and its recording is over
      const s = sessions.find((x) => x.startMs <= m.startMs + 60_000 && x.endMs > m.startMs);
      if (!s || live.has(m.court) || nowMs - s.endMs < 20 * 60_000) {
        // its time is taken even while it waits, so its recording isn't also done as "no match" (review 2026-11-22)
        covered.set(m.court, [...(covered.get(m.court) ?? []), [ws, s?.endMs ?? Infinity]]);
        continue;
      }
      we = s.endMs;
      endNote = 'match log never closed it: ends with the recording';
    }
    // A "match" can run all day (names set once and never changed, no scores): one job that
    // long needs several GB in the grouping step. Cut it like a long recording (review 2026-11-22).
    const pieces = Math.max(1, Math.ceil((we - ws) / RECORDING_CHUNK_MS));
    const step = (we - ws) / pieces;
    for (let k = 0; k < pieces; k++) {
      const pws = Math.round(ws + k * step);
      const pwe = k === pieces - 1 ? we : Math.round(ws + (k + 1) * step);
      jobs.push({
        id: k === 0 ? `${m.court}-${stamp(m.startMs)}` : `${m.court}-${stamp(m.startMs)}-p${k + 1}`,
        kind: 'match', court: m.court, n: m.n, ws: pws, we: pwe, teams: teamsOf(m),
        title: `${m.court} match ${m.n}: ${teamsOf(m)} (${hm(Math.max(pws, m.startMs))}–${hm(pwe)})${pieces > 1 ? ` part ${k + 1} of ${pieces}` : ''}`,
        checks: [...(m.checks ?? []), ...(endNote ? [endNote] : []), ...(pieces > 1 ? [`over ${mins(RECORDING_CHUNK_MS)} long: cut into ${pieces} parts`] : [])],
      });
    }
    covered.set(m.court, [...(covered.get(m.court) ?? []), [ws, we]]);
  }
  for (const [court, sessions] of sessionsByCourt) {
    for (const s of sessions) {
      if (live.has(court) && s === sessions.at(-1)) continue; // still being recorded
      const overlap = (covered.get(court) ?? []).some(([a, b]) => a < s.endMs && b > s.startMs);
      if (overlap) continue;
      const pieces = Math.max(1, Math.ceil((s.endMs - s.startMs) / RECORDING_CHUNK_MS));
      const step = (s.endMs - s.startMs) / pieces;
      for (let k = 0; k < pieces; k++) {
        const ws = Math.round(s.startMs + k * step);
        const we = k === pieces - 1 ? s.endMs : Math.round(s.startMs + (k + 1) * step);
        jobs.push({
          id: `${court}-${stamp(ws)}-rec`, kind: 'recording', court, n: null, ws, we,
          teams: 'no match found in the match log',
          title: `${court} recording ${hm(ws)}–${hm(we)}${pieces > 1 ? ` (part ${k + 1} of ${pieces})` : ''} (no match found in the match log)`,
          checks: ['no match in the match log during this recording: all of it in one page'],
        });
      }
    }
  }
  return jobs.sort((x, y) => x.ws - y.ws);
}

function readPs() {
  try { return execFileSync('ps', ['-ww', '-eo', 'pid=,args='], { encoding: 'utf8', maxBuffer: 16e6, timeout: 5_000 }); } catch { return null; }
}

function tempC() {
  let best = null;
  for (const dir of ['/sys/class/thermal']) {
    let zones = [];
    try { zones = fs.readdirSync(dir).filter((z) => z.startsWith('thermal_zone')); } catch { /* not linux */ }
    for (const z of zones) {
      try {
        const v = Number(fs.readFileSync(path.join(dir, z, 'temp'), 'utf8')) / 1000;
        if (Number.isFinite(v) && v > 0 && (best === null || v > best)) best = Math.round(v);
      } catch { /* sensor gone */ }
    }
  }
  return best;
}

function freeGBOf(dir) {
  try { const st = fs.statfsSync(dir); return Math.floor((st.bavail * st.bsize) / 1e9); } catch { return null; }
}

// ---- resource use (Linux /proc; empty columns elsewhere) ---------------------------
let lastBoxCpu = null;
/** Share of the whole processor busy since the last call (all programs, not only stats). */
function boxCpuPct() {
  try {
    const f = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = f[3] + (f[4] || 0);
    const total = f.reduce((x, y) => x + y, 0);
    const prev = lastBoxCpu;
    lastBoxCpu = { idle, total };
    if (!prev || total === prev.total) return null;
    return Math.round(100 * (1 - (idle - prev.idle) / (total - prev.total)));
  } catch { return null; }
}
function memAvailableGB() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m);
    if (m) return Math.round(Number(m[1]) / 1e5) / 10;
  } catch { /* not linux */ }
  return Math.round(os.freemem() / 1e8) / 10;
}
const CLK_TCK = (() => { try { return Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 3000 }).trim()) || 100; } catch { return 100; } })();
/**
 * The job's whole group (python steps and their ffmpeg): memory now and processor seconds
 * used so far. Each member's own time plus the time of children it already collected, so
 * a finished ffmpeg still counts.
 */
function groupUsage(pgid) {
  let ps = '';
  try { ps = execFileSync('ps', ['-eo', 'pid=,pgid=,rss='], { encoding: 'utf8', timeout: 5000 }); } catch { return null; }
  let rssKB = 0;
  let ticks = 0;
  let members = 0;
  let haveProc = false;
  for (const line of ps.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (!m || Number(m[2]) !== pgid) continue;
    members++;
    rssKB += Number(m[3]);
    try {
      const st = fs.readFileSync(`/proc/${m[1]}/stat`, 'utf8');
      const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
      ticks += Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14]); // utime stime cutime cstime
      haveProc = true;
    } catch { /* gone, or not linux */ }
  }
  return { members, rssMB: Math.round(rssKB / 1024), cpuS: haveProc ? ticks / CLK_TCK : null };
}
const RES_HEADER = 'time,job,state,step,pct,job_cpu_cores,job_mem_mb,job_processes,box_cpu_busy_pct,load1,temp_c,mem_available_gb,disk_free_gb\n';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeAtomic(file, body) {
  try {
    fs.writeFileSync(`${file}.tmp`, body);
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) { console.error(`[stats] could not write ${file}: ${err.message}`); }
}

const USAGE = `usage: stats-runner.mjs --root DIR [--env-file cameras.env --camera court1=CAM_URL_COURT1 ...]
  --courts stats/courts.json   (per court: poly, court, size)
  [--python stats-venv/bin/python] [--job-script stats/run_job.py] [--models stats/models]
  [--ignore /hlscam/] [--free-for-s 300] [--check-ms 10000] [--for S]`;

function parseArgs(argv) {
  const a = { cameras: [], ignore: [], root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${k} needs a value`); return x; };
    if (k === '--root') a.root = v();
    else if (k === '--env-file') a.envFile = v();
    else if (k === '--camera') a.cameras.push(v());
    else if (k === '--courts') a.courts = v();
    else if (k === '--python') a.python = v();
    else if (k === '--job-script') a.jobScript = v();
    else if (k === '--models') a.models = v();
    else if (k === '--ignore') a.ignore.push(v());
    else if (k === '--free-for-s') FREE_FOR_MS = Number(v()) * 1000;
    else if (k === '--check-ms') CHECK_MS = Number(v());
    else if (k === '--for') a.forS = Number(v());
    else throw new Error(`unknown option ${k}\n${USAGE}`);
  }
  const R = path.resolve(a.root);
  a.root = R;
  a.recordings = path.join(R, 'recordings');
  a.matchesDir = path.join(R, 'matches');
  a.out = path.join(R, 'stats-out');
  a.status = path.join(R, 'STATS.txt');
  a.courts ??= path.join(R, 'stats', 'courts.json');
  a.python ??= path.join(R, 'stats-venv', 'bin', 'python');
  a.jobScript ??= path.join(R, 'stats', 'run_job.py');
  a.models ??= path.join(R, 'stats', 'models');
  return a;
}

/**
 * A job from a crashed run (maybe frozen) holds memory and would fight the new one: stop it.
 * Only a python process running exactly our job script on a job in our stats-out counts, so
 * a shell or a grep that merely mentions these paths is never touched (review 2026-11-22).
 */
function sweepLeftovers(a) {
  const killed = [];
  let ps = '';
  try { ps = execFileSync('ps', ['-ww', '-eo', 'pid=,pgid=,args='], { encoding: 'utf8', maxBuffer: 16e6, timeout: 5000 }); } catch { return killed; }
  const mark = ` ${a.jobScript} ${a.out}/`;
  for (const line of ps.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)(.*)$/);
    if (!m || Number(m[1]) === process.pid || !/^python[\d.]*$/.test(path.basename(m[3])) || !m[4].includes(mark)) continue;
    // Our jobs lead their own group (spawned detached): stop the whole group, frozen or not.
    // One started by hand sits in its shell's group: then only that process (review 2026-11-22).
    const pid = Number(m[1]);
    const pgid = Number(m[2]);
    try {
      if (pgid === pid && pgid > 1) { process.kill(-pgid, 'SIGCONT'); process.kill(-pgid, 'SIGKILL'); }
      else { process.kill(pid, 'SIGCONT'); process.kill(pid, 'SIGKILL'); }
    } catch { /* gone */ }
    killed.push(m[1]);
  }
  return killed;
}

function haveIonice() {
  try { execFileSync('ionice', ['-c3', 'true'], { stdio: 'ignore', timeout: 3000 }); return true; } catch { return false; }
}

function lockHeld(file) {
  try {
    const [pid] = fs.readFileSync(file, 'utf8').trim().split(/\s+/);
    if (!pid || Number(pid) === process.pid) return false;
    process.kill(Number(pid), 0);
    const cmd = fs.existsSync(`/proc/${pid}/cmdline`) ? fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8') : 'stats-runner.mjs';
    return cmd.includes('stats-runner.mjs');
  } catch { return false; }
}

async function main() {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exit(2); }
  fs.mkdirSync(a.out, { recursive: true });
  const lock = path.join(a.out, '.runner.pid');
  if (lockHeld(lock)) { console.error(`another stats runner is already working in ${a.out}`); process.exit(3); }
  const leftoverPids = sweepLeftovers(a);
  try { fs.writeFileSync(lock, `${process.pid}\n`); } catch (err) { console.error(`[stats] could not write the lock: ${err.message}`); }

  const histFile = path.join(a.out, 'history.txt');
  const history = (line) => {
    const l = `${isoLocal(Date.now())}  ${line}`;
    console.log(l);
    try { fs.appendFileSync(histFile, `${l}\n`); } catch { /* disk full must not stop the loop */ }
  };

  const env = a.envFile ? readEnvFile(a.envFile, a.cameras.map((c) => c.split('=')[1])) : {};
  const hints = new Map();
  for (const c of a.cameras) {
    const [label, key] = c.split('=');
    const url = env[key] ?? process.env[key];
    if (url) { for (const s of loginsOf(url)) addSecret(s); hints.set(label, liveHintFor(url)); }
  }
  const courts = Object.fromEntries(Object.entries(readJson(a.courts) ?? {}).filter(([k]) => !k.startsWith('_')));
  const ionice = haveIonice();
  const ownMarks = [a.out];
  const ignore = a.ignore.length ? a.ignore : ['/hlscam/'];

  for (const pid of leftoverPids) history(`stopped a stats job left over from an earlier run (pid ${pid})`);

  const durCache = new Map();
  const durOf = (dir) => (name) => {
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { return null; }
    const key = `${full}:${st.size}`;
    if (durCache.has(key)) return durCache.get(key);
    let d = null;
    try {
      d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', full], { encoding: 'utf8', timeout: 20_000 }).trim());
      if (!Number.isFinite(d) || d <= 0) d = null;
    } catch { d = null; }
    // a failed read is not remembered: one ffprobe timeout must not drop a file for good
    if (d !== null) durCache.set(key, d);
    return d;
  };

  let jobs = [];
  const state = new Map(); // id -> {state, pct, step, note}
  let worker = null; // {id, proc, paused, startedAt, pct, step}
  let busy = ['starting up'];
  let busySince = Date.now();
  let lastBusyAt = Date.now();
  let lastScan = 0;
  let stopping = false;

  const jobDir = (id) => path.join(a.out, id);
  const markerState = (id) => {
    const d = jobDir(id);
    if (fs.existsSync(path.join(d, 'DONE'))) return 'DONE';
    if (fs.existsSync(path.join(d, 'FAILED'))) return 'FAILED';
    if (fs.existsSync(path.join(d, 'NO-VIDEO'))) return 'NO VIDEO';
    return 'WAITING';
  };

  const scan = () => {
    const sessionsByCourt = new Map();
    let courtDirs = [];
    try { courtDirs = fs.readdirSync(a.recordings, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none yet */ }
    for (const c of courtDirs) {
      const dir = path.join(a.recordings, c);
      let names = [];
      try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.mkv')); } catch { /* gone */ }
      sessionsByCourt.set(c, sessionsOf(names, durOf(dir)).map((s) => ({ ...s, dir })));
    }
    const matches = readJson(path.join(a.matchesDir, 'matches.json')) ?? [];
    const live = new Set(busy.filter((w) => w.endsWith(' live')).map((w) => w.split(' ')[0]));
    const planned = planJobs({ matches, sessionsByCourt, live });
    for (const j of planned) {
      const before = jobs.find((x) => x.id === j.id);
      const d = jobDir(j.id);
      if (!before) history(`new job ${j.id}: ${j.title}`);
      const started = fs.existsSync(path.join(d, 'job.json'));
      if (started) {
        const old = readJson(path.join(d, 'job.json'));
        if (old && (Math.abs(old.ws - j.ws) > 5000 || Math.abs(old.we - j.we) > 5000) && !state.get(j.id)?.warned) {
          history(`${j.id}: the match log now has different times (${hm(j.ws)}–${hm(j.we)}) than when this job was made (${hm(old.ws)}–${hm(old.we)}); kept the old ones`);
          state.set(j.id, { ...(state.get(j.id) ?? {}), warned: true });
        }
      }
      j.sessions = sessionsByCourt.get(j.court) ?? [];
    }
    jobs = planned;
  };

  const prepare = (j) => {
    const d = jobDir(j.id);
    fs.mkdirSync(d, { recursive: true });
    if (fs.existsSync(path.join(d, 'job.json'))) return true;
    const files = j.sessions.flatMap((s) => s.files.map((f) => ({ ...f, dir: s.dir })));
    let body = 'ffconcat version 1.0\n';
    let held = 0;
    const byDir = new Map();
    for (const f of files) byDir.set(f.dir, [...(byDir.get(f.dir) ?? []), f]);
    for (const [dir, fs_] of byDir) {
      const c = concatFor(dir, fs_, j.ws, j.we);
      body += c.body.replace(/^ffconcat version 1\.0\n/, '');
      held += c.heldS;
    }
    const geo = courts[j.court];
    if (held < 60 || !geo) {
      const why = !geo ? `no court outline for ${j.court} in ${a.courts}` : `only ${Math.round(held)} s of recording in ${hm(j.ws)}–${hm(j.we)}`;
      fs.writeFileSync(path.join(d, 'NO-VIDEO'), `${why}\n`);
      history(`${j.id} skipped: ${why}`);
      return false;
    }
    fs.writeFileSync(path.join(d, 'list.ffconcat'), body);
    fs.writeFileSync(path.join(d, 'job.json'), `${JSON.stringify({
      id: j.id, kind: j.kind, court_name: j.court, n: j.n, teams: j.teams, title: j.title, checks: j.checks,
      ws: j.ws, we: j.we, start: isoLocal(j.ws), end: isoLocal(j.we), duration_s: Math.round(held),
      key: `ds-${j.id}`, poly: geo.poly, court: geo.court, size: geo.size, fps: geo.fps ?? 5, part_min: 10, device: 'cpu',
    }, null, 1)}\n`);
    return true;
  };

  const startJob = (j) => {
    if (!prepare(j)) return;
    const d = jobDir(j.id);
    const cmd = [...(ionice ? ['ionice', '-c3'] : []), 'nice', '-n', '19', a.python, '-I', a.jobScript, d];
    const proc = spawn(cmd[0], cmd.slice(1), {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DS_MODELS: a.models, DS_THREADS: '3', OMP_NUM_THREADS: '3', YOLO_OFFLINE: '1', PYTHONUNBUFFERED: '1' },
    });
    worker = {
      id: j.id, proc, paused: false, startedAt: Date.now(), pct: 0, step: 'starting', errTail: '',
      workingMs: 0, pausedMs: 0, lastTick: Date.now(), peakMB: 0, hottest: null, cpuS: 0, lastCpuS: null, lastRowAt: 0, rowCpuS: null,
    };
    history(`${j.id} STARTED: ${j.title}`);
    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = line.match(/^PROGRESS (\d+) (\S+)/);
        if (m && worker?.proc === proc) { worker.pct = Number(m[1]); worker.step = m[2]; }
      }
    });
    proc.stderr.on('data', (chunk) => { if (worker?.proc === proc) worker.errTail = (worker.errTail + chunk).slice(-400); });
    let finished = false;
    const finish = (code, sig, err) => {
      if (finished) return;
      finished = true;
      const w = worker;
      if (w?.proc === proc) worker = null;
      // Whatever is left of the job's group (a step whose run_job.py died) would keep running
      // unmanaged and never freeze: stop it. The group id can't be reused while a member lives.
      try { process.kill(-proc.pid, 'SIGCONT'); process.kill(-proc.pid, 'SIGKILL'); } catch { /* group already empty */ }
      const took = mins(Date.now() - (w?.startedAt ?? Date.now()));
      if (w?.stoppedForDisk) return; // not a failure: it waits, and the next start carries on
      const used = w ? `working ${mins(w.workingMs)}, paused ${mins(w.pausedMs)}; on average ${w.workingMs && w.lastCpuS !== null ? (w.cpuS / (w.workingMs / 1000)).toFixed(1) : 'unknown'} processor cores while working, peak memory ${w.peakMB} MB${w.hottest !== null ? `, hottest ${w.hottest} °C` : ''}` : '';
      if (w) { try { fs.writeFileSync(path.join(d, 'resources.txt'), `${used}\n`); } catch { /* disk full */ } }
      if (stopping) return;
      if (code === 0) {
        try { fs.writeFileSync(path.join(d, 'DONE'), `${isoLocal(Date.now())} took ${took}\n`); } catch { /* disk full: retried next run */ }
        history(`${j.id} DONE in ${took} (${used}): ${path.join(d, 'whos-who.html')}`);
      } else {
        let last = '';
        try { last = fs.readFileSync(path.join(d, 'log.txt'), 'utf8').trim().split('\n').slice(-3).join(' | '); } catch { /* no log */ }
        const why = err ? err.message : `exit ${code ?? sig} in step ${w?.step ?? '?'}`;
        try { fs.writeFileSync(path.join(d, 'FAILED'), `${isoLocal(Date.now())} ${why}\n${last}\n${w?.errTail ?? ''}\n`); } catch { /* disk full */ }
        history(`${j.id} FAILED (${why}) after ${took} (${used}); last log lines: ${last.slice(0, 300)}`);
      }
    };
    proc.on('exit', (code, sig) => finish(code, sig, null));
    proc.on('error', (err) => finish(null, null, err));
  };

  const signalGroup = (sig) => {
    if (!worker) return;
    try { process.kill(-worker.proc.pid, sig); } catch { try { worker.proc.kill(sig); } catch { /* gone */ } }
  };

  const writeReports = () => {
    const now = Date.now();
    const rows = jobs.map((j) => {
      let st = markerState(j.id);
      if (worker?.id === j.id) st = worker.paused ? `PAUSED ${worker.pct}%` : `WORKING ${worker.pct}% (${worker.step})`;
      return { j, st };
    });
    const len = (j) => mins(j.we - j.ws);
    const board = [
      `Stats jobs (one per match). Updated ${isoLocal(now)}`,
      'WAITING = not started yet, WORKING/PAUSED = being done (paused while the box is busy), DONE = page ready, FAILED = see history.txt and the job\'s log.txt',
      '',
      ...rows.map(({ j, st }) => `${j.id.padEnd(30)} ${st.padEnd(26)} ${hm(j.ws)}–${hm(j.we)} (${len(j)})  ${j.teams}${st === 'DONE' ? `  -> ${path.join(jobDir(j.id), 'whos-who.html')}` : ''}`),
      ...(rows.length ? [] : ['(no finished matches or recordings yet)']),
      '',
    ].join('\n');
    writeAtomic(path.join(a.out, 'ledger.txt'), board);
    const count = (s) => rows.filter((r) => r.st.startsWith(s)).length;
    const status = [
      `DropShot stats (worked out while the box is free). Updated ${isoLocal(now)}`,
      busy.length ? `Box: BUSY since ${hm(busySince)} (${busy.join(', ')}): stats wait` :
        now - lastBusyAt < FREE_FOR_MS ? `Box: free since ${hm(lastBusyAt)}; stats start after ${mins(FREE_FOR_MS)} free (at ${hm(lastBusyAt + FREE_FOR_MS)})` :
          `Box: free since ${hm(lastBusyAt)}: stats working`,
      worker ? `Now: ${worker.id} ${worker.paused ? 'PAUSED' : 'WORKING'} ${worker.pct}% (${worker.step}), started ${hm(worker.startedAt)}` : 'Now: nothing running',
      `Jobs: ${rows.length} (done ${count('DONE')}, waiting ${count('WAITING')}, failed ${count('FAILED')}, no video ${count('NO VIDEO')})`,
      '',
      `Details: ${path.join(a.out, 'ledger.txt')} (one line per match), ${histFile} (every change), <job>/log.txt`,
      '',
    ].join('\n');
    writeAtomic(a.status, status);
  };

  const check = () => {
    if (stopping) return;
    const now = Date.now();
    const ps = readPs();
    const reasons = ps === null ? ['could not read the process list'] : busyReasons({
      ps, hints, ownMarks, ignore, matchStatus: readJson(path.join(a.matchesDir, 'status.json')), nowMs: now, tempC: tempC(),
      freeGB: freeGBOf(a.out),
    });
    if (reasons.join() !== busy.join()) {
      if (reasons.length && !busy.length) { busySince = now; history(`box BUSY: ${reasons.join(', ')}`); }
      else if (!reasons.length) history(`box free (was busy: ${busy.join(', ')}); stats start after ${mins(FREE_FOR_MS)} free`);
      else history(`box busy: ${reasons.join(', ')}`);
    }
    busy = reasons;
    if (busy.length) {
      lastBusyAt = now;
      if (worker && busy.some((b) => b.startsWith('disk low')) && !worker.stoppedForDisk) {
        // Frozen, a job keeps its memory for as long as the disk stays full (hours, until
        // someone frees space). Stopped, it frees it and later carries on from its last step.
        worker.stoppedForDisk = true;
        history(`${worker.id} STOPPED at ${worker.pct}% (${busy.join(', ')}); carries on from its last finished step when there is room`);
        signalGroup('SIGCONT');
        signalGroup('SIGTERM');
      } else if (worker && !worker.paused && !worker.stoppedForDisk) { signalGroup('SIGSTOP'); worker.paused = true; history(`${worker.id} PAUSED at ${worker.pct}% (${busy.join(', ')})`); }
    } else if (now - lastBusyAt >= FREE_FOR_MS) {
      if (worker?.paused) { signalGroup('SIGCONT'); worker.paused = false; history(`${worker.id} RESUMED at ${worker.pct}%`); }
      if (!worker) {
        if (now - lastScan > 5000) { scan(); lastScan = now; }
        let next = jobs.find((j) => markerState(j.id) === 'WAITING');
        if (!next) {
          // one more try for a failed job (a passing problem: disk, a killed step), never more
          next = jobs.find((j) => markerState(j.id) === 'FAILED' && !fs.existsSync(path.join(jobDir(j.id), '.retried')));
          if (next) {
            try {
              fs.renameSync(path.join(jobDir(next.id), 'FAILED'), path.join(jobDir(next.id), 'FAILED-1'));
              fs.writeFileSync(path.join(jobDir(next.id), '.retried'), `${isoLocal(now)}\n`);
              history(`${next.id}: trying once more after it failed (first failure kept in FAILED-1)`);
            } catch { next = null; }
          }
        }
        if (next) startJob(next);
      }
    }
    if (now - lastScan >= SCAN_MS) { try { scan(); } catch (err) { history(`could not read the recordings or match log: ${err.message}`); } lastScan = now; }
    try { trackResources(now); } catch (err) { console.error(`[stats] resource log: ${err.message}`); }
    writeReports();
  };

  // Every check: working/paused time and peaks for the running job. Every minute: one row.
  const resFile = path.join(a.out, 'resources.csv');
  const trackResources = (now) => {
    const w = worker;
    if (!w) return;
    w[w.paused ? 'pausedMs' : 'workingMs'] += now - w.lastTick;
    w.lastTick = now;
    const g = groupUsage(w.proc.pid);
    const t = tempC();
    if (g) {
      w.peakMB = Math.max(w.peakMB, g.rssMB);
      if (g.cpuS !== null) {
        const maxDelta = ((now - (w.lastSampleAt ?? now)) / 1000) * os.cpus().length; // can't use more than every core
        if (w.lastCpuS !== null && g.cpuS >= w.lastCpuS) w.cpuS += Math.min(g.cpuS - w.lastCpuS, maxDelta);
        w.lastSampleAt = now;
        w.lastCpuS = g.cpuS;
      }
    }
    if (t !== null && !w.paused) w.hottest = Math.max(w.hottest ?? t, t);
    if (now - w.lastRowAt < 60_000) return;
    const cores = w.rowCpuS !== null && w.lastRowAt ? ((w.cpuS - w.rowCpuS) / ((now - w.lastRowAt) / 1000)).toFixed(2) : '';
    w.rowCpuS = w.cpuS;
    w.lastRowAt = now;
    const row = [isoLocal(now), w.id, w.paused ? 'PAUSED' : 'WORKING', w.step, w.pct, cores, g?.rssMB ?? '', g?.members ?? '',
      boxCpuPct() ?? '', os.loadavg()[0].toFixed(2), t ?? '', memAvailableGB(), freeGBOf(a.out) ?? ''].join(',');
    try {
      if (!fs.existsSync(resFile)) fs.writeFileSync(resFile, RES_HEADER);
      fs.appendFileSync(resFile, `${row}\n`);
    } catch { /* disk full must not stop the loop */ }
  };

  history(`stats runner started (pid ${process.pid}): courts ${Object.keys(courts).join(', ') || 'NONE (no courts.json)'}, waits for ${mins(FREE_FOR_MS)} free, live check ${[...hints].map(([l, h]) => `${l}${h}`).join(', ') || 'none'}`);
  try { scan(); lastScan = Date.now(); } catch (err) { history(`could not read the recordings or match log: ${err.message}`); }
  const tick = () => { try { check(); } catch (err) { history(`check failed: ${err.message}`); } };
  tick();
  const timer = setInterval(tick, CHECK_MS);

  const stop = (why) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    history(`stats runner stopped (${why})${worker ? `; ${worker.id} stopped at ${worker.pct}%, carries on from its last finished step next time` : ''}`);
    if (worker) {
      signalGroup('SIGCONT');
      signalGroup('SIGTERM');
      const w = worker;
      setTimeout(() => { try { process.kill(-w.proc.pid, 'SIGKILL'); } catch { /* gone */ } }, 5000).unref();
    }
    try { fs.unlinkSync(lock); } catch { /* gone */ }
    writeReports();
    setTimeout(() => process.exit(0), worker ? 5500 : 200);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('uncaughtException', (err) => { history(`stats runner hit an error (${err.message}); stopping so pm2 restarts it`); stop('error'); });
  if (a.forS) setTimeout(() => stop(`--for ${a.forS}s`), a.forS * 1000);
}

const entry = process.env.pm_exec_path || process.argv[1] || '';
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
if (entry && pathToFileURL(real(entry)).href === pathToFileURL(real(fileURLToPath(import.meta.url))).href) main();
