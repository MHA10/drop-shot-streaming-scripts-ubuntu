// Reel audio + logo stacking.
//
// Two things the finished reel is judged on and that nothing else catches:
//
// 1. AUDIO. It used to be dropped in three separate places — the live command's
//    highlight-buffer output, the extractor's cut, and the renderer's overlay
//    pass. Re-enabling any two of them still yields a silent reel, so each
//    stage is asserted on its own.
// 2. BRANDING. The venue's logo must sit UNDER the DropShot mark in the
//    bottom-right, smaller and faded. It used to be full size in the top-right,
//    where on a 9:16 reel it covered a chunk of the court.
//
// Run:  npm run build && node --test test/reel-audio-and-branding.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { HighlightRendererService } = require("../dist/src/infrastructure/services/HighlightRendererService.js");

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

// Config is a process-wide singleton that reads env in its constructor, so the
// client logo path has to be planted before anything calls getInstance().
const FIXTURES = mkdtempSync(join(tmpdir(), "reel-fixtures-"));
writeFileSync(join(FIXTURES, "client.png"), "not-a-real-png");
process.env.CLIENT_IMAGES_PATH = join(FIXTURES, "client.png");
process.env.DROPSHOT_GROUND_ID = process.env.DROPSHOT_GROUND_ID || "test-ground";
const { Config } = require("../dist/src/infrastructure/config/Config.js");
const { NodeFFmpegService } = require("../dist/src/infrastructure/services/NodeFFmpegService.js");

// Reel canvas: 4:5 at 1080 tall, the aspect Padel Central actually runs.
const W = 864;
const H = 1080;

