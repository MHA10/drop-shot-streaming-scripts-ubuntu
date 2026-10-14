// Behavioral tests for the REAL compiled SupabaseListener (real canvas, real fs).
// Verifies the 8 Oct 2026 fix works AND that normal overlay behaviour is intact.
//
// Run:  npm run build && node --test test/supabase-listener.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { SupabaseListener } = require("../dist/src/infrastructure/listeners/SupabaseListener.js");
const SupaMod = require("../dist/src/infrastructure/services/SupabaseService.js");

// The whole point of the fix: no rejection must ever escape to the process
// (that is what exited the streamer). Fail the run if one does.
let unhandled = null;
process.on("unhandledRejection", (e) => { unhandled = e; });

function fakeService() {
  const active = new Set();
  return {
    subCalls: 0,
    isEnabled() { return true; },
    subscribeToTable(name) { this.subCalls++; active.add(name); return {}; },
    isChannelActive(name) { return active.has(name); },
    unsubscribe(name) { active.delete(name); return Promise.resolve(); },
    unsubscribeAll() { active.clear(); return Promise.resolve(); },
  };
}

function newListener(scoreDir, svc = fakeService()) {
  SupaMod.SupabaseService.instance = svc;            // inject the singleton
  const l = new SupabaseListener("score", "score_board");
  l.scoreImageDir = scoreDir;                         // write PNGs to a temp dir
  return l;
}

const rec = (court, a, b, ga, gb) => ({
  new: {
    court_id: court, red_score: String(a), blue_score: String(b),
    red_games: String(ga), blue_games: String(gb), red_team: "ALFA", blue_team: "BETA",
  },
});
const tmp = () => mkdtempSync(join(tmpdir(), "ov-"));
const drain = (l, court) => l.writeChainByCourt.get(court); // await one court's chain
const PNG = [0x89, 0x50, 0x4e, 0x47];

// 1) THE INCIDENT: many near-simultaneous updates for one court must not crash,
//    must run one-at-a-time, and the last score must win.
test("concurrent updates: no crash, serialised, last score wins", async () => {
  const dir = tmp();
  const l = newListener(dir);
  let active = 0, maxActive = 0;
  const orig = l.writeScoreImage.bind(l);
  l.writeScoreImage = async (...a) => {
    active++; maxActive = Math.max(maxActive, active);
    try { return await orig(...a); } finally { active--; }
  };
  const court = "court-1";
  for (let i = 0; i < 8; i++) l.handleAllEvents(rec(court, i, i, 1, 1)); // 8 distinct scores at once
  await drain(l, court);

  assert.equal(unhandled, null, "no unhandled rejection reached the process");
  assert.equal(maxActive, 1, "writes were serialised (never two at once for a court)");
  const file = join(dir, court + ".png");
  assert.ok(existsSync(file), "overlay was written");
  assert.deepEqual([...readFileSync(file).subarray(0, 4)], PNG, "a valid PNG was produced");
  assert.equal(l.lastRenderedTextByCourt.get(court), "ALFA|BETA 7-7 1-1", "final state is the LAST score, in order");
  rmSync(dir, { recursive: true, force: true });
});

// 2) A write that FAILS must be caught (not crash) and must not break later writes.
test("a failing write is caught and does not break the chain", async () => {
  const good = tmp();
  const blocker = join(good, "blocker");
  writeFileSync(blocker, "x");                         // a FILE where a dir is expected
  const l = newListener(join(blocker, "sub"));         // mkdir under a file -> every write throws
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  const court = "court-2";
  for (let i = 0; i < 3; i++) l.handleAllEvents(rec(court, i, 0, 1, 1));
  await drain(l, court);
  console.error = origErr;

  assert.equal(unhandled, null, "failing writes did not crash the process");
  assert.ok(errs.some((e) => /overlay write failed/i.test(e)), "the failure was caught and logged");

  l.scoreImageDir = good;                              // recover
  l.handleAllEvents(rec(court, 9, 9, 2, 2));
  await drain(l, court);
  assert.ok(existsSync(join(good, court + ".png")), "a later write still succeeds (chain intact)");
  rmSync(good, { recursive: true, force: true });
});

