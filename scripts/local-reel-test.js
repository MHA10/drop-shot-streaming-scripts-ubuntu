#!/usr/bin/env node
/*
 * local-reel-test.js — generate a highlight reel from a LOCAL recorded video,
 * with no live stream / RTSP / SSE / YouTube.
 *
 * The reel pipeline (buffer -> extract window -> reframe -> logo overlay) only
 * needs a directory of segment files. This harness segments a recorded clip
 * into that exact format, then runs the REAL services against it — so you can
 * confirm reel generation works (and judge ball-tracking) on real footage.
 *
 * Prereq: `npm run build` (this requires the compiled services in dist/).
 *
 * Usage:
 *   node scripts/local-reel-test.js --input match.mp4 --moment 40
 *   node scripts/local-reel-test.js --input match.mp4 --moment 40 --track
 *   node scripts/local-reel-test.js --input match.mp4 --moment 40 \
 *        --ds ./public/ds.png --client ./public/client.png --aspect 9:16
 *
 *   --input   recorded video (any ffmpeg-readable file)          [required]
 *   --moment  seconds into the video where the "highlight" is     [required]
 *   --track   use the Python/OpenCV ball reframer (needs opencv)  [default off]
 *   --aspect  reel aspect for --track                             [default 9:16]
 *   --pre / --post  window seconds before/after the moment        [25 / 5]
 *   --ds / --client logo PNG paths (placeholders auto-made if missing)
 *   --out     output directory                                   [./local-reel-out]
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

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
  // boolean flag (next token is another flag or absent)
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

async function main() {
  const input = arg("--input");
  const moment = parseFloat(arg("--moment"));
  if (!input || !fs.existsSync(input) || !Number.isFinite(moment)) {
    console.error("Usage: --input <video> --moment <seconds> [--track] [--aspect 9:16]");
    process.exit(1);
  }
  const track = arg("--track", false) === true;
  const aspect = arg("--aspect", "9:16");
  const pre = parseFloat(arg("--pre", "25"));
  const post = parseFloat(arg("--post", "5"));
  const outDir = path.resolve(arg("--out", "./local-reel-out"));
  const court = "local";
  const segSec = 2;

  const { HighlightBufferManager } = req("HighlightBufferManager");
  const { HighlightExtractorService } = req("HighlightExtractorService");
  const { HighlightRendererService } = req("HighlightRendererService");
  const { NullBallReframer } = req("NullBallReframer");
  const { PythonBallReframer } = req("PythonBallReframer");

  // Probe duration so we can clamp the window to the available footage.
  const dur = parseFloat(
    execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1", input,
    ]).toString().trim()
  );
  const effPre = Math.min(pre, moment);
  const effPost = Math.min(post, Math.max(0, dur - moment));
  if (effPre <= 0 && effPost <= 0) {
    console.error(`--moment ${moment}s leaves no window in a ${dur}s video.`);
    process.exit(1);
  }
  console.log(`Video ${dur.toFixed(1)}s; window = [moment-${effPre}s, moment+${effPost}s]`);

  // 1. Segment the recording into the buffer format the live ffmpeg produces:
  //    seg-<token>-<epoch>.ts, 2s each, forced keyframes at 2s boundaries.
  const bufDir = path.join(outDir, "buffer", court);
  fs.rmSync(path.join(outDir, "buffer"), { recursive: true, force: true });
  fs.mkdirSync(bufDir, { recursive: true });
  execFileSync("ffmpeg", [
    "-y", "-i", input,
    "-an",
    "-c:v", "libx264", "-preset", "veryfast",
    "-force_key_frames", `expr:gte(t,n_forced*${segSec})`,
    "-f", "segment", "-segment_time", String(segSec), "-reset_timestamps", "1",
    path.join(bufDir, "tmp-%05d.ts"),
  ], { stdio: "ignore" });

  // Rename tmp-<i>.ts -> seg-local-<base + i*segSec>.ts so each segment's epoch
  // equals its position in the video (deterministic window math).
  const base = 1000000;
  const tmps = fs.readdirSync(bufDir).filter((f) => f.startsWith("tmp-")).sort();
  tmps.forEach((f, i) => {
    fs.renameSync(path.join(bufDir, f), path.join(bufDir, `seg-local-${base + i * segSec}.ts`));
  });
  console.log(`Segmented into ${tmps.length} chunks.`);

  // 2. Window around the chosen moment, in the same epoch space.
  const eventMs = (base + moment) * 1000;
  const windowStartMs = eventMs - effPre * 1000;
  const windowEndMs = eventMs + effPost * 1000;

  const mgr = new HighlightBufferManager(court, bufDir, segSec, 100000, logger);
  const segs = mgr.getSegmentsInWindow(windowStartMs, windowEndMs);
  if (!segs) {
    console.error("No usable window (missing leading/trailing footage or a gap).");
    process.exit(1);
  }

  // 3. Extract the window.
  const extractor = new HighlightExtractorService(path.join(outDir, "clips"), logger);
  const raw = await extractor.extractWindow(segs, windowStartMs, windowEndMs, court);
  if (!raw) {
    console.error("Extraction failed.");
    process.exit(1);
  }

  // 4. (Optional) ball-tracking reframe.
  const reframer = track ? new PythonBallReframer(aspect, logger) : new NullBallReframer();
  const reframed = await reframer.reframe(raw, court);
  const source = reframed || raw;

  // 5. Logo overlay. Use provided logos, else the repo's, else placeholders.
  let ds = arg("--ds", path.join(REPO, "public/ds.png"));
  let client = arg("--client", path.join(REPO, "public/client.png"));
  ds = ensureLogo(ds, "DS", outDir);
  client = ensureLogo(client, "CLIENT", outDir);
  const renderer = new HighlightRendererService(ds, client, logger);
  const reelPath = path.join(outDir, "clips", court, "reel.mp4");
  const reel = await renderer.render(source, reelPath, court);

  const final = reel || source;
  console.log("\n=== RESULT ===");
  console.log("reframed (ball-tracking):", reframed ? "yes" : "no (full frame)");
  console.log("branded (logos):", reel ? "yes" : "no");
  console.log("FINAL REEL:", final);
  const info = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,codec_name:format=duration",
    "-of", "default=nw=1", final,
  ]).toString().trim();
  console.log(info);
}

// Return a usable logo path: the given one if it exists, else a generated
// placeholder so the overlay step is exercised.
function ensureLogo(p, label, outDir) {
  if (p && fs.existsSync(p)) return p;
  const gen = path.join(outDir, `placeholder-${label}.png`);
  fs.mkdirSync(outDir, { recursive: true });
  const color = label === "DS" ? "red" : "blue";
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `color=c=${color}:size=300x100`,
    "-frames:v", "1", gen,
  ], { stdio: "ignore" });
  console.log(`(logo ${label} not found; using placeholder ${gen})`);
  return gen;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
