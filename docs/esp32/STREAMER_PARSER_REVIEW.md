# Streamer highlight listener: protocol review

Point-in-time review (2026-08-14) answering the streamer team's questions about
`SerialHighlightListener.ts` and the ESP32 serial protocol, written against the
firmware in this repo.

The authoritative contract is [`STREAMER_INTEGRATION.md`](./STREAMER_INTEGRATION.md)
— it has been updated with the spec-level gaps this review turned up. This file
is the "why", and answers the specific conclusions that were drawn from reading
the desk harness instead of the spec.

Sources: `esp32-leader/esp32-leader.ino`, `push-button-esp8266/push-button-esp8266.ino`
(+ its `Config.h`), `esp8266/esp8266.ino`, and `esp-serial-com/index.js`.

---

## Summary

| Finding | Verdict |
| --- | --- |
| The pipe-delimited parser never matches real firmware | **Confirmed** — and it never has |
| "No highlight type exists in this protocol" | **Incorrect** — `type:"button"` is shipped |
| `\r\n` vs `\n` delimiter mismatch | **Non-issue** — the existing code already handles it |
| Two processes fighting over the port | **Real, but operational** — don't run the harness beside a live streamer |
| Mesh bleed / court filtering | **Missed** — will cut highlights on the wrong court |

---

## 1. The pipe parser — confirmed

`RECOGNIZED_PREFIXES` and `line.split("|", 1)[0]` will never match, and this has
never worked against real hardware. `esp32-leader.ino` has only ever written
JSON via `serializeJson`; there was no earlier pipe-delimited phase on the
ESP32 to regress from.

The docblock in `SerialHighlightListener.ts` stating that the ESP32 prints
`HEARTBEAT|ESP32` every 5s is wrong about our firmware. The pipe format is real,
but it lives one hop earlier — on the Arduino → ESP8266 wire — and the ESP8266
is the translator that turns it into JSON. Only the `115200` baud in that
comment is correct.

The pipeline, for reference:

```
Arduino (wired, pipe-text) -> ESP8266 (mesh, JSON) -> ESP32 (USB, JSON) -> Streamer
```

## 2. The highlight packet exists — incorrect finding

`type:"button"` is documented and shipped. The conclusion that only
`score`/`heartbeat`/`log` exist came from reading the harness's `switch`
statement, which pretty-prints three types and dumps everything else through
`default:`. **The harness is a desk tool, not the spec.**

```json
{"type":"button","source":"BUTTON","courtId":"CRT-001","nodeId":1234567890,"event":"press","seq":7}
```

The button is a *separate* ESP8266 from the scoreboard one (`push-button-esp8266/`)
— its own board, own power, own mesh `nodeId` — provisioned with the **same**
`courtId`. That shared court ID is exactly what correlates a press with the
court it happened on.

- **Press edge only.** Holding sends nothing further; releasing sends nothing
  at all.
- **Debounced 50 ms in firmware**, so one physical click is exactly one
  message. You do not need your own debounce.
- **`seq` is a delivery check.** Monotonic per boot, `+1` per press. A gap means
  the mesh broadcast was lost (best-effort, no retry); a value that goes
  *backwards* means the button node rebooted. Log gaps; don't try to recover them.
- **`nodeId` is injected by the ESP32**, not the button — it's the mesh sender
  ID, so you won't find it in the button firmware.
- **The node is uplink-only.** It acts on nothing it receives, so there is no
  ack and nothing to send it.

## 3. Line endings — non-issue

The existing code already handles this. `ReadlineParser({ delimiter: "\n" })`
splits the line and `handleLine` calls `raw.trim()`, which strips the trailing
`\r`. No change needed.

(The harness sets `delimiter: '\r\n'` instead. Both work, since `Serial.println`
emits CRLF.)

## 4. Port contention — real, but operational

True only if both run at once. `esp-serial-com` is a manual desk tool with an
interactive REPL — it is not a service and shouldn't run beside a live streamer.
It also accepts a `PORT_FILTER` env var to pin one device by path or serial
number when several USB-serial gadgets are attached.

---

## 5. The one that was missed: court filtering

> **This will cut highlights on the wrong court.**

Every unit is flashed with the same hardcoded `MESH_PREFIX` / `MESH_PASSWORD`
(`DropShotLiveMesh`). At a venue where two courts are within WiFi range, one
box's ESP32 hears the other court's traffic — and relays it verbatim. That is
deliberate: `esp32-leader.ino` does zero court filtering, and the spec puts that
responsibility on the streamer.

`SerialHighlightListener` has no notion of `courtId` at all, and `main.ts` routes
any highlight to `running[0]`. So a press on court 2 cuts a clip from court 1's
stream, with nothing in the logs to explain it.

**What that implies:**

