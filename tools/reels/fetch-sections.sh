#!/usr/bin/env bash
# Download ONLY the candidate 30s sections of a YouTube VOD, then rank them by
# motion energy. Second half of the remote workflow (see score-audio.py).
#
# ── WHY ──
# A 2-hour 1080p stream is ~2 GB. Each 30s section is ~5-10 MB. Fetching six
# sections instead of the whole VOD is roughly a 40x saving, and the winning
# section is already on disk ready to feed straight into make-reel.sh.
#
# Usage:
#   bash tools/reels/fetch-sections.sh <youtube-url> <outdir> <start1> [start2 ...]
#
# Then render the winner (the section file IS the window, so --moment 25):
#   bash tools/reels/make-reel.sh --input <outdir>/sec_<start>.mp4 \
#        --moment 25 --out reel.mp4
set -euo pipefail

[ $# -ge 3 ] || { echo "Usage: fetch-sections.sh <url> <outdir> <start1> [start2 ...]" >&2; exit 2; }

URL="$1"; OUT="$2"; shift 2
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YTDLP="$HERE/.venv/bin/yt-dlp"
PY="$HERE/.venv/bin/python"
[ -x "$YTDLP" ] || { echo "venv missing — run: bash tools/reels/setup.sh" >&2; exit 1; }
mkdir -p "$OUT"

for S in "$@"; do
  E=$((S + 30))
  F="$OUT/sec_$S.mp4"
  if [ -f "$F" ]; then
    echo "── ${S}s already fetched ──"
    continue
  fi
  echo "── fetching ${S}-${E}s ──"
  "$YTDLP" --no-warnings -q \
    -f "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]" \
    --merge-output-format mp4 \
    --download-sections "*${S}-${E}" \
    -o "$F" "$URL" || echo "   ! fetch failed for ${S}s (skipping)"
done

echo
echo "── motion energy per candidate (higher = more sustained play) ──"
for S in "$@"; do
  F="$OUT/sec_$S.mp4"
  [ -f "$F" ] || continue
  M=$(ffmpeg -v error -i "$F" -vf "fps=8,scale=160:90,format=gray" -f rawvideo - 2>/dev/null \
      | "$PY" -c "
import sys, numpy as np
a = np.frombuffer(sys.stdin.buffer.read(), dtype=np.uint8)
w, h = 160, 90
n = len(a) // (w * h)
if n < 2:
    print('0.00')
else:
    f = a[:n*w*h].reshape(n, h*w).astype(np.int16)
    print(f'{np.abs(np.diff(f, axis=0)).mean():.2f}')
")
  printf "  start=%-7s motion=%-7s file=%s\n" "$S" "$M" "$F"
done
echo
echo "Pick the highest motion, then:"
echo "  bash tools/reels/make-reel.sh --input $OUT/sec_<start>.mp4 --moment 25 --out reel.mp4"
