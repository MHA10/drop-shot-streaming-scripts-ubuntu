# streamer-node

A lightweight TypeScript streaming system with Clean Architecture

## Installation

```bash
npm install streamer-node
# or
npx streamer-node
```

---

## New Streamer Machine Setup

To set up a new Ubuntu streamer machine, run the following command. It will fetch the setup script directly from the repo and execute it:

```bash
export DROPSHOT_GROUND_ID="your-ground-id" && \
bash <(curl -fsSL https://raw.githubusercontent.com/MHA10/drop-shot-streaming-scripts-ubuntu/master/lib/NEW-STREAMER-SETUP-07-04-26/setup.sh)
```

> Replace `your-ground-id` with the actual ground ID for this machine.

### What this does
- Downloads and runs the setup script directly — no manual file transfer needed
- Sets up the complete streamer environment in one command
- Takes 5-10 minutes depending on internet speed

### Prerequisites
- Ubuntu 24.04 LTS installed on the machine
- Internet connection (LAN cable or USB tethering from Android phone)
- `curl` installed (`sudo apt install curl -y`)

### After the script completes
1. **Authenticate Tailscale:**
   ```bash
   sudo tailscale up
   # Open the printed URL and login with: streamer.ds.01@gmail.com
   ```
2. **Verify streamer is running:**
   ```bash
   pm2 status
   ```
3. **Reboot and confirm auto-start:**
   ```bash
   sudo reboot
   # After reboot: pm2 status should show streamer as online
   ```
   