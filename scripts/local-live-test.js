#!/usr/bin/env node
/*
 * local-live-test.js — simulate a LIVE stream from a local video file and
 * generate a highlight reel when you mark a moment, all locally (no RTSP / SSE
 * / YouTube).
 *
 * It runs a real-time (`-re`) ffmpeg segmenter that writes the SAME rolling
 * buffer the live pipeline produces (Phase 1), runs the real retention sweep
 * (Phase 2), and on a highlight mark runs the real extract -> reframe -> logo
 * overlay (Phases 4-5). So the buffer fills in real time and you cut ~30s
 * around whatever moment you mark — exactly the live behavior.
 *
 * Prereq: `npm run build`.
 *
 * Get a test video first (on your machine):
 *   yt-dlp -f 'bestvideo[height<=720]' -o match.mp4 'https://youtu.be/T0afGDiqYPk'
 *
 * Usage:
 *   node scripts/local-live-test.js --input match.mp4
 *       → streams it "live"; press ENTER whenever you want to mark a highlight.
 *   node scripts/local-live-test.js --input match.mp4 --highlight-after 40
 *       → auto-marks a highlight 40s in (scripted).
 *   flags: --loop  --track  --aspect 9:16  --pre 25  --post 5  --lag 0
 *          --ds <png>  --client <png>  --out ./local-live-out
 */

const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const readline = require("readline");

const REPO = path.resolve(__dirname, "..");
const DIST = path.join(REPO, "dist/src/infrastructure/services");

function req(name) {
  const p = path.join(DIST, `${name}.js`);
  if (!fs.existsSync(p)) {
    console.error(`Missing ${p} — run 'npm run build' first.`);
    process.exit(1);
  }
  return require(p);
}
function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return def;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}
const logger = {
  info: (m, meta) => console.log("INFO ", m, meta ? JSON.stringify(meta) : ""),
  warn: (m, meta) => console.log("WARN ", m, meta ? JSON.stringify(meta) : ""),
  error: (m, meta) => console.log("ERROR", m, meta ? JSON.stringify(meta) : ""),
  debug: () => {},
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const input = arg("--input");
if (!input || !fs.existsSync(input)) {
  console.error("Need --input <local video file>. Fetch one with yt-dlp (see header).");
  process.exit(1);
}
const loop = arg("--loop", false) === true;
const track = arg("--track", false) === true;
const aspect = arg("--aspect", "9:16");
const pre = parseFloat(arg("--pre", "25"));
const post = parseFloat(arg("--post", "5"));
const lag = parseFloat(arg("--lag", "0")); // 0 locally: mark == moment (no mesh delay)
const highlightAfter = arg("--highlight-after", null);
const outDir = path.resolve(arg("--out", "./local-live-out"));
const court = "local";
const segSec = 2;
const retentionSec = Math.ceil(pre + post + lag + 15);

const { HighlightBufferManager } = req("HighlightBufferManager");
const { HighlightExtractorService } = req("HighlightExtractorService");
const { HighlightRendererService } = req("HighlightRendererService");
const { NullBallReframer } = req("NullBallReframer");
const { PythonBallReframer } = req("PythonBallReframer");

const bufDir = path.join(outDir, "buffer", court);
fs.rmSync(path.join(outDir, "buffer"), { recursive: true, force: true });
fs.mkdirSync(bufDir, { recursive: true });

// Real-time segmenter — identical output to the live Phase 1 buffer branch.
const segArgs = [
  "-re",
  ...(loop ? ["-stream_loop", "-1"] : []),
  "-i", input,
  "-an",
  "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "800k",
  "-force_key_frames", `expr:gte(t,n_forced*${segSec})`,
  "-f", "segment", "-segment_time", String(segSec), "-reset_timestamps", "1",
  "-strftime", "1",
  path.join(bufDir, "seg-live-%s.ts"),
];
console.log("Starting live buffer segmenter (real-time)...");
const seg = spawn("ffmpeg", segArgs, { stdio: ["ignore", "ignore", "ignore"] });

const mgr = new HighlightBufferManager(court, bufDir, segSec, retentionSec, logger);
mgr.start();

const extractor = new HighlightExtractorService(path.join(outDir, "clips"), logger);
const reframer = track ? new PythonBallReframer(aspect, logger) : new NullBallReframer();
let ds = arg("--ds", path.join(REPO, "public/ds.png"));
let client = arg("--client", path.join(REPO, "public/client.png"));
ds = ensureLogo(ds, "DS");
client = ensureLogo(client, "CLIENT");
const renderer = new HighlightRendererService(ds, client, logger);

let capturing = false;
async function markHighlight() {
  if (capturing) {
    console.log("(already capturing a highlight; ignoring)");
    return;
  }
  capturing = true;
  const receivedAtMs = Date.now();
  const eventMs = receivedAtMs - lag * 1000;
  const windowStartMs = eventMs - pre * 1000;
  const windowEndMs = eventMs + post * 1000;
  console.log(`\n★ Highlight marked. Window = ${pre}s before / ${post}s after. Waiting for post-roll...`);

  // Wait for the trailing segment to flush (same as CaptureHighlightUseCase).
  const waitMs = windowEndMs + (segSec + 1) * 1000 - Date.now();
  if (waitMs > 0) await sleep(waitMs);

  const segs = mgr.getSegmentsInWindow(windowStartMs, windowEndMs);
  if (!segs) {
    console.log("✗ Not enough buffer yet for that window (mark later, once ~30s has streamed).");
    capturing = false;
    return;
  }
  const raw = await extractor.extractWindow(segs, windowStartMs, windowEndMs, court);
  if (!raw) { console.log("✗ extraction failed"); capturing = false; return; }
  const reframed = await reframer.reframe(raw, court);
  const source = reframed || raw;
  const reelPath = path.join(outDir, "clips", court, `reel-${windowStartMs}.mp4`);
  const reel = await renderer.render(source, reelPath, court);
  const final = reel || raw;
  console.log(`✓ REEL: ${final}  (reframed:${reframed ? "yes" : "no"}, branded:${reel ? "yes" : "no"})`);
  try {
    const info = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height:format=duration",
      "-of", "default=nw=1", final,
    ]).toString().trim().replace(/\n/g, " ");
    console.log(`  ${info}`);
  } catch {}
  capturing = false;
}

function ensureLogo(p, label) {
  if (p && fs.existsSync(p)) return p;
  const gen = path.join(outDir, `placeholder-${label}.png`);
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i",
    `color=c=${label === "DS" ? "red" : "blue"}:size=300x100`, "-frames:v", "1", gen],
    { stdio: "ignore" });
  return gen;
}

function shutdown() {
  console.log("\nStopping...");
  try { seg.kill("SIGKILL"); } catch {}
  mgr.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
seg.on("exit", () => { if (!loop) console.log("(source ended; pass --loop to keep streaming)"); });

if (highlightAfter !== null) {
  const afterMs = parseFloat(highlightAfter) * 1000;
  console.log(`Will auto-mark a highlight after ${highlightAfter}s...`);
  setTimeout(async () => { await markHighlight(); shutdown(); }, afterMs);
} else {
  console.log("Streaming live. Press ENTER to mark a highlight (Ctrl+C to quit).");
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", () => void markHighlight());
}
