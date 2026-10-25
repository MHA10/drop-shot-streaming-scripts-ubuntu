// Reel uploads that failed must go up by themselves once the link is back.
//
// The failure this exists for (Hello Padel, 25 Oct 2026): heartbeat, SSE and
// the reel upload all failed inside one ~30s window — the venue's uplink, not
// the backend. The pipeline had done everything right; the reel was simply
// stranded on disk with nothing to pick it up.
//
// Two properties matter more than the happy path and are asserted hardest:
//   1. A reel is NEVER deleted unless a real videoId came back.
//   2. Giving up keeps the mp4. Abandonment stops retries, not footage.
//
// Run:  npm run build && node --test test/reel-upload-retry.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { PendingReelUploads, NOTE_SUFFIX, ABANDONED_SUFFIX } = require("../dist/src/infrastructure/services/PendingReelUploads.js");

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };
const COURT = "court-1";
const RETRY_SEC = 120;

/** A scratch output dir laid out the way the capture pipeline lays it out. */
function withOutputDir(run) {
  const root = mkdtempSync(join(tmpdir(), "reel-retry-"));
  try {
    const courtDir = join(root, COURT);
    mkdirSync(courtDir, { recursive: true });
    const reel = join(courtDir, "highlight-1.mp4");
    writeFileSync(reel, "not-a-real-mp4");
    run({ root, courtDir, reel });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

function makeService(root, uploader, { now, deleteAfterUpload = true, maxAgeHours = 24 } = {}) {
  return new PendingReelUploads(
    root, uploader, quietLogger, RETRY_SEC, maxAgeHours, deleteAfterUpload, now
  );
}

const request = (reel) => ({
  filePath: reel,
  courtId: COURT,
  streamKey: "stream-key-secret",
  title: "DropShot highlight",
  preferShort: true,
});

test("parking a failed upload leaves a note beside the reel", () => {
  withOutputDir(({ root, reel }) => {
    let t = 1_000_000;
    makeService(root, fakeUploader([]), { now: () => t }).park(request(reel));

    const note = JSON.parse(readFileSync(reel + NOTE_SUFFIX, "utf8"));
    assert.equal(note.filePath, reel);
    assert.equal(note.courtId, COURT);
    assert.equal(note.attempts, 1);
    assert.equal(note.firstFailedAtMs, t);
  });
});

test("the note is not world-readable: it carries the stream key", () => {
  withOutputDir(({ root, reel }) => {
    makeService(root, fakeUploader([]), { now: () => 1 }).park(request(reel));
    // The backend needs the stream key to resolve privacy and it cannot be
    // recovered once the booking ends, so it has to be persisted — which makes
    // the file mode part of the contract, not an implementation detail.
    const mode = statSync(reel + NOTE_SUFFIX).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });
});

test("re-parking keeps the ORIGINAL failure time so the age cap still bites", () => {
  withOutputDir(({ root, reel }) => {
    let t = 1_000_000;
    const svc = makeService(root, fakeUploader([]), { now: () => t });
    svc.park(request(reel));
    t += 60 * 60 * 1000;
    svc.park(request(reel));

    const note = JSON.parse(readFileSync(reel + NOTE_SUFFIX, "utf8"));
    assert.equal(note.firstFailedAtMs, 1_000_000, "age must run from first failure");
    assert.equal(note.attempts, 2);
  });
});

test("when the link is back the reel uploads and both files are cleaned up", async () => {
  await withOutputDirAsync(async ({ root, reel }) => {
    let t = 1_000_000;
    const uploader = fakeUploader(["video-123"]);
    const svc = makeService(root, uploader, { now: () => t });
    svc.park(request(reel));

    t += RETRY_SEC * 1000;
    await svc.drain();

    assert.equal(uploader.calls.length, 1);
    assert.equal(uploader.calls[0].streamKey, "stream-key-secret", "key must survive the restart");
    assert.ok(!existsSync(reel), "reel should be deleted after a confirmed upload");
    assert.ok(!existsSync(reel + NOTE_SUFFIX), "note should be removed");
  });
});

test("a reel is NEVER deleted when no videoId came back", async () => {
  await withOutputDirAsync(async ({ root, reel }) => {
    let t = 1_000_000;
    const uploader = fakeUploader([null]);
    const svc = makeService(root, uploader, { now: () => t });
    svc.park(request(reel));

    t += RETRY_SEC * 1000;
    await svc.drain();

    assert.ok(existsSync(reel), "a failed upload must keep the only copy of the reel");
    assert.ok(existsSync(reel + NOTE_SUFFIX), "and must stay queued");
    assert.equal(JSON.parse(readFileSync(reel + NOTE_SUFFIX, "utf8")).attempts, 2);
  });
});

test("deleteAfterUpload=false keeps the reel but still clears the queue", async () => {
  await withOutputDirAsync(async ({ root, reel }) => {
    let t = 1_000_000;
    const svc = makeService(root, fakeUploader(["video-123"]), {
      now: () => t, deleteAfterUpload: false,
    });
    svc.park(request(reel));
    t += RETRY_SEC * 1000;
    await svc.drain();

    assert.ok(existsSync(reel));
    assert.ok(!existsSync(reel + NOTE_SUFFIX), "must not retry an uploaded reel");
  });
});

test("retries back off instead of hammering an offline uplink", async () => {
  await withOutputDirAsync(async ({ root, reel }) => {
    let t = 1_000_000;
    const uploader = fakeUploader([]); // always fails
    const svc = makeService(root, uploader, { now: () => t });
    svc.park(request(reel)); // attempts = 1, lastAttempt = t

    // One interval on: due (backoff for attempt 1 is exactly the interval).
    t += RETRY_SEC * 1000;
    await svc.drain();
    assert.equal(uploader.calls.length, 1);

    // Another interval: NOT due — attempt 2 waits two intervals.
    t += RETRY_SEC * 1000;
    await svc.drain();
    assert.equal(uploader.calls.length, 1, "should still be backing off");

    // Two intervals after the last attempt: due again.
    t += RETRY_SEC * 1000;
    await svc.drain();
    assert.equal(uploader.calls.length, 2);
  });
});

test("giving up stops the retries but KEEPS the reel", async () => {
  await withOutputDirAsync(async ({ root, reel }) => {
    let t = 1_000_000;
    const uploader = fakeUploader([]);
    const svc = makeService(root, uploader, { now: () => t, maxAgeHours: 24 });
    svc.park(request(reel));

    t += 25 * 60 * 60 * 1000; // a day and an hour later
    await svc.drain();

    assert.equal(uploader.calls.length, 0, "past the cap, stop trying");
    assert.ok(existsSync(reel), "footage is never destroyed by giving up");
    assert.ok(!existsSync(reel + NOTE_SUFFIX));
    assert.ok(existsSync(reel + ABANDONED_SUFFIX), "kept as a record for an operator");
  });
});

test("an abandoned note is never picked back up", async () => {
  await withOutputDirAsync(async ({ root, reel }) => {
    let t = 1_000_000;
    const uploader = fakeUploader(["video-123"]);
    const svc = makeService(root, uploader, { now: () => t, maxAgeHours: 24 });
    svc.park(request(reel));
    t += 25 * 60 * 60 * 1000;
    await svc.drain(); // abandons

    t += 60 * 60 * 1000;
    await svc.drain();
    // ABANDONED_SUFFIX also ends in ".json"; a sloppy filter would re-queue it.
    assert.equal(uploader.calls.length, 0);
  });
});

test("a note whose reel has vanished is dropped, not retried forever", async () => {
  await withOutputDirAsync(async ({ root, reel }) => {
    let t = 1_000_000;
    const uploader = fakeUploader(["video-123"]);
    const svc = makeService(root, uploader, { now: () => t });
    svc.park(request(reel));
    rmSync(reel); // collected by hand, or cleaned up by an operator

    t += RETRY_SEC * 1000;
    await svc.drain();

    assert.equal(uploader.calls.length, 0, "nothing left to send");
    assert.ok(!existsSync(reel + NOTE_SUFFIX));
  });
});

test("notes left by a PREVIOUS run are collected on the next sweep", async () => {
  await withOutputDirAsync(async ({ root, courtDir, reel }) => {
    // Hand-written note, as if the process had died after parking it. This is
    // the real recovery case: the link usually comes back overnight, long
    // after the process that failed was restarted.
    writeFileSync(
      reel + NOTE_SUFFIX,
      JSON.stringify({
        filePath: reel, courtId: COURT, streamKey: "k", title: "t",
        firstFailedAtMs: 1, lastAttemptAtMs: 1, attempts: 1,
      })
    );
    const uploader = fakeUploader(["video-123"]);
    const svc = makeService(root, uploader, { now: () => 10_000_000, maxAgeHours: 24 * 365 });

    await svc.drain();

    assert.equal(uploader.calls.length, 1);
    assert.equal(readdirSync(courtDir).length, 0, "reel and note both cleared");
  });
});

test("a truncated note is discarded rather than parsed forever", async () => {
  await withOutputDirAsync(async ({ root, reel }) => {
    writeFileSync(reel + NOTE_SUFFIX, '{"filePath": "/x", '); // killed mid-write
    const uploader = fakeUploader(["video-123"]);
    const svc = makeService(root, uploader, { now: () => 1 });

    await svc.drain();

    assert.equal(uploader.calls.length, 0);
    assert.ok(!existsSync(reel + NOTE_SUFFIX));
    assert.ok(existsSync(reel), "an unreadable note must not cost the reel");
  });
});

// Async twin of withOutputDir — the sweep is async and the dir must outlive it.
async function withOutputDirAsync(run) {
  const root = mkdtempSync(join(tmpdir(), "reel-retry-"));
  try {
    const courtDir = join(root, COURT);
    mkdirSync(courtDir, { recursive: true });
    const reel = join(courtDir, "highlight-1.mp4");
    writeFileSync(reel, "not-a-real-mp4");
    await run({ root, courtDir, reel });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
