#!/bin/bash

# Ubuntu Installation Script for Streaming Dependencies
# This script installs all necessary libraries for the RTSP to RTMP streaming script

set -e  # Exit on any error

echo "Starting Ubuntu dependency installation for streaming script..."
echo "================================================"

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to handle errors
handle_error() {
    echo "Error: $1" >&2
    exit 1
}

# Check if running as root or with sudo
if [[ $EUID -eq 0 ]]; then
    SUDO=""
else
    if ! command_exists sudo; then
        handle_error "This script requires sudo privileges. Please install sudo or run as root."
    fi
    SUDO="sudo"
fi

echo "Updating package manager..."
$SUDO apt update || handle_error "Failed to update package manager"

echo "Installing essential build tools..."
$SUDO apt install -y \
    software-properties-common \
    build-essential \
    pkg-config \
    wget \
    curl \
    git || handle_error "Failed to install essential build tools"

echo "Installing FFmpeg and multimedia libraries..."
$SUDO apt install -y \
    ffmpeg \
    libavcodec-extra \
    libavformat-dev \
    libavutil-dev \
    libswscale-dev \
    libswresample-dev \
    libavfilter-dev || handle_error "Failed to install FFmpeg packages"

echo "Installing video/audio codecs..."
$SUDO apt install -y \
    libx264-dev \
    libx265-dev \
    libvpx-dev \
    libfdk-aac-dev \
    libmp3lame-dev \
    libopus-dev \
    libvorbis-dev || handle_error "Failed to install codec libraries"

echo "Installing network and streaming libraries..."
$SUDO apt install -y \
    librtmp-dev \
    libssl-dev \
    libgnutls28-dev || handle_error "Failed to install network libraries"

echo "Installing Node.js and npm..."
# Install Node.js 18.x LTS
curl -fsSL https://deb.nodesource.com/setup_18.x | $SUDO -E bash - || handle_error "Failed to add NodeSource repository"
$SUDO apt install -y nodejs || handle_error "Failed to install Node.js"

# Verify Node.js and npm installation
echo "Verifying Node.js and npm installation..."
if ! command_exists node; then
    handle_error "Node.js installation failed"
fi

if ! command_exists npm; then
    handle_error "npm installation failed"
fi

node_version=$(node --version 2>/dev/null)
npm_version=$(npm --version 2>/dev/null)
echo "Installed Node.js: $node_version"
echo "Installed npm: $npm_version"

# Verify FFmpeg installation and check for required codecs
echo "Verifying FFmpeg installation..."
if ! command_exists ffmpeg; then
    handle_error "FFmpeg installation failed"
fi

echo "Checking FFmpeg codec support..."
ffmpeg_version=$(ffmpeg -version 2>/dev/null | head -n1)
echo "Installed: $ffmpeg_version"

# Check for required codecs
echo "Verifying codec support..."
codecs_check=true

if ! ffmpeg -codecs 2>/dev/null | grep -q "libx264"; then
    echo "Warning: libx264 codec not found"
    codecs_check=false
fi

if ! ffmpeg -codecs 2>/dev/null | grep -q "aac"; then
    echo "Warning: AAC codec not found"
    codecs_check=false
fi

if ! ffmpeg -formats 2>/dev/null | grep -q "flv"; then
    echo "Warning: FLV format support not found"
    codecs_check=false
fi

if ! ffmpeg -protocols 2>/dev/null | grep -q "rtsp"; then
    echo "Warning: RTSP protocol support not found"
    codecs_check=false
fi

if ! ffmpeg -protocols 2>/dev/null | grep -q "rtmp"; then
    echo "Warning: RTMP protocol support not found"
    codecs_check=false
fi

if [ "$codecs_check" = true ]; then
    echo "✓ All required codecs and protocols are available"
else
    echo "⚠ Some codecs/protocols may not be available. The script might still work."
fi

echo "================================================"
echo "Installation completed successfully!"
echo ""
echo "Your system is now ready to run the streaming applications."
echo "You can now:"
echo "1. Execute: ./initial.sh (for basic streaming script)"
echo "2. Navigate to streamer-node/ and run: npm install (for Node.js application)"
echo ""
echo "Note: Make sure to:"
echo "1. Update the RTSP URL with your camera credentials"
echo "2. Update the RTMP URL with your streaming service key"
echo "3. Adjust video quality settings as needed"
echo "4. Configure the .env file in streamer-node/ for the Node.js application"
echo "================================================"