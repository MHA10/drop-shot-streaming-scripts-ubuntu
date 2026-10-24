#!/bin/bash

set -e

echo "=================================="
echo "Streamer Node Installation"
echo "=================================="
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
    echo "Please run as regular user (with sudo privileges), not as root"
    exit 1
fi

# Prompt for configuration
read -p "Enter GROUND_ID: " GROUND_ID
if [ -z "$GROUND_ID" ]; then
    echo "Error: GROUND_ID is required"
    exit 1
fi

read -p "Enter installation path [/opt/streamer-node]: " INSTALL_PATH
INSTALL_PATH=${INSTALL_PATH:-/opt/streamer-node}

# Install Node.js 22+ if missing or too old.
#
# Node 22 is a requirement, not a preference: @supabase/supabase-js needs a global
# WebSocket, which does not exist before Node 21. Without it every realtime
# subscription times out after 10s and the scorecard overlay is never redrawn.
# Nothing crashes - the stream runs on with a blank scoreboard - so the only
# symptom is a client complaint. Cost Padel Central a 5-hour stream on 23 Oct 2026.
NODE_MAJOR_REQUIRED=22
need_node=1
if command -v node &> /dev/null; then
    current_major=$(node -v | sed 's/^v//; s/\..*//')
    if [ "${current_major:-0}" -ge "$NODE_MAJOR_REQUIRED" ]; then
        need_node=0
    else
        echo "Node $(node -v) is older than ${NODE_MAJOR_REQUIRED}; upgrading."
    fi
fi
if [ "$need_node" -eq 1 ]; then
    echo "Installing Node.js ${NODE_MAJOR_REQUIRED}..."
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_REQUIRED}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Assert the property we actually depend on, not just the version number, and fail
# loudly here rather than silently streaming with a dead scoreboard.
node -e 'if (typeof WebSocket !== "function") process.exit(1)' || {
    echo "Error: Node $(node -v) has no global WebSocket. Supabase realtime will"
    echo "       never subscribe and the scoreboard overlay will stay blank."
    echo "       Install Node ${NODE_MAJOR_REQUIRED}+ and re-run."
    exit 1
}
echo "Node.js $(node -v) (global WebSocket present)"

# Install FFmpeg if not present
if ! command -v ffmpeg &> /dev/null; then
    echo "Installing FFmpeg..."
    sudo apt-get update
    sudo apt-get install -y ffmpeg
fi

# Create directories
echo "Creating directories..."
sudo mkdir -p $INSTALL_PATH/public
sudo mkdir -p /var/tmp/stream_registry
sudo mkdir -p /tmp/stream_registry
sudo chown -R $USER:$USER $INSTALL_PATH
sudo chown -R $USER:$USER /var/tmp/stream_registry

# Set global environment variables
echo "Setting up environment variables..."
if ! grep -q "GROUND_ID" ~/.bashrc; then
    cat >> ~/.bashrc << EOF

# Streamer Node Configuration
export GROUND_ID="$GROUND_ID"
export CLIENT_IMAGES_PATH="./public/client.png"
EOF
    source ~/.bashrc
fi

# Download setup script
echo "Downloading setup script..."
curl -sL https://raw.githubusercontent.com/MHA10/drop-shot-streaming-scripts-ubuntu/master/streamer-node-env-setup.sh -o /tmp/streamer-node-env-setup.sh
sudo mv /tmp/streamer-node-env-setup.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/streamer-node-env-setup.sh

# Create systemd service
echo "Creating systemd service..."
sudo tee /etc/systemd/system/streamer-node.service > /dev/null << EOF
[Unit]
Description=Streamer Node Service
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
Group=$USER
Environment="GROUND_ID=$GROUND_ID"
Environment="CLIENT_IMAGES_PATH=./public/client.png"
ExecStart=/usr/local/bin/streamer-node-env-setup.sh --path $INSTALL_PATH
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=streamer-node

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd
echo "Configuring systemd..."
sudo systemctl daemon-reload
sudo systemctl enable streamer-node

echo ""
echo "=================================="
echo "Installation Complete!"
echo "=================================="
echo ""
echo "Configuration:"
echo "  GROUND_ID: $GROUND_ID"
echo "  Installation Path: $INSTALL_PATH"
echo "  Environment Variables: ~/.bashrc"
echo ""
echo "Commands:"
echo "  Start:   sudo systemctl start streamer-node"
echo "  Stop:    sudo systemctl stop streamer-node"
echo "  Status:  sudo systemctl status streamer-node"
echo "  Logs:    sudo journalctl -u streamer-node -f"
echo ""
echo "Manual run:"
echo "  streamer-node-env-setup.sh --path $INSTALL_PATH"
echo ""
echo "To apply environment variables in current session:"
echo "  source ~/.bashrc"
echo ""
