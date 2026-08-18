#!/usr/bin/env bash
# Render the A/B/C/D player-tracking overlay for a clip.
#
# Produces a full-frame video annotated with:
#   coloured box   — one per player, A amber / B teal / C magenta / D mint
#   letter chip    — the player's permanent tag, sized to the player
#   fading trail   — where that player has been over the last ~1.2s
#   dashed box     — the detector lost them this frame; position is a guess
#   corner radar   — top-down formation view, one dot per player
#
# Letters are handed out ONCE, by frame quadrant, at --lock-sec into the clip:
# top-left=A, top-right=B, bottom-left=C, bottom-right=D. After that the letter
# follows the person, not the corner.
#
# This is the ML sibling of debug-overlay.sh. That one shows what the *crop* is
# following (motion blobs, no identity); this one shows *who is who*.
#
# Usage:
#   # a clip that is already the window you want:
#   bash tools/reels/track-players.sh --input clip.mp4 --out tracked.mp4
#
#   # a moment inside a long recording (same --pre/--post as make-reel.sh):
#   bash tools/reels/track-players.sh --input match.mp4 --moment 3509 --out tracked.mp4
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PY="$HERE/.venv-track/bin/python"

INPUT=""; MOMENT=""; OUT=""; PRE=25; POST=5; STRIP=1
LOCK=2.0; RADAR="bottom-left"; MODEL="$HERE/models/yolo11s.pt"; EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --input) INPUT="$2"; shift 2 ;;
    --moment) MOMENT="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --pre) PRE="$2"; shift 2 ;;
    --post) POST="$2"; shift 2 ;;
    --lock-sec) LOCK="$2"; shift 2 ;;
    --radar) RADAR="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --keep-bars) STRIP=0; shift ;;
    --) shift; EXTRA=("$@"); break ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (pass tracker flags after --)" >&2; exit 2 ;;
  esac
done

[ -n "$INPUT" ] && [ -n "$OUT" ] || {
  echo "Usage: track-players.sh --input FILE --out FILE [--moment SEC]" >&2; exit 2; }
[ -x "$PY" ] || { echo "tracking venv missing — run: bash tools/reels/setup-tracking.sh" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/reeltrack.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$(dirname "$OUT")"

SRCV="$INPUT"
STEPS=3
if [ -n "$MOMENT" ]; then
  STEPS=4
  START=$(python3 -c "print(max(0, $MOMENT - $PRE))")
  DUR=$(python3 -c "print($PRE + $POST)")
  echo "── 1/$STEPS cut ${DUR}s window at ${START}s ──"
  ffmpeg -y -v error -i "$INPUT" -ss "$START" -t "$DUR" \
    -c:v libx264 -preset veryfast -an "$WORK/win.mp4"
  SRCV="$WORK/win.mp4"
fi

N=$((STEPS-2))
if [ "$STRIP" -eq 1 ]; then
  echo "── $N/$STEPS strip letterbox bars ──"
  # Bars must go before tracking, not after: the court finder fits the playing
  # surface, and a black band at the frame edge shifts the fitted near edge.
  CROP="$(ffmpeg -hide_banner -ss 3 -t 4 -i "$SRCV" -vf cropdetect=24:2:0 -f null - 2>&1 \
        | grep -o 'crop=[0-9:]*' | sort | uniq -c | sort -rn | head -1 | grep -o 'crop=.*' || true)"
  if [ -n "$CROP" ]; then
    echo "   $CROP"
    ffmpeg -y -v error -i "$SRCV" -vf "$CROP" -c:v libx264 -preset veryfast -an "$WORK/clean.mp4"
    SRCV="$WORK/clean.mp4"
  else
    echo "   none found"
  fi
fi

echo "── $((STEPS-1))/$STEPS detect + track + overlay ──"
"$PY" "$REPO/scripts/track_players.py" \
  --input "$SRCV" --output "$WORK/tracked_raw.mp4" \
  --model "$MODEL" --lock-sec "$LOCK" --radar "$RADAR" \
  --calib-debug "${OUT%.*}-calibration.png" --debug "${EXTRA[@]}"

# cv2 writes mpeg4; transcode to h264 so it plays in browsers/QuickTime.
echo "── $STEPS/$STEPS transcode to h264 ──"
ffmpeg -y -v error -i "$WORK/tracked_raw.mp4" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -movflags +faststart "$OUT"

echo "── done: $OUT ──"
ffprobe -v error -show_entries stream=codec_name,width,height \
  -show_entries format=duration -of default=nw=1 "$OUT"
echo
echo "Check ${OUT%.*}-calibration.png before trusting the radar: green = fitted"
echo "sidelines, red = the net, cyan = evenly-spaced depth lines. If the green"
echo "lines do not sit on the real court edges, the radar is wrong."
