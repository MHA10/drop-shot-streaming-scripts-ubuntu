# Player Stats → DB / Server Handoff

**Status:** ready for backend build · **For:** Farooq (backend/DB) · **From:** streaming · **Last updated:** 2026-10-16
**Pairs with:** [`docs/v1-stats-spec.md`](./v1-stats-spec.md) (plain-English meaning + accuracy of every field).

---

## 0. TL;DR — what you're building

The streamer computes per-player and per-team stats for a padel match (plus a heatmap picture). Today those land in **local files on the box only** — nothing is stored or sent. This is greenfield on your side.

You need two things:

1. **A table** to hold one stats record per match.
2. **A backend route** the streamer can POST the final stats to — mirroring exactly how the live **score** already reaches the backend (`POST /api/v1/padel-grounds/{groundId}/courts/{courtId}/scoreboard`, authed with the per-box `x-streaming-api-key`). We send; the backend writes the DB. Court boxes never get database credentials — same security model as the score path.

**Cadence (decided):** the streamer sends the stats **once, when the match's stream stops** — the final numbers, not live updates. One POST, one row.

**Heatmap (decided):** the picture is uploaded to **Cloudinary** (same account used for logos) by the streamer; the POST carries the resulting **image URL**. You store the URL, not the image.

---

## 1. How it arrives (transport)

- **Method/route:** `POST /api/v1/padel-grounds/{groundId}/courts/{courtId}/stats` (final path name is yours to choose — this mirrors the existing `…/scoreboard` route).
- **Auth header:** `x-streaming-api-key: <per-box key>` — the same key the score POST uses (`STREAMING_API_KEY`). Validate the court belongs to the ground, exactly as the scoreboard route does.
- **When:** once, at match end (when the stream for that court stops).
- **State is absolute:** the body is the complete, final stats object — never a partial/delta. If the same match is sent twice (e.g. a retry), treat it as a replace, not an append.
- **Body:** the JSON in §2.

### Example request
```
POST /api/v1/padel-grounds/75097349-fbfd-467b-ab0d-81ebc7e9d376/courts/fea8178e-81b9-475e-8dd0-038a2c06f7fe/stats
x-streaming-api-key: <per-box key>
Content-Type: application/json

{ …the payload in §2… }
```

---

## 2. The payload (data contract)

The streamer wraps the computed stats in a small **envelope** that identifies the match, then the stats themselves sit under `stats`. The envelope fields are what you key/store the row by; `stats` is the content.

```jsonc
{
  // ── envelope: identity + metadata (added by the streamer) ──
  "schemaVersion": 1,
  "groundId": "75097349-fbfd-467b-ab0d-81ebc7e9d376",   // which venue (stable, per box)
  "courtId":  "fea8178e-81b9-475e-8dd0-038a2c06f7fe",   // which court (from the stream event)
  "matchId":  null,                                      // OPEN — see §3
  "streamId": "stream_mv9n6pe8_45bd11a6579831ac",        // per-stream tag (optional, not stable)
  "capturedAt": "2026-10-16T18:20:00Z",                  // when the final numbers were written (UTC)
  "heatmapUrl": "https://res.cloudinary.com/<acct>/image/upload/v169.../court-heatmap.png",

  // ── stats: the computed content (produced by scripts/player_stats.py) ──
  "stats": {
    "source": "",                 // internal; empty in the live/near-live mode
    "duration_s": 742.0,          // match length in seconds

    "calibration": {
      "court_m": [10, 20],        // court size used (10 m wide × 20 m long)
      "width": "exact (X = 10 * u)",
      "depth": "net-anchored estimate (Y = 10 * v / v_net); metric values are ~±10-15%"
    },

    "players": {                  // keys are fixed slots A, B, C, D (see note on missing players)
      "A": {
        "name": "A",              // label or real name if provided
        "team": "far",            // "far" = {A,B}, "near" = {C,D}
        "distance_m": 612.4,
        "lateral_distance_m": 240.1,
        "court_coverage_pct": 63.0,
        "mean_speed_ms": 1.34,
        "top_speed_ms": 4.80,
        "sprints": 11,            // integer count
        "time_at_net_s": 180.4,
        "time_at_net_pct": 24,    // whole %
        "time_at_back_s": 300.9,
        "time_at_back_pct": 41,   // whole %
        "avg_position_xy_m": [4.8, 6.2],   // [x, y] metres on HIS OWN side (see field table)
        "avg_side": "right",      // "left" | "right" — the player's own left/right
        "left_side_pct": 38,      // % of time on his own left half (whole %)
        "detection_rate": 0.91    // 0–1, how often the camera actually saw this player (trust score)
      },
      "B": { … }, "C": { … }, "D": { … }
    },

    "teams": {                    // keys are fixed: "far" and "near"
      "far": {
        "players": ["A", "B"],    // the two names on this team
        "mean_separation_m": 3.10,
        "max_separation_m": 7.42,
        "pct_time_gap_over_2m": 58,            // whole %
        "formation": {
          "both_at_net_pct": 22,
          "both_at_back_pct": 35,
          "one_up_one_back_pct": 43
        },
        "dominant_formation": "one up, one back"   // text
      },
      "near": { … }
    }
  }
}
```

