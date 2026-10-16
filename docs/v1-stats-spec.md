# DropShot v1 — Player Stats & Heatmap Spec

**Status:** draft for v1 scoping · **Owner:** streaming/analytics · **Last updated:** 2026‑10‑09

## What this is

The complete list of player stats and the heatmap we produce today, with each metric's plain meaning, its exact field name in the output, its unit, and how accurate it is — plus the open question of **when/where it runs for v1** (after the match vs. live).

**Where it all comes from:** one thing only — tracking where each of the four players stood in every video frame. "Tracking" here = an AI that finds the people in each frame (model: `yolo11s`), plus the court calibration that turns a pixel into a spot on the court. **No ball detection is involved.** The math then falls out of the four position-trails.

Source files: `scripts/track_players.py` (find + follow the 4 players → a trail per player), `scripts/player_stats.py` (the numbers), `scripts/player_heatmap.py` (the picture).

---

## 1. The heatmap (the picture)

A top‑down court per player, **stained by how long they stood in each spot** — green where they passed through, red where they camped (a long‑exposure photo of their feet). Four mini‑courts, one per player, laid out as a 9:16 share card with the clip playing in the middle.

*Produced by `player_heatmap.py` from the same trails as the stats below.*

---

## 2. Per‑player stats

One block per player. Field names are the exact JSON keys from `player_stats.py`.

### Movement
| Stat | What it means (plain) | Field | Unit |
|---|---|---|---|
| Distance run | Total ground covered over the clip | `distance_m` | metres |
| Side‑to‑side distance | Total left‑right running only (separate from up‑down) | `lateral_distance_m` | metres |
| Court coverage | How much of **their own half** they moved around in (own half split into a 10×10 grid; % of cells visited) | `court_coverage_pct` | % |

### Speed
| Stat | What it means (plain) | Field | Unit |
|---|---|---|---|
| Average speed | Typical moving speed (median of non‑zero speeds) | `mean_speed_ms` | m/s |
| Top speed | Fastest sustained speed, capped at a realistic 8 m/s | `top_speed_ms` | m/s |
| Sprints | Count of bursts where they covered **more than 4 m inside any 1‑second window** | `sprints` | count |

### Where they stood
| Stat | What it means (plain) | Field | Unit |
|---|---|---|---|
| Time at the net | Time in the front 3 m of their half (3 m = the service line) | `time_at_net_s` / `time_at_net_pct` | seconds / % |
| Time at the back glass | Time in the back 3 m of their half | `time_at_back_s` / `time_at_back_pct` | seconds / % |
| Average position | Their average spot on the court | `avg_position_xy_m` | [x, y] metres |
| Favoured side | Which side they leaned to | `avg_side` | "left" / "right" |

### Identity & quality
| Field | Meaning |
|---|---|
| `name` | Player label/name (defaults to A/B/C/D) |
| `team` | Which half they play — "near" or "far" |
| `detection_rate` | **How often the camera actually saw this player** (0–1). Low = part of their path is missing, so their numbers under‑count. *This is the trust score — see §5.* |

---

## 3. Per‑team stats

One block per pair of partners. A "team" is the two players sharing a half (`{A,B}` far, `{C,D}` near) — in padel partners never cross the net, so no appearance matching is needed.

