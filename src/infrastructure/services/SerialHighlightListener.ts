import { EventEmitter } from "events";
import * as fs from "fs";
import type { SerialPort as SerialPortInstance } from "serialport";
import type { ReadlineParser as ReadlineParserInstance } from "@serialport/parser-readline";
import {
  CourtScoreSignal,
  HighlightSignal,
  HighlightSignalSource,
} from "../../domain/services/HighlightSignalSource";
import { Logger } from "../../application/interfaces/Logger";

/**
 * Reads the ESP32's USB-serial output to detect whether the highlight hardware
 * is attached and alive (presence detection). Presence drives automatic
 * enablement of the highlight buffer — see HighlightSignalSource.
 *
 * ── IN SIMPLE WORDS ──
 * The court ESP32 plugs into the box over USB and prints one JSON object per
 * line — a heartbeat every 5s, score updates, logs, and a `button` packet when
 * someone presses the physical highlight button. This class keeps the serial
 * port open and notes the last time it heard a valid line. If we've heard the
 * device recently, it's "present" and the box should record highlights; if the
 * box has no ESP32, we never hear it and `isDevicePresent()` stays false.
 *
 * Protocol contract: docs/esp32/STREAMER_INTEGRATION.md (authoritative — the
 * desk harness in lib/esp-serial-com is NOT the spec; it only pretty-prints
 * three of the four types).
 *
 * ── BUSINESS RULES ──
 * - Highlight capture is enabled per-box by HARDWARE PRESENCE (decision
 *   2026-07-18): a box with the ESP32 attached records the buffer; one without
 *   never does. `isDevicePresent()` is that signal.
 * - Presence is proven by the ESP32's own heartbeat, emitted every 5s
 *   unconditionally (needs no mesh, no court). Freshness window = 15s
 *   (tolerate 3 missed beats).
 * - A highlight is a `{"type":"button","event":"press"}` packet. It comes from
 *   a SEPARATE ESP8266 to the scoreboard one, on its own power and mesh nodeId,
 *   provisioned with the same courtId — that shared court ID is what correlates
 *   a press with the court it happened on.
 * - COURT FILTERING IS MANDATORY. All units share one set of mesh credentials,
 *   so at a venue with two courts in WiFi range this ESP32 relays the other
 *   court's traffic verbatim (the firmware does no filtering — by design; the
 *   spec puts it on the streamer). The courtId rides on HighlightSignal and is
 *   matched downstream before any clip is cut.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - Presence is CONTENT-based (a recognized packet seen recently), not merely
 *   port-open-based: an open port proves nothing about what's on the other end,
 *   so trusting it would let an unrelated serial gadget switch on the buffer.
 *   Content-gating means a wrong/other device reads as absent (no false
 *   positive) and we don't need the ESP32's USB vendor/product id (unconfirmed)
 *   to identify it. The ONE bounded exception is a short post-open grace (see
 *   OPEN_GRACE_MS) that bridges the gap before the first heartbeat on a fresh
 *   boot; it expires quickly and then content-gating governs.
 * - The native `serialport` module is loaded defensively (lazy require in a
 *   try/catch). If it can't load on a given box, highlights just stay off
 *   forever — the live streaming app must never fail to boot over this.
 *
 * ── DO NOT ──
 * - Do NOT make `isDevicePresent()` throw or do I/O — it's on the stream-start
 *   hot path. It is a couple of timestamp comparisons.
 * - Do NOT treat port-open as *durable* presence (only the bounded grace).
 * - Do NOT let a serial error/disconnect crash the process — port AND parser
 *   errors are handled and route to a backoff reconnect (mirrors NodeSSEService).
 */

// The ESP32 heartbeats every 5s (esp32-leader.ino). Allow ~3 missed beats
// before declaring the device gone, so a single dropped line doesn't flap.
const PRESENCE_FRESHNESS_MS = 15_000;

// Bounded startup grace: a freshly-opened matched device counts as present for
// just over one heartbeat interval, to bridge the window before the first
// heartbeat on a cold boot. After this, only real traffic keeps it present.
const OPEN_GRACE_MS = 7_000;

