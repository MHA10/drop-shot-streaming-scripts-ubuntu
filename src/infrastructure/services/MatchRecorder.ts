import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { monitorEventLoopDelay, IntervalHistogram } from "perf_hooks";
import { Logger } from "../../application/interfaces/Logger";
import { maskCameraUrl } from "../utils/cameraSubstream";
import { MIN_FREE_BYTES, freeDiskBytes } from "../utils/disk";
import {
  DONE_FILE,
  ENDED_FILE,
  HEATMAP_FILE,
  MATCH_FILE,
  MatchRecord,
  PENDING_FILE,
  REJECTED_FILE,
  STATS_FILE,
  readJson,
  writeJsonAtomic,
} from "./MatchStatsOutbox";

/**
 * The match folder's local logbook: box resources every minute, a stats
 * snapshot every STATS_SNAPSHOT_MIN, a final snapshot, and a readable summary.
 *
 * ── IN SIMPLE WORDS ──
 * While a court's stats reader runs, this writes down how the box is coping
 * (CPU, memory, temperature, how far behind the reader is) once a minute, and
 * every 15 minutes it files a copy of the stats and the heatmap as they stood
 * at that moment. When the match ends it files the complete final set and a
 * one-page summary.md that a person can open to see, without any tools, what
 * was measured, how much of the match was actually analysed, and whether the
 * box struggled. It's the flight recorder we read when a number looks wrong.
 *
 * ── BUSINESS RULES ──
 * - Everything is saved on the box FIRST, sent or not (Hamza, 2026-10-23: prove
 *   the stats locally before relying on the backend). The outbox keeps the
 *   folder after sending (done.json) until STATS_KEEP_DAYS.
 * - Snapshots every STATS_SNAPSHOT_MIN (default 15) of wall-clock time since
 *   the stream started, named by that minute (snapshots/015min, 030min, …),
 *   plus snapshots/final at the end. A milestone that fell while the app was
 *   down is not back-filled — after a restart stats.json still holds the
 *   numbers from before the outage, so a copy taken late would file older
 *   numbers under that minute's name; the summary lists it as missed. No
 *   milestone is taken once the match has ended (ended.json): it would carry
 *   the final numbers under an earlier minute.
 * - A milestone copy holds stats.json + heatmap.png (all four players on one
 *   card). The final copy also holds each player's own map, photo sheets and
 *   the court calibration — as hard links to the folder's own files where the
 *   disk allows (same bytes on disk, no second copy).
 * - Times in summary.md and resources.csv are the box's local time; the JSON
 *   files keep ISO (UTC) times too.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - The summary is rebuilt from the FILES in the folder (match.json,
 *   reader.log, resources.csv, snapshots/, the delivery files), never from
 *   memory. An app restart mid-match resumes the same folder with a new
 *   recorder; anything kept only in memory would vanish from the report.
 * - resources.csv is appended one row at a time, never rewritten: a crash
 *   loses at most the row being written, not the match's history.
 * - CPU is measured as the change since the previous sample (box: os.cpus();
 *   processes: /proc/<pid>/stat), not as a lifetime average (`ps %cpu`). A
 *   lifetime average flattens exactly the spikes we want to see.
 * - Live-stream encoders are found as `ffmpeg` processes whose parent is THIS
 *   app and that run at the app's own priority, by /proc's name, parent and
 *   nice value only — never their command line, which holds the camera password
 *   and the YouTube stream key. That set is the live encodes (NodeFFmpegService)
 *   plus brief ad-preparation and audio-probe runs at stream start; reel work
 *   runs at nice 19 (withLowPriority) and is left out.
 * - The final snapshot hard-links instead of copying (a second name for the
 *   same bytes). Safe because nothing writes the top-level files after the
 *   final snapshot: the reader has been told to stop (and SIGKILLed after the
 *   grace, so it runs no more code), the outbox only reads them, and a queued
 *   folder is never resumed. The reader also replaces stats/heatmaps/photos by
 *   rename, so even a late write would land in a new file; court.json is the
 *   one file it writes in place, but only once, at calibration. Under a low
 *   disk only a picture whose link fails (a real copy) is skipped.
 * - Snapshot pictures are skipped when the disk has less than MIN_FREE_BYTES
 *   free: a full disk can stop the live ffmpeg (it writes the highlight
 *   buffer to the same disk), and the broadcast matters more than a copy.
 * - Never throws, start() included: it runs on a timer next to the live
 *   stream, and start() runs after the reader was launched — a throw there
 *   would leave a reader nothing can stop.
 *
 * ── DO NOT ──
 * - Do NOT read or log process command lines here (see above).
 * - Do NOT make the timer do heavy work: a sample is a few small file reads.
 * - Do NOT rename the files listed in FOLDER_GUIDE without updating it —
 *   summary.md is how people find their way around the folder.
 */

export const SUMMARY_FILE = "summary.md";
export const RESOURCES_FILE = "resources.csv";
export const SNAPSHOT_DIR = "snapshots";
const SNAPSHOT_META = "snapshot.json";
const READER_LOG = "reader.log";
const SLOTS = ["A", "B", "C", "D"] as const;
const CLOCK_TICKS = 100; // Linux USER_HZ: /proc/<pid>/stat counts CPU in 1/100 s
const PAGE_BYTES = 4096; // x86 page size (the venue boxes); /proc/<pid>/stat rss is in pages
const MAX_MISSED_LISTED = 100;
// monitorEventLoopDelay's sampling interval; every recorded gap includes it.
const LOOP_RESOLUTION_MS = 20;

export interface RecorderTiming {
  sampleEveryMs: number;
  snapshotEveryMs: number;
}

