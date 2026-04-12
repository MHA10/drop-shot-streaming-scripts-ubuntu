# Dropshot Staging — PM2 Operational Runbook

> **Audience**: Engineers and DevOps responsible for operating the `dropshot-staging` service on the Ubuntu host (`ds@<server>`).  
> **Process name**: `dropshot-staging`  
> **Script**: `/home/ds/Documents/drop-shot-streaming-scripts-ubuntu/lib/pm2/run-staging.sh`  
> **Working directory**: `/home/ds/Documents/drop-shot-streaming-scripts-ubuntu/`  
> **Node version**: 22 (managed via `nvm`)

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [First-Time Setup](#2-first-time-setup)
3. [PM2 Startup on System Boot](#3-pm2-startup-on-system-boot)
4. [Starting the Service](#4-starting-the-service)
5. [Day-to-Day Operations](#5-day-to-day-operations)
6. [Log Management](#6-log-management)
7. [Health Checks](#7-health-checks)
8. [Common Troubleshooting](#8-common-troubleshooting)
9. [Full Reset Procedure](#9-full-reset-procedure)
10. [Maintenance Checklist](#10-maintenance-checklist)

---

## 1. Prerequisites

| Requirement | How to verify |
|---|---|
| `pm2` installed globally | `pm2 --version` |
| `nvm` installed for the `ds` user | `nvm --version` |
| Node 22 available via nvm | `nvm list` → look for `v22.*` |
| Script is executable | `ls -l .../run-staging.sh` → permissions include `x` |

### Install PM2 (if missing)

```bash
npm install -g pm2
```

### Make the script executable (if needed)

```bash
chmod +x /home/ds/Documents/drop-shot-streaming-scripts-ubuntu/lib/pm2/run-staging.sh
```

---

## 2. First-Time Setup

Run these steps **once** on a fresh machine or after a clean reinstall.

### Step 1 — Verify the script contents

```bash
cat /home/ds/Documents/drop-shot-streaming-scripts-ubuntu/lib/pm2/run-staging.sh
```

Expected output:

```bash
#!/bin/bash
cd /home/ds/Documents/drop-shot-streaming-scripts-ubuntu/ || exit 1
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use 22
npm install
npm run dev
```

### Step 2 — Start the service for the first time

```bash
pm2 start /home/ds/Documents/drop-shot-streaming-scripts-ubuntu/lib/pm2/run-staging.sh \
  --name "dropshot-staging"
```

### Step 3 — Confirm it is running

```bash
pm2 status
```

Look for `dropshot-staging` with status `online`.

---

## 3. PM2 Startup on System Boot

This is a **critical one-time configuration** step. Without it, the service will **not** restart automatically after a system reboot.

### Step 1 — Generate the startup hook

Run this command and **carefully read its output**:

```bash
pm2 startup
```

PM2 will detect your init system (systemd on Ubuntu) and print a `sudo env PATH=...` command. **Copy and execute that full command exactly as printed.** It will look similar to:

```bash
# Example only — use the actual command printed by `pm2 startup`, not this one
sudo env PATH=$PATH:/home/ds/.nvm/versions/node/v22.x.x/bin \
  /home/ds/.nvm/versions/node/v22.x.x/lib/node_modules/pm2/bin/pm2 \
  startup systemd -u ds --hp /home/ds
```

> ⚠️ **Do not copy the example above.** The paths will differ depending on which Node version nvm is using. Always use the command printed by your own `pm2 startup` run.

### Step 2 — Save the current process list

After the `dropshot-staging` process is running and confirmed healthy, persist it:

```bash
pm2 save
```

This writes the process list to `~/.pm2/dump.pm2`. On the next boot, systemd will call `pm2 resurrect` automatically, which restores all saved processes.

### Step 3 — Verify the systemd service

```bash
systemctl status pm2-ds
```

Expected: `active (running)`. If the service name differs (e.g., `pm2-root`), adjust accordingly — the name is shown in the output of `pm2 startup`.

### Re-saving After Any Process Change

Every time you **add, remove, or rename** a PM2 process, re-run `pm2 save` so the new state is preserved across reboots:

```bash
pm2 save
```

---

## 4. Starting the Service

### Normal start (after setup)

```bash
pm2 start dropshot-staging
```

### Start from scratch (if not yet registered)

```bash
pm2 start /home/ds/Documents/drop-shot-streaming-scripts-ubuntu/lib/pm2/run-staging.sh \
  --name "dropshot-staging"
```

---

## 5. Day-to-Day Operations

### View all managed processes

```bash
pm2 status
```

### Restart the service

Use this after a new deployment or code change:

```bash
pm2 restart dropshot-staging
```

### Graceful reload (zero-downtime when clustering)

```bash
pm2 reload dropshot-staging
```

### Stop the service

```bash
pm2 stop dropshot-staging
```

### Remove the service from PM2

```bash
pm2 delete dropshot-staging
```

> ⚠️ After deleting, run `pm2 save` to prevent it from being resurrected on the next boot.

### Open the interactive monitoring dashboard

```bash
pm2 monit
```

### Get detailed process info

```bash
pm2 describe dropshot-staging
```

---

## 6. Log Management

### Tail live logs

```bash
pm2 logs dropshot-staging
```

### View the last N lines only

```bash
pm2 logs dropshot-staging --lines 100
```

### View only error logs

```bash
pm2 logs dropshot-staging --err
```

### Log file locations on disk

| Log type | Path |
|---|---|
| Standard output | `~/.pm2/logs/dropshot-staging-out.log` |
| Standard error | `~/.pm2/logs/dropshot-staging-error.log` |

```bash
# Tail directly via tail
tail -f ~/.pm2/logs/dropshot-staging-out.log
tail -f ~/.pm2/logs/dropshot-staging-error.log
```

### Flush (clear) all logs

```bash
pm2 flush
```

### Install log rotation (recommended for long-running servers)

```bash
pm2 install pm2-logrotate

# Optional: keep logs for 3 days, rotate at 10 MB
pm2 set pm2-logrotate:retain 3
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:compress true
```

---

## 7. Health Checks

### Quick status check

```bash
pm2 status
```

Expected `dropshot-staging` row:

| Field | Expected value |
|---|---|
| status | online |
| restarts | Low (< 5 in steady state) |
| uptime | Growing (not resetting frequently) |

### Check systemd startup service is active

```bash
systemctl status pm2-ds
```

### Verify process is persisted across reboots (dry-run check)

```bash
cat ~/.pm2/dump.pm2 | grep dropshot-staging
```

Should return a non-empty result.

### Simulate a reboot check (without rebooting)

```bash
pm2 kill          # Stop PM2 daemon
pm2 resurrect     # Restore saved processes
pm2 status        # Confirm dropshot-staging is back online
```

---

## 8. Common Troubleshooting

### Service won't start / keeps restarting

```bash
# Check error logs immediately
pm2 logs dropshot-staging --err --lines 50

# Common causes:
# - nvm not sourced → script loads wrong Node version
# - npm install fails → check for network or disk issues
# - Build error (TypeScript) → check for type errors in logs
```

### `nvm: command not found` in logs

PM2 launches processes in a non-interactive, non-login shell, so `.bashrc` / `.bash_profile` are not sourced automatically. The `run-staging.sh` script handles this by explicitly exporting `NVM_DIR` and sourcing `nvm.sh`. If the error persists, verify the nvm path inside the script matches the actual installation:

```bash
# Confirm nvm install location
ls ~/.nvm/nvm.sh
```

### Process not coming back after reboot

1. Confirm startup hook was installed: `systemctl status pm2-ds`
2. Confirm `pm2 save` was run after the process was online
3. Re-run the full startup setup:
   ```bash
   pm2 startup          # generates the sudo command
   # Run the printed sudo command
   pm2 save
   ```

### TypeScript build errors (`Cannot find module '@napi-rs/canvas'`)

This is a known compilation warning visible in logs. Ensure native dependencies are installed:

```bash
cd /home/ds/Documents/drop-shot-streaming-scripts-ubuntu/
npm install
```

If the error persists, check peer dependencies and rebuild native modules:

```bash
npm rebuild
```

### PM2 daemon is unresponsive

```bash
pm2 kill          # Kill the daemon cleanly
pm2 resurrect     # Bring back saved processes
```

### Out-of-disk-space causing log issues

```bash
du -sh ~/.pm2/logs/
pm2 flush         # Clears all log files
```

---

## 9. Full Reset Procedure

Use this when you need to completely wipe and re-register the service (e.g., path changes, major environment rebuild).

```bash
# 1. Stop and remove the existing process
pm2 delete dropshot-staging

# 2. Kill PM2 daemon (optional, for a truly clean state)
pm2 kill

# 3. Re-start PM2 and register the process
pm2 start /home/ds/Documents/drop-shot-streaming-scripts-ubuntu/lib/pm2/run-staging.sh \
  --name "dropshot-staging"

# 4. Confirm it is healthy
pm2 status

# 5. Re-configure startup hook
pm2 startup
# → Run the printed sudo command

# 6. Save the process list
pm2 save

# 7. Verify systemd service is active
systemctl status pm2-ds
```

---

## 10. Maintenance Checklist

### After every code deployment

- [ ] `pm2 restart dropshot-staging`
- [ ] `pm2 logs dropshot-staging --lines 50` — confirm no build errors
- [ ] `pm2 status` — confirm status is `online`

### After adding/removing any PM2 process

- [ ] `pm2 save` — persist the new process list for boot recovery

### Weekly

- [ ] `pm2 status` — review restart counts; high counts indicate instability
- [ ] `du -sh ~/.pm2/logs/` — check log disk usage
- [ ] `systemctl status pm2-ds` — confirm startup hook is still active

### After system package / Node upgrades

- [ ] Re-run `pm2 startup` (the Node binary path may change with nvm)
- [ ] Run the printed `sudo env PATH=...` command
- [ ] `pm2 save`

---

*Last updated: 2026-02-24 | Maintainer: Dropshot Engineering*
