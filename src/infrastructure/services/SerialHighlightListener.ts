import { EventEmitter } from "events";
import * as fs from "fs";
import type { SerialPort as SerialPortInstance } from "serialport";
import type { ReadlineParser as ReadlineParserInstance } from "@serialport/parser-readline";
import {
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
 * The scoreboard ESP32 plugs into the box over USB and prints a line every few
 * seconds ("HEARTBEAT|ESP32", score packets, and eventually "HIGHLIGHT"). This
 * class keeps the serial port open and notes the last time it heard a
 * recognized line. If we've heard the device recently, it's "present" and the
 * box should record highlights; if the box has no ESP32, we never hear it and
 * `isDevicePresent()` stays false.
 *
 * ── BUSINESS RULES ──
 * - Highlight capture is enabled per-box by HARDWARE PRESENCE (decision
 *   2026-07-18): a box with the ESP32 attached records the buffer; one without
 *   never does. `isDevicePresent()` is that signal.
 * - Presence is proven by the ESP32's own heartbeat: esp32-leader.ino runs
 *   `Serial.begin(115200)` and prints `HEARTBEAT|ESP32` every 5s, so no
 *   firmware change is needed. Freshness window = 15s (tolerate 3 missed beats).
 * - Recognized tokens (HEARTBEAT / TENNIS / AMER / HIGHLIGHT) are exactly the
 *   prefixes of the existing pipe-delimited packets the ESP32 prints and relays
 *   over USB (`TENNIS|15|40|1|0`, `HEARTBEAT|ESP32`, …); anything else is noise.
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

// Token before the first '|' in the existing pipe-delimited protocol. A line
// starting with one of these is genuine ESP32 traffic (vs. line noise).
const RECOGNIZED_PREFIXES = new Set(["HEARTBEAT", "TENNIS", "AMER", "HIGHLIGHT"]);

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
    const line = raw.trim();
    if (!line) return;

    const prefix = line.split("|", 1)[0];
    if (!RECOGNIZED_PREFIXES.has(prefix)) return; // ignore noise / partial junk

    // Any recognized packet proves the device is alive → refresh presence.
    // Log only the absent→present transition (not every 5s heartbeat) so
    // staging can confirm the ESP32 is actually being heard without log spam.
    const now = Date.now();
    const wasFresh = now - this.lastTrafficAtMs <= PRESENCE_FRESHNESS_MS;
    this.lastTrafficAtMs = now;
    this.reconnectAttempts = 0;
    if (!wasFresh) {
      this.logger.info("Highlight hardware detected (recognized serial traffic)", {
        prefix,
      });
    }

    // The button press: fire a highlight signal for CaptureHighlightUseCase.
    if (prefix === "HIGHLIGHT") {
      this.logger.info("Highlight signal received (serial)", { line });
      this.emit("highlight", { receivedAtMs: now } as HighlightSignal);
    }
  }

  private async resolvePortPath(): Promise<string> {
    if (this.portPath && this.portPath !== "auto") {
      return this.portPath;
    }
    // Auto-discovery: open ONLY a USB-serial-looking device. Deliberately no
    // "first available port" fallback — grabbing an arbitrary tty (e.g. a
    // system debug console) could disturb unrelated hardware. If nothing
    // matches, return "" so openPort() backs off and re-scans later (the ESP32
    // may be plugged in after boot). A precise vendor/product-id match can be
    // added here once the hardware team confirms the ESP32's ids.
    const { SerialPort } = this.serialLib!;
    const ports = await SerialPort.list();
    const usbLike = ports.find((p) =>
      /ttyusb|ttyacm|cu\.usb|tty\.usb/i.test(p.path)
    );
    return usbLike?.path ?? "";
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
