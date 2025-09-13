#!/bin/bash

# Ubuntu Installation Script for RTSP-SSE Streaming System
# Compatible with Ubuntu 18.04, 20.04, 22.04, and newer

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] ✓${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] ⚠${NC} $1"
}

log_error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ✗${NC} $1"
}

# Check if running as root
check_root() {
    if [[ $EUID -eq 0 ]]; then
        log_warning "Running as root. This is not recommended for security reasons."
        read -p "Continue anyway? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
}

# Check Ubuntu version
check_ubuntu_version() {
    if [[ ! -f /etc/os-release ]]; then
        log_error "Cannot determine OS version. This script is designed for Ubuntu."
        exit 1
    fi
    
    source /etc/os-release
    
    if [[ "$ID" != "ubuntu" ]]; then
        log_error "This script is designed for Ubuntu. Detected: $ID"
        exit 1
    fi
    
    log_success "Detected Ubuntu $VERSION_ID"
    
    # Check if version is supported
    case "$VERSION_ID" in
        "18.04"|"20.04"|"22.04"|"24.04")
            log_success "Ubuntu version $VERSION_ID is supported"
            ;;
        *)
            log_warning "Ubuntu version $VERSION_ID may not be fully tested"
            ;;
    esac
}

# Update package lists
update_packages() {
    log "Updating package lists..."
    sudo apt-get update -qq
    log_success "Package lists updated"
}

# Install essential packages
install_essentials() {
    log "Installing essential packages..."
    
    local packages=(
        "curl"
        "wget"
        "bash"
        "coreutils"
        "util-linux"
        "procps"
        "net-tools"
        "iproute2"
        "systemd"
        "jq"
        "bc"
        "grep"
        "sed"
        "awk"
        "gawk"
        "findutils"
        "psmisc"
    )
    
    for package in "${packages[@]}"; do
        if ! dpkg -l | grep -q "^ii  $package "; then
            log "Installing $package..."
            sudo apt-get install -y "$package" > /dev/null 2>&1
            log_success "$package installed"
        else
            log_success "$package already installed"
        fi
    done
}

# Install FFmpeg
install_ffmpeg() {
    log "Installing FFmpeg..."
    
    if command -v ffmpeg > /dev/null 2>&1; then
        local version=$(ffmpeg -version 2>/dev/null | head -n1 | cut -d' ' -f3)
        log_success "FFmpeg already installed (version: $version)"
        return
    fi
    
    # Install FFmpeg
    sudo apt-get install -y ffmpeg > /dev/null 2>&1
    
    # Verify installation
    if command -v ffmpeg > /dev/null 2>&1; then
        local version=$(ffmpeg -version 2>/dev/null | head -n1 | cut -d' ' -f3)
        log_success "FFmpeg installed successfully (version: $version)"
    else
        log_error "FFmpeg installation failed"
        exit 1
    fi
}

# Install development tools (optional but recommended)
install_dev_tools() {
    log "Installing development tools..."
    
    local packages=(
        "build-essential"
        "git"
        "vim"
        "nano"
        "htop"
        "tree"
        "unzip"
        "zip"
    )
    
    for package in "${packages[@]}"; do
        if ! dpkg -l | grep -q "^ii  $package "; then
            log "Installing $package..."
            sudo apt-get install -y "$package" > /dev/null 2>&1
            log_success "$package installed"
        else
            log_success "$package already installed"
        fi
    done
}

# Install Node.js (for mock SSE server)
install_nodejs() {
    log "Installing Node.js..."
    
    if command -v node > /dev/null 2>&1; then
        local version=$(node --version)
        log_success "Node.js already installed ($version)"
        return
    fi
    
    # Install Node.js via NodeSource repository
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - > /dev/null 2>&1
    sudo apt-get install -y nodejs > /dev/null 2>&1
    
    # Verify installation
    if command -v node > /dev/null 2>&1; then
        local version=$(node --version)
        log_success "Node.js installed successfully ($version)"
    else
        log_error "Node.js installation failed"
        exit 1
    fi
}

# Create necessary directories
create_directories() {
    log "Creating necessary directories..."
    
    local dirs=(
        "/var/log/rtsp-sse"
        "/etc/rtsp-sse"
        "/opt/rtsp-sse"
        "$HOME/.rtsp-sse"
    )
    
    for dir in "${dirs[@]}"; do
        if [[ ! -d "$dir" ]]; then
            if [[ "$dir" == "/var/log/rtsp-sse" ]] || [[ "$dir" == "/etc/rtsp-sse" ]] || [[ "$dir" == "/opt/rtsp-sse" ]]; then
                sudo mkdir -p "$dir"
                sudo chown $USER:$USER "$dir"
            else
                mkdir -p "$dir"
            fi
            log_success "Created directory: $dir"
        else
            log_success "Directory already exists: $dir"
        fi
    done
}

# Set up systemd service (optional)
setup_systemd() {
    log "Setting up systemd service..."
    
    local service_file="/etc/systemd/system/rtsp-sse-stream.service"
    
    if [[ -f "$service_file" ]]; then
        log_success "Systemd service already exists"
        return
    fi
    
    sudo tee "$service_file" > /dev/null << EOF
[Unit]
Description=RTSP-SSE Stream Manager
After=network.target
Wants=network.target

[Service]
Type=simple
User=$USER
Group=$USER
WorkingDirectory=$(pwd)
ExecStart=$(pwd)/rtsp-sse-stream.sh
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rtsp-sse-stream

[Install]
WantedBy=multi-user.target
EOF
    
    sudo systemctl daemon-reload
    log_success "Systemd service created"
}

# Verify installation
verify_installation() {
    log "Verifying installation..."
    
    local errors=0
    
    # Check essential commands
    local commands=("curl" "bash" "ffmpeg" "jq" "bc" "node")
    
    for cmd in "${commands[@]}"; do
        if command -v "$cmd" > /dev/null 2>&1; then
            log_success "$cmd is available"
        else
            log_error "$cmd is not available"
            ((errors++))
        fi
    done
    
    # Check directories
    local dirs=("/var/log/rtsp-sse" "/etc/rtsp-sse" "$HOME/.rtsp-sse")
    
    for dir in "${dirs[@]}"; do
        if [[ -d "$dir" ]]; then
            log_success "Directory exists: $dir"
        else
            log_error "Directory missing: $dir"
            ((errors++))
        fi
    done
    
    if [[ $errors -eq 0 ]]; then
        log_success "All dependencies installed successfully!"
        return 0
    else
        log_error "Installation completed with $errors errors"
        return 1
    fi
}

# Main installation function
main() {
    echo "======================================"
    echo "  RTSP-SSE Streaming System Installer"
    echo "  Ubuntu Linux Edition"
    echo "======================================"
    echo
    
    check_root
    check_ubuntu_version
    
    log "Starting installation process..."
    
    update_packages
    install_essentials
    install_ffmpeg
    install_dev_tools
    install_nodejs
    create_directories
    setup_systemd
    
    echo
    echo "======================================"
    
    if verify_installation; then
        echo
        log_success "Installation completed successfully!"
        echo
        echo "Next steps:"
        echo "1. Run: ./ubuntu-setup.sh to configure the environment"
        echo "2. Run: ./ubuntu-test.sh to test the complete flow"
        echo "3. Check the troubleshooting guide if you encounter issues"
        echo
    else
        echo
        log_error "Installation completed with errors. Please check the output above."
        exit 1
    fi
}

# Run main function
main "$@"