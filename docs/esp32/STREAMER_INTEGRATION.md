# Streamer <-> ESP32 Serial Integration

This document is the contract between the on-ground streamer (Node.js/Python,
running on the laptop) and the `esp32-leader` firmware in this repo. It
covers the USB serial connection, the JSON message schemas in both
directions, and how court identity works across a shared mesh.

If you just need to poke at this end-to-end without building the real
integration yet, see [Testing](#testing) below.

## Pipeline

```
Arduino (wired, pipe-text) -> ESP8266 (mesh, JSON) -> ESP32 (USB, JSON) -> Streamer (laptop)
                                                              ^
                                                              |
                                            Streamer -> ESP32 -> mesh.sendSingle -> ESP8266 -> Arduino (names)
```

- Uplink (scoreboard state, heartbeats, logs) flows continuously,
  Arduino -> ESP8266 -> ESP32 -> streamer.
- Downlink (player/team names) is the new reverse path, streamer -> ESP32 ->
  the *one* ESP8266 whose court the command targets -> Arduino.
- The Arduino stays fully "dumb" - no JSON, no court awareness, just the
  pipe-delimited text it always spoke. ESP8266 is the translator between
  that and JSON.

## Serial connection

- **Baud rate: 115200**, 8N1, USB CDC.
- **Port auto-detection**: ESP32 boards typically enumerate via a
  Silicon Labs, `wch.cn`/QinHeng (CH340), or similar USB-serial chip. Match
  on `manufacturer` containing `"Silicon Labs"`, `"wch.cn"`, `"QinHeng"`, or a
  `path` containing `"usbserial"`/`"ttyUSB"`. Poll every ~5s and reconnect on
  `close` - the ESP32 can be unplugged/replugged or reset independently of
  the streamer process. See `esp-serial-com/index.js` for a working
  reference implementation of this scan/reconnect loop.
- **Framing**: one JSON object per line. The ESP32 uses `Serial.println`, so
  lines are `\r\n`-terminated; either split on `\r\n`, or split on `\n` and
  trim the trailing `\r`. Write a line, get a line.

### Detecting whether the hardware is attached

If the streamer needs to know whether an ESP32 is actually plugged into this
box (e.g. to enable a feature only on equipped boxes), gate on **content, not
on the port being open** - an open port proves nothing about what is on the
other end, and an unrelated USB-serial gadget would otherwise read as present.

The ESP32's own heartbeat is the presence signal: it is emitted every 5s
unconditionally, needs no mesh and no court, and is therefore alive as soon as
the USB link is. A reasonable predicate is "a line parsed as JSON and carried a
string `type` within the last ~15s" (three missed beats before declaring the
device gone, so one dropped line doesn't flap).

Note the ESP32's heartbeat carries **no `courtId`** - it is the local leader
and has no court. Presence must not require one, or it will never become true.
Court filtering (below) applies to routing decisions, not to liveness.

## Uplink: ESP32 -> Streamer

Every line the ESP32 writes to Serial is a JSON object with a `type` field.
Streamer code should switch on `type` and ignore unknown types (forward
compatibility - new types may be added later).

**Not every line is JSON.** `receivedCallback` in `esp32-leader.ino`
deliberately relays mesh messages it cannot parse as-is rather than dropping
them (e.g. raw strings from an ESP8266's debug passthrough), and boot-time
chatter appears on the port too. Treat a parse failure as "ignore this line",
never as an error condition - a parser that throws on the first line of ESP8266
boot noise will take the streamer down with it.

### `score`

Sent whenever the Arduino's score state changes.

```jsonc
{
  "type": "score",
  "courtId": "CRT-001",
  "nodeId": 1234567890,     // mesh node ID of the originating ESP8266
  "mode": "TENNIS",         // or "AMER"
  "scoreA": "15",           // Tennis: "00"/"15"/"30"/"40"/"AD". Americano: "00".."99"
  "scoreB": "40",
  "gamesA": 1,              // Americano packets carry 0 here (not meaningful in that mode)
  "gamesB": 0
}
```

- **`scoreA`/`scoreB` are strings, not numbers.** The ESP8266 passes the
  Arduino's token straight through, and tennis scores include `"AD"` - a
  parser that assumes integers works right up until deuce.
- `gamesA`/`gamesB` *are* integers.
- **Score packets carry no `source` field at all** (unlike every other type).
  Switch on `type` first; don't key on `source` being present.

### `button`

Sent when the physical push-button on a court is pressed. The button node is a
*separate* ESP8266 from the scoreboard one (see `push-button-esp8266/`), joined
to the same mesh and tagged with the same `courtId`.

```jsonc
{
  "type": "button",
  "source": "BUTTON",
  "courtId": "CRT-001",
  "nodeId": 1234567890,     // mesh node ID of the button ESP8266
  "event": "press",         // press edge only - releases are not reported
  "seq": 7                  // monotonic per boot, increments on each press
}
```

- Only the **press** edge produces a message; holding the button down does not
  repeat, and releasing it sends nothing.
- Debounced in firmware (50 ms), so one physical click is one message.
- `seq` resets to 0 when the button node reboots, and increments by 1 per
  press. Mesh broadcasts are best-effort - a gap in `seq` means a press was
  lost in transit, and a `seq` that goes backwards means the node rebooted.

### `heartbeat`

Emitted every 5 seconds by each node in the chain, so the streamer (and
whatever it forwards to) can tell from the office whether the whole chain is
alive without going on-site.

```jsonc
{ "type": "heartbeat", "source": "ARDUINO", "courtId": "CRT-001", "nodeId": 1234567890 }
{ "type": "heartbeat", "source": "ESP8266", "courtId": "CRT-001", "nodeId": 1234567890 }
{ "type": "heartbeat", "source": "BUTTON",  "courtId": "CRT-001", "nodeId": 1234567890 }
{ "type": "heartbeat", "source": "ESP32" }
```

If the `ARDUINO` heartbeat stops arriving but `ESP8266`'s doesn't, the
Arduino<->ESP8266 wire is the problem. If `ESP8266`'s stops but `ESP32`'s
doesn't, that court's mesh link dropped. If `ESP32`'s stops, the USB
connection itself is down. `BUTTON` is an independent node on its own power -
it can go quiet while the scoreboard chain stays healthy, and vice versa.

### `log`

Diagnostic messages from any node, so failures are debuggable remotely.

```jsonc
{ "type": "log", "source": "ESP8266", "courtId": "CRT-001", "level": "warn", "message": "unrecognized arduino line: ..." }
{ "type": "log", "source": "ESP32", "level": "warn", "message": "names command for unknown courtId: CRT-999" }
```

`level` is one of `"error"`, `"warn"`, `"info"`, `"debug"`.

**Forwarding to ds-backend:** the backend's device-logs endpoint
(`POST /logs`, see its `device-logs` module) expects:

```ts
{ source: string, logs: [{ level, message, timestamp, metadata? }] }
```

It has no dedicated `courtId`/`deviceId` column today - when forwarding,
put this message's `courtId` (and `nodeId` if present) into that entry's
`metadata` object, and use this message's `source` field (`ARDUINO` /
`ESP8266` / `ESP32`) for the log entry's `source`, e.g. `"esp32-<courtId>"`.

## Downlink: Streamer -> ESP32

Write one JSON line per command to the same serial port.

### `names`

```jsonc
{ "type": "names", "courtId": "CRT-001", "sideA": "JOHN & MIKE", "sideB": "ALEX & SAM" }
```

- `sideA`/`sideB` are plain display strings, already formatted by the
  streamer (e.g. `"John & Mike"` for a doubles pair). The Arduino does no
  formatting of its own.
- To clear names (revert the board to its current/default behavior - no
  scrolling, no cycling), send `sideA`/`sideB` as `null` or omit them:
  ```jsonc
  { "type": "names", "courtId": "CRT-001", "sideA": null, "sideB": null }
  ```
- **`courtId` is required.** The ESP32 only knows how to route a command to
  a physical board because it has previously seen an uplink message tagged
  with that same `courtId` (it learns `courtId -> mesh nodeId` passively).
  If the ESP32 has never seen that court's uplink traffic yet (e.g. sent
  before the board finished booting), the command is dropped and a
  `type:"log"` warning is emitted uplink instead of silently failing.
