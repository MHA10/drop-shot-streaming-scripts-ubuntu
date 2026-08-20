#!/usr/bin/env python3
"""
match_points.py — split a full padel match into points, from the sound of the
ball, and report what happened in each one.

── IN SIMPLE WORDS ──
Padel is loud in a very specific way: a ball off a carbon paddle is a sharp
crack, and nothing else on a padel court sounds like it. This script listens to
the whole match, marks every one of those cracks, and groups them into rallies —
a burst of cracks is a point, and the quiet between bursts is the gap between
points. From that it can tell you when each point started and ended and how many
shots were in it, without anyone typing in a score.

It reads NO scoreboard. This stream does not have one, and even on streams that
do, an overlay can lag, drop out, or be missing entirely.

── BUSINESS RULES ──
- A point is a burst of >=`--min-strikes` ball strikes separated from its
  neighbours by at least `--point-gap` seconds of quiet.
- Warmup is excluded: play before the first long break is knock-up, not match
  play (decision 2026-08-20, from the Clash Of Champions final where rallies at
  3s and 15s were followed by a 53s gap before the match proper).
- Long quiet stretches (`--break-gap`) are treated as set breaks / changeovers
  and split the match into segments.
- Strike counts are of AUDIBLE strikes. Near-end shots are louder than far-end
  ones on these single-mic streams, so treat the count as a floor.

── WHY IT'S BUILT THIS WAY (change at your peril) ──
- **Detection is on a 2.5-9 kHz band, not the raw waveform.** Crowd noise,
  voices and the venue music all live mostly below ~2 kHz. Onset-detecting the
  broadband signal fires on every cheer.
- **The adaptive baseline is a rolling MEAN, not a median.** Positive spectral
  flux is zero in over half of all frames by construction, so a rolling median
  is ~0 and dividing by it sends the score to infinity everywhere. That bug
  reported 301 strikes in a 60-second window that contained about 40.
- **There is an ABSOLUTE energy gate as well as a relative one.** The venue
  plays music between points, and a hi-hat is a genuine sharp transient that a
  purely relative detector cannot distinguish from a ball strike. Measured on
  the reference match, music onsets sat at 0.02-0.18 band energy and real
  strikes at 0.3-2.5, so an absolute floor separates them where spectral shape
  (high/low ratio, attack sharpness) does not — both were tried and neither
  separated the two populations.
- **Events within `--merge` seconds collapse to the loudest.** A single strike
  produces several onset frames (the hit, its reverb off the glass, and the
  ball's floor bounce right after). Counting those separately triples the
  strike count and makes every rally look like a net exchange.
- **Audio is downmixed to mono deliberately.** These streams LOOK stereo — two
  channels, 44.1 kHz — but the channels are identical. Left/right balance
  measured exactly 0.00 at every strike in the reference match, so there is no
  lateral cue to recover and pretending otherwise just costs a second FFT.

── DO NOT ──
- Do NOT use the strike count, or a point's absence, as evidence about the
  score. Recall is not 1.0: points that end in two strikes (serve, then an
  error) fall below `--min-strikes` and are dropped on purpose, because a
  player bouncing the ball before serving produces the same one or two onsets.
  Precision is high; recall is not, and the two are not interchangeable.
- Do NOT infer who served from this file. It reports WHEN, not WHO. Serve
  attribution needs vision — on a single near-end mic the far team's serve is
  routinely too quiet to detect, which makes the first audible strike the
  near team's RETURN and the near player look like the server every time.
- Do NOT reuse `--abs-gate` across venues without checking it. It is an
  absolute level on a specific stream's mix; a quieter venue needs a lower one.
  Run with `--debug` and confirm the strike/music separation still holds.
"""

import argparse
import json
import subprocess
import sys

try:
    import numpy as np
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"match_points: dependencies unavailable: {exc}\n")
    sys.exit(2)

FFT_N, FFT_HOP = 1024, 256
STRIKE_BAND = (2500, 9000)


