// SerialHighlightListener silent-port watchdog.
//
// Incident (Padel Central, 21 Oct 2026): after a power cut the box rebooted,
// opened the ESP32's port, and heard nothing until the streamer was restarted
// by hand — so no scores reached the stream. The watchdog must reopen a port
// that is open but silent, and leave a talking port alone.
//
// Uses a fake `serialport` library (no hardware) and short watchdog timings.
//
// Run:  npm run build && node --test test/serial-silence-watchdog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const { SerialHighlightListener } = require("../dist/src/infrastructure/services/SerialHighlightListener.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake serialport + parser. Each open/close is recorded; tests push lines
// through the current parser to simulate the ESP32 talking.
function fakeSerial() {
  const state = { opens: 0, closes: 0, parser: null };
  class FakePort extends EventEmitter {
    static async list() {
      return [{ path: "/dev/ttyUSB0", manufacturer: "Silicon Labs" }];
    }
    constructor(opts) { super(); this.path = opts.path; }
    open(cb) { state.opens++; setImmediate(() => cb(null)); }
    close(cb) { state.closes++; cb && cb(null); }
    pipe(parser) { state.parser = parser; return parser; }
  }
  class FakeParser extends EventEmitter {}
  return {
    state,
    serialLib: { SerialPort: FakePort },
    parserLib: { ReadlineParser: FakeParser },
    send(obj) { state.parser?.emit("data", JSON.stringify(obj) + "\r"); },
  };
}

function recordingLogger() {
  const lines = [];
  const rec = (level) => (msg, meta) => lines.push({ level, msg, meta });
  return { lines, info: rec("info"), warn: rec("warn"), error: rec("error"), debug: () => {} };
}

function newListener(fake, logger, timings = { silenceMs: 150, maxSilenceMs: 600, checkMs: 25 }) {
  const l = new SerialHighlightListener("auto", 115200, logger, false, "", timings);
  // start() lazily requires the real native module; swap in the fake instead
  // and run the same open path start() would.
  l.serialLib = fake.serialLib;
  l.parserLib = fake.parserLib;
  l.started = true;
  l.watchdogTimer = setInterval(() => l.checkSilence(), timings.checkMs);
  void l.openPort();
  return l;
}

test("a silent open port is closed and reopened (the power-cut case)", async () => {
  const fake = fakeSerial();
  const log = recordingLogger();
  const l = newListener(fake, log);
  try {
    await sleep(30);
    assert.equal(fake.state.opens, 1, "port opened once at start");
    // ESP32 says nothing → watchdog fires after ~150ms, reconnect after 1s backoff
    await sleep(1400);
    assert.ok(fake.state.closes >= 1, "silent port was closed");
    assert.ok(fake.state.opens >= 2, "and reopened");
    const warn = log.lines.find((x) => x.msg === "ESP32 silent on open serial port; reopening it");
    assert.ok(warn, "watchdog logged why it reopened");
    assert.equal(warn.meta.path, "/dev/ttyUSB0");
  } finally {
    l.stop();
  }
});

test("a port with regular heartbeats is never reopened", async () => {
  const fake = fakeSerial();
  const log = recordingLogger();
  const l = newListener(fake, log);
  const beat = setInterval(() => fake.send({ type: "heartbeat", source: "ESP32" }), 50);
  try {
    await sleep(800);
    assert.equal(fake.state.opens, 1);
    assert.equal(fake.state.closes, 0);
    assert.ok(!log.lines.some((x) => x.msg.startsWith("ESP32 silent")));
  } finally {
    clearInterval(beat);
    l.stop();
  }
});

test("after a reopen, traffic resuming is logged and resets the watchdog", async () => {
  const fake = fakeSerial();
  const log = recordingLogger();
  const l = newListener(fake, log);
  try {
    await sleep(1400); // silent → reopened
    assert.ok(fake.state.opens >= 2);
    const opensBefore = fake.state.opens;
    fake.send({ type: "score", courtId: "c1", scoreA: 15, scoreB: 0 });
    const resumed = log.lines.find((x) => x.msg === "ESP32 serial traffic resumed after reopening the port");
    assert.ok(resumed, "resume logged");
    assert.equal(l.silentReopens, 0, "backoff reset");
    // keep talking: no further reopen
    const beat = setInterval(() => fake.send({ type: "heartbeat", source: "ESP32" }), 50);
    await sleep(500);
    clearInterval(beat);
    assert.equal(fake.state.opens, opensBefore);
  } finally {
    l.stop();
  }
});

test("repeated silent reopens back off instead of churning", async () => {
  const fake = fakeSerial();
  const log = recordingLogger();
  const l = newListener(fake, log);
  try {
    await sleep(30);
    // Stub the reconnect delay to ~0 so only the silence window paces reopens.
    l.scheduleReconnect = function (reason) {
      if (!this.started || this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.openPort(); }, 5);
    };
    await sleep(1600);
    const warns = log.lines.filter((x) => x.msg === "ESP32 silent on open serial port; reopening it");
    // windows 150, 300, 600, 600 (cap) … ⇒ only a handful in 1.6s, not ~60
    assert.ok(warns.length >= 2 && warns.length <= 5, `got ${warns.length} reopens`);
    const gaps = warns.slice(1).map((w, i) => w.meta.silentForMs - warns[i].meta.silentForMs);
    assert.ok(gaps.every((g) => g >= 0), "silence window never shrinks");
  } finally {
    l.stop();
  }
});

test("stop() clears the watchdog (no reopen after stop)", async () => {
  const fake = fakeSerial();
  const l = newListener(fake, recordingLogger());
  await sleep(30);
  l.stop();
  const opens = fake.state.opens;
  await sleep(1400);
  assert.equal(fake.state.opens, opens);
});
