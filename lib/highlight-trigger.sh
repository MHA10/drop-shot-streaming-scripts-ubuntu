#!/usr/bin/env bash
#
# highlight-trigger.sh — manually fire a highlight on this streamer box.
#
# ── IN SIMPLE WORDS ──
# On staging (and any box without the ESP32 button wired up yet) there is no
# physical button to press, so we can't test reel generation the normal way.
# The app already watches a "trigger file": the moment that file appears on
# disk it behaves exactly as if the button was pressed — it cuts the last ~30s
# out of the rolling buffer and builds a reel. This script just creates that
# file (and first checks the box is actually configured to watch for it), so an
# operator can trigger a reel with one command instead of remembering the path.
#
# ── WHY IT'S BUILT THIS WAY ──
# It reads HIGHLIGHT_* straight from the box's .env (the single source of truth
# the running app was started with) rather than taking the path as an argument,
# so it can't touch a file the app isn't watching. It parses .env by grep — it
# does NOT `source` it — so a stray command or quoting in .env can't execute.
#
# ── DO NOT ──
# - Do NOT hardcode a trigger path here; always read it from .env so this
#   tracks whatever the running process was configured with.
# - This is an operator/test convenience for the trigger-file mechanism, NOT the
#   production path — real highlights come from the ESP32 over serial.
#
# Usage:  bash lib/highlight-trigger.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${HIGHLIGHT_ENV_FILE:-$REPO_DIR/.env}"

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[0;33m%s\033[0m\n' "$*"; }

# Read an UNCOMMENTED `KEY=value` from .env: last assignment wins, an inline
# `# comment` is stripped, surrounding whitespace trimmed. Empty if unset.
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  # `|| true`: a missing key makes grep exit 1, which under `set -o pipefail`
  # would otherwise abort the whole script before we can print guidance.
  local val
  val="$(grep -E "^[[:space:]]*$1[[:space:]]*=" "$ENV_FILE" 2>/dev/null \
    | tail -n1 \
    | sed -E "s/^[[:space:]]*$1[[:space:]]*=//; s/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//")" || true
  printf '%s' "$val"
}

if [ ! -f "$ENV_FILE" ]; then
  red "No .env found at $ENV_FILE"
  echo "Set HIGHLIGHT_ENV_FILE=/path/to/.env if it lives elsewhere."
  exit 1
fi

ENABLED="$(env_get HIGHLIGHT_ENABLED)"
TRIGGER_FILE="$(env_get HIGHLIGHT_TRIGGER_FILE)"
OUTPUT_DIR="$(env_get HIGHLIGHT_OUTPUT_DIR)"
GROUND_ID="$(env_get DROPSHOT_GROUND_ID)"
: "${OUTPUT_DIR:=./highlights}"

if [ "$ENABLED" != "true" ]; then
  red "HIGHLIGHT_ENABLED is not 'true' in $ENV_FILE"
  echo "Enable it (and, on a box with no ESP32, HIGHLIGHT_FORCE_PRESENT=true so"
  echo "the buffer actually records), then restart the streamer:"
  echo "    pm2 restart streamer-${GROUND_ID:-<ground-id>}"
  exit 1
fi

if [ -z "$TRIGGER_FILE" ]; then
  red "HIGHLIGHT_TRIGGER_FILE is not set in $ENV_FILE"
  echo "The app only watches for a trigger file when this is set. Add e.g.:"
  echo "    HIGHLIGHT_TRIGGER_FILE=/tmp/hl-trigger"
  echo "then restart:  pm2 restart streamer-${GROUND_ID:-<ground-id>}"
  exit 1
fi

if [ -e "$TRIGGER_FILE" ]; then
  yellow "Trigger file already exists ($TRIGGER_FILE) — a highlight may be"
  yellow "pending. The app removes it within ~1s of firing; if it lingers, the"
  yellow "streamer may not be running. Check:  pm2 status"
fi

mkdir -p "$(dirname "$TRIGGER_FILE")" 2>/dev/null || true
: > "$TRIGGER_FILE"
green "Highlight triggered → touched $TRIGGER_FILE"
echo
echo "The streamer should now cut the last ~30s from the buffer and build a reel."
echo "  Reel output : $OUTPUT_DIR/${GROUND_ID:-<court>}/  (relative paths are to the streamer's working dir)"
echo "  Watch logs  : pm2 logs streamer-${GROUND_ID:-<ground-id>} | grep -i highlight"
echo
echo "Expect these log lines in order:"
echo "  'Highlight signal received (manual trigger file)'  (trigger seen)"
echo "  'Highlight capture starting'                       (window being cut)"
echo "  'Highlight reel rendered'                          (logos added; if branding on)"
echo "  'Highlight captured' with finalPath=...            (done — that's your reel)"