### Field reference

**Envelope**
| field | type | notes |
|---|---|---|
| `schemaVersion` | int | bump if the shape changes; start at `1` |
| `groundId` | string (uuid) | the venue; stable per box |
| `courtId` | string (uuid) | the court this match was on |
| `matchId` | string \| null | **open decision — §3**; `null` until we settle it |
| `streamId` | string \| null | per-stream session tag; **not** a stable match id — don't key on it |
| `capturedAt` | string (ISO-8601 UTC) | when the final numbers were produced |
| `heatmapUrl` | string (url) \| null | Cloudinary link to the heatmap picture; `null` if the upload failed |

**Per player** (`stats.players.{A,B,C,D}`) — all numbers are plain JSON numbers:
| field | type | unit | meaning |
|---|---|---|---|
| `name` | string | — | label (A/B/C/D) or real name |
| `team` | string | — | `far` ({A,B}) or `near` ({C,D}) |
| `distance_m` | number | metres | total ground covered |
| `lateral_distance_m` | number | metres | left-right running only |
| `court_coverage_pct` | number | % | how much of their own half they roamed |
| `mean_speed_ms` | number | m/s | typical moving speed |
| `top_speed_ms` | number | m/s | fastest sustained speed (capped at 8) |
| `sprints` | int | count | bursts of >4 m within any 1-second window |
| `time_at_net_s` / `time_at_net_pct` | number | sec / % | time in the front 3 m of their half |
| `time_at_back_s` / `time_at_back_pct` | number | sec / % | time in the back 3 m of their half |
| `avg_position_xy_m` | [number, number] | metres | average spot **on his own side, seen from behind him**: `x` = metres from his left sideline (0–10), `y` = metres back from the net (0–10) |
| `avg_side` | string | — | `left` or `right` — **the player's own** left/right (how padel players name their side), not the camera's |
| `left_side_pct` | number | % | share of time he spent on his own left half |

> **Updated 2026-10-17:** pairs change ends every two games, so position stats (net/back time, coverage, side, average position, formation) are now measured on each player's own side. Before this fix, a player's net time was badly over-counted after a changeover (one test player read 73% at the net; the real figure was 13%). If you stored any earlier test payloads, re-run them.
| `detection_rate` | number | 0–1 | camera-coverage / trust score — **see §6** |

**Per team** (`stats.teams.{far,near}`):
| field | type | unit | meaning |
|---|---|---|---|
| `players` | [string, string] | — | the two names |
| `mean_separation_m` | number | metres | typical distance between partners |
| `max_separation_m` | number | metres | biggest gap they reached |
| `pct_time_gap_over_2m` | number | % | share of time more than 2 m apart |
| `formation.both_at_net_pct` | number | % | both up at the net |
| `formation.both_at_back_pct` | number | % | both back |
| `formation.one_up_one_back_pct` | number | % | staggered |
| `dominant_formation` | string | — | their most common shape |

**Match-level** (`stats.*`): `source` (string, internal), `duration_s` (number, seconds), `calibration` (object, fixed descriptive strings + `court_m` `[10, 20]`).

