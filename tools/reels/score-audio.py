#!/usr/bin/env python3
"""
Rank windows by AUDIO energy alone — the first half of the remote workflow.

── WHY THIS EXISTS ──
A 2-hour 1080p VOD is ~2 GB. Downloading it whole just to find 30 good seconds
is wasteful. The audio track is ~100 MB, so: score the audio first, then fetch
ONLY the top candidate sections (fetch-sections.sh) for the motion check.

Usage:  score-audio.py <audio-or-video-file> [window_sec] [topN]
Output: one "<start_sec> <score>" line per candidate, best first
        (stdout is machine-readable so it can pipe into fetch-sections.sh)
"""
import subprocess, sys, wave, numpy as np

SRC = sys.argv[1]
WIN = int(sys.argv[2]) if len(sys.argv) > 2 else 30
TOPN = int(sys.argv[3]) if len(sys.argv) > 3 else 6

wav = "/tmp/score-audio.wav"
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", SRC,
                "-vn", "-ac", "1", "-ar", "8000", wav], check=True)
with wave.open(wav) as w:
    sr = w.getframerate()
    pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)

secs = len(pcm) // sr
if secs <= WIN:
    sys.exit(f"track is only {secs}s — need more than the {WIN}s window")
pcm = pcm[: secs * sr].reshape(secs, sr)
rms = np.sqrt((pcm ** 2).mean(axis=1)) + 1e-6
win = np.convolve(rms, np.ones(WIN) / WIN, mode="valid")

# Diagnostics to stderr so stdout stays pipeable.
print(f"# duration {secs}s  rms median={np.median(rms):.0f} max={rms.max():.0f}",
      file=sys.stderr)

picked = []
for s in np.argsort(win)[::-1]:
    s = int(s)
    if all(abs(s - p) >= WIN for p in picked):
        picked.append(s)
    if len(picked) >= TOPN:
        break

for s in picked:
    print(f"{s} {win[s]:.0f}")
