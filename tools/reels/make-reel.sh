#!/usr/bin/env bash
# Build a social-ready highlight reel from match footage.
#
# ── IN SIMPLE WORDS ──
# Give it a video and the second where something good happened. It cuts the 30s
# around that moment, crops it to a vertical shape that follows the players,
# stamps the two logos on, keeps the sound, and writes an upload-ready MP4.
#
# ── PIPELINE (mirrors the streamer's production reel path, plus 3 extras) ──
#   1. cut window        [moment-pre, moment+post]      (production: from buffer)
#   2. strip letterbox   auto-detect black bars          ← EXTRA (local sources)
#   3. reframe           scripts/reframe_ball.py         (production: identical)
#   4. scale + logos     to delivery size                (production: no scale)
#   5. mux audio         from the source window          ← EXTRA (production is silent)
#
# Steps 2 and 5 exist because marketing sources are recordings (often
# letterboxed, and we want their sound). The streamer's own reels have neither:
# its buffer is recorded with -an, and its camera feed fills the frame.
#
# Usage:
#   bash tools/reels/make-reel.sh --input match.mp4 --moment 3509 --out reel.mp4
#
# Options:
#   --input FILE      source video                                  [required]
#   --moment SEC      the highlight second within the source         [required]
#   --out FILE        output path                                    [required]
#   --aspect W:H      crop aspect                                    [4:5]
#   --pre SEC         seconds kept before the moment                 [25]
#   --post SEC        seconds kept after the moment                  [5]
#   --width PX        output width (height follows the aspect)       [1080]
#   --logo FILE       ground/client logo   [<repo>/public/client.png]
#   --ds-logo FILE    DropShot logo        [<repo>/public/ds.png]
#   --no-track        skip tracking; full-frame reel (no crop)
#   --no-audio        don't mux audio
#   --keep-bars       don't auto-strip letterbox bars
#   --keep-temp       leave intermediates in the work dir
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
VENV="$HERE/.venv"
PY="$VENV/bin/python"

INPUT=""; MOMENT=""; OUT=""
ASPECT="4:5"; PRE=25; POST=5; WIDTH=1080
LOGO="$REPO/public/client.png"; DSLOGO="$REPO/public/ds.png"
TRACK=1; AUDIO=1; STRIP=1; KEEPTMP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --input) INPUT="$2"; shift 2 ;;
    --moment) MOMENT="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --aspect) ASPECT="$2"; shift 2 ;;
    --pre) PRE="$2"; shift 2 ;;
    --post) POST="$2"; shift 2 ;;
    --width) WIDTH="$2"; shift 2 ;;
    --logo) LOGO="$2"; shift 2 ;;
    --ds-logo) DSLOGO="$2"; shift 2 ;;
    --no-track) TRACK=0; shift ;;
    --no-audio) AUDIO=0; shift ;;
    --keep-bars) STRIP=0; shift ;;
    --keep-temp) KEEPTMP=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -n "$INPUT" ] && [ -n "$MOMENT" ] && [ -n "$OUT" ] || {
  echo "Usage: make-reel.sh --input FILE --moment SEC --out FILE   (see --help)" >&2; exit 2; }
[ -f "$INPUT" ] || { echo "input not found: $INPUT" >&2; exit 1; }
[ -x "$PY" ] || { echo "venv missing — run: bash tools/reels/setup.sh" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/reel.XXXXXX")"
cleanup() { [ "$KEEPTMP" -eq 1 ] && echo "temp kept: $WORK" || rm -rf "$WORK"; }
trap cleanup EXIT

START=$(python3 -c "print(max(0, $MOMENT - $PRE))")
DUR=$(python3 -c "print($PRE + $POST)")
mkdir -p "$(dirname "$OUT")"

echo "── 1/5 cut ${DUR}s window at ${START}s ──"
ffmpeg -y -v error -i "$INPUT" -ss "$START" -t "$DUR" \
  -c:v libx264 -preset veryfast -c:a aac -b:a 128k "$WORK/window.mp4"

SRCV="$WORK/window.mp4"
if [ "$STRIP" -eq 1 ]; then
  echo "── 2/5 detect letterbox bars ──"
  # cropdetect prints nothing when there are no bars; never let that abort us.
  CROP="$(ffmpeg -hide_banner -ss 3 -t 4 -i "$WORK/window.mp4" -vf cropdetect=24:2:0 -f null - 2>&1 \
        | grep -o 'crop=[0-9:]*' | sort | uniq -c | sort -rn | head -1 | grep -o 'crop=.*' || true)"
  FULL="crop=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$WORK/window.mp4" | tr ',' ':'):0:0"
  if [ -n "$CROP" ] && [ "$CROP" != "$FULL" ]; then
    echo "   $CROP  (stripping)"
    ffmpeg -y -v error -i "$WORK/window.mp4" -vf "$CROP" \
      -c:v libx264 -preset veryfast -c:a copy "$WORK/clean.mp4"
    SRCV="$WORK/clean.mp4"
  else
    echo "   none found — using full frame"
  fi