// 3) Dedupe: an identical consecutive score must NOT rewrite; a changed score must.
test("identical consecutive score is deduped; a change redraws", async () => {
  const dir = tmp();
  const l = newListener(dir);
  const court = "court-3";
  const file = join(dir, court + ".png");
  l.handleAllEvents(rec(court, 40, 15, 3, 2)); await drain(l, court);
  const m1 = statSync(file).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  l.handleAllEvents(rec(court, 40, 15, 3, 2)); await drain(l, court); // identical
  assert.equal(statSync(file).mtimeMs, m1, "identical score did not rewrite the file");
  await new Promise((r) => setTimeout(r, 20));
  l.handleAllEvents(rec(court, 40, 30, 3, 2)); await drain(l, court); // changed
  assert.ok(statSync(file).mtimeMs > m1, "a changed score rewrote the file");
  rmSync(dir, { recursive: true, force: true });
});

// 4) Idempotent subscribe: subscribing twice must open only ONE channel.
test("subscribing to the same court twice opens only one channel", () => {
  const svc = fakeService();
  const l = newListener(tmp(), svc);
  l.subscribeToCourt("court-X");
  l.subscribeToCourt("court-X");
  assert.equal(svc.subCalls, 1, "the duplicate subscribe was skipped");
});

// 5) REGRESSION: the overlay still renders for both the games and no-games layouts.
test("overlay still renders for games and no-games scores", async () => {
  const dir = tmp();
  const l = newListener(dir);
  l.handleAllEvents(rec("c-games", 40, 15, 3, 2)); await drain(l, "c-games");
  l.handleAllEvents({ new: { court_id: "c-nog", red_score: "5", blue_score: "3",
    red_games: "|", blue_games: "|", red_team: "A", blue_team: "B" } });
  await drain(l, "c-nog");
  for (const c of ["c-games", "c-nog"]) {
    const buf = readFileSync(join(dir, c + ".png"));
    assert.deepEqual([...buf.subarray(0, 4)], PNG, c + " is a valid PNG");
    assert.ok(buf.length > 200, c + " PNG has real content");
  }
  rmSync(dir, { recursive: true, force: true });
});

// 6) REGRESSION: the public API callers depend on is unchanged.
test("public API is unchanged", () => {
  const l = newListener(tmp());
  for (const m of ["subscribeToCourt", "unsubscribeFromCourt", "stop"])
    assert.equal(typeof l[m], "function", m + " still present");
});

// 7) GAP CLOSED: a write still in flight when a court is torn down must still
//    serialise with the write that arrives right after a resubscribe — otherwise the
//    two race on the same <court>.png.tmp file (the very collision this PR removes).
//    Before the fix, unsubscribe deleted the chain, so the post-resubscribe write
//    started a fresh parallel chain and both ran at once (maxActive === 2).
test("unsubscribe + resubscribe keeps writes serialised (no parallel temp-file race)", async () => {
  const dir = tmp();
  const l = newListener(dir);
  let active = 0, maxActive = 0;
  const orig = l.writeScoreImage.bind(l);
  l.writeScoreImage = async (...a) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 30));  // hold the write "in flight"
    try { return await orig(...a); } finally { active--; }
  };
  const court = "court-7";
  l.subscribeToCourt(court);
  l.handleAllEvents(rec(court, 1, 0, 1, 1));       // write A: starts, now in flight
  await l.unsubscribeFromCourt(court);             // tear the court down WHILE A runs
  l.subscribeToCourt(court);                       // resubscribe immediately
  l.handleAllEvents(rec(court, 2, 0, 1, 1));       // write B must queue BEHIND A
  await drain(l, court);
  await new Promise((r) => setTimeout(r, 60));     // let any trailing async settle

  assert.equal(unhandled, null, "no unhandled rejection across teardown + resubscribe");
  assert.equal(maxActive, 1, "A and B never ran at once (chain survived the teardown)");
  assert.ok(existsSync(join(dir, court + ".png")), "overlay was still written");
  rmSync(dir, { recursive: true, force: true });
});

after(async () => {
  await new Promise((r) => setTimeout(r, 50)); // let any stray async settle
  assert.equal(unhandled, null, "no unhandled rejection across the whole run");
});
