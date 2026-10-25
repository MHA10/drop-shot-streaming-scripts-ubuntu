// A reel must never sit on a box with nothing coming for it.
//
// The failure this exists for (Hello Padel, 25 Oct 2026): heartbeat, SSE and
// the reel upload all failed inside one ~30s window — the venue's uplink, not
// the backend. The pipeline had done everything right; the reel was simply
// stranded on disk with nothing to pick it up.
//
// Three properties matter more than the happy path and are asserted hardest:
//   1. Retries NEVER stop. No attempt limit, no age cap.
//   2. A reel is NEVER deleted unless a real videoId came back.
//   3. A reel is queued BEFORE the first attempt, so a process killed
//      mid-transfer still leaves a record that the upload is owed.
//
// Run:  npm run build && node --test test/reel-upload-retry.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { PendingReelUploads, QUEUE_SUFFIX } = require("../dist/src/infrastructure/services/PendingReelUploads.js");

const COURT = "court-1";
const RETRY_SEC = 600; // the shipping default: 10 minutes

function collectingLogger() {
  const lines = [];
  const push = (level) => (msg, meta) => lines.push({ level, msg, meta });
  return { lines, info: push("info"), warn: push("warn"), error: push("error"), debug: push("debug") };
}

/** An uploader that returns whatever the test queues, and records its calls. */
function fakeUploader(results) {
  const calls = [];
  return {
    calls,
    async upload(req) {
      calls.push(req);
      return results.length ? results.shift() : null;
    },
  };
}

const request = (reel) => ({
  filePath: reel,
  courtId: COURT,
  streamKey: "stream-key-secret",
  title: "DropShot highlight",
  preferShort: true,
});

/** A scratch output dir laid out the way the capture pipeline lays it out. */
async function withOutputDir(run) {
  const root = mkdtempSync(join(tmpdir(), "reel-retry-"));
  try {
    const courtDir = join(root, COURT);
    mkdirSync(courtDir, { recursive: true });
    const reel = join(courtDir, "highlight-1.mp4");
    writeFileSync(reel, "not-a-real-mp4");
    const logger = collectingLogger();
    const make = (uploader, { now, deleteAfterUpload = true } = {}) =>
      new PendingReelUploads(root, uploader, logger, RETRY_SEC, deleteAfterUpload, now);
    await run({ root, courtDir, reel, logger, make });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a reel is queued before the first attempt, not after it fails", async () => {
  await withOutputDir(({ reel, make }) => {
    make(fakeUploader([]), { now: () => 1_000_000 }).enqueue(request(reel));
    const entry = JSON.parse(readFileSync(reel + QUEUE_SUFFIX, "utf8"));
    // attempts 0: nothing has been tried yet. This is the window that matters —
    // a process killed here still leaves a record that the upload is owed.
    assert.equal(entry.attempts, 0);
    assert.equal(entry.filePath, reel);
    assert.equal(entry.queuedAtMs, 1_000_000);
  });
});

test("the queue entry is not world-readable: it carries the stream key", async () => {
  await withOutputDir(({ reel, make }) => {
    make(fakeUploader([]), { now: () => 1 }).enqueue(request(reel));
    // The backend needs the stream key to resolve privacy and it cannot be
    // recovered once the booking ends, so it has to be persisted — which makes
    // the file mode part of the contract, not an implementation detail.
    const mode = statSync(reel + QUEUE_SUFFIX).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });
});

test("resolve() clears the entry after a successful first attempt", async () => {
  await withOutputDir(({ reel, make }) => {
    const svc = make(fakeUploader([]), { now: () => 1 });
    svc.enqueue(request(reel));
    svc.resolve(reel);
    assert.ok(!existsSync(reel + QUEUE_SUFFIX));
  });
});

test("re-queueing keeps the ORIGINAL queue time so the wait stays honest", async () => {
  await withOutputDir(({ reel, make }) => {
    let t = 1_000_000;
    const svc = make(fakeUploader([]), { now: () => t });
    svc.enqueue(request(reel));
    t += 60 * 60 * 1000;
    svc.enqueue(request(reel));
    assert.equal(JSON.parse(readFileSync(reel + QUEUE_SUFFIX, "utf8")).queuedAtMs, 1_000_000);
  });
});

test("RETRIES NEVER STOP — a reel offline for days still goes up", async () => {
  await withOutputDir(async ({ reel, make }) => {
    let t = 1_000_000;
    // Fails for three solid days of sweeps, then the line comes back.
    const uploader = fakeUploader([]);
    const svc = make(uploader, { now: () => t });
    svc.enqueue(request(reel));

    const sweepsPerDay = (24 * 60 * 60) / RETRY_SEC;
    for (let i = 0; i < sweepsPerDay * 3; i++) {
      t += RETRY_SEC * 1000;
      await svc.drain();
    }
    assert.equal(uploader.calls.length, sweepsPerDay * 3, "must keep trying, forever");
    assert.ok(existsSync(reel), "and must still have the reel to send");

    uploader.upload = async (req) => { uploader.calls.push(req); return "video-123"; };
    t += RETRY_SEC * 1000;
    await svc.drain();

    assert.ok(!existsSync(reel), "uploaded at last, then cleaned up");
    assert.ok(!existsSync(reel + QUEUE_SUFFIX));
  });
});

