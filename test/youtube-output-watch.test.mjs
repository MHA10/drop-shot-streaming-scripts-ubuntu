// YoutubeOutputWatch: spots the YouTube (RTMP/flv) output dying while ffmpeg
// keeps running for the highlight buffer (Padel Central, 21 Oct 2026).
//
// Fixtures are real stderr lines from ffmpeg 6.1.1-3ubuntu5 (the boxes'
// version) with the production two-output shape, RTMP server killed at ~8s.
//
// Run:  npm run build && node --test test/youtube-output-watch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { YoutubeOutputWatch } = require("../dist/src/infrastructure/utils/youtubeOutputWatch.js");

const progress = (frame, time) =>
  `frame=${String(frame).padStart(5)} fps= 25 q=7.0 q=14.0 size=    1167kB time=${time} bitrate= 967.6kbits/s speed=   1x    \r`;
const secs = (s) => `00:00:${String(s.toFixed(2)).padStart(5, "0")}`;

test("normal progress (frame keeps rising) is ok", () => {
  const w = new YoutubeOutputWatch(10);
  for (let i = 1; i <= 50; i++) {
    assert.equal(w.feed(progress(i * 12, secs(i * 0.5))).kind, "ok");
  }
});

test("muxing error on the flv (YouTube) output is reported immediately", () => {
  const w = new YoutubeOutputWatch(10);
  const chunk =
    "[vost#0:0/libx264 @ 0xaaaae4e5c890] Error submitting a packet to the muxer: Connection reset by peer\n" +
    "[out#0/flv @ 0xaaaae4e5bf10] Error muxing a packet\n";
  const v = w.feed(chunk);
  assert.equal(v.kind, "output-failed");
  assert.equal(v.detail, "Error muxing a packet");
});

test("trailer error on the flv output is reported", () => {
  const w = new YoutubeOutputWatch(10);
  const v = w.feed("[out#0/flv @ 0xaaaae4e5bf10] Error writing trailer: Connection reset by peer\n");
  assert.equal(v.kind, "output-failed");
  assert.match(v.detail, /Error writing trailer/);
});

test("errors on the highlight-buffer output never restart the live stream", () => {
  const w = new YoutubeOutputWatch(10);
  const chunk =
    "[vost#1:0/libx264 @ 0x1] Error submitting a packet to the muxer: No space left on device\n" +
    "[out#1/segment @ 0x2] Error muxing a packet\n" +
    "[out#1/segment @ 0x2] Error writing trailer: No space left on device\n";
  assert.equal(w.feed(chunk).kind, "ok");
});

test("the incident: frame freezes while time keeps moving → stalled after 10 reports", () => {
  const w = new YoutubeOutputWatch(10);
  // healthy until the RTMP side dies at frame 194
  for (let i = 1; i <= 16; i++) assert.equal(w.feed(progress(i * 12, secs(i * 0.5))).kind, "ok");
  assert.equal(w.feed(progress(194, secs(8.2))).kind, "ok");
  // ffmpeg 6.1 keeps running for the buffer: time advances, frame stays 194
  const verdicts = [];
  for (let i = 1; i <= 10; i++) verdicts.push(w.feed(progress(194, secs(8.2 + i * 0.5))));
  assert.deepEqual(verdicts.slice(0, 9).map((v) => v.kind), Array(9).fill("ok"));
  assert.equal(verdicts[9].kind, "stalled");
  assert.equal(verdicts[9].frame, 194);
});

test("a brief hiccup shorter than the threshold does not trigger", () => {
  const w = new YoutubeOutputWatch(10);
  w.feed(progress(100, secs(4)));
  for (let i = 0; i < 9; i++) assert.equal(w.feed(progress(100, secs(4 + i))).kind, "ok");
  assert.equal(w.feed(progress(112, secs(14))).kind, "ok"); // recovered → counter resets
  for (let i = 0; i < 9; i++) assert.equal(w.feed(progress(112, secs(15 + i))).kind, "ok");
});

test("several progress reports in one stderr chunk are each counted", () => {
  const w = new YoutubeOutputWatch(10);
  w.feed(progress(194, secs(8)));
  const chunk = Array.from({ length: 10 }, (_, i) => progress(194, secs(9 + i))).join("");
  assert.equal(w.feed(chunk).kind, "stalled");
});
