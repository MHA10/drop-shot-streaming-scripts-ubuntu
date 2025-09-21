#!/bin/bash

# Node.js Stream Manager - Linux Installation Script
# This script installs all required dependencies for the streaming application

set -e  # Exit on any error

echo "🚀 Starting Node.js Stream Manager installation..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   print_error "This script should not be run as root. Please run as a regular user."
   exit 1
fi

# Check if running on Linux
if [[ "$OSTYPE" != "linux-gnu"* ]]; then
    print_error "This script is designed for Linux systems. For macOS, use install-macos.sh"
    exit 1
fi

print_status "Updating system packages..."
sudo apt update && sudo apt upgrade -y
print_success "System packages updated"

print_status "Installing FFmpeg..."
if command -v ffmpeg &> /dev/null; then
    print_warning "FFmpeg is already installed"
    ffmpeg -version | head -1
else
    sudo apt install ffmpeg -y
    print_success "FFmpeg installed successfully"
fi

print_status "Installing Node.js (version 18.x)..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    print_warning "Node.js is already installed: $NODE_VERSION"
    
    # Check if version is 18 or higher
    MAJOR_VERSION=$(echo $NODE_VERSION | cut -d'.' -f1 | sed 's/v//')
    if [ "$MAJOR_VERSION" -lt 18 ]; then
        print_warning "Node.js version is below 18. Installing Node.js 18.x..."
        curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
        sudo apt install nodejs -y
        print_success "Node.js 18.x installed"
    fi
else
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt install nodejs -y
    print_success "Node.js 18.x installed successfully"
fi

print_status "Installing additional system dependencies..."
sudo apt install -y \
    build-essential \
    git \
    curl \
    wget \
    unzip \
    software-properties-common \
    apt-transport-https \
    ca-certificates \
    gnupg \
    lsb-release

print_success "Additional dependencies installed"

print_status "Installing Node.js project dependencies..."
cd "$(dirname "$0")/.."  # Go to project root
npm install
print_success "Node.js dependencies installed"

print_status "Building the project..."
npm run build
print_success "Project built successfully"

print_status "Setting up log directories..."
mkdir -p logs
chmod 755 logs
print_success "Log directories created"

print_status "Verifying installation..."
echo "Node.js version: $(node --version)"
echo "NPM version: $(npm --version)"
echo "FFmpeg version: $(ffmpeg -version | head -1)"

print_success "🎉 Installation completed successfully!"
echo ""
echo "To start the application:"
echo "  npm start"
echo ""
echo "To run in development mode:"
echo "  npm run dev"
echo ""
echo "For more information, check the README.md file."