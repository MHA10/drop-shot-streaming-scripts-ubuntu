# esp-serial-com — ESP32 serial desk harness

A **manual diagnostic tool** for the ESP32 ⇄ streamer serial link. Auto-connects
to an attached ESP32, pretty-prints uplink traffic, and gives you a REPL for
sending downlink `names` commands.

> ⚠️ **This is not the protocol spec.** The contract is
> [`docs/esp32/STREAMER_INTEGRATION.md`](../../docs/esp32/STREAMER_INTEGRATION.md).
> This harness's `switch` statement only pretty-prints `score` / `heartbeat` /
> `log`; every other type (including **`button`**) falls through to `default:`
> and prints as raw JSON. Reading the switch as the list of message types is
> exactly the mistake that produced the wrong conclusion in
> [`STREAMER_PARSER_REVIEW.md`](../../docs/esp32/STREAMER_PARSER_REVIEW.md) §2.

> ⚠️ **Never run this beside a live streamer on the same box.** A serial device
> can only be held by one consumer, and this tool also *writes* to the port. If
> the streamer has highlights enabled it already owns the ESP32. Stop the
> streamer first, or use `PORT_FILTER` to pin a different device.

## Usage

```bash
cd lib/esp-serial-com
npm install
npm run dev
```

Pin one device when several USB-serial gadgets are attached (ESP8266 debug
cable, Arduino FTDI, …) — matches on path *or* serial number:

```bash
PORT_FILTER=599C0042731 npm run dev
```

## REPL commands

```
names CRT-001 JOHN & MIKE :: ALEX & SAM   push team names to a court's board
clear CRT-001                             revert that board to score-only
{"type":"names","courtId":"CRT-001",...}  send raw JSON as-is
help                                      usage
```

## What it's useful for

- **Confirming the hardware chain is alive** — you should see `heartbeat` from
  `ARDUINO`, `ESP8266`, `BUTTON` and `ESP32`. Which ones are missing tells you
  where the chain is broken (see the spec's `heartbeat` section).
- **Verifying a button press** — press the physical button and watch for a
  `type:"button"` line. It prints as raw JSON here, which is expected.
- **Reading the real `courtId`** off live traffic, to confirm it matches the
  court ID the streamer is configured with.
- **Exercising the downlink** without a real streamer in the loop.

## Relationship to the streamer

The streamer's own `SerialHighlightListener` speaks the same protocol and is the
production consumer. This harness exists for desk/on-site diagnosis only — it is
not a service, has an interactive REPL, and is not started by PM2.

On a box running the PM2 score forwarder (`score-to-supabase.js`, usually
`dropshot-score`), that process owns the serial port, so this harness cannot
open it. You don't need to stop the forwarder to check health: it prints the
same `heartbeat` / `log` / `button` packets to its log (writing only `score` to
Supabase), so use `pm2 logs dropshot-score`. Set `HEALTH_LOGS=0` to silence them.

It vendors `serialport` v13 in its own `package.json` while the streamer pins
v12. That's fine: the surface both use (`SerialPort.list`, the constructor,
`.pipe`, `ReadlineParser`) is unchanged between the two versions.

Source: the Arduino project's `esp-serial-com/`, vendored here unmodified.
