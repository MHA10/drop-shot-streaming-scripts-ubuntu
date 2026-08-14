#!/usr/bin/env bash
# One-time setup for the marketing reel toolkit.
#
# Creates a self-contained Python venv in tools/reels/.venv with the two things
# the toolkit needs beyond ffmpeg:
#   opencv-python-headless + numpy  → the player-tracking reframe
#   yt-dlp                          → pulling source footage from YouTube
#
# The venv is local to this folder and gitignored, so it never touches the
# system Python or the streamer runtime.
#
# Usage: bash tools/reels/setup.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HERE/.venv"

echo "── checking prerequisites ──"
missing=0
for c in ffmpeg ffprobe python3; do
  if command -v "$c" >/dev/null 2>&1; then
    printf "  %-9s ok\n" "$c"
  else
    printf "  %-9s MISSING\n" "$c"; missing=1
  fi
done
if [ "$missing" -eq 1 ]; then
  echo
  echo "Install the missing tools first:"
  echo "  macOS:  brew install ffmpeg python"
  echo "  Ubuntu: sudo apt-get install -y ffmpeg python3 python3-venv"
  exit 1
fi

echo "── creating venv at $VENV ──"
python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
echo "── installing yt-dlp, opencv-python-headless, numpy (~80 MB) ──"
"$VENV/bin/pip" install --quiet yt-dlp opencv-python-headless numpy

echo "── verifying ──"
"$VENV/bin/python" -c "import cv2, numpy; print(f'  opencv {cv2.__version__}, numpy {numpy.__version__}')"
echo "  yt-dlp $("$VENV/bin/yt-dlp" --version)"
echo
echo "Setup complete. Next: see tools/reels/README.md"