// Reconnect backoff bounds (mirror NodeSSEService.scheduleRetry).
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class SerialHighlightListener
  extends EventEmitter
  implements HighlightSignalSource
{
  private port: SerialPortInstance | null = null;
  private parser: ReadlineParserInstance | null = null;
  private lastTrafficAtMs = 0;
  private portOpenedAtMs = 0;
  private started = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private triggerTimer: NodeJS.Timeout | null = null;
  // Last `seq` seen on a button packet, to spot presses lost in mesh transit.
  private lastButtonSeq: number | undefined;

  // Native serial libs, lazily required in start(). Null when unavailable, in
  // which case the listener is inert and isDevicePresent() stays false.
  private serialLib: typeof import("serialport") | null = null;
  private parserLib: typeof import("@serialport/parser-readline") | null = null;

  constructor(
    private readonly portPath: string, // "auto" or an explicit device path
    private readonly baudRate: number,
    private readonly logger: Logger,
    // Debug/test only (default off): force presence true, and/or fire a
    // highlight whenever `triggerFile` appears on disk — so the pipeline can be
    // exercised on a box without the ESP32 button hardware.
    private readonly forcePresent: boolean = false,
    private readonly triggerFile: string = ""
  ) {
    super();
  }

  public onHighlight(listener: (signal: HighlightSignal) => void): void {
    this.on("highlight", listener);
  }

  public onScore(listener: (signal: CourtScoreSignal) => void): void {
    this.on("score", listener);
  }

  public start(): void {
    if (this.started) return;
    this.started = true;

    this.startTriggerFileWatch();

    try {
      this.serialLib = require("serialport") as typeof import("serialport");
      this.parserLib = require("@serialport/parser-readline") as typeof import("@serialport/parser-readline");
    } catch (error) {
      this.logger.warn(
        "serialport module unavailable; highlight hardware detection disabled",
        { error: error instanceof Error ? error.message : String(error) }
      );
      return;
    }

    void this.openPort();
  }

  public stop(): void {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.triggerTimer) {
      clearInterval(this.triggerTimer);
      this.triggerTimer = null;
    }
    this.teardownPort();
    this.lastTrafficAtMs = 0;
  }

  // Debug/test: when a trigger file path is configured, fire a highlight
  // whenever that file appears (then remove it). Lets staging exercise the
  // capture pipeline via `touch <file>` without the ESP32 button. No-op unless
  // HIGHLIGHT_TRIGGER_FILE is set.
  private startTriggerFileWatch(): void {
    if (!this.triggerFile) return;
    this.logger.info("Highlight manual trigger file watch enabled", {
      triggerFile: this.triggerFile,
    });
    this.triggerTimer = setInterval(() => {
      try {
        if (!fs.existsSync(this.triggerFile)) return;
        fs.unlinkSync(this.triggerFile);
        this.logger.info("Highlight signal received (manual trigger file)");
        this.emit("highlight", { receivedAtMs: Date.now() } as HighlightSignal);
      } catch {
        /* transient fs error; retry next tick */
      }
    }, 1_000);
  }

  public isDevicePresent(): boolean {
    if (this.forcePresent) return true; // debug/test override
    const now = Date.now();
    // Durable presence: recognized traffic within the freshness window.
    if (now - this.lastTrafficAtMs <= PRESENCE_FRESHNESS_MS) return true;
    // Bounded startup grace: matched device just opened, first heartbeat not
    // yet due. Expires into content-gating.
    if (this.portOpenedAtMs && now - this.portOpenedAtMs <= OPEN_GRACE_MS) {
      return true;
    }
    return false;
  }

  private async openPort(): Promise<void> {
    if (!this.started || !this.serialLib || !this.parserLib) return;

    // Clear any lingering port/listeners before (re)opening so reconnects never
    // accumulate orphaned SerialPort/parser objects and their listeners.
    this.teardownPort();

    let path = "";
    try {
      path = await this.resolvePortPath();
    } catch (error) {
      this.scheduleReconnect(
        `serial discovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }
    if (!path) {
      this.scheduleReconnect("no candidate serial device found");
      return;
    }

    try {
      const { SerialPort } = this.serialLib;
      const { ReadlineParser } = this.parserLib;

      const port = new SerialPort({
        path,
        baudRate: this.baudRate,
        autoOpen: false,
      });

      port.open((err) => {
        if (err) {
          this.scheduleReconnect(`open ${path} failed: ${err.message}`);
          return;
        }
        this.reconnectAttempts = 0;
        this.portOpenedAtMs = Date.now(); // start the bounded presence grace
        this.logger.info("Highlight serial port opened", { path });
      });

      // ESP32 uses println (\r\n); split on \n and trim the trailing \r.
      const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
      parser.on("data", (line: unknown) => this.handleLine(String(line)));
      // A parser-side stream error would otherwise be an unhandled 'error'
      // event and crash the process — route it to the same reconnect path.
      parser.on("error", (err: Error) => {
        this.logger.warn("Highlight serial parser error", {
          error: err.message,
        });
        this.handlePortDown();
      });

      port.on("error", (err: Error) => {
        this.logger.warn("Highlight serial port error", { error: err.message });
        this.handlePortDown();
      });
      port.on("close", () => this.handlePortDown());

      this.port = port;
      this.parser = parser;
    } catch (error) {
      this.scheduleReconnect(
        `serial open threw: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private handleLine(raw: string): void {
    // Trailing \r: the ESP32 uses Serial.println (CRLF) while we split on \n.
    const line = raw.trim();
    if (!line) return;

    // NOT every line is JSON. esp32-leader relays mesh messages it can't parse
    // verbatim rather than dropping them, and boot-time chatter appears on the
    // port too. A parse failure means "ignore this line" — never an error path,
    // or the first line of ESP8266 boot noise takes the streamer down.
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    const type = msg.type;
    if (typeof type !== "string") return;

    // PRESENCE: any line that parsed as JSON and carries a string `type` proves
    // the USB link is alive. Deliberately NOT gated on courtId — the ESP32's own
    // heartbeat is {"type":"heartbeat","source":"ESP32"} with no court (it is the
    // local leader), so requiring one would leave presence false forever.
    const now = Date.now();
    const wasFresh = now - this.lastTrafficAtMs <= PRESENCE_FRESHNESS_MS;
    this.lastTrafficAtMs = now;
    this.reconnectAttempts = 0;
    if (!wasFresh) {
      this.logger.info("Highlight hardware detected (ESP32 serial traffic)", {
        type,
      });
    }

    // Switch on `type` and IGNORE unknown types — the protocol reserves the
    // right to add more. Four exist today: score, button, heartbeat, log.
    if (type === "score") {
      this.handleScore(msg);
      return;
    }
    if (type !== "button") return;

    const courtId = typeof msg.courtId === "string" ? msg.courtId : undefined;
    const seq = typeof msg.seq === "number" ? msg.seq : undefined;

    // Press edge only, debounced 50ms in firmware — one physical click is one
    // message, so no debounce of our own is needed.
    if (typeof msg.event === "string" && msg.event !== "press") return;

    // `seq` is monotonic per boot, +1 per press. A gap means the mesh broadcast
    // was lost (best-effort, no retry); going backwards means the node rebooted.
    // Log it as a delivery signal — do not try to recover missed presses.
    if (seq !== undefined && this.lastButtonSeq !== undefined) {
      if (seq > this.lastButtonSeq + 1) {
        this.logger.warn("Highlight button presses lost in mesh transit", {
          courtId,
          expected: this.lastButtonSeq + 1,
          got: seq,
          missed: seq - this.lastButtonSeq - 1,
        });
      } else if (seq < this.lastButtonSeq) {
        this.logger.info("Highlight button node rebooted (seq reset)", {
          courtId,
          previous: this.lastButtonSeq,
          got: seq,
        });
      }
    }
    if (seq !== undefined) this.lastButtonSeq = seq;

    this.logger.info("Highlight signal received (button press)", {
      courtId,
      seq,
    });
    this.emit("highlight", { receivedAtMs: now, courtId } as HighlightSignal);
  }

  /**
   * A `score` packet: the board's current state, forwarded verbatim.
   *
   * Score packets are the one type that carries NO `source` field, so anything
   * keying on `source` being present would drop them — switch on `type` only.
   * Values are passed through untouched: interpreting "AD" or mapping the mode
   * is the consumer's job, not the transport's.
   */
  private handleScore(msg: Record<string, unknown>): void {
    const courtId = typeof msg.courtId === "string" ? msg.courtId : undefined;
    // Without a court we cannot address the write, and at a multi-court venue we
    // could not tell whose score it is — drop rather than guess.
    if (!courtId) return;

    const scoreA = msg.scoreA;
    const scoreB = msg.scoreB;
    if (scoreA === undefined || scoreB === undefined) return;

    this.emit("score", {
      courtId,
      mode: typeof msg.mode === "string" ? msg.mode : undefined,
      // Coerced with String() rather than assumed: the firmware sends strings,
      // but a number here must not become "undefined" downstream.
      scoreA: String(scoreA),
      scoreB: String(scoreB),
      gamesA: typeof msg.gamesA === "number" ? msg.gamesA : undefined,
      gamesB: typeof msg.gamesB === "number" ? msg.gamesB : undefined,
    } as CourtScoreSignal);
  }

  private async resolvePortPath(): Promise<string> {
    if (this.portPath && this.portPath !== "auto") {
      return this.portPath;
    }
    // Auto-discovery: open ONLY an ESP32-looking device. Deliberately no "first
    // available port" fallback — grabbing an arbitrary tty (e.g. a system debug
    // console) could disturb unrelated hardware. If nothing matches, return ""
    // so openPort() backs off and re-scans later (the ESP32 may be plugged in
    // after boot).
    //
    // Match on MANUFACTURER, not product id: the boards ship with either a
    // CP2102 (Silicon Labs) or a CH340 (wch.cn / QinHeng) bridge, so no single
    // PID covers the fleet. Path matching alone is not enough — on a box that
    // also has the ESP8266 debug cable or an Arduino FTDI attached, "first
    // USB-ish tty" can open the wrong device and then sit there hearing
    // nothing. Manufacturer is checked first for that reason.
    const { SerialPort } = this.serialLib!;
    const ports = await SerialPort.list();

    const isEsp32 = (p: {
      path: string;
      manufacturer?: string;
      vendorId?: string;
    }): boolean => {
      const mfr = p.manufacturer ?? "";
      if (/silicon labs|wch\.cn|qinheng/i.test(mfr)) return true;
      // Linux reports the bare USB vendor ID for the CH340 instead of a name.
      if (p.vendorId?.toLowerCase() === "1a86") return true;
      return /usbserial|ttyusb|ttyacm|cu\.usb|tty\.usb/i.test(p.path);
    };

    // Prefer a manufacturer/vendor match over a bare path match.
    const byIdentity = ports.find(
      (p) =>
        /silicon labs|wch\.cn|qinheng/i.test(p.manufacturer ?? "") ||
        p.vendorId?.toLowerCase() === "1a86"
    );
    return (byIdentity ?? ports.find(isEsp32))?.path ?? "";
  }

  private handlePortDown(): void {
    this.teardownPort();
    this.scheduleReconnect("serial port closed/errored");
  }

  // Remove listeners and close the current port/parser, resetting the grace.
  // Idempotent and never throws.
  private teardownPort(): void {
    if (this.parser) {
      try {
        this.parser.removeAllListeners();
      } catch {
        /* ignore */
      }
      this.parser = null;
    }
    if (this.port) {
      try {
        this.port.removeAllListeners();
        this.port.close(() => {});
      } catch {
        /* already closing/closed */
      }
      this.port = null;
    }
    this.portOpenedAtMs = 0;
  }

  private scheduleReconnect(reason: string): void {
    if (!this.started || this.reconnectTimer) return;

    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 10);
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_MAX_MS
    );
    this.logger.warn("Highlight serial reconnect scheduled", {
      reason,
      delayMs: delay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openPort();
    }, delay);
  }
}
