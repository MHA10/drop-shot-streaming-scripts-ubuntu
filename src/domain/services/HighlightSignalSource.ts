/**
 * Source of highlight signals from the physical ESP32 device.
 *
 * ── IN SIMPLE WORDS ──
 * The referee's scoreboard hardware (an ESP32) plugs into the streamer box
 * over USB and constantly chatters — a "HEARTBEAT|ESP32" line every 5 seconds,
 * plus (eventually) a "HIGHLIGHT" line when someone presses the highlight
 * button. This interface is the streamer's window onto that device: it can
 * tell us whether the hardware is currently attached and alive
 * (`isDevicePresent`), which is what decides whether a box records the
 * highlight buffer at all.
 *
 * ── BUSINESS RULES ──
 * - Highlight capture is enabled per-box by HARDWARE PRESENCE, not by config
 *   (decision 2026-07-18): a box with the ESP32 plugged in records the rolling
 *   buffer; a box without it never does. `isDevicePresent()` is that signal.
 * - Presence is proven by the device's own traffic (the existing 5s heartbeat),
 *   so no ESP32 firmware change is needed to support it.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * The application layer (StartStreamUseCase) depends on this abstraction, not
 * on the concrete serial implementation, so the buffer-enable decision stays
 * testable and the transport (USB serial today) can change without touching
 * stream orchestration. Without the abstraction, the use-case would hard-couple
 * to node-serialport and become impossible to exercise without real hardware.
 *
 * ── DO NOT ──
 * - Do NOT make `isDevicePresent()` throw or block — it is called on the
 *   stream-start hot path and must be a cheap, synchronous, non-failing read.
 * - Do NOT treat "port open" alone as present without a freshness check; a
 *   stale/hung device should read as absent.
 */
/**
 * A highlight moment was signalled. `receivedAtMs` is the streamer's local
 * receipt time (Date.now); the true event time is estimated downstream by
 * subtracting the configured lag margin (the mesh/transport delay).
 */
export interface HighlightSignal {
  receivedAtMs: number;
}

export interface HighlightSignalSource {
  /**
   * Begin listening to the device (open the serial port, start parsing).
   * Called once at app boot. Must be fail-soft: if the device/library is
   * unavailable, it logs and leaves `isDevicePresent()` returning false rather
   * than throwing.
   */
  start(): void;

  /**
   * Stop listening and release the port. Idempotent; safe from shutdown.
   */
  stop(): void;

  /**
   * True when the ESP32 is attached and has produced recognized traffic
   * recently (within the freshness window). Cheap O(1) read, never throws.
   * Drives automatic enablement of the highlight buffer.
   */
  isDevicePresent(): boolean;

  /**
   * Subscribe to highlight signals (a button press → HIGHLIGHT packet, or a
   * debug trigger). The listener receives the receipt time; window anchoring
   * (subtracting the lag margin) happens in the capture use-case.
   */
  onHighlight(listener: (signal: HighlightSignal) => void): void;
}