def read_band_energy(path, sr=44100, verbose=False):
    """
    Stream the audio through ffmpeg and return per-frame energy in the strike
    band, plus a low band for diagnostics.

    Streamed rather than decoded to a WAV on disk: the reference match is a
    414 MB WAV for 39 minutes of audio, and every future match would pay that
    again for no benefit.
    """
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1",
           "-ar", str(sr), "-f", "s16le", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    win = np.hanning(FFT_N).astype(np.float32)
    fr = np.fft.rfftfreq(FFT_N, 1.0 / sr)
    m_hi = (fr >= STRIKE_BAND[0]) & (fr < STRIKE_BAND[1])
    m_lo = (fr >= 80) & (fr < 800)
    hi, lo = [], []
    carry = np.zeros(0, np.float32)
    CHUNK = FFT_HOP * 4000
    while True:
        raw = proc.stdout.read(CHUNK * 2)
        if not raw:
            break
        a = np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0
        a = np.concatenate([carry, a])
        nf = 1 + (len(a) - FFT_N) // FFT_HOP if len(a) >= FFT_N else 0
        if nf <= 0:
            carry = a
            continue
        for i in range(nf):
            S = np.abs(np.fft.rfft(a[i*FFT_HOP:i*FFT_HOP+FFT_N] * win))
            hi.append(S[m_hi].mean())
            lo.append(S[m_lo].mean())
        carry = a[nf*FFT_HOP:]
        if verbose and len(hi) % 40000 < nf:
            sys.stderr.write(f"match_points: analysed {len(hi)*FFT_HOP/sr:.0f}s of audio\n")
    proc.stdout.close()
    proc.wait()
    if not hi:
        raise SystemExit("match_points: no audio decoded")
    return np.array(hi, np.float32), np.array(lo, np.float32), sr