const RESOURCE_COLUMNS = [
  "time",
  "match_min",
  "box_cpu_pct",
  "load_1m",
  "mem_avail_mb",
  "mem_used_pct",
  "cpu_temp_c",
  "disk_free_gb",
  "reader_cores",
  "reader_rss_mb",
  "stream_ffmpegs",
  "stream_cores",
  "stream_rss_mb",
  "streamer_cores",
  "streamer_rss_mb",
  "event_loop_max_ms",
  "reader_clips",
  "reader_dropped",
  "reader_speed_x",
  "reader_backlog",
  "reader_lag_s",
] as const;
type ResourceColumn = (typeof RESOURCE_COLUMNS)[number];
type ResourceRow = Partial<Record<ResourceColumn, string | number | null>>;

export class MatchRecorder {
  private timer?: NodeJS.Timeout;
  private sampler?: ResourceSampler;
  private readonly startedAtMs: number;
  // When THIS recorder started: milestones due before it fell in an outage.
  private recorderStartMs = Date.now();

  constructor(
    private readonly courtId: string,
    private readonly matchDir: string,
    private readonly readerPid: () => number | null,
    private readonly timing: RecorderTiming,
    private readonly logger: Logger
  ) {
    const record = readJson<MatchRecord>(path.join(matchDir, MATCH_FILE));
    const started = record ? Date.parse(record.startedAt) : NaN;
    this.startedAtMs = Number.isFinite(started) ? started : Date.now();
  }

