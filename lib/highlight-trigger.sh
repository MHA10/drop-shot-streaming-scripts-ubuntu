#!/usr/bin/env bash
#
# highlight-trigger.sh — fire a highlight on this streamer box without the button,
# then watch it through to the reel and report what happened.
#
# ── IN SIMPLE WORDS ──
# Normally a reel is made when someone presses the physical button on the court's
# ESP32. On staging (or any box where the hardware isn't wired up, or when you
# just don't want to walk to the court) there's no button to press. The app also
# watches a "trigger file": the instant that file appears on disk it behaves
# EXACTLY as if the button was pressed. This script creates that file, follows
# the logs, and prints a verdict — clip length, reel dimensions, YouTube link —
# so one command replaces "trigger, then squint at pm2 logs for two minutes".
#
# ── BUSINESS RULES ──
# - The trigger file path and every HIGHLIGHT_* setting are read from the box's
#   .env, the same source the running app was started with. Never take them as
#   arguments: that would let you trigger a path the app isn't watching and sit
#   there wondering why nothing happened.
# - The app deletes the trigger file within ~1s of firing. A file that lingers
#   means the streamer isn't running or isn't watching — reported, not ignored.
#
# ── WHY IT'S BUILT THIS WAY (change at your peril) ──
# - .env is parsed with grep, never `source`d. Sourcing executes whatever is in
#   the file; a stray backtick in a config value would run as root-ish on a
#   production box.
# - The log follower starts BEFORE the trigger is written. Reversed, the reel
#   can finish before pm2 attaches and the run reports a false timeout — the
#   pipeline is fast when the buffer is warm.
# - The pm2 app name is DISCOVERED, not assumed. It differs per box
#   (dropshot-staging here, streamer-<ground-id> elsewhere); a hardcoded name
#   sends the operator to an empty log and looks like a hung pipeline.
#
# ── DO NOT ──
# - Do NOT treat this as the production path. Real highlights come from the
#   ESP32 over serial; this exercises the same capture pipeline behind it, but
#   it does NOT test the serial listener, court filtering, or the button itself.
# - Do NOT add anything here that writes to the app's state, buffer, or output
#   dirs. This script only creates one trigger file and reads logs.
#
# Usage:
#   bash lib/highlight-trigger.sh              # trigger + follow + verdict
#   bash lib/highlight-trigger.sh --no-follow  # just trigger, return immediately
#   bash lib/highlight-trigger.sh --diag       # probe buffer timing, no trigger
#   bash lib/highlight-trigger.sh --timeout 300
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${HIGHLIGHT_ENV_FILE:-$REPO_DIR/.env}"

FOLLOW=1
DIAG=0
TIMEOUT=240
while [ $# -gt 0 ]; do
  case "$1" in
    --no-follow) FOLLOW=0 ;;
    --diag)      DIAG=1 ;;
    --timeout)   TIMEOUT="${2:-240}"; shift ;;
    -h|--help)   sed -n '40,46p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[0;33m%s\033[0m\n' "$*"; }
dim()   { printf '\033[0;90m%s\033[0m\n' "$*"; }

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

# The pm2 app name varies per box, so ask pm2 rather than guessing. node is a
# hard dependency of this repo, so it's always available to parse pm2's JSON.
detect_pm2_app() {
  [ -n "${PM2_APP:-}" ] && { printf '%s' "$PM2_APP"; return; }
  command -v pm2 >/dev/null 2>&1 || return 0
  pm2 jlist 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const apps = JSON.parse(s);
        const hit = apps.find(a => /dropshot|streamer/i.test(a.name)) || apps[0];
        if (hit) process.stdout.write(hit.name);
      } catch { /* pm2 absent or not JSON — caller handles the empty result */ }
    });
  ' 2>/dev/null
}

