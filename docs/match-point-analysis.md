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
  --input $S/full.mp4 --output points.json --csv points.csv \
  --emit-bursts --debug

# 1b. refine those points with video: un-split rallies, absorb faults  (~50s)
tools/reels/.venv-track/bin/python scripts/match_refine.py \
  --input $S/court.mp4 --bursts points.json --output refined.json --debug
#     (match_points.py must have been run with --emit-bursts)

# 2. which END served each point, from player geometry                (~2min)
tools/reels/.venv-track/bin/python scripts/match_serves.py \
  --input $S/court.mp4 --points refined.json --output serves.json --debug

# 2b. name the four players and say WHICH one served                   (~30s)
tools/reels/.venv-track/bin/python scripts/match_players.py \
  --input $S/court.mp4 --serves serves.json --output players.json \
  --montage players.png --debug

# 3. a review reel you can actually watch                            (~3min)
tools/reels/.venv-track/bin/python scripts/match_debug.py \
  --input $S/court.mp4 --audio-from $S/full.mp4 \
  --serves serves.json --points refined.json --players players.json \
  --labels "P1=WHITE,P2=GREEN,P3=NUM-10,P4=ORANGE-SHORTS" \
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

## Stage 1b — refine the points with video

Audio mis-counts points two ways, and both are settled by looking at the court:

1. **A long lob puts 3s of silence mid-rally**, so one point is counted as two.
2. **A serve fault is a burst of its own** — serve, then nothing — so a point
   that took two serves is counted as two points.

At a real point start somebody is deep in a back corner, partner up at the net,
opponents waiting back. Mid-rally nobody is near that shape. Scoring that
formation on a single frame just before each burst separates them:

| | Formation score |
|---|---|
| Point starts | p10 = **0.639** |
| Mid-rally | p90 = **0.610** |

The default `--serve-threshold 0.625` sits in that measured gap. Each burst then
attaches in exactly one direction:

| Burst | Role | Attaches |
|---|---|---|
| serve-shaped, ≥3 strikes | rally start | opens a point |
| serve-shaped, ≤2 strikes | serve attempt (fault *or* pre-serve bounce) | **forward**, to the next rally |
| not serve-shaped | continuation | **backward**, if within `--max-continue` |

Direction matters. An earlier version pushed a too-soon serve-shaped burst
*backwards* as a continuation; bursts then chained and produced a 40-second and
a 52-second "point". A serve formation 3s after a rally ended is the start of the
next point, never the middle of the last one.

### Two features that failed first — don't rebuild them

Both were measured and both are dead:

| Feature | Rally | 1-strike burst | Verdict |
|---|---|---|---|
| Total player path length / frame | 0.046 | 0.051 | no separation |
| Post-serve displacement, non-servers | 0.075 | 0.105 | separates **backwards** |

Between-point walking is as much motion as a rally, and a one-strike burst is
often mid-walkabout while a short rally has players already set. The formation
only exists in the *instant* before contact, which is why a single frame beats
any window average.

The service-box rule (padel alternates boxes between points, so a repeated box
implies a fault) is also unused: measured alternation was 67% against an expected
~77%, so it carries ~10 points of noise from the server-position estimate.

### What it changed on the reference match

| | Audio only | + video refine |
|---|---|---|
| Points | 121 | **102** |
| Longest rally | — | 18.3s (was 51.9s pre-fix) |
| Points with usable serve geometry | 118/121 | **102/102** |
| Smoothing overrode geometry | 7% | **1%** |

**The count is not settled.** 102 and 121 have errors in opposite directions:
audio-only over-splits rallies, refine drops 72 stray bursts of which some were
probably real short points. An independent estimate — 18 games (time-anchored
from serve runs) × ~6.5 points/game — suggests **~117**, i.e. the truth is
between the two and closer to the audio figure. The improvement in geometry
coherence is partly circular, since refined points are *defined* as bursts with a
serve formation.

Settling it needs a hand-labelled sample. Watch `--only-overridden` plus the
`fast_restart` and `orphan_attempt` flags first — those are where it is weakest.

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

## Stage 2b — which PLAYER served

Identity by kit, from the player's own pixels, validated against the rulebook.

**Three descriptors were built; the first two failed.** Recording them so nobody
rebuilds them:

| Attempt | Result |
|---|---|
| Mean BGR over the torso box | 41% of four-player frames split into four clusters |
| Shirt/shorts mean hue-sat-val, box-masked | clusters swapped at every changeover |
| **Segmentation mask + hue histograms + kit cues** | **works** |

The killer detail: a standing player is *thin*, so the bounding box is mostly
blue court. Averaged, that drags the mean hue toward blue and swamps the kit —
far-end shirt hue read 36.5 against near-end 108.6 for the same four kits.
Segmentation masks fix it by using only the player's pixels. Then histograms
rather than means, because a region contains kit *and* skin *and* shadow, so the
mean of orange shorts plus bare legs is not orange.

Even on masks, histograms alone confused the two light shirts with each other
and the two dark shirts with each other. Four explicit kit cues — orange/red
fraction, near-black fraction, green fraction, white/grey fraction — weighted
3x above the histograms, separate them.

Assignment is **bijective per frame**: never "which player is this?", always
"what is the best way to hand out all four names in this instant?". Free k-means
has no idea a frame holds one of each and will happily use one name twice.

### How it is validated — the rulebook, not a guess

Teams alternate serve every game, and within a team the two players alternate
their service games. So the server sequence must be `X1, Y1, X2, Y2, X1, …`.
Nothing in the identity model knows that, which makes it a real test:

| | |
|---|---|
| Serve-rotation consistency | **0.941** (16 of 17 games) |
| Per set | 1.0, 1.0, 0.75, 1.0, 1.0 |
| Team pairing from court sides | `{P1,P3}` vs `{P2,P4}` |
| Team pairing from serve rotation | `{P1,P3}` vs `{P2,P4}` — **same** |
| Side consistency | 0.98 |
| Mean within-game server agreement | 0.94 |

Two independent routes to the same team pairing, and 16/17 games obeying a rule
the model was never told, is the strongest evidence available without hand
labels.

Score rotation **per set**, not across the match: teams may pick their serve
order afresh at a new set, and scoring globally reported 0.588 while set 1 was a
flawless 7-game alternation.

### The identities on the reference match

| | Kit | Partner |
|---|---|---|
| P1 | white shirt, dark shorts | P3 |
| P2 | dark green shirt | P4 |
| P3 | black "10" jersey | P1 |
| P4 | grey shirt, **orange shorts** | P2 |

`P1..P4` are arbitrary labels — pass `--labels` to `match_debug.py` to show
something human. **Quote `games[].server`, not the per-point name**: a game pools
~6 points and the rules fix the server within it.

Caveat: this keys on clothing. A kit change mid-match swaps an identity, and
`team_side_consistency` is the number that drops when that happens.

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
| When each point started/ended | done; exact count ±15 (see Stage 1b) |
| Strike count per point | done (audible strikes — a floor, not a total) |
| Which **end** served | done, 93% geometry agreement |
| Which **player** served | done — 0.941 rotation consistency |
| Who made the last contact | timestamp yes; player now reachable via strike parity |
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