### Spacing — how well the pair kept its shape
| Stat | What it means (plain) | Field | Unit |
|---|---|---|---|
| Average gap between partners | Typical distance apart (median) | `mean_separation_m` | metres |
| Biggest gap | How far apart they got at the extreme | `max_separation_m` | metres |
| % time too stretched | Share of time more than 2 m apart (2 m = the coaches' "too stretched" line) | `pct_time_gap_over_2m` | % |

### Formation — the shape they held
| Stat | What it means (plain) | Field | Unit |
|---|---|---|---|
| Both at the net | Share of time both players were up at the net | `formation.both_at_net_pct` | % |
| Both at the back | Share of time both were back | `formation.both_at_back_pct` | % |
| One up, one back | Share of time staggered | `formation.one_up_one_back_pct` | % |
| Dominant formation | Their most common shape | `dominant_formation` | text |

---

## 4. Attached to every report

| Field | Meaning |
|---|---|
| `source` | the video it was computed from |
| `duration_s` | clip length in seconds |
| `calibration.court_m` | court size used: 10 m wide × 20 m long, net on the midline |
| `calibration.width` | "exact (X = 10·u)" |
| `calibration.depth` | "net‑anchored estimate; metric values are ~±10–15%" |

---

## 5. Accuracy & "should we show it?" rules (v1)

These are the guardrails for v1 — what the numbers are worth, and when **not** to show them.

1. **Width is exact; depth is an estimate (±10–15%).** The court is 10 m wide at every depth, so across‑court distance is exact. Up‑the‑court distance is worked out from the net line and carries the lens's distortion. **Present metres and m/s as good for comparing players and rallies — not as a line call.** Prefer showing comparisons and ranks over raw survey‑grade figures.

2. **Gate on `detection_rate`.** A player the camera keeps losing (typically the back‑glass player who leaves frame) has a chunk of their path missing, which **under‑counts** their distance, coverage and times. **Proposed v1 rule:** below a threshold (suggest **0.60**), either hide that player's stats or show them with a visible "limited view" caveat — never present a confidently wrong number.

3. **Only run on clips with stable identity.** If the tracker lost track of which player is which, the stats are garbage. v1 should only produce stats for clips/matches where the per‑player tracking stayed stable (there's a per‑player hit rate to check first).

4. **Numbers are already de‑jittered.** Distances are summed only after smoothing and a dead‑band, and any single‑frame "teleport" (a re‑acquired player jumping) is thrown out. Without these a stationary far player reads tens of thousands of fake metres — so **do not** recompute distance from raw positions.

---

## 6. How it runs — today, and the runtime question

> **Built (2026-10-09):** the near-live option below (row 2) now exists as
> `scripts/live_stats.py` + `scripts/live-stats.ecosystem.config.js`. It can reuse the
> streamer's own highlight chunks (`--source buffer`) or slice the camera itself
> (`--source camera`), runs the player-finder at a reduced rate, and keeps
> `stats.json` + `heatmap.png` up to date while the match streams — touching nothing in
> the ffmpeg pipeline. It self-reports its processing speed each slice (the benchmark).
> See [`docs/live-stats.md`](./live-stats.md). The one thing still to measure is its
> actual speed on the box's CPU, from that logged line on the first real run.
>
> **Reviewed + hardened (2026-10-14):** three-way review (correctness / performance /
> security). Fixed: a chunk missing a player no longer crashes the reader; a restart
> mid-match no longer double-counts; the detector's CPU use is capped so it can't starve
> the live broadcast; the stats/heatmap are computed in-process with a running heatmap
> grid and a timed checkpoint (no more per-chunk cost that grew with match length); and it
> drops stale chunks to stay live when behind. Logic verified with a synthetic-data test
> suite (running heatmap proven identical to the full re-count). Still unrun on the box.

**Today (offline, after the fact):** the tracker reads a **recorded video file** and runs the AI over it frame by frame at full input size (1280 px). That's heavy — it's not computed while the match streams. (Confirmed: none of this lives in the live streamer app; it's separate tools run on a recording.)

**The question: can we produce these live, while ffmpeg is streaming?** Honest assessment, grounded in the code:

| Approach | Feasible? | Notes |
|---|---|---|
| **Full, every‑frame AI, live on the streamer box** | **No** | The box (Dell OptiPlex 5050) is almost certainly CPU‑only — no graphics card for the AI — and it's already busy encoding the live video. Running the people‑finder on every frame can't keep up with 30 frames/sec there, and would fight ffmpeg for the CPU. |
| **Near‑live, a separate process reading the camera, at a reduced rate** | **Yes — the box has the headroom (measured 2026‑10‑09)** | A separate process (like the live‑score script) opens the camera feed itself and runs the people‑finder at a **reduced rate** — the tracker already supports "every Nth frame" and a smaller input size. At ~3 frames/sec on a lower‑resolution feed the cost drops ~10–20×, plenty for a heatmap / positioning / time‑at‑net. It touches **nothing** in the ffmpeg pipeline. **Best input: the camera's low‑res sub‑stream** (e.g. `…/Streaming/Channels/102`) — lower resolution is faster for the finder and we don't need HD for positions. (Note: the on‑disk `.ts` chunks are **off** on this box, so don't depend on them.) |
| **Offload to a graphics‑card server** | **Yes (robust)** | The box just streams; the chunks (or the stream) go to a server with a graphics card that runs full tracking in real time and writes the stats out (same way the live score reaches Supabase). Real‑time and accurate, but adds a server. v1.1+. |
| **End‑of‑match job** | **Yes, but needs a recording first** | Run the tracker on the finished video and produce the final card. Catch on this box: it keeps **no local recording** today (the `.ts` buffer is off; ffmpeg only pushes to YouTube). So this path first needs **either** a local file output added to ffmpeg **or** pulling the YouTube archive afterward. Simplest *logic*, but more plumbing than it sounds, since nothing is saved today. |

**Measured on the live box (2026‑10‑09, ground `75097349…`):** 4 CPU cores; while streaming it was **~75% idle** (load average 0.83) with **ffmpeg using under one core**; **8 GB RAM, ~5 GB free**; graphics = **Intel HD 530 only (no separate graphics card)**. ffmpeg itself: pull the RTSP camera at 1080p, overlay the two logos, encode `libx264 veryfast` at 4.5 Mbps, push to YouTube. Takeaway: there are **~3 free CPU cores** — real room for a reduced‑rate finder — but it runs on the **CPU**, so **every‑frame at 30 fps is still out**; a reduced rate is the way.

**Recommendation for v1:** because this box keeps **no local recording** today and it has the CPU headroom, the **near‑live camera‑reading process** is the natural fit — it needs no recording (it watches the camera and builds the stats as it goes, writing the final card at match end), touches nothing in the ffmpeg pipeline, and deploys like the live‑score script. The **end‑of‑match job** is the alternative only if we'd rather add a recording (a local file output or the YouTube archive) and process it afterward. Either way the finder runs on the CPU at a **reduced rate**, not every frame.

**One number still to pin down:** the finder's actual speed on *this* CPU, to pick the frame rate/resolution that keeps up without touching ffmpeg. That needs the Python vision libraries installed on the box once (a one‑time setup), then a quick timing run.

---

## 7. Open decisions for v1

1. **When does it run?** End‑of‑match (recommended) vs near‑live building during the match.
2. **Where does it run?** On the streamer box vs a central server.
3. **`detection_rate` threshold** below which we hide/caveat a player's stats (proposed 0.60).
4. **Which stats are surfaced in the product for v1** vs kept internal for later — e.g. the heatmap + distance + time‑at‑net + formation are the obvious viewer‑facing ones; coverage %, sprints, separation may be coach‑facing.
5. **How metric accuracy is communicated** — ranks/comparisons vs raw metres, given the ±10–15% depth estimate.