# ── --diag: why is the reel shorter than the window? ─────────────────────────
# Compares each buffer segment's MEDIA duration against the WALL-CLOCK gap
# between segment starts (the epoch in the filename). They should match. When
# media is much smaller, frames are being stamped closer together than they
# were captured, and every reel plays back sped up.
if [ "$DIAG" = "1" ]; then
  BUF_DIR="$(env_get HIGHLIGHT_BUFFER_DIR)"
  # Must match Config.ts's default for HIGHLIGHT_BUFFER_DIR, or --diag probes an
  # empty directory on a box that never set the key and reports a false "no data".
  : "${BUF_DIR:=./highlight-buffer}"
  command -v ffprobe >/dev/null 2>&1 || { red "ffprobe not installed"; exit 1; }

  mapfile -t SEGS < <(ls -1 "$BUF_DIR"/*/seg-*.ts 2>/dev/null | sort | tail -12)
  if [ "${#SEGS[@]}" -lt 3 ]; then
    red "Not enough segments under $BUF_DIR — is a stream running with highlights on?"
    exit 1
  fi

  echo "buffer: $BUF_DIR"
  printf '%-28s %9s %8s %7s %10s\n' SEGMENT MEDIA_s FRAMES FPS WALL_GAP_s
  prev_epoch=""; tot_media=0; tot_wall=0
  for f in "${SEGS[@]}"; do
    dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null)"
    nf="$(ffprobe -v error -count_packets -select_streams v:0 \
          -show_entries stream=nb_read_packets -of csv=p=0 "$f" 2>/dev/null)"
    epoch="$(basename "$f" .ts | sed 's/.*-//')"
    gap=""
    if [ -n "$prev_epoch" ] && [ -n "$epoch" ]; then
      gap=$(( epoch - prev_epoch ))
      tot_wall=$(( tot_wall + gap ))
      tot_media="$(awk -v a="$tot_media" -v b="${dur:-0}" 'BEGIN{print a+b}')"
    fi
    prev_epoch="$epoch"
    fps="$(awk -v n="${nf:-0}" -v d="${dur:-0}" 'BEGIN{if(d>0)printf "%.1f",n/d; else printf "-"}')"
    printf '%-28s %9s %8s %7s %10s\n' \
      "$(basename "$f")" "$(printf '%.2f' "${dur:-0}" 2>/dev/null || echo '?')" \
      "${nf:-?}" "$fps" "${gap:--}"
  done

  echo
  if [ "$tot_wall" -gt 0 ]; then
    ratio="$(awk -v m="$tot_media" -v w="$tot_wall" 'BEGIN{printf "%.2f", m/w}')"
    echo "media/wall ratio = $ratio   (1.00 is healthy)"
    awk -v r="$ratio" 'BEGIN{ exit !(r < 0.9) }' && {
      red "Segments hold less video than the wall-clock time they span."
      echo "Every reel will play back about $(awk -v r="$ratio" 'BEGIN{printf "%.1f", 1/r}')x too fast."
      echo "The frames are all there — their timestamps are too close together."
    }
    awk -v r="$ratio" 'BEGIN{ exit !(r >= 0.9) }' && \
      green "Buffer timing is healthy; any short reel is coming from extract/reframe."
  fi
  exit 0
fi

# ── preflight ────────────────────────────────────────────────────────────────
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
APP="$(detect_pm2_app)"
: "${APP:=streamer-${GROUND_ID:-<ground-id>}}"

if [ "$ENABLED" != "true" ]; then
  red "HIGHLIGHT_ENABLED is not 'true' in $ENV_FILE"
  echo "Enable it (and, on a box with no ESP32, HIGHLIGHT_FORCE_PRESENT=true so"
  echo "the buffer actually records), then restart:  pm2 restart $APP"
  exit 1
fi

if [ -z "$TRIGGER_FILE" ]; then
  red "HIGHLIGHT_TRIGGER_FILE is not set in $ENV_FILE"
  echo "The app only watches for a trigger file when this is set. Add:"
  echo "    HIGHLIGHT_TRIGGER_FILE=/tmp/hl-trigger"
  echo "then restart:  pm2 restart $APP"
  exit 1
fi

if [ -e "$TRIGGER_FILE" ]; then
  yellow "Trigger file already exists ($TRIGGER_FILE) — a highlight may be pending."
  yellow "The app removes it within ~1s of firing; if it lingers the streamer is"
  yellow "not running or not watching.  Check:  pm2 status"
fi

fire() {
  mkdir -p "$(dirname "$TRIGGER_FILE")" 2>/dev/null || true
  : > "$TRIGGER_FILE"
  green "Highlight triggered → touched $TRIGGER_FILE"
}

# ── no-follow: fire and get out of the way ───────────────────────────────────
if [ "$FOLLOW" = "0" ] || ! command -v pm2 >/dev/null 2>&1; then
  fire
  echo
  echo "  Reel output : $OUTPUT_DIR/<court>/"
  echo "  Watch logs  : pm2 logs $APP | grep -iE 'highlight|reel'"
  exit 0
fi

# ── follow: attach FIRST, then fire ──────────────────────────────────────────
# Order matters — see the header. A warm buffer can finish the whole pipeline
# in under a minute, and pm2 takes a moment to attach.
LOG="$(mktemp -t hl-trigger.XXXXXX)"
cleanup() { [ -n "${LOG_PID:-}" ] && kill "$LOG_PID" 2>/dev/null; rm -f "$LOG"; }
trap cleanup EXIT INT TERM

timeout "$TIMEOUT" pm2 logs "$APP" --raw --lines 0 >"$LOG" 2>/dev/null &
LOG_PID=$!
sleep 1.5

fire
echo
dim "watching '$APP' (up to ${TIMEOUT}s; Ctrl-C to stop) …"
echo

# Print the pipeline's milestones live. awk exits on a terminal line, which
# SIGPIPEs the tail and ends the wait — no fixed sleep, no guessing.
tail -f -n +1 "$LOG" 2>/dev/null | awk '
  /Highlight signal received/          { print "  ▸ trigger seen";        next }
  /Highlight capture starting/         { print "  ▸ cutting window";      next }
  /Highlight clip extracted/           { print "  ▸ clip extracted";      next }
  /much shorter than the requested/    { print "  ! clip is short";       next }
  /Ball reframe (stats|complete)/      { print "  ▸ reframed";            next }
  /Ball reframe skipped/               { print "  ▸ reframe skipped";     next }
  /Highlight reel rendered/            { print "  ▸ reel rendered";       next }
  /Reel upload starting/               { print "  ▸ uploading";           next }
  /Reel uploaded/                      { print "  ▸ uploaded";            next }
  /Reel upload skipped/                { print "  ▸ upload skipped (not configured)"; exit }
  /Local reel deleted after upload/    { print "  ▸ local reel deleted";  exit }
  /Highlight (capture failed|extraction failed)/ { print "  ✗ FAILED";    exit }
  /Highlight window (missing|has a segment gap)/ { print "  ✗ buffer does not cover the window"; exit }
  /Highlight captured/                 { print "  ▸ captured";            next }
'

# ── verdict ──────────────────────────────────────────────────────────────────
echo
grep -q "Highlight signal received" "$LOG" || {
  red "The app never saw the trigger."
  echo "It only watches HIGHLIGHT_TRIGGER_FILE if that was set BEFORE it started."
  echo "  pm2 restart $APP    then run this again"
  exit 1
}

# Pull the numbers that actually matter out of the JSON tails.
jsonval() { grep -o "\"$1\":[^,}]*" "$LOG" | tail -1 | cut -d: -f2- | tr -d '"'; }

REQ="$(jsonval requestedSec)"; ACT="$(jsonval actualSec)"
W="$(jsonval width)"; H="$(jsonval height)"; VID="$(jsonval videoId)"

echo "── result ──"
[ -n "$REQ$ACT" ] && echo "  clip      : ${ACT:-?}s of ${REQ:-?}s requested"
[ -n "$W$H" ]     && echo "  reel      : ${W:-?}x${H:-?}"
[ -n "$VID" ]     && echo "  youtube   : https://youtu.be/$VID"

# A reel that is much shorter than the window plays back sped up. Say so here
# rather than leaving it in the log — it is the difference between a usable
# Short and an unusable one, and it is easy to miss.
if [ -n "$REQ" ] && [ -n "$ACT" ]; then
  awk -v a="$ACT" -v r="$REQ" 'BEGIN{ exit !(r > 0 && a/r < 0.9) }' && {
    yellow "  ⚠ clip is $(awk -v a="$ACT" -v r="$REQ" 'BEGIN{printf "%.1f", r/a}')x short — the reel plays sped up."
    yellow "    Run:  bash lib/highlight-trigger.sh --diag"
  }
fi

grep -q "Reel uploaded" "$LOG" && green "  ✓ pipeline completed end to end"
dim "  full log: pm2 logs $APP --lines 200 --nostream"
