#!/usr/bin/env bash
# One-time setup for the A/B/C/D player tracker (track-players.sh).
#
# This is SEPARATE from setup.sh on purpose. The reel toolkit's venv is ~80 MB
# (opencv + yt-dlp); this one pulls torch + ultralytics and lands around 2 GB.
# Nobody making a marketing reel should have to download that, so the tracker
# gets its own venv and the two never interfere.
#
# Usage: bash tools/reels/setup-tracking.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HERE/.venv-track"
MODELS="$HERE/models"

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
echo "── installing torch + ultralytics + opencv (~2 GB, takes a few minutes) ──"
"$VENV/bin/pip" install --quiet torch torchvision ultralytics opencv-python-headless numpy

echo "── fetching detector weights ──"
mkdir -p "$MODELS"
# Downloaded here rather than left to ultralytics' implicit cwd download, which
# drops a .pt file wherever the tool happens to be run from.
( cd "$MODELS" && "$VENV/bin/python" -c "
from ultralytics import YOLO
YOLO('yolo11s.pt')
print('  yolo11s.pt ready')
" )

echo "── verifying ──"
"$VENV/bin/python" -c "
import torch, ultralytics, cv2
print(f'  torch {torch.__version__}, ultralytics {ultralytics.__version__}, opencv {cv2.__version__}')
print('  mps' if torch.backends.mps.is_available() else ('  cuda' if torch.cuda.is_available() else '  cpu only'))
"
echo
echo "Setup complete. Next:"
echo "  bash tools/reels/track-players.sh --input clip.mp4 --out tracked.mp4"
