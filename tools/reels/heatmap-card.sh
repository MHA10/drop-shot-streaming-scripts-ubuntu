#!/usr/bin/env bash
# Build the 9:16 player-heatmap share card from a clip.
#
# Runs the whole chain: cut → strip bars → detect+track A/B/C/D → composite.
# Produces THREE files (the tracking overlay comes free — the detection pass
# that feeds the heatmap has already paid for it):
#
#   <out>.mp4                  the 1080x1920 card, heat building as the clip plays
#   <out>-poster.png           the final frame, for a static post
#   <out>-overlay.mp4          the full-frame A/B/C/D tracking overlay
#   <out>-calibration.png      the court fit — check this before trusting anything
#
# Usage:
#   bash tools/reels/heatmap-card.sh --input clip.mp4 --out local-reels/card.mp4
#
#   bash tools/reels/heatmap-card.sh --input match.mp4 --moment 3509 \
#     --out local-reels/card.mp4 --title "SET 1" \
#     --names "A=DI NENNO,B=LEBRON,C=TAPIA,D=COELLO"
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PY="$HERE/.venv-track/bin/python"

INPUT=""; MOMENT=""; OUT=""; PRE=25; POST=5; STRIP=1
LOCK=2.0; TITLE=""; NAMES=""; LOGO="$REPO/public/ds.png"
MODEL="$HERE/models/yolo11s.pt"; STATIC=0
while [ $# -gt 0 ]; do
  case "$1" in
    --input) INPUT="$2"; shift 2 ;;
    --moment) MOMENT="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --pre) PRE="$2"; shift 2 ;;
    --post) POST="$2"; shift 2 ;;
    --lock-sec) LOCK="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    --names) NAMES="$2"; shift 2 ;;
    --logo) LOGO="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --static) STATIC=1; shift ;;
    --keep-bars) STRIP=0; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -n "$INPUT" ] && [ -n "$OUT" ] || {
  echo "Usage: heatmap-card.sh --input FILE --out FILE [--moment SEC]" >&2; exit 2; }
[ -x "$PY" ] || { echo "tracking venv missing — run: bash tools/reels/setup-tracking.sh" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/reelheat.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$(dirname "$OUT")"
STEM="${OUT%.*}"

SRCV="$INPUT"
if [ -n "$MOMENT" ]; then
  START=$(python3 -c "print(max(0, $MOMENT - $PRE))")
  DUR=$(python3 -c "print($PRE + $POST)")
  echo "── 1/4 cut ${DUR}s window at ${START}s ──"
  ffmpeg -y -v error -i "$INPUT" -ss "$START" -t "$DUR" \
    -c:v libx264 -preset veryfast -an "$WORK/win.mp4"
  SRCV="$WORK/win.mp4"
fi

if [ "$STRIP" -eq 1 ]; then
  echo "── 2/4 strip letterbox bars ──"
  # Before tracking, not after: the court fit keys off the playing surface, and
  # a black band at the frame edge drags the fitted near edge with it.
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

echo "── 3/4 detect + track A/B/C/D ──"
"$PY" "$REPO/scripts/track_players.py" \
  --input "$SRCV" --output "$WORK/overlay.mp4" \
  --model "$MODEL" --lock-sec "$LOCK" \
  --dump-tracks "$WORK/tracks.json" \
  --calib-debug "${STEM}-calibration.png" --debug
ffmpeg -y -v error -i "$WORK/overlay.mp4" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -movflags +faststart \
  "${STEM}-overlay.mp4"

echo "── 4/4 composite the heatmap card ──"
ARGS=(--tracks "$WORK/tracks.json" --output "$WORK/card.mp4"
      --poster "${STEM}-poster.png" --logo "$LOGO" --debug)
[ -n "$TITLE" ] && ARGS+=(--title "$TITLE")
[ -n "$NAMES" ] && ARGS+=(--names "$NAMES")
[ "$STATIC" -eq 1 ] && ARGS+=(--static)
"$PY" "$REPO/scripts/player_heatmap.py" "${ARGS[@]}"

if [ "$STATIC" -eq 0 ]; then
  ffmpeg -y -v error -i "$WORK/card.mp4" \
    -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -movflags +faststart "$OUT"
  echo "── done ──"
  ffprobe -v error -show_entries stream=codec_name,width,height \
    -show_entries format=duration -of default=nw=1 "$OUT"
else
  echo "── done (poster only) ──"
fi
echo
echo "  card     ${OUT}"
echo "  poster   ${STEM}-poster.png"
echo "  overlay  ${STEM}-overlay.mp4"
echo "  calib    ${STEM}-calibration.png   <- check this first"
