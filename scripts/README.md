# Global Environment Variables Setup Guide

This guide shows how to set global environment variables and use them to create `.env` files automatically for `streamer-node`.

---

## Quick Start

### 1. Set Global Environment Variables

```bash
# Add to your shell profile
nano ~/.bashrc
```

Add these lines at the end:

```bash
# Streamer Node Configuration
export GROUND_ID="385136f6-7cf0-4e7f-b601-fea90079c227"
export CLIENT_IMAGES_PATH="./public/client.png"
```

Apply changes:

```bash
source ~/.bashrc
```

### 2. Download and Use the Script

```bash
# Download the script
curl -sL https://raw.githubusercontent.com/MHA10/drop-shot-streaming-scripts-ubuntu/master/streamer-node-env-setup.sh -o streamer-node-env-setup.sh

# Make it executable
chmod +x streamer-node-env-setup.sh

# Run it
./streamer-node-env-setup.sh
```

**What it does:**
1. Reads global environment variables
2. Creates `.env` file at specified path
3. Changes to that directory
4. Runs `npx streamer-node@latest`

---

## Detailed Setup

### Option 1: User-Level Environment Variables

Best for single-user systems or development.

#### Set Variables

```bash
# Edit .bashrc
nano ~/.bashrc
```

Add at the end:

```bash
# Streamer Node Configuration
export GROUND_ID="385136f6-7cf0-4e7f-b601-fea90079c227"
export CLIENT_IMAGES_PATH="./public/client.png"
```

Apply:

```bash
source ~/.bashrc
```

Verify:

```bash
echo $GROUND_ID
echo $CLIENT_IMAGES_PATH
```

---

### Option 2: System-Wide Environment Variables

Best for production servers where multiple users need access.

#### Method A: /etc/environment

```bash
# Edit system environment
sudo nano /etc/environment
```

Add:

```bash
GROUND_ID="385136f6-7cf0-4e7f-b601-fea90079c227"
CLIENT_IMAGES_PATH="./public/client.png"
```

**Note:** Requires logout/login or reboot to take effect.

#### Method B: /etc/profile.d/

```bash
# Create a new profile script
sudo nano /etc/profile.d/streamer-node.sh
```

Add:

```bash
#!/bin/bash
export GROUND_ID="385136f6-7cf0-4e7f-b601-fea90079c227"
export CLIENT_IMAGES_PATH="./public/client.png"
```

Make it executable:

```bash
sudo chmod +x /etc/profile.d/streamer-node.sh
```

Apply:

```bash
source /etc/profile.d/streamer-node.sh
```

---

## Using the Setup Script

### Basic Usage

```bash
# Use default path (/opt/streamer-node)
./streamer-node-env-setup.sh

# Use custom path
./streamer-node-env-setup.sh --path /home/ubuntu/streamer

# Override environment variables
./streamer-node-env-setup.sh --ground-id "new-id" --image "/custom/logo.png"

# Only create .env file (don't run service)
./streamer-node-env-setup.sh --create-only
```

### Command Line Options

| Option | Description | Example |
|--------|-------------|---------|
| `-p, --path` | Installation path | `--path /opt/streamer-node` |
| `-g, --ground-id` | Override GROUND_ID | `--ground-id "abc-123"` |
| `-i, --image` | Override image path | `--image "./logo.png"` |
| `-c, --create-only` | Only create .env | `--create-only` |
| `-h, --help` | Show help | `--help` |

---

## Systemd Integration

### Create Service with Script

Create systemd service that uses the setup script:

```bash
sudo nano /etc/systemd/system/streamer-node.service
```

Add:

```ini
[Unit]
Description=Streamer Node Service
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu

# Run the setup script
ExecStart=/usr/local/bin/streamer-node-env-setup.sh --path /opt/streamer-node

# Restart policy
Restart=always
RestartSec=10

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=streamer-node

[Install]
WantedBy=multi-user.target
```

### Install the Script System-Wide

```bash
# Copy script to system location
sudo cp streamer-node-env-setup.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/streamer-node-env-setup.sh
```

### Enable and Start Service

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable service
sudo systemctl enable streamer-node

# Start service
sudo systemctl start streamer-node

# Check status
sudo systemctl status streamer-node

# View logs
sudo journalctl -u streamer-node -f
```

---

## Complete Installation Script

Create an all-in-one installation script:

```bash
nano install-streamer-node.sh
```

```bash
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
```

Make it executable and run:

```bash
chmod +x install-streamer-node.sh
./install-streamer-node.sh
```

---

## Managing Multiple Grounds

### Set Multiple Ground IDs

```bash
# In ~/.bashrc
export GROUND_ID_1="ground-1-id"
export GROUND_ID_2="ground-2-id"
export GROUND_ID_3="ground-3-id"
```

### Create Services for Each Ground

```bash
# Ground 1
streamer-node-env-setup.sh --path /opt/streamer-ground1 --ground-id "$GROUND_ID_1" --create-only

# Ground 2
streamer-node-env-setup.sh --path /opt/streamer-ground2 --ground-id "$GROUND_ID_2" --create-only

