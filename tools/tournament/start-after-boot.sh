#!/bin/bash
# Starts the tournament programs (ds-recorder, ds-match-log, ds-stats) after the box boots.
#
# Why: pm2 only brings back the processes in its saved list, and we never `pm2 save`
# (it would rewrite how the box restores Hassan's processes). Without this, a power cut
# leaves recording, the match log and stats off until someone starts them by hand
# (happened 2026-11-23: off from 17:30 to 21:08).
#
# Run by the box user's crontab:
#   @reboot /home/hello-padel/dropshot-tournament/start-after-boot.sh >> /home/hello-padel/dropshot-tournament/boot-start.log 2>&1
# Keep them off across reboots: touch ~/dropshot-tournament/NO-AUTOSTART (or remove the crontab line).
#
# Rules (review 2026-11-23):
# - Waits until pm2's own background manager ("God Daemon", started by its systemd restore)
#   is up, without calling pm2 before that: any pm2 command would otherwise start a new,
#   empty one owned by cron instead of systemd.
# - A program already in pm2 is left alone: `pm2 start <config> --only X` RESTARTS a running X,
#   so if pm2's list can't be read, nothing is started at all.
sleep "${BOOT_SLEEP:-120}"
D=~/dropshot-tournament
cd "$D" || { echo "$(date -Is) no $D"; exit 1; }
echo "$(date -Is) start-after-boot"
[ -e "$D/NO-AUTOSTART" ] && { echo "  NO-AUTOSTART present: nothing started"; exit 0; }

# pm2's manager must already be running (pm2-<user> systemd unit); wait up to 10 minutes
for _ in $(seq 1 60); do
  pgrep -u "$(id -un)" -f "PM2 .*God Daemon" >/dev/null && break
  sleep 10
done
pgrep -u "$(id -un)" -f "PM2 .*God Daemon" >/dev/null || { echo "  pm2's manager never came up: nothing started"; exit 1; }

source ~/.nvm/nvm.sh >/dev/null 2>&1
command -v pm2 >/dev/null || { echo "  pm2 not on PATH (nvm default Node?): nothing started"; exit 1; }
names=$(pm2 jlist 2>/dev/null | python3 -c "import json,sys; print(' '.join(p['name'] for p in json.load(sys.stdin)))") \
  || { echo "  could not read pm2's list: nothing started (a start would restart running programs)"; exit 1; }
for app in ds-recorder ds-match-log ds-stats; do
  case " $names " in
    *" $app "*) echo "  $app already in pm2: left alone" ;;
    *) if pm2 start ecosystem.config.cjs --only "$app"; then echo "  started $app"; else echo "  FAILED to start $app"; fi ;;
  esac
done
