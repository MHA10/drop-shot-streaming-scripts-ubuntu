#!/bin/bash
# =============================================================================
# Streamer Setup Script
# Description: Complete automated setup for a new Ubuntu streamer machine
# Usage: bash setup.sh
# Or with presets: export DROPSHOT_GROUND_ID="your-id" BASE_URL="https://api.drop-shot.live" && bash setup.sh
# BASE_URL defaults to staging if not provided
# =============================================================================

set -e  # Exit on any error

# Color codes
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log_header() {
    echo ""
    echo -e "${BLUE}=============================================${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}=============================================${NC}"
    echo ""
}

log_step() {
    echo ""
    echo -e "${CYAN}---------------------------------------------${NC}"
    echo -e "${CYAN}  STEP $1: $2${NC}"
    echo -e "${CYAN}---------------------------------------------${NC}"
    echo ""
}

log_info() {
    echo -e "  ${YELLOW}→${NC} $1"
}

log_success() {
    echo ""
    echo -e "  ${GREEN}✓ $1${NC}"
    echo ""
}

# =============================================================================
# START
# =============================================================================

log_header "Streamer Setup Script - Starting..."
log_info "This script will set up a complete Ubuntu streamer machine."
log_info "Estimated time: 5-15 minutes depending on internet speed."
echo ""

# =============================================================================
# REQUIRE DROPSHOT_GROUND_ID BEFORE ANYTHING RUNS
# =============================================================================
if [ -z "${DROPSHOT_GROUND_ID:-}" ]; then
    read -p "  Enter DROPSHOT_GROUND_ID: " DROPSHOT_GROUND_ID
    if [ -z "$DROPSHOT_GROUND_ID" ]; then
        echo ""
        echo "  ERROR: DROPSHOT_GROUND_ID is required. Exiting."
        echo ""
        exit 1
    fi
    export DROPSHOT_GROUND_ID
fi

log_info "Ground ID: $DROPSHOT_GROUND_ID"