> **Important — players/teams can be missing.** If the camera never got a clean fix on a player for the whole match, that player's key is **absent** from `players` (not zeroed). If either partner is missing, that team is absent from `teams`. Store what's present; don't assume all four players / both teams always exist.

---

## 3. Match identity — the one open decision (needs you + backend)

The streamer can reliably tag a record with **`groundId`** (its env var) and **`courtId`** (from the stream event). It does **not** have a stable **match id** — there is no `matchId`/`match_id` anywhere in the streamer today, and `streamId` is a throwaway value generated locally per stream session (not shared with the backend, not stable).

The problem this creates: a single court hosts many matches over time. Keying stats only by `(groundId, courtId)` would make every new match overwrite the last. So we need a way to tell matches apart. Options, your call:

- **(Recommended) Backend owns match identity.** The backend already starts/stops streams for a court (it sends the start/stop events). If it mints a `matchId` when a stream starts and passes it to the streamer in that start event, we echo it straight back in this payload. Cleanest, and it lets stats join to whatever the backend already knows about the match.
- **Key by `(groundId, courtId, capturedAt)`** as a stand-in match id. Works with zero streamer changes, but it's a weaker key (no clean join to a "match" entity, and relies on the end-timestamp being unique).

Until this is settled, the streamer sends `matchId: null`. Tell me which way you want to go and, if it's option 1, where in the start event the id should live — I'll wire the streamer to echo it.

---

## 4. The heatmap picture

- The streamer renders a single image: four top-down court maps (one per player) showing where each stood.
- The streamer **uploads it to Cloudinary** (the account already used for client logos) and puts the resulting URL in `heatmapUrl`.
- You just **store the URL** and let the product show the image. Nothing to render on your side.
- If the upload ever fails, `heatmapUrl` is `null` and the numeric stats still arrive — treat the image as optional.

---

## 5. Suggested storage shape (your call)

A simple, future-proof shape:

- One row per match: identity columns (`ground_id`, `court_id`, `match_id`, `stream_id`, `captured_at`, `heatmap_url`, `schema_version`) **+ the whole `stats` object in a single JSON column.** That stores everything with zero field-by-field mapping and survives us adding fields later.
- If you need to query/sort by individual stats (e.g. "top distance this week"), add a child `player_match_stats` table with one row per player (`match_id`, `slot` A/B/C/D, `name`, `team`, and the per-player columns) and keep the team block either as JSON on the match row or a small `team_match_stats` child. Up to you — the JSON column alone is enough to ship v1.
- Make every per-player/per-team column **nullable** (players/teams can be absent — §2).

**We're sending all fields.** Even if the product only shows a few for v1 (the obvious viewer-facing ones are the heatmap, `distance_m`, time-at-net, and team formation), store the lot — it's cheap and avoids a re-plumb when more get surfaced.

---

## 6. Display / accuracy rules to respect (from the spec)

These don't change storage, but they matter for how the product uses the numbers (full detail in `v1-stats-spec.md §5`):

- **`detection_rate` is a trust gate.** Below ~**0.60**, that player's numbers under-count (the camera kept losing them) — the product should hide or caveat them, not show them as fact. Store the value regardless.
- **Depth is an estimate (±10–15%); width is exact.** Present metres/speeds as comparisons between players and rallies, not as precise measurements.
- These are per the spec's proposed v1 guardrails — worth a shared read of `v1-stats-spec.md §5` so the product side treats the numbers correctly.

---

## 7. Who does what

**Backend (you):**
- [ ] Decide match identity (§3) and tell me the plan.
- [ ] Create the stats table (§5) and the receiving route (§1).
- [ ] Validate `x-streaming-api-key` + court-belongs-to-ground, same as the scoreboard route.

**Streamer (me), once the route + match-id decision land:**
- [ ] On match end, assemble the envelope (§2): tag with `groundId` + `courtId` (+ `matchId` if backend supplies it) + `capturedAt`.
- [ ] Upload the heatmap to Cloudinary, set `heatmapUrl`.
- [ ] POST the payload to the route with the per-box API key.

The data contract in §2 is final and ready to build against now — the only thing blocking a clean start is the match-identity call in §3.
