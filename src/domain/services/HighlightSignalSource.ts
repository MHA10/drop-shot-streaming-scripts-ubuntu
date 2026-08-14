/**
 * Source of highlight signals from the physical ESP32 device.
 *
 * ── IN SIMPLE WORDS ──
 * The court hardware (an ESP32) plugs into the streamer box over USB and
 * constantly chatters one JSON object per line — a heartbeat every 5 seconds,
 * plus a `{"type":"button"}` line when someone presses the physical highlight
 * button on a court. This interface is the streamer's window onto that device:
 * it can tell us whether the hardware is currently attached and alive
 * (`isDevicePresent`), which is what decides whether a box records the
 * highlight buffer at all.
 *
 * Protocol contract: docs/esp32/STREAMER_INTEGRATION.md (authoritative).
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
  /**
   * The court the press came from, taken from the `button` packet's `courtId`.
   *
   * MUST be checked before acting. Every unit ships with the same mesh
   * credentials, so at a venue with two courts in WiFi range this box's ESP32
   * relays the neighbouring court's traffic verbatim — the firmware does no
   * filtering and the spec puts that on the streamer. Acting on any press
   * would cut a clip from the wrong court's stream, with nothing in the logs
   * to explain it.
   *
   * Undefined for debug-triggered signals (force/trigger-file), which carry no
   * court and are treated as "this box's running stream".
   */
  courtId?: string;
}

/**
 * The court's scoreboard state, exactly as the physical board reports it.
 *
 * ── WHY THE SCORES ARE STRINGS ──
 * Tennis values are "00"/"15"/"30"/"40"/"AD" — the Arduino's token is passed
 * through untouched by every hop. An integer type works right up until deuce.
 * Games ARE integers (and are 0/meaningless in Americano).
 *
 * ── WHY ABSOLUTE, NEVER A DELTA ──
 * Mesh delivery is best-effort with no retry. Replaying absolute state is
 * self-healing after a dropped packet; replaying increments desyncs forever.
 */
export interface CourtScoreSignal {
  courtId: string;
  /** Raw firmware mode: "TENNIS" | "AMER". Mapped to the backend's enum later. */
  mode?: string;
  scoreA: string;
  scoreB: string;
  gamesA?: number;
  gamesB?: number;
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

  /**
   * Subscribe to scoreboard updates from the court hardware.
   *
   * Lives on this interface because the ESP32 is ONE serial device and a serial
   * port has exactly one reader — so the same listener necessarily surfaces both
   * the button presses and the score packets. (The interface name predates the
   * score path; renaming it to something like CourtDeviceSource is a worthwhile
   * follow-up, deliberately kept out of this change to keep the diff reviewable.)
   */
  onScore(listener: (signal: CourtScoreSignal) => void): void;
}