# BASE_URL — optional, defaults to staging
if [ -z "${BASE_URL:-}" ]; then
    echo ""
    read -p "  Enter BASE_URL [https://api.staging.drop-shot.live]: " BASE_URL
    BASE_URL=${BASE_URL:-https://api.staging.drop-shot.live}
    export BASE_URL
fi

log_info "Base URL: $BASE_URL"
echo ""

# =============================================================================
# STEP 1: System Update
# =============================================================================
log_step "1/10" "System Update"
log_info "Updating package lists and upgrading installed packages..."

sudo apt update && sudo apt upgrade -y

log_info "Installing essential tools (curl, wget)..."
sudo apt install -y curl wget

log_success "System packages updated successfully."

# =============================================================================
# STEP 2: Disable Screen Lock & Auto Sleep
# =============================================================================
log_step "2/10" "Disable Screen Lock & Auto Sleep"
log_info "Configuring power and lock settings to prevent interruptions during streaming..."

gsettings set org.gnome.desktop.screensaver lock-enabled false
gsettings set org.gnome.desktop.session idle-delay 0
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'

log_info "Current settings:"
echo "    - Screen lock:  $(gsettings get org.gnome.desktop.screensaver lock-enabled)"
echo "    - Idle delay:   $(gsettings get org.gnome.desktop.session idle-delay)"
echo "    - Sleep on AC:  $(gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type)"

log_success "Power and lock settings configured."

# =============================================================================
# STEP 3: Install Git & Clone Repo
# =============================================================================
log_step "3/10" "Install Git & Clone Repo"
log_info "Installing Git..."

sudo apt install git -y

REPO_DIR="$HOME/Documents/drop-shot-streaming-scripts-ubuntu"

if [ ! -d "$REPO_DIR" ]; then
    log_info "Cloning streaming scripts repo (master branch)..."
    mkdir -p ~/Documents
    git clone https://github.com/MHA10/drop-shot-streaming-scripts-ubuntu.git "$REPO_DIR"
else
    log_info "Repo already exists. Pulling latest changes..."
fi

cd "$REPO_DIR"
git checkout master
git pull origin master

log_info "Current branch: $(git branch --show-current)"
log_success "Repo ready at: $REPO_DIR"

# =============================================================================
# STEP 4: Install NVM and Node.js 22
# =============================================================================
log_step "4/10" "Install NVM and Node.js 22"

if [ ! -d "$HOME/.nvm" ]; then
    log_info "Installing NVM (Node Version Manager)..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
else
    log_info "NVM already installed. Skipping..."
fi

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

log_info "Installing Node.js 22..."
nvm install 22
nvm use 22
nvm alias default 22

log_info "Node version: $(node --version)"
log_info "NPM version:  $(npm --version)"
log_success "Node.js 22 installed and set as default."

# =============================================================================
# STEP 5: Install System Dependencies
# =============================================================================
log_step "5/10" "Install System Dependencies"
log_info "Installing ffmpeg and build-essential..."

sudo apt-get install -y build-essential ffmpeg

log_info "FFmpeg version: $(ffmpeg -version 2>&1 | head -1)"
log_success "System dependencies installed."

# =============================================================================
# STEP 6: Install PM2
# =============================================================================
log_step "6/10" "Install PM2"

if ! command -v pm2 &> /dev/null; then
    log_info "Installing PM2 globally via npm..."
    npm install -g pm2
else
    log_info "PM2 already installed. Skipping..."
fi

log_info "PM2 version: $(pm2 --version)"
log_success "PM2 is ready."

# =============================================================================
# STEP 7: Configure PM2 Streamer Service
# =============================================================================
log_step "7/10" "Configure PM2 Streamer Service"
log_info "Ground ID: $DROPSHOT_GROUND_ID"

PM2_DIR="$REPO_DIR/lib/pm2"

# Create pm2-config.conf from example if not present
if [ ! -f "$PM2_DIR/pm2-config.conf" ]; then
    log_info "Creating pm2-config.conf from example..."
    cp "$PM2_DIR/pm2-config.conf.example" "$PM2_DIR/pm2-config.conf"
else
    log_info "pm2-config.conf already exists. Skipping..."
fi

# Create .env file
log_info "Creating .env file..."
cat > "$REPO_DIR/.env" << ENVEOF
# Server Configuration
BASE_URL=$BASE_URL

# Streamer Ground ID
DROPSHOT_GROUND_ID=$DROPSHOT_GROUND_ID

# Development
NODE_ENV=development

# Supabase Configuration
SUPABASE_ENABLED=true
SUPABASE_URL=https://ilgtabvjdpxpwgpeknti.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlsZ3RhYnZqZHB4cHdncGVrbnRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc0MzI0OTQsImV4cCI6MjA4MzAwODQ5NH0.2fBVCVsYRkVlWvjTv5-hQBU0YWNUzU_kM4-i9EtEp6U
SUPABASE_TABLE_NAME=score_board
SUPABASE_CHANNEL_NAME=score_board-channel

# Cloudinary Configuration
REACT_APP_CLOUDINARY_CLOUD_NAME=duca7omur
REACT_APP_CLOUDINARY_FOLDER=dropshot/padel-courts
REACT_APP_CLOUDINARY_UPLOAD_PRESET=dropshot-partners
CLOUDINARY_API_KEY=941851446579375
CLOUDINARY_API_SECRET=IrdU2pOiXW9GwDeP7h5JV3MRdwM
ENVEOF
log_info ".env file created at $REPO_DIR/.env"

# Run the PM2 setup script
# Note: --validate-only flag is NOT used here intentionally
# We pipe yes to auto-confirm and use timeout to prevent log tailing from blocking
log_info "Running PM2 setup script..."
chmod +x "$PM2_DIR/setup-pm2-ubuntu.sh"
cd "$PM2_DIR"
# Run setup but kill it after pm2 save completes (before log tailing)
timeout 30 ./setup-pm2-ubuntu.sh || true

log_success "PM2 streamer service configured. Process name: streamer-$DROPSHOT_GROUND_ID"

# =============================================================================
# STEP 8: Configure PM2 Log Rotation
# =============================================================================
log_step "8/10" "Configure PM2 Log Rotation"

if ! pm2 describe pm2-logrotate > /dev/null 2>&1; then
    log_info "Installing pm2-logrotate module..."
    pm2 install pm2-logrotate
else
    log_info "pm2-logrotate already installed. Updating settings..."
fi

log_info "Applying log rotation settings..."
pm2 set pm2-logrotate:max_days 3
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
pm2 set pm2-logrotate:max_size 10M

log_info "Settings applied:"
echo "    - Retention:  3 days"
echo "    - Max size:   10MB per file"
echo "    - Rotation:   Daily at midnight"
echo "    - Compress:   Enabled"

log_success "PM2 log rotation configured."

# =============================================================================
# STEP 9: Configure PM2 Auto-start on Boot
# =============================================================================
log_step "9/10" "Configure PM2 Auto-start on Boot"
log_info "Generating PM2 systemd startup configuration..."

STARTUP_CMD=$(pm2 startup systemd -u "$USER" --hp "$HOME" | grep "sudo env")
if [ -n "$STARTUP_CMD" ]; then
    log_info "Executing startup command..."
    eval "$STARTUP_CMD"
fi

log_info "Saving current PM2 process list..."
pm2 save

log_info "Systemd service status:"
systemctl is-enabled pm2-$USER && echo "    - pm2-$USER: enabled (will start on boot)" || echo "    - pm2-$USER: not enabled"

log_success "PM2 will auto-start on every boot/restart."

# =============================================================================
# STEP 10: Install OpenSSH Server
# Description: Enable remote SSH access via Tailscale
# =============================================================================
log_step "10/11" "Install OpenSSH Server"

if ! systemctl is-active --quiet ssh; then
    sudo apt install -y openssh-server
    sudo systemctl enable ssh
    sudo systemctl start ssh
    log_success "OpenSSH server installed and enabled."
else
    log_info "OpenSSH server already running. Skipping..."
fi

log_info "SSH status: $(systemctl is-active ssh)"
log_success "SSH server ready. Connect via: ssh $USER@<tailscale-ip>"

# =============================================================================
# STEP 11: Install Tailscale
# =============================================================================
log_step "11/11" "Install Tailscale"

if ! command -v tailscale &> /dev/null; then
    log_info "Installing Tailscale..."
    curl -fsSL https://tailscale.com/install.sh | sh
else
    log_info "Tailscale already installed. Skipping..."
    log_info "Version: $(tailscale --version | head -1)"
fi

log_success "Tailscale installed. Authentication required manually (see below)."

# =============================================================================
# COMPLETION SUMMARY
# =============================================================================

echo ""
echo -e "${GREEN}=============================================${NC}"
echo -e "${GREEN}  Automated Setup Complete!${NC}"
echo -e "${GREEN}=============================================${NC}"
echo ""
echo "  Ground ID : $DROPSHOT_GROUND_ID"
echo "  Base URL  : $BASE_URL"
echo "  Service   : streamer-$DROPSHOT_GROUND_ID"
echo "  Repo      : $REPO_DIR"
echo ""
echo "  PM2 commands:"
echo "    pm2 status"
echo "    pm2 logs streamer-$DROPSHOT_GROUND_ID"
echo "    pm2 restart streamer-$DROPSHOT_GROUND_ID"
echo "    pm2 monit"
echo ""
echo -e "${YELLOW}=============================================${NC}"
echo -e "${YELLOW}  MANUAL STEPS REQUIRED AFTER THIS SCRIPT${NC}"
echo -e "${YELLOW}=============================================${NC}"
echo ""
echo "  1. BIOS AUTO POWER-ON (AC RECOVERY)"
echo "       Go to:  BIOS at startup (F1 Lenovo / F2 Dell)"
echo "       Find:   Power → After Power Loss (or AC Recovery)"
echo "       Set to: Power On"
echo "       Save:   F10"
echo "       Why:    Machine auto boots when power is connected/restored"
echo ""
echo "  2. TAILSCALE AUTHENTICATION"
echo "       Run:    sudo tailscale up"
echo "       Open the printed URL in a browser"
echo "       Login:  streamer.ds.01@gmail.com"
echo "       Verify: tailscale status"
echo ""
echo "  3. DISABLE TAILSCALE KEY EXPIRY"
echo "       Go to:  https://login.tailscale.com/admin/machines"
echo "       Find:   this machine in the list"
echo "       Click:  three dots menu → Disable key expiry"
echo "       Why:    Prevents Tailscale disconnecting after key expires"
echo ""
echo "  4. VERIFY STREAMER IS RUNNING"
echo "       Run:    pm2 status"
echo "       Expect: streamer-$DROPSHOT_GROUND_ID shown as 'online'"
echo "       Logs:   pm2 logs streamer-$DROPSHOT_GROUND_ID"
echo ""
echo "  5. TEST AUTO-START ON REBOOT"
echo "       Reboot the machine, then confirm:"
echo "       - pm2 status       → streamer is online"
echo "       - tailscale status → connected"
echo ""
echo -e "${YELLOW}=============================================${NC}"
echo ""
echo "  1. BIOS AUTO POWER-ON (AC RECOVERY)
       Go to:  BIOS settings at startup (F1 for Lenovo, F2 for Dell)
       Find:   Power → After Power Loss (or AC Recovery)
       Set to: Power On
       Save:   F10
       Why:    Machine will auto boot when power is connected/restored
echo ""
echo "  2. TAILSCALE AUTHENTICATION"
echo "       Run:    sudo tailscale up"
echo "       Open the printed URL in a browser"
echo "       Login:  streamer.ds.01@gmail.com"
echo "       Verify: tailscale status"
echo ""
echo "  2. DISABLE TAILSCALE KEY EXPIRY"
echo "       Go to:  https://login.tailscale.com/admin/machines"
echo "       Find:   this machine in the list"
echo "       Click:  three dots menu → Disable key expiry"
echo "       Why:    Prevents Tailscale disconnecting after key expires"
echo ""
echo "  3. VERIFY STREAMER IS RUNNING"
echo "       Run:    pm2 status"
echo "       Expect: streamer-$DROPSHOT_GROUND_ID shown as 'online'"
echo "       Logs:   pm2 logs streamer-$DROPSHOT_GROUND_ID"
echo ""
echo "  4. TEST AUTO-START ON REBOOT"
echo "       Reboot the machine, then confirm:"
echo "       - pm2 status       → streamer is online"
echo "       - tailscale status → connected"
echo ""
echo -e "${YELLOW}=============================================${NC}"
echo ""

# =============================================================================
# VERIFICATION CHECKS
# =============================================================================

echo ""
echo -e "\033[0;34m=============================================\033[0m"
echo -e "\033[0;34m  Verification Checks\033[0m"
echo -e "\033[0;34m=============================================\033[0m"
echo ""

PASS=0
FAIL=0

check() {
    local label="$1"
    local cmd="$2"
    if eval "$cmd" > /dev/null 2>&1; then
        echo -e "  \033[0;32m✓ PASS\033[0m  $label"
        PASS=$((PASS + 1))
    else
        echo -e "  \033[0;31m✗ FAIL\033[0m  $label"
        FAIL=$((FAIL + 1))
    fi
}

echo ""
check "Git installed"                  "command -v git"
check "NVM installed"                  "[ -d $HOME/.nvm ]"
check "Node.js 22 installed"           "node --version | grep -q 'v22'"
check "NPM installed"                  "command -v npm"
check "FFmpeg installed"               "command -v ffmpeg"
check "PM2 installed"                  "command -v pm2"
check "PM2 process running"            "pm2 status | grep -q streamer-$DROPSHOT_GROUND_ID"
check "PM2 logrotate installed"        "pm2 describe pm2-logrotate"
check "PM2 startup configured"         "systemctl is-enabled pm2-$USER"
check "OpenSSH server running"         "systemctl is-active ssh"
check "Tailscale installed"            "command -v tailscale"
check "Repo cloned"                    "[ -d $HOME/Documents/drop-shot-streaming-scripts-ubuntu ]"
check ".env file created"               "[ -f $HOME/Documents/drop-shot-streaming-scripts-ubuntu/.env ]"
check "Screen lock disabled"           "gsettings get org.gnome.desktop.screensaver lock-enabled | grep -q false"
check "Auto sleep disabled"            "gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type | grep -q nothing"
echo ""

if [ "$FAIL" -eq 0 ]; then
    echo -e "  \033[0;32mAll $PASS checks passed! Streamer B is ready.\033[0m"
else
    echo -e "  Results: \033[0;32m$PASS passed\033[0m  /  \033[0;31m$FAIL failed\033[0m"
    echo -e "  \033[0;31mPlease review the failed steps above.\033[0m"
fi
echo ""