- Where `courtId` comes from: it's provisioned into each ESP8266's firmware
  at flash time from ds-backend's court/ground records. The streamer should
  already know which court/ground it's running for and use that same ID.

## Court identity & mesh bleed

**Two nodes share one `courtId`.** A court's scoreboard ESP8266 and its button
ESP8266 are both provisioned with the same `courtId` (that's what correlates a
press with that court's score), but they have different mesh `nodeId`s. The
ESP32 learns `courtId -> nodeId` for `names` routing **only from the
scoreboard node** - it explicitly ignores messages with `"source":"BUTTON"`
when learning, since routing a `names` command to the button node would
silently drop it. Any future auxiliary node that tags itself with a `courtId`
must be excluded there too.

All units currently share the same hardcoded mesh credentials
(`MESH_PREFIX`/`MESH_PASSWORD`). If two courts' meshes are ever in WiFi
range of each other (e.g. multiple courts at one venue), an ESP32 may
receive uplink traffic that isn't "its" court. **The ESP32 does not filter
this** - it relays everything it hears. The streamer must check `courtId`
on every uplink message and ignore anything that doesn't match the court it
cares about.

This matters most for `button`: an unfiltered consumer that treats any press
as "the press" will act on a neighboring court's button with nothing in its
logs to explain it. If the streamer already knows which court it is streaming,
compare against that - don't assume the only traffic on the port is yours.

## Testing

Before the real streamer integration exists, use
`/Users/hassan/Documents/Personal/DropShot/esp-serial-com` to exercise the
full loop from a desk:

```bash
cd esp-serial-com
npm install
npm run dev
```

It auto-connects to an attached ESP32, pretty-prints uplink `score`/
`heartbeat`/`log` lines as they arrive, and offers a REPL:

```
names CRT-001 JOHN & MIKE :: ALEX & SAM
clear CRT-001
{"type":"names","courtId":"CRT-001","sideA":"A","sideB":"B"}
```

This lets you confirm the whole reverse path - streamer command -> ESP32 ->
mesh (targeted to the right ESP8266) -> Arduino -> physical board - without
either a real streamer or ds-backend in the loop.

### Verification status (live hardware, 2026-07-12)

Using the harness above against a real Arduino/ESP8266/ESP32 chain:

- **Confirmed working:** the full uplink chain (`score`/`heartbeat`/`log`
  from all three sources, correctly tagged with `courtId`/`nodeId`); the
  ESP32's `courtId -> nodeId` learning and targeted `mesh.sendSingle` routing
  for a valid court; the "unknown courtId" error path (verified it logs a
  clean warning instead of silently failing); the `names` clear command.
- **Not yet confirmed:** whether the Arduino actually renders received names
  correctly on the physical LED panel (no ack exists in the protocol, and
  the panel was powered off during this test session - deliberate attempts
  to add a temporary debug ack introduced a *different*, unrelated problem,
  see the SoftwareSerial turnaround warning in `esp8266/README.md`, and were
  reverted rather than risk further disruption). This remains the one gap -
  confirm visually once the board is powered.

### Verification status (live hardware + LED panel, 2026-07-17)

The gap above is closed: with a single 32x16 panel powered
(`SINGLE_PANEL_TEST` mode), `names` commands sent from the desk harness were
**visually confirmed** rendering as the scrolling marquee, alternating with
the score view, and `names`-clear visually reverts the panel to score-only.
The full downlink path (harness -> ESP32 -> targeted mesh -> ESP8266 ->
Arduino -> LED) works end-to-end.

Two findings from that session:

1. **Firmware bug found and fixed** (`arduino-scoreboard` `Input.cpp`): the
   serial debug-keystroke switch matched uppercase `'M'`/`'R'` on *every*
   received byte, so the `NAMES|` prefix itself (plus any name containing
   M/R, e.g. "MIKE", "ROGER") fired spurious mode-switch/reset events on
   every names command. Fixed by only honoring debug keystrokes as the
   first character of a line. Residual (accepted) risk: a garbage byte that
   lands at line start (e.g. ESP8266 boot noise on the shared line) can
   still fire a debug key - observed once as a phantom "A 01" after an
   ESP8266 power-cycle.
2. **The Arduino must be flashed with the Pro Mini 3.3V/8MHz profile**
   (`arduino:avr:pro:cpu=8MHzatmega328`). Flashing the 16MHz profile drops
   the physical baud to 2400 and the ESP8266 hears only garbage - the
   uplink looks dead even though the board runs. See the board-profile
   section of `arduino-scoreboard/README.md`.

Still untested (needs the RF remote at hand): score changes originating
from real RF button presses while names are loaded, and the games-won
snap-back behavior on the full 2x2 panel layout.

### Verification status: the `button` node (as of 2026-08-14)

**The push-button uplink has not been confirmed end-to-end.** The firmware in
`push-button-esp8266/` is written and the packet shape above is fixed, but no
consumer has yet read a press off the ESP32's serial port - there was no
streamer to read it when the node was built, and the desk harness
(`esp-serial-com`) only pretty-prints `score`/`heartbeat`/`log`, so a `button`
line falls through its `default:` branch and prints as raw JSON.

Before building against it, put a serial monitor on the ESP32 and press the
button once. That confirms the mesh join, the `courtId` tagging and the `seq`
increment in about five minutes, and de-risks everything downstream of it.

Note that the harness's `switch` statement is **not** the protocol - this
document is. Types it doesn't pretty-print still arrive on the wire.
