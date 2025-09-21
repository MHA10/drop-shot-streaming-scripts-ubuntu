#!/bin/bash

# Node.js Stream Manager - macOS Installation Script
# This script installs all required dependencies for the streaming application

set -e  # Exit on any error

echo "🚀 Starting Node.js Stream Manager installation on macOS..."

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

# Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    print_error "This script is designed for macOS systems. For Linux, use install-linux.sh"
    exit 1
fi

# Check if Homebrew is installed
if ! command -v brew &> /dev/null; then
    print_status "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    print_success "Homebrew installed successfully"
else
    print_status "Updating Homebrew..."
    brew update
    print_success "Homebrew updated"
fi

print_status "Installing FFmpeg..."
if command -v ffmpeg &> /dev/null; then
    print_warning "FFmpeg is already installed"
    ffmpeg -version | head -1
else
    brew install ffmpeg
    print_success "FFmpeg installed successfully"
fi

print_status "Installing Node.js (version 18.x)..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    print_warning "Node.js is already installed: $NODE_VERSION"
    
    # Check if version is 18 or higher
    MAJOR_VERSION=$(echo $NODE_VERSION | cut -d'.' -f1 | sed 's/v//')
    if [ "$MAJOR_VERSION" -lt 18 ]; then
        print_warning "Node.js version is below 18. Installing Node.js 18..."
        brew install node@18
        brew link node@18 --force
        print_success "Node.js 18 installed"
    fi
else
    brew install node@18
    brew link node@18 --force
    print_success "Node.js 18 installed successfully"
fi

print_status "Installing additional development tools..."
# Install common development tools that might be needed
if ! command -v git &> /dev/null; then
    brew install git
    print_success "Git installed"
fi

if ! command -v wget &> /dev/null; then
    brew install wget
    print_success "wget installed"
fi

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
echo "Homebrew version: $(brew --version | head -1)"

print_success "🎉 Installation completed successfully!"
echo ""
echo "To start the application:"
echo "  npm start"
echo ""
echo "To run in development mode:"
echo "  npm run dev"
echo ""
echo "For more information, check the README.md file."