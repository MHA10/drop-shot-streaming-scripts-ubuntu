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

# Install Node.js if not present
if ! command -v node &> /dev/null; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

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