# Ground 3
streamer-node-env-setup.sh --path /opt/streamer-ground3 --ground-id "$GROUND_ID_3" --create-only
```

### Create Systemd Services

```bash
# Service for Ground 1
sudo nano /etc/systemd/system/streamer-node-ground1.service
```

```ini
[Unit]
Description=Streamer Node Service - Ground 1

[Service]
Type=simple
User=ubuntu
Environment="GROUND_ID=ground-1-id"
Environment="CLIENT_IMAGES_PATH=./public/client.png"
ExecStart=/usr/local/bin/streamer-node-env-setup.sh --path /opt/streamer-ground1
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable streamer-node-ground1
sudo systemctl start streamer-node-ground1
```

---

## Updating Configuration

### Change GROUND_ID

#### Method 1: Update Global Variable

```bash
# Edit .bashrc
nano ~/.bashrc

# Change the GROUND_ID line
export GROUND_ID="new-ground-id"

# Apply
source ~/.bashrc

# Recreate .env and restart
streamer-node-env-setup.sh --create-only
sudo systemctl restart streamer-node
```

#### Method 2: Override in Service

```bash
# Edit service
sudo nano /etc/systemd/system/streamer-node.service

# Change Environment line
Environment="GROUND_ID=new-ground-id"

# Reload and restart
sudo systemctl daemon-reload
sudo systemctl restart streamer-node
```

### Change Client Image

```bash
# Copy new image
cp /path/to/new-logo.png /opt/streamer-node/public/client.png

# Restart service
sudo systemctl restart streamer-node
```

---

## Verification

### Check Environment Variables

```bash
# Check current values
echo $GROUND_ID
echo $CLIENT_IMAGES_PATH

# Check all environment
env | grep -E 'GROUND_ID|CLIENT_IMAGES_PATH'
```

### Check .env File

```bash
# View .env file
cat /opt/streamer-node/.env

# Check if file exists
ls -la /opt/streamer-node/.env
```

### Verify Service Configuration

```bash
# Check service environment
sudo systemctl show streamer-node -p Environment

# Check service status
sudo systemctl status streamer-node

# Check logs
sudo journalctl -u streamer-node -n 50
```

---

## Testing

### Test Script Manually

```bash
# Test with default settings
./streamer-node-env-setup.sh --create-only

# Verify .env was created
cat /opt/streamer-node/.env

# Test running
cd /opt/streamer-node
npx streamer-node@latest
```

### Test Different Configurations

```bash
# Test custom path
./streamer-node-env-setup.sh --path /tmp/test-streamer --create-only

# Test override
./streamer-node-env-setup.sh --ground-id "test-123" --create-only

# Check results
cat /tmp/test-streamer/.env
```

---

## Troubleshooting

### Environment Variables Not Set

**Problem:** Script says "GROUND_ID is not set"

**Solution:**
```bash
# Check if variables are set
echo $GROUND_ID

# If empty, source the profile
source ~/.bashrc

# Or set them temporarily
export GROUND_ID="your-ground-id"
export CLIENT_IMAGES_PATH="./public/client.png"
```

### .env File Not Created

**Problem:** .env file doesn't exist

**Solution:**
```bash
# Check directory exists
ls -la /opt/streamer-node

# Check permissions
ls -ld /opt/streamer-node

# Create directory if needed
sudo mkdir -p /opt/streamer-node
sudo chown $USER:$USER /opt/streamer-node

# Run script again
./streamer-node-env-setup.sh --create-only
```

### Service Doesn't Start

**Problem:** systemctl start fails

**Solution:**
```bash
# Check service status
sudo systemctl status streamer-node

# Check logs
sudo journalctl -u streamer-node -n 100

# Verify script exists
ls -la /usr/local/bin/streamer-node-env-setup.sh

# Test script manually
/usr/local/bin/streamer-node-env-setup.sh --create-only
```

### npx Command Not Found

**Problem:** "npx: command not found"

**Solution:**
```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version
npm --version
npx --version
```

---

## Advantages of This Approach

✅ **Centralized Configuration** - Environment variables defined once, used everywhere  
✅ **Easy Updates** - Change global variables, recreate .env  
✅ **Multi-Ground Support** - Different variables for different instances  
✅ **Service Integration** - Works seamlessly with systemd  
✅ **Override Capability** - Can override via command line  
✅ **Development Friendly** - Easy to test locally  

---

## Quick Reference

### Set Variables
```bash
echo 'export GROUND_ID="your-id"' >> ~/.bashrc
echo 'export CLIENT_IMAGES_PATH="./public/client.png"' >> ~/.bashrc
source ~/.bashrc
```

### Install Script
```bash
curl -sL https://raw.githubusercontent.com/.../streamer-node-env-setup.sh -o /tmp/setup.sh
sudo mv /tmp/setup.sh /usr/local/bin/streamer-node-env-setup.sh
sudo chmod +x /usr/local/bin/streamer-node-env-setup.sh
```

### Run
```bash
# Default
streamer-node-env-setup.sh

# Custom path
streamer-node-env-setup.sh --path /opt/streamer-node

# Only create .env
streamer-node-env-setup.sh --create-only
```

### Service
```bash
sudo systemctl start streamer-node
sudo systemctl status streamer-node
sudo journalctl -u streamer-node -f
```

---

**Last Updated:** October 2025  
**Version:** 1.0.0