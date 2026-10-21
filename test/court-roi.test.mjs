// Court boundary for the highlight reel tracker.
//
// 1. Config/selection logic (compiled TS): per-court override beats the box
//    default, empty means no --roi flag, bad JSON never breaks startup.
// 2. The REAL scripts/reframe_ball.py on a synthetic clip: a player on court
//    plus a bigger passer-by outside it. With the boundary the crop must stay
//    on the player; without it the passer-by drags the crop away (the
//    incident this fixes). Skipped when Python/OpenCV isn't available.
//
// Run:  npm run build && node --test test/court-roi.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { parseCourtRoiMap, pickCourtRoi } = require("../dist/src/infrastructure/utils/courtRoi.js");
const { PythonBallReframer } = require("../dist/src/infrastructure/services/PythonBallReframer.js");

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "scripts", "reframe_ball.py");
// Padel Central camera (the court the incident happened on).
const ROI = "0.427,0.100;0.593,0.124;0.824,0.921;0.782,0.998;0.257,0.998;0.165,0.837";

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

test("parseCourtRoiMap: valid JSON object of strings", () => {
  assert.deepEqual(parseCourtRoiMap('{"c1":" 0,0;1,0;1,1 ","c2":"0,0;1,0;0,1"}'), {
    c1: "0,0;1,0;1,1",
    c2: "0,0;1,0;0,1",
  });
});

test("parseCourtRoiMap: empty, bad JSON, wrong shape and bad values are dropped, not thrown", () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.deepEqual(parseCourtRoiMap("", warn), {});
  assert.deepEqual(parseCourtRoiMap("{not json", warn), {});
  assert.deepEqual(parseCourtRoiMap('["0,0;1,0;1,1"]', warn), {});
  assert.deepEqual(parseCourtRoiMap('{"c1":5,"c2":"","c3":"0,0;1,0;1,1"}', warn), { c3: "0,0;1,0;1,1" });
  assert.equal(warnings.length, 4);
});

test("pickCourtRoi: per-court override wins, else box default, else none", () => {
  const byCourt = { c1: "A" };
  assert.equal(pickCourtRoi("D", byCourt, "c1"), "A");
  assert.equal(pickCourtRoi("D", byCourt, "c2"), "D");
  assert.equal(pickCourtRoi("", {}, "c2"), "");
});

test("PythonBallReframer passes --roi only when the court has a boundary", () => {
  const r = new PythonBallReframer("9:16", quietLogger, SCRIPT, "D", { c1: "A" });
  const without = new PythonBallReframer("9:16", quietLogger, SCRIPT).buildArgs("in.mp4", "out.mp4", "");
  assert.ok(!without.includes("--roi"));
  const withRoi = r.buildArgs("in.mp4", "out.mp4", "A");
  assert.deepEqual(withRoi.slice(-2), ["--roi", "A"]);
});

// ── Real script on a synthetic clip ──

function findPython() {
  const candidates = [
    process.env.REFRAME_PYTHON,
    join(REPO, "tools", "reels", ".venv", "bin", "python"),
    "python3",
  ].filter(Boolean);
  for (const py of candidates) {
    const r = spawnSync(py, ["-c", "import cv2, numpy"], { encoding: "utf8" });
    if (r.status === 0) return py;
  }
  return null;
}
const PY = findPython();

// Draws the clip, runs the tracker, then reports which coloured figure is
// visible in the middle of the reel: red = player on court, green = passer-by.
const HARNESS = String.raw`
import sys, subprocess, cv2, numpy as np
script, work, roi = sys.argv[1], sys.argv[2], sys.argv[3]
W, H, FPS, N = 640, 360, 15, 120
src = work + "/src.mp4"
wr = cv2.VideoWriter(src, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
for i in range(N):
    f = np.full((H, W, 3), 90, np.uint8)
    dx = int(20 * np.sin(i / 4.0))
    # player on court: feet at (0.60, 0.70)
    cx, fy = int(0.60 * W) + dx, int(0.70 * H)
    cv2.rectangle(f, (cx - 15, fy - 60), (cx + 15, fy), (0, 0, 255), -1)
    # bigger passer-by outside the left glass: feet at (0.08, 0.50)
    ox, oy = int(0.08 * W) - dx, int(0.50 * H)
    cv2.rectangle(f, (ox - 20, oy - 80), (ox + 20, oy), (0, 255, 0), -1)
    wr.write(f)
wr.release()
out = work + "/out.mp4"
args = [sys.executable, script, "--input", src, "--output", out, "--aspect", "9:16", "--debug"]
if roi:
    args += ["--roi", roi]
p = subprocess.run(args, capture_output=True, text=True)
sys.stderr.write(p.stderr)
if p.returncode != 0:
    sys.exit(p.returncode)
cap = cv2.VideoCapture(out)
cap.set(cv2.CAP_PROP_POS_FRAMES, N // 2)
ok, fr = cap.read()
red = int(((fr[:, :, 2] > 180) & (fr[:, :, 1] < 80)).sum())
green = int(((fr[:, :, 1] > 180) & (fr[:, :, 2] < 80)).sum())
print(f"{red} {green}")
`;

function runSynthetic(roi) {
  const work = mkdtempSync(join(tmpdir(), "court-roi-"));
  try {
    const r = spawnSync(PY, ["-c", HARNESS, SCRIPT, work, roi], { encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    const [red, green] = r.stdout.trim().split(/\s+/).map(Number);
    return { red, green, stderr: r.stderr };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test("reframe_ball.py: with the court boundary the crop stays on the player, not the passer-by",
  { skip: !PY || !existsSync(SCRIPT) ? "python3 + opencv not available" : false },
  () => {
    const withRoi = runSynthetic(ROI);
    assert.match(withRoi.stderr, /roi=on rejected_outside=[1-9]/);
    assert.ok(withRoi.red > 500, `player should be in the reel (red px=${withRoi.red})`);
    assert.equal(withRoi.green, 0, "passer-by must not be in the reel");

    // Control: without the boundary the passer-by pulls the crop off the player.
    const without = runSynthetic("");
    assert.match(without.stderr, /roi=off/);
    assert.ok(without.red < withRoi.red / 2, `without a boundary the crop should drift (red px=${without.red})`);
  });

test("reframe_ball.py: an invalid boundary is ignored with a warning, the reel still renders",
  { skip: !PY || !existsSync(SCRIPT) ? "python3 + opencv not available" : false },
  () => {
    const r = runSynthetic("garbage");
    assert.match(r.stderr, /ignoring invalid --roi/);
    assert.match(r.stderr, /roi=off/);
  });
