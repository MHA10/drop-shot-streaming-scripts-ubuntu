# Match point analysis (no scoreboard, no score feed)

Break a full match into points and work out which end served — from the video
and its sound only. Nothing here reads a scoreboard overlay or the ESP32 score
feed. The reference stream (Padel Central Court 1, Clash Of Champions final)
has no scoreboard on it at all, so there was nothing to read even if we wanted
to.

**Laptop tooling.** Needs the tracker venv (`bash tools/reels/setup-tracking.sh`).
Nothing here runs on a streamer box.

---

## The pipeline

```bash
S=~/work                      # wherever you keep working files

# 0. get the match, and strip the letterbox ONCE (all stages want the same crop)
tools/reels/.venv/bin/yt-dlp -f "137+140/136+140" --merge-output-format mp4 \
  -o $S/full.mp4 "https://youtu.be/<id>"
ffmpeg -hide_banner -ss 390 -t 5 -i $S/full.mp4 -vf cropdetect=24:2:0 -f null -   # prints crop=
ffmpeg -y -i $S/full.mp4 -vf crop=1920:862:0:108 \
  -c:v libx264 -preset ultrafast -crf 20 -an $S/court.mp4

# 1. points, from the sound of the ball                              (~5s)
tools/reels/.venv-track/bin/python scripts/match_points.py \
  --input $S/full.mp4 --output points.json --csv points.csv --debug

# 2. which END served each point, from player geometry                (~2min)
tools/reels/.venv-track/bin/python scripts/match_serves.py \
  --input $S/court.mp4 --points points.json --output serves.json --debug

# 3. a review reel you can actually watch                            (~3min)
tools/reels/.venv-track/bin/python scripts/match_debug.py \
  --input $S/court.mp4 --audio-from $S/full.mp4 \
  --serves serves.json --points points.json \
  --output review.mp4 --debug
```

> `--audio-from` matters. The cropped copy is encoded `-an`, and the review reel
> is useless silent — the ticks are a claim about audio.

---

## Stage 1 — points from ball-strike audio

A ball off a carbon paddle is a sharp 2.5–9 kHz crack, and nothing else on a
padel court sounds like it. Detect those, group them into bursts, and a burst is
a point.

On the reference match:

| | |
|---|---|
| Points | 121 (+2 warmup rallies dropped) |
| Strikes | 752 — median 5/point, max 15 |
| Play time | 10.2 min of 39 (26%) |
| Runtime | ~5s |

**Precision is high, recall is not, and they are not interchangeable.** Points
that end in two strikes (serve, then an error) fall below `--min-strikes` and are
dropped deliberately, because a player bouncing the ball before serving produces
the same one or two onsets. Never argue from a point's *absence*.

Two traps already hit and fixed, so nobody re-derives them:

- The venue plays music between points. A hi-hat is a genuine sharp transient,
  and a purely relative detector cannot tell it from a ball strike — the first
  version reported 301 strikes in a 60s window holding about 40. What separates
  them is absolute level (`--abs-gate`): music onsets measured 0.02–0.18 band
  energy, real strikes 0.3–2.5. Spectral shape does *not* separate them; high/low
  ratio and attack sharpness were both tried.
- One strike makes several onsets — the hit, its reverb off the glass, and the
  floor bounce right after. `--merge` collapses them, or every rally looks like a
  net exchange.

## Stage 2 — which end served

**Not from audio.** The obvious approach — "whoever hit the first strike served"
— is wrong on these streams. The mic sits at the near end, so a far-end serve is
often too quiet to detect at all and the first *audible* strike is the near
team's return. That made the near end the server for 25 consecutive points, which
the rules make impossible.

Instead, read the geometry at the serve: server deep in a back corner, partner up
at the net, opponents waiting back. Three independent votes (net-most player's
side, larger front-to-back spread, deepest-player-in-a-corner), then a Viterbi
pass that knows ends do not change often.

### Why runs of ~13 points are correct

Teams change ends after every odd game *and* the serve alternates every game.
Together those mean the serving **end** holds for two games, then flips for two.
So the sequence is long runs, not alternation:

| | |
|---|---|
| End switches | 8 → 9 runs |
| Implied games | ~18 |
| Points per game | **6.72** |
| Geometry vs smoothing | agree on 93% of points |

Padel games average ~6.5 points. Nothing in the estimator knows about games, so
that number landing where it does is independent confirmation. **It is also the
diagnostic**: if a new match implies 15 or 2 points per game, `--switch-cost` is
wrong — don't conclude the match was unusual.

`serve_side` is an **end**, not a team. The two games inside one run are served
by *different* teams, because the teams swapped ends between them. Do not
difference the runs to get who won a game.

## Stage 3 — the review reel

Every detected point back to back, dead time cut, with the machine's reading
printed on top and **the original audio carried through**. 39 minutes of stream
becomes ~19 minutes of review.

What to check, in order:

1. **Do the ticks land on cracks you can hear?** That is strike detection. Sound
   on, or the tool tells you nothing.
2. **Is the boxed player the one serving?** The box marks a court *position*, not
   a named human.
3. **The points flagged in red.** These are where rule-smoothing overrode the
   geometry, i.e. where the answer is least safe.

```bash
# just the flagged ones — 8 points, ~66 seconds
... scripts/match_debug.py ... --only-overridden --output flagged.mp4
```

On the reference match that is **11 of 121 points** worth human attention: 8
overridden, 3 with no usable geometry (fewer than two players detected). Point 1
is a good example of the failure mode — only one near player was detected, which
starves the spread rule, so all three votes went the wrong way and the smoothing
corrected it.

---

## What this does NOT do yet

| Field | State |
|---|---|
| When each point started/ended | done |
| Strike count per point | done (audible strikes — a floor, not a total) |
| Which **end** served | done, 93% geometry agreement |
| Which **player** served | **blocked on identity** |
| Who made the last contact | timestamp yes, player no — same blocker |
| Why the point stopped | not started |
| Who scored | needs stop-reason first |

**The identity blocker.** Naming a player needs identity held across 39 minutes.
Torso-colour clustering was measured and is not good enough: only **41%** of
four-player frames separate into four distinct clusters, because kits are
low-saturation under floodlights and torsos are 40–120 px tall in compressed
video.

Two routes, very different cost:

- **Team-level only.** Strikes alternate between teams, so once the server is
  known the last contact's *team* follows from strike parity. Reachable without
  solving identity at all.
- **Real player identity.** Per-point tracking plus a re-ID feature using
  shirt+shorts combinations rather than torso alone. This is where the work is.

`who scored` is downstream of *why the point stopped* (winner vs into-the-net vs
out), so it cannot be answered honestly before that.