function withLogos(run, { ds = true, client = true, scale, opacity } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reel-brand-"));
  try {
    const dsPath = join(dir, "ds.png");
    const clientPath = join(dir, "client.png");
    if (ds) writeFileSync(dsPath, "not-a-real-png");
    if (client) writeFileSync(clientPath, "not-a-real-png");
    const renderer = new HighlightRendererService(
      dsPath,
      clientPath,
      quietLogger,
      ...(scale !== undefined ? [scale, opacity] : [])
    );
    run({ renderer, dsPath, clientPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The `overlay=X:Y` position string for the Nth overlay step in the filter. */
function overlayPositions(filter) {
  return [...filter.matchAll(/overlay=([^ \]]+)/g)].map((m) => m[1]);
}
function scaleBoxes(filter) {
  return [...filter.matchAll(/scale=(\d+):(\d+)/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
  ]);
}
function filterOf(args) {
  return args[args.indexOf("-filter_complex") + 1];
}

test("renderer keeps the clip's audio instead of dropping it", () => {
  withLogos(({ renderer }) => {
    const args = renderer.buildRenderArgs("clip.mp4", W, H);
    assert.ok(!args.includes("-an"), "-an would silence the reel");
    // Optional map: a clip with no audio must still render.
    assert.ok(args.includes("0:a?"), "audio must be mapped optionally");
    assert.equal(args[args.indexOf("-c:a") + 1], "copy");
  });
});

test("renderer maps video explicitly so the audio map can't displace it", () => {
  withLogos(({ renderer }) => {
    const args = renderer.buildRenderArgs("clip.mp4", W, H);
    assert.ok(args.includes("[vout]"));
    assert.ok(args.indexOf("[vout]") < args.indexOf("0:a?"), "video maps first");
  });
});

test("client logo sits below the DropShot logo, both bottom-right", () => {
  withLogos(({ renderer }) => {
    const filter = filterOf(renderer.buildRenderArgs("clip.mp4", W, H));
    const [dsPos, clientPos] = overlayPositions(filter);

    // Both pinned to the right edge by the same margin.
    const marginX = Math.round(W * 0.02);
    assert.ok(dsPos.startsWith(`main_w-overlay_w-${marginX}:`), dsPos);
    assert.ok(clientPos.startsWith(`main_w-overlay_w-${marginX}:`), clientPos);

    // Both measured up from the BOTTOM edge — neither is in the top corner
    // any more. The old client position was a bare `:<margin>` from the top.
    assert.ok(dsPos.includes("main_h-overlay_h-"), dsPos);
    assert.ok(clientPos.includes("main_h-overlay_h-"), clientPos);

    // DropShot is lifted further off the bottom, so the client sits beneath it.
    const dsUp = Number(dsPos.split("main_h-overlay_h-")[1]);
    const clientUp = Number(clientPos.split("main_h-overlay_h-")[1]);
    assert.ok(dsUp > clientUp, `DropShot (${dsUp}) must sit above client (${clientUp})`);

    // The lift clears the client's whole box, so they can never overlap.
    const clientBoxH = Math.round(Math.round(H * 0.18) * 0.55);
    assert.ok(dsUp >= clientUp + clientBoxH, "gap must clear the client logo");
  });
});

test("client logo is smaller than the DropShot logo and semi-transparent", () => {
  withLogos(({ renderer }) => {
    const filter = filterOf(renderer.buildRenderArgs("clip.mp4", W, H));
    const [dsBox, clientBox] = scaleBoxes(filter);

    assert.ok(clientBox[0] < dsBox[0], "client must be narrower");
    assert.ok(clientBox[1] < dsBox[1], "client must be shorter");
    assert.equal(clientBox[0], Math.round(dsBox[0] * 0.55));

    // Alpha is applied to the client only, and format=rgba comes first or the
    // mixer has no alpha channel to scale.
    assert.match(filter, /format=rgba,colorchannelmixer=aa=0\.65/);
    assert.equal((filter.match(/colorchannelmixer/g) || []).length, 1);
  });
});

test("scale and opacity are configurable", () => {
  withLogos(
    ({ renderer }) => {
      const filter = filterOf(renderer.buildRenderArgs("clip.mp4", W, H));
      const [dsBox, clientBox] = scaleBoxes(filter);
      assert.equal(clientBox[0], Math.round(dsBox[0] * 0.3));
      assert.match(filter, /colorchannelmixer=aa=0\.9/);
    },
    { scale: 0.3, opacity: 0.9 }
  );
});

test("a fully opaque client logo skips the alpha filter entirely", () => {
  withLogos(
    ({ renderer }) => {
      const filter = filterOf(renderer.buildRenderArgs("clip.mp4", W, H));
      assert.ok(!filter.includes("colorchannelmixer"), filter);
    },
    { scale: 0.55, opacity: 1 }
  );
});

test("without a client logo, DropShot keeps the plain bottom-right corner", () => {
  withLogos(
    ({ renderer }) => {
      const filter = filterOf(renderer.buildRenderArgs("clip.mp4", W, H));
      const [dsPos] = overlayPositions(filter);
      assert.equal(dsPos, `main_w-overlay_w-${Math.round(W * 0.02)}:main_h-overlay_h-${Math.round(H * 0.02)}`);
    },
    { client: false }
  );
});

test("no logos on disk means no render at all", () => {
  withLogos(
    ({ renderer }) => {
      assert.equal(renderer.buildRenderArgs("clip.mp4", W, H), null);
    },
    { ds: false, client: false }
  );
});

test("landscape full-frame clips keep their original logo sizing", () => {
  withLogos(({ renderer }) => {
    const filter = filterOf(renderer.buildRenderArgs("clip.mp4", 1920, 1080));
    const [dsBox] = scaleBoxes(filter);
    assert.deepEqual(dsBox, [Math.round(1920 * 0.26), Math.round(1080 * 0.13)]);
  });
});

// ── the buffer, where the audio has to exist in the first place ──────────────

/** The highlight-buffer output is everything after its `-map [hlbuf]`. */
function bufferOutputArgs(args) {
  const i = args.lastIndexOf("[hlbuf]");
  assert.ok(i > 0, "expected a highlight buffer output");
  return args.slice(i + 1);
}

function buildLiveCommand(hasAudio) {
  const bufferDir = mkdtempSync(join(tmpdir(), "hl-buffer-"));
  try {
    const svc = new NodeFFmpegService(quietLogger, Config.getInstance());
    return svc.buildStreamCommand(
      { value: "rtsp://camera/stream" },
      "stream-key",
      hasAudio,
      "court-1",
      false,
      undefined,
      bufferDir
    ).args;
  } finally {
    rmSync(bufferDir, { recursive: true, force: true });
  }
}

test("highlight buffer records court audio when the camera has it", () => {
  const out = bufferOutputArgs(buildLiveCommand(true));
  assert.ok(!out.includes("-an"), "buffer would be silent and no reel could recover it");
  assert.ok(out.includes("0:a"), "camera audio must be mapped into the buffer");
  assert.equal(out[out.indexOf("-c:a") + 1], "aac");
});

test("highlight buffer stays silent when the camera has no audio", () => {
  // The only audio present is the anullsrc filler added for the RTMP output.
  // Recording that into every segment costs disk for literal silence.
  const out = bufferOutputArgs(buildLiveCommand(false));
  assert.ok(out.includes("-an"), "silent camera must not fill the buffer with silence");
  assert.ok(!out.includes("-c:a"), out.join(" "));
});

test("the live YouTube output is unchanged by the buffer's audio", () => {
  for (const hasAudio of [true, false]) {
    const args = buildLiveCommand(hasAudio);
    const live = args.slice(0, args.lastIndexOf("[hlbuf]") - 1);
    assert.ok(live.includes("flv"), "live output must still be flv");
    assert.equal(live[live.indexOf("-c:a") + 1], "aac");
    assert.equal(live[live.indexOf("-b:a") + 1], "128k");
  }
});