else
  echo "── 2/5 bar strip disabled (--keep-bars) ──"
fi

if [ "$TRACK" -eq 1 ]; then
  echo "── 3/5 reframe to $ASPECT (player tracking) ──"
  "$PY" "$REPO/scripts/reframe_ball.py" \
    --input "$SRCV" --output "$WORK/reframed.mp4" \
    --aspect "$ASPECT" --mode action --debug
  VID="$WORK/reframed.mp4"
else
  echo "── 3/5 tracking disabled (--no-track) — full frame ──"
  VID="$SRCV"
fi

CW=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$VID")
CH=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$VID")
OW=$WIDTH
OH=$(python3 -c "print(int(round($WIDTH * $CH / $CW / 2) * 2))")
echo "── 4/5 scale ${CW}x${CH} → ${OW}x${OH} + logos ──"

# Logo box + inset as a fraction of the output canvas, so branding scales with
# any aspect. Client logo top-right, DropShot bottom-right (matches the stream).
BW=$(python3 -c "print(round($OW*0.34))"); BH=$(python3 -c "print(round($OH*0.12))")
IX=$(python3 -c "print(round($OW*0.03))"); IY=$(python3 -c "print(round($OH*0.03))")

FC="[0:v] scale=$OW:$OH [base]"
MAPIN=(-i "$VID"); n=1; last="base"
if [ -f "$DSLOGO" ]; then
  MAPIN+=(-i "$DSLOGO")
  FC="$FC; [$n:v] scale=$BW:$BH:force_original_aspect_ratio=decrease [ds]; [$last][ds] overlay=main_w-overlay_w-$IX:main_h-overlay_h-$IY [v$n]"
  last="v$n"; n=$((n+1))
else echo "   ! DropShot logo missing: $DSLOGO"; fi
if [ -f "$LOGO" ]; then
  MAPIN+=(-i "$LOGO")
  FC="$FC; [$n:v] scale=$BW:$BH:force_original_aspect_ratio=decrease [cl]; [$last][cl] overlay=main_w-overlay_w-$IX:$IY [v$n]"
  last="v$n"; n=$((n+1))
else echo "   ! ground logo missing: $LOGO"; fi

ffmpeg -y -v error "${MAPIN[@]}" -filter_complex "$FC" -map "[$last]" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -movflags +faststart -an \
  "$WORK/branded.mp4"

echo "── 5/5 audio ──"
if [ "$AUDIO" -eq 1 ] && ffprobe -v error -select_streams a -show_entries stream=index \
     -of csv=p=0 "$WORK/window.mp4" 2>/dev/null | grep -q .; then
  ffmpeg -y -v error -i "$WORK/branded.mp4" -i "$WORK/window.mp4" \
    -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 128k -shortest \
    -movflags +faststart "$OUT"
  echo "   muxed from source"
else
  cp "$WORK/branded.mp4" "$OUT"
  [ "$AUDIO" -eq 1 ] && echo "   source has no audio track — video only" || echo "   skipped (--no-audio)"
fi

echo "── done: $OUT ──"
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height \
  -show_entries format=duration,size -of default=nw=1 "$OUT"
BARS="$(ffmpeg -hide_banner -ss 5 -t 3 -i "$OUT" -vf cropdetect=24:2:0 -f null - 2>&1 \
      | grep -o 'crop=[0-9:]*' | sort | uniq -c | sort -rn | head -1 | grep -o 'crop=.*' || true)"
if [ "$BARS" = "crop=${OW}:${OH}:0:0" ] || [ -z "$BARS" ]; then
  echo "letterbox check: clean (${BARS:-n/a})"
else
  echo "letterbox check: ${BARS} — expected crop=${OW}:${OH}:0:0"
  echo "  A small difference is usually dark PICTURE at a frame edge (night footage,"
  echo "  shadowed court), not a bar — check a frame before worrying:"
  echo "    ffmpeg -ss 15 -i '$OUT' -frames:v 1 /tmp/check.jpg"
  echo "  A large difference means the source had bars this pass didn't catch, e.g."
  echo "  because a logo or scoreboard sits inside the bar region. Try --keep-bars"
  echo "  and crop manually, or pick a window without the overlay."
fi
