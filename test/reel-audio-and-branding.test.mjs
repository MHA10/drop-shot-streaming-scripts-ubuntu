// Reel audio + logo stacking.
//
// Two things the finished reel is judged on and that nothing else catches:
//
// 1. AUDIO. It used to be dropped in three separate places — the live command's
//    highlight-buffer output, the extractor's cut, and the renderer's overlay
//    pass. Re-enabling any two of them still yields a silent reel, so each
//    stage is asserted on its own.
// 2. BRANDING. The venue's logo must sit in the bottom-LEFT corner, faded, and
//    bounded by an invisible box no longer and no taller than the DropShot
//    mark RENDERS — not than its nominal box, which is far taller than the
//    4.4:1 wordmark inside it. The DropShot mark itself must stay exactly
//    where it has always been in the bottom-right. The venue's logo used to be
//    full size in the top-right, covering a chunk of a vertical reel's court.
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

// public/ds.png as shipped: a 4.4:1 wordmark. Its real proportions are the
// point of these tests — a square stand-in would hide the bug the cap fixes.
const DS_PNG = { width: 3504, height: 790 };
// What that wordmark RENDERS at inside its 346x194 nominal box on this canvas:
// width-limited, so ~116px of the box's height goes unused.
const DS_FIT = [346, 78];

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

