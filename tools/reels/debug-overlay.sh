#!/usr/bin/env bash
# Render the tracking guides for a window, so you can SEE what the reframer is
# doing instead of trusting the crop.
#
# Produces a full-frame (uncropped) video annotated with:
#   green boxes  — each blob the detector accepted as a player
#   red dot      — the area-weighted crop centre it chose
#   yellow box   — the crop window that would become the reel
#   text         — "action center x=<px>" per frame
#
# Use it when a reel pans oddly, or to sanity-check a new camera angle before
# committing to a batch of reels.
#
# Usage:
#   bash tools/reels/debug-overlay.sh --input match.mp4 --moment 3509 --out guides.mp4
#   (same --pre/--post/--aspect defaults as make-reel.sh, so the crop window
#    drawn here is exactly the one that reel would use)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PY="$HERE/.venv/bin/python"

INPUT=""; MOMENT=""; OUT=""; ASPECT="4:5"; PRE=25; POST=5; STRIP=1
while [ $# -gt 0 ]; do
  case "$1" in
    --input) INPUT="$2"; shift 2 ;;
    --moment) MOMENT="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --aspect) ASPECT="$2"; shift 2 ;;
    --pre) PRE="$2"; shift 2 ;;
    --post) POST="$2"; shift 2 ;;
    --keep-bars) STRIP=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -n "$INPUT" ] && [ -n "$MOMENT" ] && [ -n "$OUT" ] || {
  echo "Usage: debug-overlay.sh --input FILE --moment SEC --out FILE" >&2; exit 2; }
[ -x "$PY" ] || { echo "venv missing — run: bash tools/reels/setup.sh" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/reeldbg.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
START=$(python3 -c "print(max(0, $MOMENT - $PRE))")
DUR=$(python3 -c "print($PRE + $POST)")
mkdir -p "$(dirname "$OUT")"

echo "── 1/4 cut ${DUR}s window at ${START}s ──"
ffmpeg -y -v error -i "$INPUT" -ss "$START" -t "$DUR" \
  -c:v libx264 -preset veryfast -an "$WORK/win.mp4"

SRCV="$WORK/win.mp4"
if [ "$STRIP" -eq 1 ]; then
  echo "── 2/4 strip letterbox bars ──"
  CROP="$(ffmpeg -hide_banner -ss 3 -t 4 -i "$WORK/win.mp4" -vf cropdetect=24:2:0 -f null - 2>&1 \
        | grep -o 'crop=[0-9:]*' | sort | uniq -c | sort -rn | head -1 | grep -o 'crop=.*' || true)"
  if [ -n "$CROP" ]; then
    echo "   $CROP"
    ffmpeg -y -v error -i "$WORK/win.mp4" -vf "$CROP" -c:v libx264 -preset veryfast -an "$WORK/clean.mp4"
    SRCV="$WORK/clean.mp4"
  else
    echo "   none found"
  fi
fi

echo "── 3/4 reframe with tracking overlay ──"
"$PY" "$REPO/scripts/reframe_ball.py" \
  --input "$SRCV" --output "$WORK/reframed.mp4" \
  --aspect "$ASPECT" --mode action --debug \
  --debug-overlay "$WORK/overlay_raw.mp4"

# cv2 writes mpeg4; transcode to h264 so it plays in browsers/QuickTime.
echo "── 4/4 transcode to h264 ──"
ffmpeg -y -v error -i "$WORK/overlay_raw.mp4" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -movflags +faststart "$OUT"

echo "── done: $OUT ──"
ffprobe -v error -show_entries stream=codec_name,width,height \
  -show_entries format=duration -of default=nw=1 "$OUT"
echo
echo "Reading it: sparse green boxes are NORMAL — MOG2 only fires on pixels that"
echo "CHANGED, so a player standing still vanishes from detection. The smooth pan"
echo "comes from the median+average+velocity-clamp smoothing, not from dense boxes."