- Carry `courtId` on `HighlightSignal` and match it against the running stream's
  court, instead of blindly taking `running[0]`.
- **Don't apply that filter to presence detection.** The ESP32's own heartbeat is
  `{"type":"heartbeat","source":"ESP32"}` with *no* `courtId` — it's the local
  leader and has no court. Requiring a court ID for presence leaves
  `isDevicePresent()` false forever.
- **Verify the join key.** Firmware `COURT_ID` is provisioned at flash time from
  ds-backend's court records (currently `"CRT-001"`), and the stream record's
  `court.courtId` is supposed to be that same string. Worth confirming against
  one real box rather than assuming.

---

## 6. Parser notes

Switch on `type`; **ignore unknown types** — the spec reserves the right to add
more. Four exist today: `score`, `button`, `heartbeat`, `log`. Full schemas are
in `STREAMER_INTEGRATION.md`.

Three things that will bite a naive parser:

- **Scores are strings, not numbers.** `"scoreA":"15"` — tennis values are
  `"00"`/`"15"`/`"30"`/`"40"`/`"AD"`, Americano is `"00"`–`"99"`. The ESP8266
  assigns the raw token straight through. An integer parse works right up until
  deuce. (`gamesA`/`gamesB` *are* ints, and are always `0` in Americano.)
- **Score packets carry no `source` field at all**, unlike every other type.
  Don't key on it.
- **Not every line is JSON.** `esp32-leader.ino` relays unparseable mesh messages
  verbatim rather than dropping them, and boot noise appears on the port too.
  Treat a `JSON.parse` failure as "ignore this line", never as an error path.

### Presence detection

Keep the content-gating rationale in the current docblock — it's sound, and the
reasoning about not trusting an open port still holds. Just change the predicate
from a prefix set to *"parsed as JSON and has a string `type`"*. The ESP32's 5s
heartbeat still proves the USB link, so the 15s freshness window and the 7s open
grace both remain correct.

### Port auto-detection

`resolvePortPath` currently takes the first tty matching a USB-ish path regex,
and its docblock notes that a precise match is blocked on "the hardware team
confirming the ESP32's ids". The answer: **match on manufacturer, not product
ID.** The boards ship with either a CP2102 or a CH340 bridge, so no single PID
covers the fleet.

```js
manufacturer includes 'Silicon Labs' | 'wch.cn' | 'QinHeng'
  || vendorId === '1a86'        // Linux reports the bare VID for the CH340
  || path includes 'usbserial' | 'ttyUSB' | 'ttyACM'
```

This matters more than it looks: on a box that also has the ESP8266 debug cable
or an Arduino FTDI plugged in, "first USB-ish tty" can open the wrong device and
sit there hearing nothing.

---

## 7. The downlink, for when you get to it

The reverse path — pushing team names to the physical board — is built and
visually confirmed on hardware. Write one JSON line to the same port:

```json
{"type":"names","courtId":"CRT-001","sideA":"JOHN & MIKE","sideB":"ALEX & SAM"}
```

```json
{"type":"names","courtId":"CRT-001","sideA":null,"sideB":null}
```

- **Timing constraint that will catch you out:** the ESP32 routes by a
  `courtId -> nodeId` table it learns *passively* from uplink traffic. Send
  `names` before that court's board has spoken and the command is dropped —
  you'll get `{"type":"log","source":"ESP32","level":"warn","message":"names command for unknown courtId: …"}`
  back on the uplink. Don't send until you've seen a packet from that court, and
  watch for that warning.
- **Sides are display strings you format.** The Arduino does no formatting of its
  own — send `"John & Mike"` exactly as it should appear.
- **There is no ack.** That warning is the only failure signal in the protocol.

---

## 8. Housekeeping

- **serialport v12 vs v13 is a non-problem.** The surface in use — `SerialPort.list`,
  the constructor, `.pipe`, `ReadlineParser` — is unchanged between the two. Keep
  the streamer on v12 and let the vendored harness use it rather than adding a
  second copy.
- **`lib/esp-serial-com/` is the right home** for the harness, and vendoring it as
  a documented diagnostic tool is a fine call. Just don't let it read as the
  protocol spec — `STREAMER_INTEGRATION.md` is that.
- **Verified on live hardware (2026-07-17):** the full uplink chain with correct
  court/node tagging, the ESP32's route learning and targeted `mesh.sendSingle`,
  the unknown-court error path, and `names` rendering and clearing on a real LED
  panel.
- **Not verified:** the button node's press reaching a consumer end-to-end. The
  firmware is written and the shape is fixed, but nothing has read it off the port
  in anger, because no streamer existed to read it. Put a serial monitor on the
  ESP32 and press the button before wiring the parser to it — five minutes, and it
  de-risks the whole feature.

Ping us on anything the spec leaves ambiguous. It is much easier to change
firmware now than after the fleet is flashed.