def _rolling_mean(x, k):
    k = int(k) | 1
    c = np.cumsum(np.insert(np.pad(x, k // 2, mode="edge"), 0, 0.0))
    return (c[k:] - c[:-k]) / k


def detect_strikes(hi, sr, abs_gate, rel_gate, min_gap, merge):
    """Ball strikes as timestamps. See the module header for why each gate exists."""
    t = (np.arange(len(hi)) * FFT_HOP + FFT_N / 2) / sr
    flux = np.diff(hi, prepend=hi[0]).clip(min=0)
    baseline = _rolling_mean(flux, 2.0 * sr / FFT_HOP) + 0.05 * flux.mean() + 1e-9
    score = flux / baseline

    gap = max(1, int(min_gap * sr / FFT_HOP))
    idx = []
    for i in range(1, len(score) - 1):
        if score[i] < rel_gate or hi[i] < abs_gate:
            continue
        if score[i] < score[i - 1] or score[i] < score[i + 1]:
            continue
        if idx and i - idx[-1] < gap:
            if hi[i] > hi[idx[-1]]:
                idx[-1] = i
            continue
        idx.append(i)

    merged = []
    for i in idx:
        if merged and t[i] - t[merged[-1]] < merge:
            if hi[i] > hi[merged[-1]]:
                merged[-1] = i
            continue
        merged.append(i)
    merged = np.array(merged, int)
    return t[merged], hi[merged]


def segment_points(strikes, energies, point_gap, min_strikes, break_gap):
    """Group strikes into points, then split the match at long breaks."""
    if len(strikes) == 0:
        return [], []
    bursts = np.split(strikes, np.where(np.diff(strikes) > point_gap)[0] + 1)
    kept = [b for b in bursts if len(b) >= min_strikes]
    points = [{"start": float(b[0]), "end": float(b[-1]),
               "strikes": int(len(b)), "strike_times": [round(float(x), 3) for x in b]}
              for b in kept]

    # Segment boundaries: a long quiet stretch is a set break or changeover.
    breaks = []
    for a, b in zip(points, points[1:]):
        if b["start"] - a["end"] >= break_gap:
            breaks.append((a["end"], b["start"]))
    return points, breaks


def drop_warmup(points, breaks):
    """
    Everything before the first long break is knock-up.

    Warmup looks like match play to an audio detector — same strikes, same
    bursts — so it cannot be filtered on sound. What separates it is that a
    match starts after a pause: on the reference final, two rallies at 3s and
    15s were followed by 53 seconds of nothing before the first real point.
    """
    if not breaks:
        return points, []
    first_end = breaks[0][0]
    warm = [p for p in points if p["end"] <= first_end]
    # Only treat it as warmup if it is a short prelude, not a whole set.
    if len(warm) > max(4, 0.15 * len(points)):
        return points, []
    return [p for p in points if p["end"] > first_end], warm


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--input", required=True, help="match video (or audio) file")
    ap.add_argument("--output", required=True, help="JSON out")
    ap.add_argument("--csv", default="", help="also write a flat CSV")
    ap.add_argument("--abs-gate", type=float, default=0.20,
                    help="absolute strike-band energy floor; the music rejector")
    ap.add_argument("--rel-gate", type=float, default=6.0,
                    help="flux over local baseline")
    ap.add_argument("--min-gap", type=float, default=0.15,
                    help="closest two distinct strikes can be")
    ap.add_argument("--merge", type=float, default=0.28,
                    help="collapse hit+reverb+bounce into one strike")
    ap.add_argument("--point-gap", type=float, default=2.5,
                    help="quiet gap that ends a point")
    ap.add_argument("--min-strikes", type=int, default=3,
                    help="fewer than this is treated as a pre-serve bounce, not a point")
    ap.add_argument("--break-gap", type=float, default=45.0,
                    help="quiet gap treated as a set break / changeover")
    ap.add_argument("--keep-warmup", action="store_true")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    hi, lo, sr = read_band_energy(args.input, verbose=args.debug)
    dur = len(hi) * FFT_HOP / sr
    strikes, energies = detect_strikes(hi, sr, args.abs_gate, args.rel_gate,
                                       args.min_gap, args.merge)
    points, breaks = segment_points(strikes, energies, args.point_gap,
                                    args.min_strikes, args.break_gap)
    warm = []
    if not args.keep_warmup:
        points, warm = drop_warmup(points, breaks)

    for n, p in enumerate(points, 1):
        p["point"] = n
        p["duration"] = round(p["end"] - p["start"], 2)

    play = sum(p["end"] - p["start"] for p in points)
    payload = {
        "input": args.input,
        "duration": round(dur, 1),
        "points": points,
        "warmup_rallies": len(warm),
        "breaks": [{"from": round(a, 1), "to": round(b, 1), "seconds": round(b - a, 1)}
                   for a, b in breaks],
        "totals": {
            "points": len(points),
            "strikes": int(sum(p["strikes"] for p in points)),
            "play_seconds": round(play, 1),
            "play_fraction": round(play / dur, 3) if dur else 0.0,
        },
    }
    with open(args.output, "w") as fh:
        json.dump(payload, fh, indent=2)

    if args.csv:
        with open(args.csv, "w") as fh:
            fh.write("point,start_s,end_s,duration_s,strikes\n")
            for p in points:
                fh.write(f"{p['point']},{p['start']:.2f},{p['end']:.2f},"
                         f"{p['duration']:.2f},{p['strikes']}\n")

    if args.debug:
        d = np.array([p["strikes"] for p in points]) if points else np.array([0])
        sys.stderr.write(
            f"match_points: {len(points)} points over {dur/60:.1f} min "
            f"({len(warm)} warmup rallies dropped, {len(breaks)} long breaks)\n"
            f"match_points: strikes/point median={np.median(d):.0f} max={d.max()} "
            f"play={play/60:.1f}min ({play/dur*100:.0f}% of stream)\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"match_points: unexpected error: {exc}\n")
        sys.exit(1)