test("when the link is back the reel uploads and both files are cleaned up", async () => {
  await withOutputDir(async ({ reel, make }) => {
    let t = 1_000_000;
    const uploader = fakeUploader(["video-123"]);
    const svc = make(uploader, { now: () => t });
    svc.enqueue(request(reel));

    t += RETRY_SEC * 1000;
    await svc.drain();

    assert.equal(uploader.calls.length, 1);
    assert.equal(uploader.calls[0].streamKey, "stream-key-secret", "key must survive the restart");
    assert.ok(!existsSync(reel));
    assert.ok(!existsSync(reel + QUEUE_SUFFIX));
  });
});

test("a reel is NEVER deleted when no videoId came back", async () => {
  await withOutputDir(async ({ reel, make }) => {
    let t = 1_000_000;
    const svc = make(fakeUploader([null]), { now: () => t });
    svc.enqueue(request(reel));

    t += RETRY_SEC * 1000;
    await svc.drain();

    assert.ok(existsSync(reel), "a failed upload must keep the only copy of the reel");
    assert.ok(existsSync(reel + QUEUE_SUFFIX), "and must stay queued");
    assert.equal(JSON.parse(readFileSync(reel + QUEUE_SUFFIX, "utf8")).attempts, 1);
  });
});

test("deleteAfterUpload=false keeps the reel but still clears the queue", async () => {
  await withOutputDir(async ({ reel, make }) => {
    let t = 1_000_000;
    const svc = make(fakeUploader(["video-123"]), { now: () => t, deleteAfterUpload: false });
    svc.enqueue(request(reel));
    t += RETRY_SEC * 1000;
    await svc.drain();

    assert.ok(existsSync(reel));
    assert.ok(!existsSync(reel + QUEUE_SUFFIX), "must not retry an uploaded reel");
  });
});

test("the interval is fixed, not a widening backoff", async () => {
  await withOutputDir(async ({ reel, make }) => {
    let t = 1_000_000;
    const uploader = fakeUploader([]);
    const svc = make(uploader, { now: () => t });
    svc.enqueue(request(reel));

    // A doubling backoff would make the longest outages slowest to recover
    // from — backwards for the case this exists to serve. Every interval
    // must produce exactly one attempt, no matter how many have failed.
    for (let i = 1; i <= 5; i++) {
      t += RETRY_SEC * 1000;
      await svc.drain();
      assert.equal(uploader.calls.length, i, `sweep ${i} should have tried once`);
    }

    // And a sweep before the interval elapses must NOT try.
    t += RETRY_SEC * 1000 - 1;
    await svc.drain();
    assert.equal(uploader.calls.length, 5, "must respect the interval");
  });
});

test("a reel that vanished is dropped, not retried forever", async () => {
  await withOutputDir(async ({ reel, make }) => {
    let t = 1_000_000;
    const uploader = fakeUploader(["video-123"]);
    const svc = make(uploader, { now: () => t });
    svc.enqueue(request(reel));
    rmSync(reel); // collected by hand, or cleaned up by an operator

    t += RETRY_SEC * 1000;
    await svc.drain();

    assert.equal(uploader.calls.length, 0, "nothing left to send");
    assert.ok(!existsSync(reel + QUEUE_SUFFIX));
  });
});

test("entries left by a PREVIOUS run are collected on the next sweep", async () => {
  await withOutputDir(async ({ courtDir, reel, make }) => {
    // Hand-written entry, as if the process had died after queueing it. This
    // is the real recovery case: the link usually comes back overnight, long
    // after the process that failed was restarted.
    writeFileSync(
      reel + QUEUE_SUFFIX,
      JSON.stringify({
        filePath: reel, courtId: COURT, streamKey: "k", title: "t",
        queuedAtMs: 1, lastAttemptAtMs: 1, attempts: 0,
      })
    );
    const uploader = fakeUploader(["video-123"]);
    await make(uploader, { now: () => 10_000_000 }).drain();

    assert.equal(uploader.calls.length, 1);
    assert.equal(readdirSync(courtDir).length, 0, "reel and entry both cleared");
  });
});

test("a truncated entry is discarded rather than parsed forever", async () => {
  await withOutputDir(async ({ reel, make }) => {
    writeFileSync(reel + QUEUE_SUFFIX, '{"filePath": "/x", '); // killed mid-write
    const uploader = fakeUploader(["video-123"]);
    await make(uploader, { now: () => 1 }).drain();

    assert.equal(uploader.calls.length, 0);
    assert.ok(!existsSync(reel + QUEUE_SUFFIX));
    assert.ok(existsSync(reel), "an unreadable entry must not cost the reel");
  });
});

test("a reel with no queue entry is reported, never left unexplained", async () => {
  await withOutputDir(async ({ reel, logger, make }) => {
    // No enqueue: this is a reel from before the queue existed, which cannot
    // be uploaded automatically because its stream key is unrecoverable.
    await make(fakeUploader([]), { now: () => 1 }).drain();

    const warning = logger.lines.find(
      (l) => l.level === "warn" && /no pending upload/i.test(l.msg)
    );
    assert.ok(warning, "an orphan reel must be named in the log");
    assert.equal(warning.meta.count, 1);
    assert.ok(warning.meta.files.includes(reel));
    assert.ok(existsSync(reel), "reporting it must not delete it");
  });
});

test("a queued reel is not also reported as an orphan", async () => {
  await withOutputDir(async ({ reel, logger, make }) => {
    const svc = make(fakeUploader([]), { now: () => 1 });
    svc.enqueue(request(reel));
    await svc.drain();

    assert.ok(
      !logger.lines.some((l) => /no pending upload/i.test(l.msg)),
      "a reel that is queued is accounted for"
    );
  });
});