/** Render args with the real ds.png proportions supplied to the cap. */
function argsWithRealDsLogo(renderer, w = W, h = H) {
  return renderer.buildRenderArgs("clip.mp4", w, h, DS_PNG);
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

test("logos sit in opposite bottom corners: DropShot right, client left", () => {
  withLogos(({ renderer }) => {
    const filter = filterOf(argsWithRealDsLogo(renderer));
    const [dsPos, clientPos] = overlayPositions(filter);
    const marginX = Math.round(W * 0.02);
    const marginY = Math.round(H * 0.02);

    // DropShot: bottom-right, exactly the corner it has always occupied.
    assert.equal(dsPos, `main_w-overlay_w-${marginX}:main_h-overlay_h-${marginY}`);
    // Client: bottom-LEFT. A bare x margin means the left edge; `main_w-...`
    // would put it back on the right.
    assert.equal(clientPos, `${marginX}:main_h-overlay_h-${marginY}`);
    assert.ok(!clientPos.startsWith("main_w"), "client must not be right-aligned");

    // Same bottom line, so the pair reads as one footer rather than two
    // unrelated stamps.
    assert.equal(
      dsPos.split("main_h-overlay_h-")[1],
      clientPos.split("main_h-overlay_h-")[1]
    );
  });
});

test("the client logo never moves the DropShot logo", () => {
  let withClient;
  withLogos(({ renderer }) => {
    withClient = overlayPositions(filterOf(argsWithRealDsLogo(renderer)))[0];
  });
  withLogos(
    ({ renderer }) => {
      const alone = overlayPositions(filterOf(argsWithRealDsLogo(renderer)))[0];
      assert.equal(alone, withClient, "DropShot's corner must not depend on the client logo");
    },
    { client: false }
  );
});

test("the client logo's box is capped at the DropShot mark's rendered box", () => {
  withLogos(({ renderer }) => {
    const filter = filterOf(argsWithRealDsLogo(renderer));
    const [, clientBox] = scaleBoxes(filter);
    // Same length cap and same height cap as the mark it sits beside.
    assert.deepEqual(clientBox, DS_FIT);
  });
});

test("the cap follows the rendered mark, not its nominal box", () => {
  withLogos(({ renderer }) => {
    const filter = filterOf(argsWithRealDsLogo(renderer));
    const [dsBox, clientBox] = scaleBoxes(filter);
    // The regression this exists for: the nominal box is 194 tall while the
    // wordmark inside it renders 78 tall, so a client logo capped at the
    // nominal height could stand taller than DropShot's own mark.
    assert.ok(
      clientBox[1] < dsBox[1],
      `client height cap ${clientBox[1]} must be below the nominal ${dsBox[1]}`
    );
    assert.equal(clientBox[1], DS_FIT[1]);
  });
});

test("the box bounds any artwork instead of stretching it", () => {
  withLogos(({ renderer }) => {
    const filter = filterOf(argsWithRealDsLogo(renderer));
    // Every logo is fitted with its aspect preserved. Without `decrease` a
    // venue's square badge would be squashed into a 4.4:1 letterbox — the
    // difference between a bounding box and a forced size.
    assert.equal(
      (filter.match(/force_original_aspect_ratio=decrease/g) || []).length,
      2
    );
  });
});

test("the cap is generic: it is derived, not written for one logo", () => {
  // A hypothetical venue running square DropShot artwork gets a square cap.
  // Nothing here knows about ds.png specifically.
  withLogos(({ renderer }) => {
    const filter = filterOf(
      renderer.buildRenderArgs("clip.mp4", W, H, { width: 500, height: 500 })
    );
    const [dsBox, clientBox] = scaleBoxes(filter);
    const side = Math.min(dsBox[0], dsBox[1]); // 194: height-limited
    assert.deepEqual(clientBox, [side, side]);
  });
});

test("an unprobed DropShot logo falls back to the pre-cap sizing", () => {
  withLogos(({ renderer }) => {
    // No size supplied: nothing to cap against, so the box reverts to the
    // fraction-of-nominal the reel shipped with before the cap.
    //
    // Note what is NOT asserted: that this box is under the DropShot mark's
    // rendered height. It isn't, and it can't be — that height is the thing
    // that could not be read. This path restores the old look rather than
    // guessing, and the old look is what prompted the cap in the first place.
    const filter = filterOf(renderer.buildRenderArgs("clip.mp4", W, H));
    const [dsBox, clientBox] = scaleBoxes(filter);
    assert.deepEqual(clientBox, [
      Math.round(dsBox[0] * 0.55),
      Math.round(dsBox[1] * 0.55),
    ]);
  });
});

test("the client logo is semi-transparent and DropShot is not", () => {
  withLogos(({ renderer }) => {
    const filter = filterOf(argsWithRealDsLogo(renderer));
    // Alpha is applied to the client only, and format=rgba comes first or the
    // mixer has no alpha channel to scale.
    assert.match(filter, /format=rgba,colorchannelmixer=aa=0\.85/);
    assert.equal((filter.match(/colorchannelmixer/g) || []).length, 1);
  });
});

test("scale and opacity are configurable", () => {
  withLogos(
    ({ renderer }) => {
      const filter = filterOf(argsWithRealDsLogo(renderer));
      const [, clientBox] = scaleBoxes(filter);
      assert.deepEqual(clientBox, [
        Math.round(DS_FIT[0] * 0.5),
        Math.round(DS_FIT[1] * 0.5),
      ]);
      assert.match(filter, /colorchannelmixer=aa=0\.9/);
    },
    { scale: 0.5, opacity: 0.9 }
  );
});

test("a fully opaque client logo skips the alpha filter entirely", () => {
  withLogos(
    ({ renderer }) => {
      const filter = filterOf(argsWithRealDsLogo(renderer));
      assert.ok(!filter.includes("colorchannelmixer"), filter);
    },
    { scale: 1, opacity: 1 }
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
    const filter = filterOf(argsWithRealDsLogo(renderer, 1920, 1080));
    const [dsBox] = scaleBoxes(filter);
    assert.deepEqual(dsBox, [Math.round(1920 * 0.26), Math.round(1080 * 0.13)]);
  });
});

test("capping the client logo never resizes the DropShot logo", () => {
  withLogos(({ renderer }) => {
    const [dsAlone] = scaleBoxes(filterOf(argsWithRealDsLogo(renderer)));
    const [dsCapped] = scaleBoxes(
      filterOf(renderer.buildRenderArgs("clip.mp4", W, H))
    );
    // The DropShot mark is scaled from the canvas and nothing else; the cap
    // reads its size but must never feed back into it.
    assert.deepEqual(dsAlone, dsCapped);
    assert.deepEqual(dsAlone, [Math.round(W * 0.4), Math.round(H * 0.18)]);
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
