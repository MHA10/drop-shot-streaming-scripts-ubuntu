#!/bin/bash

# Node.js Stream Manager - Quick Dependency Setup
# This script installs the basic dependencies mentioned in the README

set -e  # Exit on any error

echo "🚀 Setting up Node.js Stream Manager dependencies..."

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

# Detect operating system
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    print_status "Linux system detected"
    
    # Update system packages
    print_status "Updating system packages..."
    sudo apt update && sudo apt upgrade -y
    print_success "System packages updated"
    
    # Install FFmpeg
    print_status "Installing FFmpeg..."
    if command -v ffmpeg &> /dev/null; then
        print_warning "FFmpeg is already installed"
        ffmpeg -version | head -1
    else
        sudo apt install ffmpeg -y
        print_success "FFmpeg installed successfully"
    fi
    
    # Install Node.js (using NodeSource repository)
    print_status "Installing Node.js 18.x..."
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

elif [[ "$OSTYPE" == "darwin"* ]]; then
    print_status "macOS system detected"
    
    # Check if Homebrew is installed
    if ! command -v brew &> /dev/null; then
        print_status "Installing Homebrew..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        print_success "Homebrew installed successfully"
    else
        print_status "Updating Homebrew..."
        brew update
    fi
    
    # Install FFmpeg
    print_status "Installing FFmpeg..."
    if command -v ffmpeg &> /dev/null; then
        print_warning "FFmpeg is already installed"
        ffmpeg -version | head -1
    else
        brew install ffmpeg
        print_success "FFmpeg installed successfully"
    fi
    
    # Install Node.js
    print_status "Installing Node.js..."
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

else
    print_error "Unsupported operating system: $OSTYPE"
    print_status "This script supports Linux and macOS only"
    print_status "Please install the following manually:"
    echo "  1. Node.js 18.x"
    echo "  2. FFmpeg"
    exit 1
fi

# Install npm dependencies
print_status "Installing Node.js project dependencies..."
cd "$(dirname "$0")/.."  # Go to project root

if [ -f "package.json" ]; then
    npm install
    print_success "Node.js dependencies installed"
    
    # Build the project if build script exists
    if npm run | grep -q "build"; then
        print_status "Building the project..."
        npm run build
        print_success "Project built successfully"
    fi
else
    print_warning "No package.json found in project root"
fi

print_status "Verifying installation..."
echo "Node.js version: $(node --version)"
echo "NPM version: $(npm --version)"
echo "FFmpeg version: $(ffmpeg -version | head -1)"

print_success "🎉 Dependencies setup completed successfully!"
echo ""
echo "Next steps:"
echo "  1. Configure the application in config/default.json"
echo "  2. Start the application with: npm start"
echo "  3. For development mode: npm run dev"
echo ""
echo "For full system installation (Raspberry Pi), use: sudo ./scripts/install.sh"