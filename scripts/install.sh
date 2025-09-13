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
echo "Your system is now ready to run the streaming script."
echo "You can now execute: ./initial.sh"
echo ""
echo "Note: Make sure to:"
echo "1. Update the RTSP URL with your camera credentials"
echo "2. Update the RTMP URL with your streaming service key"
echo "3. Adjust video quality settings as needed"
echo "================================================"