  /** Never throws (header). */
  public start(): void {
    this.stop(); // a second start() must not leave the first timer running
    try {
      this.recorderStartMs = Date.now();
      this.sampler = new ResourceSampler(this.readerPid());
      this.timer = setInterval(() => this.tick(), this.timing.sampleEveryMs);
      this.timer.unref();
    } catch (error) {
      this.stop();
      this.logger.warn("Match stats logbook could not start; the stats themselves carry on", {
        courtId: this.courtId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.sampler?.close();
    this.sampler = undefined;
  }

  /** One minute's row, and a snapshot if a milestone has come due. Never throws. */
  public tick(): void {
    try {
      if (!this.sampler) return;
      appendResourceRow(this.matchDir, this.sampleRow(this.sampler));
      // header: no milestone after the end
      if (fs.existsSync(path.join(this.matchDir, ENDED_FILE))) return;
      const elapsed = Date.now() - this.startedAtMs;
      const step = this.timing.snapshotEveryMs;
      const k = Math.floor(elapsed / step);
      if (k < 1) return;
      // header: a milestone that fell during an outage is missed, not back-filled
      if (this.startedAtMs + k * step < this.recorderStartMs) return;
      const name = milestoneName(k * step);
      if (fs.existsSync(path.join(this.matchDir, SNAPSHOT_DIR, name, SNAPSHOT_META))) return;
      takeSnapshot(this.matchDir, name, {
        milestoneMs: k * step,
        lateByMs: elapsed - k * step,
        stepMs: step,
        final: false,
      });
      writeMatchSummary(this.matchDir);
      this.logger.info("Match stats snapshot saved", {
        courtId: this.courtId,
        snapshot: name,
        matchDir: this.matchDir,
      });
    } catch (error) {
      this.logger.warn("Match stats logbook step failed", {
        courtId: this.courtId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private sampleRow(sampler: ResourceSampler): ResourceRow {
    const reader = readReaderLog(this.matchDir);
    const last = reader.clips[reader.clips.length - 1];
    // From the START of the newest clip the reader finished (analysed or
    // skipped) to now. A clip is only ready once the next one has started, so
    // a reader that keeps up still shows ~50–90 s with 30 s clips; a number
    // that keeps climbing is what "falling behind" looks like.
    const lastStart = reader.lastClipName ? clipStartMs(reader.lastClipName) : null;
    const lagS = lastStart != null ? (Date.now() - lastStart) / 1000 : null;
    return {
      ...sampler.sample(this.readerPid(), this.matchDir),
      time: localTime(new Date()),
      match_min: round((Date.now() - this.startedAtMs) / 60_000, 1),
      reader_clips: reader.clips.length,
      reader_dropped: reader.droppedClips,
      reader_speed_x: last ? last.speed : null,
      reader_backlog: last ? last.backlog : null,
      reader_lag_s: lagS != null ? Math.max(0, Math.round(lagS)) : null,
    };
  }
}

/**
 * The match is over (or closed after an app restart): file the final snapshot
 * and the summary. Call it AFTER the outbox has queued the folder, so the
 * summary shows the queued state. Safe to call more than once. Never throws.
 */
export function finalizeMatchFolder(
  matchDir: string,
  endedAt: Date,
  logger: Logger,
  opts: SummaryOptions = {}
): void {
  try {
    const record = readJson<MatchRecord>(path.join(matchDir, MATCH_FILE));
    // The outbox deletes a folder with no match record; don't recreate it.
    if (!record) return;
    const started = Date.parse(record.startedAt);
    const elapsed = Number.isFinite(started) ? endedAt.getTime() - started : 0;
    takeSnapshot(matchDir, "final", {
      milestoneMs: Math.max(0, elapsed),
      lateByMs: 0,
      stepMs: 0,
      final: true,
      endedAt,
    });
    writeMatchSummary(matchDir, { ...opts, endedAt });
  } catch (error) {
    logger.warn("Could not write the match's final snapshot", {
      matchDir,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ── snapshots ──

interface SnapshotOptions {
  milestoneMs: number;
  lateByMs: number;
  stepMs: number; // the snapshot interval (0 for final)
  final: boolean;
  endedAt?: Date;
}

function takeSnapshot(matchDir: string, name: string, opts: SnapshotOptions): void {
  const dir = path.join(matchDir, SNAPSHOT_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const files = opts.final
    ? [
        STATS_FILE,
        HEATMAP_FILE,
        ...SLOTS.map((s) => `heatmap-${s}.png`),
        ...SLOTS.map((s) => `photo-${s}.jpg`),
        "court.json",
      ]
    : [STATS_FILE, HEATMAP_FILE];
  const free = freeDiskBytes(matchDir);
  const lowDisk = free != null && free < MIN_FREE_BYTES;
  const copied: string[] = [];
  for (const file of files) {
    const from = path.join(matchDir, file);
    if (!fs.existsSync(from)) continue;
    const mayCopy = !lowDisk || file.endsWith(".json"); // header: disk guard
    const to = path.join(dir, file);
    if (opts.final) {
      if (!linkOrCopy(from, to, mayCopy)) continue;
    } else if (mayCopy) {
      fs.copyFileSync(from, to);
    } else {
      continue;
    }
    copied.push(file);
  }

  const stats = readJson<StatsFile>(path.join(dir, STATS_FILE));
  const reader = readReaderLog(matchDir);
  const prevMs = previousSnapshotAtMs(matchDir, name);
  const windowRows = readResourceRows(matchDir).filter((r) => parseLocalTime(r.time) > prevMs);
  const now = opts.endedAt ?? new Date();
  const meta: SnapshotMeta = {
    snapshot: name,
    final: opts.final,
    everyMin: opts.final ? null : round(opts.stepMs / 60_000, 3),
    takenAt: now.toISOString(),
    takenAtLocal: localTime(now),
    matchMin: round(opts.milestoneMs / 60_000, 1),
    lateByMin: round(opts.lateByMs / 60_000, 1),
    files: copied,
    picturesSkipped: lowDisk ? "disk nearly full" : undefined,
    statsAvailable: !!stats,
    statsCoverMin: stats?.duration_s != null ? round(stats.duration_s / 60, 1) : null,
    players: stats ? playerDigest(stats) : null,
    reader: readerDigest(reader, opts.milestoneMs + opts.lateByMs),
    resourcesSincePrevious: resourceDigest(windowRows),
  };
  writeJsonAtomic(path.join(dir, SNAPSHOT_META), meta);
}

// Header: the final set links (no second copy on disk) — safe because the
// reader has exited and only ever replaced its files by rename.
// True when `to` now exists. rm first: on a second finalize `to` is already
// the same file, and copying a file onto itself would empty it.
function linkOrCopy(from: string, to: string, mayCopy: boolean): boolean {
  fs.rmSync(to, { force: true });
  try {
    fs.linkSync(from, to);
    return true;
  } catch {
    if (!mayCopy) return false;
    fs.copyFileSync(from, to); // e.g. a filesystem without hard links
    return true;
  }
}

// When the milestone before `name` was taken, or -Infinity if none.
function previousSnapshotAtMs(matchDir: string, name: string): number {
  const before = name === "final" ? Infinity : parseMilestoneMin(name) ?? Infinity;
  let best = -Infinity;
  for (const snap of listSnapshots(matchDir)) {
    if (snap.snapshot === name || snap.final || snap.matchMin >= before) continue;
    const at = Date.parse(snap.takenAt);
    if (Number.isFinite(at) && at > best) best = at;
  }
  return best;
}

function milestoneName(ms: number): string {
  const min = ms / 60_000;
  if (Number.isInteger(min)) return `${String(min).padStart(3, "0")}min`;
  return `${String(Math.round(ms / 1000)).padStart(5, "0")}s`; // sub-minute steps (tests)
}

function parseMilestoneMin(name: string): number | null {
  const m = /^(\d+)(min|s)$/.exec(name);
  if (!m) return null;
  return m[2] === "min" ? Number(m[1]) : Number(m[1]) / 60;
}

interface SnapshotMeta {
  snapshot: string;
  final: boolean;
  everyMin: number | null;
  takenAt: string;
  takenAtLocal: string;
  matchMin: number;
  lateByMin: number;
  files: string[];
  picturesSkipped?: string;
  statsAvailable: boolean;
  statsCoverMin: number | null;
  players: Record<string, PlayerDigest> | null;
  reader: ReturnType<typeof readerDigest>;
  resourcesSincePrevious: ReturnType<typeof resourceDigest>;
}

function listSnapshots(matchDir: string): SnapshotMeta[] {
  const root = path.join(matchDir, SNAPSHOT_DIR);
  const out: SnapshotMeta[] = [];
  for (const name of safeReaddir(root)) {
    const meta = readJson<SnapshotMeta>(path.join(root, name, SNAPSHOT_META));
    if (meta) out.push(meta);
  }
  // Milestones in time order, final last.
  return out.sort((a, b) => Number(a.final) - Number(b.final) || a.matchMin - b.matchMin);
}

// ── stats.json (written by scripts/player_stats.py) ──

interface PlayerStats {
  distance_m?: number;
  top_speed_ms?: number;
  mean_speed_ms?: number;
  sprints?: number;
  time_at_net_pct?: number;
  time_at_back_pct?: number;
  court_coverage_pct?: number;
  detection_rate?: number;
  team?: string;
}

interface TeamStats {
  mean_separation_m?: number;
  dominant_formation?: string;
  players?: string[];
}

interface StatsFile {
  duration_s?: number;
  players?: Record<string, PlayerStats>;
  teams?: Record<string, TeamStats>;
}

type PlayerDigest = Pick<
  PlayerStats,
  "distance_m" | "top_speed_ms" | "time_at_net_pct" | "detection_rate"
>;

function playerDigest(stats: StatsFile): Record<string, PlayerDigest> {
  const out: Record<string, PlayerDigest> = {};
  for (const [label, p] of Object.entries(stats.players ?? {})) {
    out[label] = {
      distance_m: p.distance_m,
      top_speed_ms: p.top_speed_ms,
      time_at_net_pct: p.time_at_net_pct,
      detection_rate: p.detection_rate,
    };
  }
  return out;
}

// ── reader.log (written by LiveStatsRunner from scripts/live_stats.py) ──

interface ClipLine {
  name: string;
  startedAtMs: number | null;
  playSec: number;
  speed: number;
  backlog: number;
  seen: string;
}

export interface ReaderLogSummary {
  clips: ClipLine[];
  droppedClips: number;
  skippedClips: number;
  skipReasons: Record<string, number>;
  // The newest clip the reader finished with, analysed or skipped.
  lastClipName: string | null;
  starts: number;
  resumes: number;
  cameraReconnects: number;
  courtFound: boolean;
  problems: string[];
}

// Line shapes from scripts/live_stats.py main()/process_clip().
const CLIP_LINE =
  /\[live_stats\] (\S+): (\d+)s play @ [\d.]+fps \| .*?\(x([\d.]+) realtime\) \| master=\d+ samples \| seen (.*?) \| backlog=(\d+)/;
const DROP_LINE = /\[live_stats\] behind by \d+ chunks .* dropping (\d+) stale/;
// "skipping clip_x.mp4 (SystemExit: track_players: never saw 4 players in-court (best frame had 0). …)"
const SKIP_LINE = /\[live_stats\] skipping (\S+) \((?:\w+: )?(?:track_players: )?(.*?)(?:\.|\)$)/;
const PROBLEM_LINE = /WARNING|FATAL|Traceback|Error|failed|exited/;

export function readReaderLog(matchDir: string): ReaderLogSummary {
  const out: ReaderLogSummary = {
    clips: [],
    droppedClips: 0,
    skippedClips: 0,
    skipReasons: {},
    lastClipName: null,
    starts: 0,
    resumes: 0,
    cameraReconnects: 0,
    courtFound: false,
    problems: [],
  };
  let text = "";
  try {
    text = fs.readFileSync(path.join(matchDir, READER_LOG), "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split("\n")) {
    // Masked again: a folder written by an older build may hold an unmasked
    // ffmpeg error with the camera login, and summary.md quotes such lines.
    const line = maskCameraUrl(raw);
    const clip = CLIP_LINE.exec(line);
    if (clip) {
      out.clips.push({
        name: clip[1],
        startedAtMs: clipStartMs(clip[1]),
        playSec: Number(clip[2]),
        speed: Number(clip[3]),
        seen: clip[4],
        backlog: Number(clip[5]),
      });
      out.lastClipName = clip[1];
      continue;
    }
    const drop = DROP_LINE.exec(line);
    if (drop) out.droppedClips += Number(drop[1]);
    const skip = SKIP_LINE.exec(line);
    if (skip) {
      out.skippedClips++;
      out.lastClipName = skip[1];
      // "best frame had 0" vs "had 3" is the useful part: how many players it saw.
      const reason = skip[2].trim().slice(0, 120) || "unknown";
      out.skipReasons[reason] = (out.skipReasons[reason] ?? 0) + 1;
      continue;
    }
    if (line.includes("[live_stats] source=")) out.starts++;
    if (line.includes("[live_stats] resumed master")) out.resumes++;
    if (line.includes("camera segmenter exited")) out.cameraReconnects++;
    if (/calibrated court from|court calibration loaded/.test(line)) out.courtFound = true;
    // ``` would end summary.md's code block early.
    if (PROBLEM_LINE.test(line)) out.problems.push(line.trim().slice(0, 300).replace(/`/g, "'"));
  }
  out.problems = out.problems.slice(-15);
  return out;
}

// clip_20261021_021039.mp4 (camera mode, box local time) or seg-<run>-<epoch>.ts (buffer mode).
function clipStartMs(name: string): number | null {
  const cam = /^clip_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\./.exec(name);
  if (cam) {
    const [, y, mo, d, h, mi, s] = cam.map(Number);
    return new Date(y, mo - 1, d, h, mi, s).getTime();
  }
  const buf = /-(\d+)\.ts$/.exec(name);
  return buf ? Number(buf[1]) * 1000 : null;
}

function readerDigest(reader: ReaderLogSummary, matchMs: number) {
  const playSec = reader.clips.reduce((sum, c) => sum + c.playSec, 0);
  const speeds = reader.clips.map((c) => c.speed);
  const last = reader.clips[reader.clips.length - 1];
  return {
    clipsAnalysed: reader.clips.length,
    clipsDropped: reader.droppedClips,
    clipsSkipped: reader.skippedClips,
    playAnalysedMin: round(playSec / 60, 1),
    analysedPct: matchMs > 0 ? Math.min(100, Math.round((100 * playSec * 1000) / matchMs)) : null,
    speedAvgX: speeds.length ? round(avg(speeds), 2) : null,
    speedMinX: speeds.length ? round(Math.min(...speeds), 2) : null,
    lastClip: last?.name ?? null,
    lastSeen: last?.seen ?? null,
    readerStarts: reader.starts,
    resumedAfterRestart: reader.resumes,
    cameraReconnects: reader.cameraReconnects,
    courtFound: reader.courtFound,
  };
}

// ── resources ──

// Cells go in the order of the file's OWN header, so a folder resumed by a
// build with different columns stays readable. A row cut short by a full
// disk or power loss gets its missing line break first, so the next row
// doesn't run on into it.
function appendResourceRow(matchDir: string, row: ResourceRow): void {
  const file = path.join(matchDir, RESOURCES_FILE);
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    // not written yet
  }
  if (!existing.trim()) {
    // Throws if the folder itself is gone — the folder is never recreated here.
    existing = RESOURCE_COLUMNS.join(",") + "\n";
    fs.writeFileSync(file, existing);
  }
  const nl = existing.indexOf("\n");
  const header = (nl >= 0 ? existing.slice(0, nl) : existing).split(",");
  const cols = header.length > 1 ? header : [...RESOURCE_COLUMNS];
  const line = cols.map((c) => csvCell(row[c as ResourceColumn])).join(",") + "\n";
  fs.appendFileSync(file, (existing.endsWith("\n") ? "" : "\n") + line);
}

function readResourceRows(matchDir: string): ResourceRow[] {
  let text = "";
  try {
    text = fs.readFileSync(path.join(matchDir, RESOURCES_FILE), "utf8");
  } catch {
    return [];
  }
  const [header, ...lines] = text.split("\n").filter(Boolean);
  const cols = (header ?? "").split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    const row: ResourceRow = {};
    cols.forEach((c, i) => (row[c as ResourceColumn] = cells[i] ?? ""));
    return row;
  });
}

function resourceDigest(rows: ResourceRow[]) {
  const stat = (col: ResourceColumn) => {
    const vals = rows.map((r) => r[col]).filter((v) => v !== "" && v != null).map(Number);
    const ok = vals.filter((v) => Number.isFinite(v));
    if (!ok.length) return null;
    return { avg: round(avg(ok), 2), min: round(Math.min(...ok), 2), max: round(Math.max(...ok), 2) };
  };
  return {
    minutes: rows.length,
    boxCpuPct: stat("box_cpu_pct"),
    load1m: stat("load_1m"),
    memAvailMb: stat("mem_avail_mb"),
    cpuTempC: stat("cpu_temp_c"),
    readerCores: stat("reader_cores"),
    readerRssMb: stat("reader_rss_mb"),
    streamFfmpegs: stat("stream_ffmpegs"),
    streamCores: stat("stream_cores"),
    streamerCores: stat("streamer_cores"),
    streamerRssMb: stat("streamer_rss_mb"),
    eventLoopMaxMs: stat("event_loop_max_ms"),
    readerLagS: stat("reader_lag_s"),
    diskFreeGb: stat("disk_free_gb"),
  };
}

class ResourceSampler {
  private lastAt = Date.now();
  private lastBox = boxCpuTimes();
  private lastNode = process.cpuUsage();
  private lastTicks = new Map<number, number>();
  // How long the app's event loop was held up (it also runs the live streams'
  // control path): the worst stall since the previous sample.
  private readonly loop: IntervalHistogram;

  // Seeds the per-process counters so the first row already has CPU numbers.
  constructor(readerPid: number | null) {
    this.loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    // First sample BEFORE enabling: if it throws, no histogram timer is left running.
    this.sample(readerPid, os.tmpdir());
    this.loop.enable();
  }

  public close(): void {
    this.loop.disable();
  }

  public sample(readerPid: number | null, dir: string): ResourceRow {
    const now = Date.now();
    const sec = Math.max(0.001, (now - this.lastAt) / 1000);
    this.lastAt = now;

    const box = boxCpuTimes();
    const busy = box.total - box.idle - (this.lastBox.total - this.lastBox.idle);
    const total = box.total - this.lastBox.total;
    this.lastBox = box;

    const nodeCpu = process.cpuUsage(this.lastNode);
    this.lastNode = process.cpuUsage();

    const loopMaxMs = this.loop.count > 0 ? Math.max(0, this.loop.max / 1e6 - LOOP_RESOLUTION_MS) : null;
    this.loop.reset();

    const procs = listProcs();
    const ticks = new Map<number, number>();
    const coresOf = (p: ProcInfo) => {
      ticks.set(p.pid, p.ticks);
      const before = this.lastTicks.get(p.pid);
      return before == null ? null : (p.ticks - before) / CLOCK_TICKS / sec;
    };
    const reader = readerPid != null ? procs.find((p) => p.pid === readerPid) : undefined;
    const readerCores = reader ? coresOf(reader) : null;
    // header: live encodes = this app's ffmpeg children at the app's own priority
    // (they inherit it; reel work is 19 steps lower)
    const appNice = os.getPriority();
    const encoders = procs.filter((p) => p.comm === "ffmpeg" && p.ppid === process.pid && p.nice === appNice);
    const encoderCores = encoders.map(coresOf);
    this.lastTicks = ticks;

    const mem = memory();
    const disk = freeDiskBytes(dir);
    return {
      box_cpu_pct: total > 0 ? round((100 * busy) / total, 1) : null,
      load_1m: round(os.loadavg()[0], 2),
      mem_avail_mb: Math.round(mem.availBytes / 1024 ** 2),
      mem_used_pct: round(100 * (1 - mem.availBytes / mem.totalBytes), 1),
      cpu_temp_c: cpuTempC(),
      disk_free_gb: disk != null ? round(disk / 1024 ** 3, 1) : null,
      reader_cores: readerCores != null ? round(readerCores, 2) : null,
      reader_rss_mb: reader ? Math.round(reader.rssBytes / 1024 ** 2) : null,
      stream_ffmpegs: procs.length ? encoders.length : null,
      // An encoder that started since the last sample has no "before", so it
      // counts once it has been seen twice.
      stream_cores: encoderCores.some((c) => c != null)
        ? round(encoderCores.reduce<number>((s, c) => s + (c ?? 0), 0), 2)
        : null,
      stream_rss_mb: encoders.length
        ? Math.round(encoders.reduce((s, p) => s + p.rssBytes, 0) / 1024 ** 2)
        : null,
      streamer_cores: round((nodeCpu.user + nodeCpu.system) / 1e6 / sec, 2),
      streamer_rss_mb: Math.round(process.memoryUsage().rss / 1024 ** 2),
      event_loop_max_ms: loopMaxMs != null ? Math.round(loopMaxMs) : null,
    };
  }
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  comm: string;
  nice: number;
  ticks: number;
  rssBytes: number;
}

// Every process's name, parent, priority, CPU ticks and memory from /proc
// (Linux only; empty elsewhere). Never the command line (header).
function listProcs(): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const entry of safeReaddir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const info = parseProcStat(Number(entry), fs.readFileSync(`/proc/${entry}/stat`, "utf8"));
      if (info) out.push(info);
    } catch {
      // exited between readdir and read
    }
  }
  return out;
}

/** One /proc/<pid>/stat line → name, parent, nice, CPU ticks, memory. Exported for tests. */
export function parseProcStat(pid: number, stat: string): ProcInfo | null {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")"); // the name may itself contain ")" or spaces
  if (open < 0 || close < open) return null;
  const f = stat.slice(close + 2).trim().split(/\s+/); // f[0] = field 3 (state)
  const info = {
    pid,
    comm: stat.slice(open + 1, close),
    ppid: Number(f[1]),
    nice: Number(f[16]), // field 19
    ticks: Number(f[11]) + Number(f[12]), // utime + stime
    rssBytes: Number(f[21]) * PAGE_BYTES,
  };
  return Number.isFinite(info.ppid) && Number.isFinite(info.ticks) ? info : null;
}

function boxCpuTimes(): { total: number; idle: number } {
  let total = 0;
  let idle = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
    idle += t.idle;
  }
  return { total, idle };
}

// MemAvailable (what can be used without swapping) when /proc has it; os.freemem
// counts reclaimable cache as used, which makes every Linux box look full.
function memory(): { availBytes: number; totalBytes: number } {
  const totalBytes = os.totalmem();
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync("/proc/meminfo", "utf8"));
    if (m) return { availBytes: Number(m[1]) * 1024, totalBytes };
  } catch {
    // not Linux
  }
  return { availBytes: os.freemem(), totalBytes };
}

// The CPU package sensor (x86_pkg_temp), chosen once. The hottest of ALL zones
// can be the chipset or a fixed fake value, and some ACPI zones run firmware
// code on every read. No package sensor → the hottest zone.
let tempFiles: string[] | undefined;
function cpuTempC(): number | null {
  tempFiles ??= pickTempFiles();
  let best: number | null = null;
  for (const file of tempFiles) {
    try {
      const c = Number(fs.readFileSync(file, "utf8")) / 1000;
      if (Number.isFinite(c) && c > 0 && c < 150 && (best == null || c > best)) best = c;
    } catch {
      // zone without a readable sensor
    }
  }
  return best != null ? round(best, 1) : null;
}

function pickTempFiles(): string[] {
  const base = "/sys/class/thermal";
  const zones = safeReaddir(base).filter((z) => z.startsWith("thermal_zone"));
  const type = (z: string) => {
    try {
      return fs.readFileSync(`${base}/${z}/type`, "utf8").trim();
    } catch {
      return "";
    }
  };
  const pkg = zones.filter((z) => type(z) === "x86_pkg_temp");
  return (pkg.length ? pkg : zones).map((z) => `${base}/${z}/temp`);
}

// ── summary.md ──

export interface SummaryOptions {
  endedAt?: Date;
  sendEnabled?: boolean;
}

/** Rebuild summary.md from the folder's files (header). Never throws. */
export function writeMatchSummary(matchDir: string, opts: SummaryOptions = {}): void {
  try {
    const tmp = path.join(matchDir, `${SUMMARY_FILE}.tmp`);
    fs.writeFileSync(tmp, renderSummary(matchDir, opts));
    fs.renameSync(tmp, path.join(matchDir, SUMMARY_FILE));
  } catch {
    // A missing summary must never stop the match from being queued or sent.
  }
}

interface DoneRecord {
  outcome?: "sent" | "no-stats";
  at?: string;
  status?: number;
  attempts?: number;
}

function renderSummary(matchDir: string, opts: SummaryOptions): string {
  const record = readJson<MatchRecord>(path.join(matchDir, MATCH_FILE));
  const startedMs = record ? Date.parse(record.startedAt) : NaN;
  const endedIso =
    opts.endedAt?.toISOString() ??
    readJson<{ endedAt?: string }>(path.join(matchDir, ENDED_FILE))?.endedAt ??
    readJson<{ capturedAt?: string }>(path.join(matchDir, PENDING_FILE))?.capturedAt ??
    readJson<{ capturedAt?: string }>(path.join(matchDir, REJECTED_FILE))?.capturedAt ??
    readJson<{ capturedAt?: string }>(path.join(matchDir, DONE_FILE))?.capturedAt ??
    listSnapshots(matchDir).find((s) => s.final)?.takenAt;
  const endedMs = endedIso ? Date.parse(endedIso) : NaN;
  const lengthMs = (Number.isFinite(endedMs) ? endedMs : Date.now()) - startedMs;
  const reader = readReaderLog(matchDir);
  const digest = readerDigest(reader, Number.isFinite(lengthMs) ? lengthMs : 0);
  const stats = readJson<StatsFile>(path.join(matchDir, STATS_FILE));
  const snaps = listSnapshots(matchDir);
  const res = resourceDigest(readResourceRows(matchDir));
  const L: string[] = [];

  const when = (ms: number) => (Number.isFinite(ms) ? localTime(new Date(ms)) : "—");
  L.push(`# Match stats — court ${record?.courtId ?? "?"}`);
  L.push("");
  L.push(`Box local time. Written ${localTime(new Date())}; rebuilt at every snapshot, at the end and after sending.`);
  L.push("");
  L.push("| | |");
  L.push("|---|---|");
  L.push(`| Started | ${when(startedMs)} |`);
  L.push(`| Ended | ${Number.isFinite(endedMs) ? when(endedMs) : "still running"} |`);
  L.push(`| Length | ${Number.isFinite(lengthMs) ? `${round(lengthMs / 60_000, 1)} min` : "—"} |`);
  L.push(`| Ground | ${record?.groundId ?? "—"} |`);
  L.push(`| Stream id | ${record?.streamId ?? "—"} |`);
  L.push(`| Scored match id | ${record?.matchId ?? "none seen (the backend will match by time)"} |`);
  L.push(`| Sending | ${deliveryLine(matchDir, opts.sendEnabled)} |`);
  L.push("");

  L.push("## How much of the match was analysed");
  L.push("");
  L.push(`- Video analysed: **${digest.playAnalysedMin} min** of ${Number.isFinite(lengthMs) ? round(lengthMs / 60_000, 1) : "?"} min` +
    (digest.analysedPct != null ? ` (**${digest.analysedPct}%**)` : ""));
  L.push(`- Clips analysed: ${digest.clipsAnalysed}; dropped to stay live (box fell behind): ${digest.clipsDropped}; skipped (players not all visible or unreadable): ${digest.clipsSkipped}`);
  const reasons = Object.entries(reader.skipReasons).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (reasons.length) {
    L.push(`- Why clips were skipped: ${reasons.map(([why, n]) => `${n}× "${why}"`).join("; ")}`);
  }
  L.push(`- Reader speed: average x${digest.speedAvgX ?? "—"}, slowest x${digest.speedMinX ?? "—"} (x1.0 = keeps up with live; below = falls behind)`);
  L.push(`- Court found: ${digest.courtFound ? "yes" : "**no** (no stats can be measured without it)"}`);
  L.push(`- Reader starts: ${digest.readerStarts} (more than 1 = crashed or the app restarted); resumed saved progress: ${digest.resumedAfterRestart}; camera reconnects: ${digest.cameraReconnects}`);
  L.push(`- Share of samples each player was clearly seen (whole match so far, as of the last analysed clip): ${digest.lastSeen ?? "—"}`);
  L.push(`- Final numbers: ${stats ? `yes, covering ${round((stats.duration_s ?? 0) / 60, 1)} min of tracked play` : "**none** — the reader only writes numbers once it has seen all four players"}`);
  L.push("");

  L.push("## Snapshots");
  L.push("");
  if (!snaps.length) {
    L.push("None yet.");
  } else {
    L.push("| Snapshot | Taken | Stats cover | A distance | B distance | C distance | D distance | Box CPU avg / max | Reader cores avg | Max temp |");
    L.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const s of snaps) {
      const p = s.players ?? {};
      const dist = (k: string) => (p[k]?.distance_m != null ? `${p[k].distance_m} m` : "—");
      const r = s.resourcesSincePrevious;
      L.push(
        `| [${s.snapshot}](${SNAPSHOT_DIR}/${s.snapshot}/) | ${s.takenAtLocal}${s.lateByMin >= 1 ? ` (${s.lateByMin} min late)` : ""} | ` +
          `${s.statsCoverMin != null ? `${s.statsCoverMin} min` : "no stats yet"} | ${dist("A")} | ${dist("B")} | ${dist("C")} | ${dist("D")} | ` +
          `${r.boxCpuPct ? `${Math.round(r.boxCpuPct.avg)}% / ${Math.round(r.boxCpuPct.max)}%` : "—"} | ${r.readerCores?.avg ?? "—"} | ${r.cpuTempC ? `${Math.round(r.cpuTempC.max)} °C` : "—"} |`
      );
    }
    const missed = missedMilestones(snaps, lengthMs);
    if (missed.length) {
      L.push("");
      L.push(`No snapshot at: ${missed.join(", ")} (the app was down at that minute, or the copy failed).`);
    }
  }
  L.push("");

  if (stats?.players && Object.keys(stats.players).length) {
    L.push("## Final numbers per player");
    L.push("");
    L.push("| Player | Side | Distance | Top speed | Avg speed | Sprints | At net | At back | Court covered | Seen |");
    L.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const [label, p] of Object.entries(stats.players)) {
      L.push(
        `| ${label} | ${p.team ?? "—"} | ${p.distance_m ?? "—"} m | ${p.top_speed_ms ?? "—"} m/s | ${p.mean_speed_ms ?? "—"} m/s | ` +
          `${p.sprints ?? "—"} | ${p.time_at_net_pct ?? "—"}% | ${p.time_at_back_pct ?? "—"}% | ${p.court_coverage_pct ?? "—"}% | ` +
          `${p.detection_rate != null ? `${Math.round(p.detection_rate * 100)}%` : "—"} |`
      );
    }
    const teams = Object.entries(stats.teams ?? {});
    if (teams.length) {
      L.push("");
      L.push("| Team | Players | Usual gap between partners | Usual formation |");
      L.push("|---|---|---|---|");
      for (const [half, t] of teams) {
        L.push(`| ${half} | ${(t.players ?? []).join(" + ")} | ${t.mean_separation_m ?? "—"} m | ${t.dominant_formation ?? "—"} |`);
      }
    }
    L.push("");
    L.push("Distances are estimates (about ±10–15%: depth is judged from one camera). Labels A–D follow the end of the court, so after a change of ends a label can hold a different person.");
    L.push("");
  }

  L.push(`## Box resources (${res.minutes} one-minute samples in ${RESOURCES_FILE})`);
  L.push("");
  L.push("| | average | lowest | highest |");
  L.push("|---|---|---|---|");
  const rowOf = (
    label: string,
    s: { avg: number; min: number; max: number } | null,
    unit = "",
    places = 2
  ) => {
    const f = (v: number) => `${round(v, places)}${unit}`;
    L.push(`| ${label} | ${s ? f(s.avg) : "—"} | ${s ? f(s.min) : "—"} | ${s ? f(s.max) : "—"} |`);
  };
  rowOf("Whole box CPU", res.boxCpuPct, "%", 0);
  rowOf("Load (1 min; above the core count = queueing)", res.load1m, "", 1);
  rowOf("Stats reader (cores busy)", res.readerCores);
  rowOf("Live stream ffmpeg, all courts (cores busy)", res.streamCores);
  rowOf("Live stream ffmpeg processes (live streams; brief ad/audio checks at stream start count too)", res.streamFfmpegs, "", 0);
  rowOf("Streamer app (cores busy)", res.streamerCores);
  rowOf("Streamer app held up (worst pause in the minute)", res.eventLoopMaxMs, " ms", 0);
  rowOf("Memory available", res.memAvailMb, " MB", 0);
  rowOf("Stats reader memory", res.readerRssMb, " MB", 0);
  rowOf("CPU temperature", res.cpuTempC, " °C", 0);
  rowOf("Newest finished clip started this long ago (50–90 s = keeping up with 30 s clips; climbing = falling behind)", res.readerLagS, " s", 0);
  rowOf("Disk free", res.diskFreeGb, " GB", 1);
  L.push("");
  L.push(`The box has ${os.cpus().length} cores. "Cores busy" 1.0 = one core fully used.`);
  L.push("");

  L.push("## Pictures (final)");
  L.push("");
  if (fs.existsSync(path.join(matchDir, HEATMAP_FILE))) {
    L.push(`![All four players](${HEATMAP_FILE})`);
    L.push("");
    const each = SLOTS.filter((s) => fs.existsSync(path.join(matchDir, `heatmap-${s}.png`)));
    if (each.length) L.push(`Each player's own map: ${each.map((s) => `[${s}](heatmap-${s}.png)`).join(" · ")}`);
    const photos = SLOTS.filter((s) => fs.existsSync(path.join(matchDir, `photo-${s}.jpg`)));
    if (photos.length) L.push(`Photo sheets: ${photos.map((s) => `[${s}](photo-${s}.jpg)`).join(" · ")}`);
  } else {
    L.push("No heatmap (no stats were produced).");
  }
  L.push("");

  if (reader.problems.length) {
    L.push("## Problems in reader.log (latest 15)");
    L.push("");
    L.push("```");
    reader.problems.forEach((p) => L.push(p));
    L.push("```");
    L.push("");
  }

  L.push("## What's in this folder");
  L.push("");
  FOLDER_GUIDE.forEach((line) => L.push(`- ${line}`));
  L.push("");
  return L.join("\n");
}

const FOLDER_GUIDE = [
  "`summary.md` — this page.",
  "`match.json` — which ground, court, stream and scored match this is, and when it started.",
  "`stats.json`, `heatmap.png`, `heatmap-A..D.png`, `photo-A..D.jpg` — the latest (after the end: final) numbers and pictures.",
  "`snapshots/015min/`, `030min/`, … — stats.json + heatmap.png as they stood at that minute, plus `snapshot.json` (coverage, reader speed, resources since the previous snapshot).",
  "`snapshots/final/` — the complete final set, including each player's map, photo sheets and `court.json`.",
  "`resources.csv` — one row a minute: box CPU, memory, temperature, disk, reader and live-stream CPU, how long the streamer app was held up, how far behind live the stats were. Opens in any spreadsheet.",
  "`reader.log` — the stats reader's own log, one line per analysed clip.",
  "`court.json` — where the reader found the court in the camera picture.",
  "`pending.json` — finished, waiting to be sent. `done.json` — sent (or nothing to send). `rejected.json` — the backend refused it.",
];

function deliveryLine(matchDir: string, sendEnabled?: boolean): string {
  const donePath = path.join(matchDir, DONE_FILE);
  const done = readJson<DoneRecord>(donePath);
  if (done?.outcome === "no-stats") return "nothing to send (no stats were produced)";
  if (done || fs.existsSync(donePath)) {
    if (!done?.outcome) {
      // The queue file renamed in place after a full disk (outbox markDone).
      if (!fs.existsSync(path.join(matchDir, STATS_FILE))) return "nothing to send (no stats were produced)";
      const at = fs.statSync(donePath).mtimeMs;
      return `sent ${localTime(new Date(at))} (attempt ${(done?.attempts ?? 0) + 1})`;
    }
    const at = done.at ? Date.parse(done.at) : fs.statSync(donePath).mtimeMs;
    return `sent ${localTime(new Date(at))} (HTTP ${done.status ?? "2xx"}, attempt ${done.attempts ?? "?"})`;
  }
  const rejected = readJson<{ status?: number; response?: string }>(path.join(matchDir, REJECTED_FILE));
  if (rejected) return `**rejected** by the backend (HTTP ${rejected.status ?? "?"}): ${(rejected.response ?? "").slice(0, 120)}`;
  const pending = readJson<{ attempts?: number; lastError?: string }>(path.join(matchDir, PENDING_FILE));
  if (pending) {
    if (sendEnabled === false) return "waiting — sending is off on this box (STATS_SEND_ENABLED)";
    if (pending.attempts) return `waiting to retry (${pending.attempts} failed attempts; last: ${(pending.lastError ?? "").slice(0, 120)})`;
    return "queued to send";
  }
  return "match still running";
}

// Milestones that came due during the match but have no snapshot. Only known
// once one milestone was taken (that's where the interval is recorded).
function missedMilestones(snaps: SnapshotMeta[], lengthMs: number): string[] {
  const milestones = snaps.filter((s) => !s.final);
  const everyMin = milestones.find((s) => s.everyMin)?.everyMin;
  if (!everyMin || !Number.isFinite(lengthMs)) return [];
  const stepMs = Math.round(everyMin * 60_000);
  if (!(stepMs >= 1000)) return []; // a hand-edited/corrupt snapshot.json must not loop forever
  const taken = new Set(milestones.map((s) => s.snapshot));
  const out: string[] = [];
  for (let k = 1; k * stepMs <= lengthMs && out.length < MAX_MISSED_LISTED; k++) {
    const name = milestoneName(k * stepMs);
    if (!taken.has(name)) out.push(name);
  }
  return out;
}

// ── small helpers ──

function localTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Inverse of localTime(); NaN for anything else.
function parseLocalTime(v: string | number | null | undefined): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(v ?? ""));
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

function csvCell(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function avg(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
