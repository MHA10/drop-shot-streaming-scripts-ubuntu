#!/usr/bin/env python3
"""
Find the best rally windows in a LOCAL match recording.

── IN SIMPLE WORDS ──
Watching a 2-hour match to find a good 30 seconds is the slow part of making a
reel. This scores the whole recording automatically and hands you a shortlist.

── HOW IT SCORES ──
  audio  — per-second RMS over the whole file. Rallies are dense ball-hit
           transients plus player calls, and good points end in a reaction.
           Cheap: audio-only decode.
  motion — mean absolute frame difference on a tiny greyscale decode, computed
           ONLY for the top audio candidates (video decode is the expensive
           part). This is the better proxy for "a real rally", so it is
           weighted higher.

Combined 60% motion / 40% audio. That weighting matters: the loudest window in
a match is often a break with music or talking — loud but static. Motion
demotes it.

Usage:  find-rally.py <video> [window_sec] [topN]
Output: ranked shortlist + BEST_MOMENT to feed straight into make-reel.sh
"""
import subprocess, sys, wave, numpy as np

SRC = sys.argv[1]
WIN = int(sys.argv[2]) if len(sys.argv) > 2 else 30
TOPN = int(sys.argv[3]) if len(sys.argv) > 3 else 8

# ── 1. whole-file audio energy, one value per second ──
wav = "/tmp/find-rally-audio.wav"
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", SRC,
                "-vn", "-ac", "1", "-ar", "8000", wav], check=True)
with wave.open(wav) as w:
    sr = w.getframerate()
    pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)

secs = len(pcm) // sr
if secs <= WIN:
    sys.exit(f"video is only {secs}s — need more than the {WIN}s window")
pcm = pcm[: secs * sr].reshape(secs, sr)
rms = np.sqrt((pcm ** 2).mean(axis=1)) + 1e-6
print(f"duration {secs}s   audio rms: median={np.median(rms):.0f} max={rms.max():.0f}")

audio_win = np.convolve(rms, np.ones(WIN) / WIN, mode="valid")  # index = start sec

# Keep candidates at least one window apart so we don't return neighbours.
picked = []
for s in np.argsort(audio_win)[::-1]:
    s = int(s)
    if all(abs(s - p) >= WIN for p in picked):
        picked.append(s)
    if len(picked) >= TOPN:
        break


# ── 2. motion energy, only for those candidates ──
def motion(start, dur=WIN, w=160, h=90):
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(start), "-t", str(dur), "-i", SRC,
         "-vf", f"fps=8,scale={w}:{h},format=gray", "-f", "rawvideo", "-"],
        capture_output=True, check=True)
    a = np.frombuffer(p.stdout, dtype=np.uint8)
    n = len(a) // (w * h)
    if n < 2:
        return 0.0
    f = a[: n * w * h].reshape(n, h * w).astype(np.int16)
    return float(np.abs(np.diff(f, axis=0)).mean())


rows = []
for s in picked:
    m = motion(s)
    rows.append((s, float(audio_win[s]), m))
    print(f"  cand start={s:5d}s  audio={rows[-1][1]:7.0f}  motion={m:6.2f}", flush=True)

A = np.array([r[1] for r in rows])
M = np.array([r[2] for r in rows])
# np.ptp(x), not x.ptp() — the method was removed in NumPy 2.x.
An = (A - A.min()) / (np.ptp(A) + 1e-9)
Mn = (M - M.min()) / (np.ptp(M) + 1e-9)
score = 0.4 * An + 0.6 * Mn

print("\n── ranked (0.6*motion + 0.4*audio) ──")
for i in np.argsort(score)[::-1]:
    s, a, m = rows[i]
    print(f"  start={s:5d}s  end={s+WIN:5d}s  score={score[i]:.3f}  audio={a:7.0f}  motion={m:6.2f}")

best = rows[int(np.argmax(score))][0]
print(f"\nBEST_START={best}")
print(f"BEST_MOMENT={best + 25}   # feed to: make-reel.sh --moment {best + 25}")
print("(BEST_MOMENT assumes the default --pre 25; the window is [start, start+30])")
