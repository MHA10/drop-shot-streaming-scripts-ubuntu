#!/bin/bash

#==============================================================================
# PM2 Streaming Service Setup Script for Ubuntu Linux
# Automates the complete PM2 configuration for paddle ground streaming services
#
# Environment Variables:
#   DROPSHOT_GROUND_ID - Ground identifier (overrides config file)
#
# Usage:
#   export DROPSHOT_GROUND_ID="your-ground-id"
#   ./setup-pm2-ubuntu.sh
#
# Author: Muhammad Hamza Ashraf
# Date: $(date +%Y-%m-%d)
# Version: 1.0.0
#==============================================================================

set -euo pipefail  # Exit on error, undefined vars, pipe failures

# Color codes for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m' # No Color

# Script configuration
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly LOG_FILE="/var/log/pm2-setup.log"
readonly CONFIG_FILE="${SCRIPT_DIR}/pm2-config.conf"
readonly RUNNER_SCRIPT_NAME="run-streamer.sh"
readonly SERVICE_NAME_PREFIX="streamer"

# Default values
DEFAULT_GROUND_NAME="${DROPSHOT_GROUND_ID:-ground1}"
DEFAULT_PACKAGE_NAME="streamer-node"
DEFAULT_NODE_VERSION="18"

#==============================================================================
# Utility Functions
#==============================================================================

log() {
    local level="$1"
    shift
    local message="$*"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    
    case "$level" in
        "INFO")  echo -e "${GREEN}[INFO]${NC} $message" ;;
        "WARN")  echo -e "${YELLOW}[WARN]${NC} $message" ;;
        "ERROR") echo -e "${RED}[ERROR]${NC} $message" ;;
        "DEBUG") echo -e "${BLUE}[DEBUG]${NC} $message" ;;
    esac
    
    # Also log to file if possible
    if [[ -w "$(dirname "$LOG_FILE")" ]] || [[ -w "$LOG_FILE" ]]; then
        echo "[$timestamp] [$level] $message" >> "$LOG_FILE"
    fi
}

error_exit() {
    log "ERROR" "$1"
    exit 1
}

check_root() {
    if [[ $EUID -eq 0 ]]; then
        error_exit "This script should not be run as root. Please run as a regular user with sudo privileges."
    fi
}

check_ubuntu() {
    if ! grep -q "Ubuntu" /etc/os-release 2>/dev/null; then
        error_exit "This script is designed for Ubuntu Linux only."
    fi
    log "INFO" "Ubuntu Linux detected: $(lsb_release -d | cut -f2)"
}

check_sudo() {
    if ! sudo -n true 2>/dev/null; then
        log "WARN" "This script requires sudo privileges. You may be prompted for your password."
        if ! sudo true; then
            error_exit "Failed to obtain sudo privileges."
        fi
    fi
    log "INFO" "Sudo privileges confirmed."
}

#==============================================================================
# Configuration Management
#==============================================================================

load_config() {
    # Check for environment variable
    if [[ -n "${DROPSHOT_GROUND_ID:-}" ]]; then
        log "INFO" "Using DROPSHOT_GROUND_ID environment variable: $DROPSHOT_GROUND_ID"
    fi
    
    if [[ -f "$CONFIG_FILE" ]]; then
        log "INFO" "Loading configuration from $CONFIG_FILE"
        source "$CONFIG_FILE"
    else
        log "WARN" "Configuration file not found. Using default values."
    fi
    
    # Set defaults if not provided
    GROUND_NAME="${GROUND_NAME:-$DEFAULT_GROUND_NAME}"
    PACKAGE_NAME="${PACKAGE_NAME:-$DEFAULT_PACKAGE_NAME}"
    NODE_VERSION="${NODE_VERSION:-$DEFAULT_NODE_VERSION}"
    KEYMETRICS_PUBLIC_KEY="${KEYMETRICS_PUBLIC_KEY:-}"
    KEYMETRICS_PRIVATE_KEY="${KEYMETRICS_PRIVATE_KEY:-}"
    MACHINE_NAME="${MACHINE_NAME:-${GROUND_NAME}-server}"
    GROUND_TAG="${GROUND_TAG:-ground=${GROUND_NAME}}"
}

create_sample_config() {
    cat > "$CONFIG_FILE" << EOF
# PM2 Streaming Service Configuration
# Copy this file and modify the values as needed

# Ground identification
GROUND_NAME="${DROPSHOT_GROUND_ID:-ground1}"
MACHINE_NAME="${GROUND_NAME}-server"
GROUND_TAG="ground=${GROUND_NAME}"

# Package configuration
PACKAGE_NAME="streamer-node"

# Node.js version (18, 20, etc.)
NODE_VERSION="18"

# Keymetrics configuration (optional)
KEYMETRICS_PUBLIC_KEY=""
KEYMETRICS_PRIVATE_KEY=""

# Additional PM2 options
PM2_INSTANCES="1"
PM2_MAX_MEMORY_RESTART="500M"
PM2_AUTORESTART="true"
EOF
    log "INFO" "Sample configuration created at $CONFIG_FILE"
}

#==============================================================================
# System Prerequisites Installation
#==============================================================================

update_system() {
    log "INFO" "Updating Ubuntu package lists..."
    sudo apt-get update -qq || error_exit "Failed to update package lists"
    log "INFO" "System packages updated successfully."
}

install_nodejs() {
    local node_version="$1"
    
    if command -v node >/dev/null 2>&1; then
        local current_version=$(node --version | sed 's/v//')
        log "INFO" "Node.js already installed: v$current_version"
        
        # Check if version is acceptable
        if [[ "${current_version%%.*}" -ge "$node_version" ]]; then
            log "INFO" "Node.js version is sufficient."
            return 0
        else
            log "WARN" "Node.js version is too old. Installing newer version..."
        fi
    fi
    
    log "INFO" "Installing Node.js v$node_version via NodeSource repository..."
    
    # Install NodeSource repository
    curl -fsSL https://deb.nodesource.com/setup_${node_version}.x | sudo -E bash - || \
        error_exit "Failed to add NodeSource repository"
    
    # Install Node.js
    sudo apt-get install -y nodejs || error_exit "Failed to install Node.js"
    
    # Verify installation
    local installed_version=$(node --version)
    log "INFO" "Node.js installed successfully: $installed_version"
    log "INFO" "npm version: $(npm --version)"
}

install_pm2() {
    if command -v pm2 >/dev/null 2>&1; then
        log "INFO" "PM2 already installed: $(pm2 --version)"
        return 0
    fi
    
    log "INFO" "Installing PM2 globally..."
    sudo npm install -g pm2 || error_exit "Failed to install PM2"
    
    # Verify installation
    local pm2_version=$(pm2 --version)
    log "INFO" "PM2 installed successfully: v$pm2_version"
}

install_dependencies() {
    log "INFO" "Installing system dependencies..."
    sudo apt-get install -y curl wget git build-essential || \
        error_exit "Failed to install system dependencies"
    log "INFO" "System dependencies installed successfully."
}

#==============================================================================
# Runner Script Generation
#==============================================================================

create_runner_script() {
    local package_name="$1"
    local script_path="${SCRIPT_DIR}/${RUNNER_SCRIPT_NAME}"
    
    log "INFO" "Creating runner script at $script_path"
    
    cat > "$script_path" << EOF
#!/bin/bash

#==============================================================================
# Streaming Service Runner Script
# Automatically generated by PM2 setup script
#==============================================================================

set -euo pipefail

readonly PACKAGE="$package_name"
readonly LOG_PREFIX="[STREAMER]"

log_message() {
    echo "\$(date '+%Y-%m-%d %H:%M:%S') \$LOG_PREFIX \$1"
}

cleanup() {
    log_message "Received termination signal. Cleaning up..."
    exit 0
}

# Set up signal handlers
trap cleanup SIGTERM SIGINT

log_message "Starting streaming service runner..."
log_message "Package: \$PACKAGE@latest"

while true; do
    log_message "Launching streaming service..."
    
    # Run the package with error handling
    if npx "\$PACKAGE@latest"; then
        log_message "Streaming service exited normally."
    else
        local exit_code=\$?
        log_message "Streaming service exited with code \$exit_code"
    fi
    
    log_message "Restarting in 5 seconds..."
    sleep 5
done
EOF
    
    # Make script executable
    chmod +x "$script_path" || error_exit "Failed to make runner script executable"
    log "INFO" "Runner script created and made executable."
}

#==============================================================================
# PM2 Configuration
#==============================================================================

setup_pm2_process() {
    local ground_name="$1"
     local script_path="${SCRIPT_DIR}/${RUNNER_SCRIPT_NAME}"
     local process_name="${SERVICE_NAME_PREFIX}-${ground_name}"
    
    log "INFO" "Setting up PM2 process: $process_name"
    
    # Stop existing process if running
    if pm2 describe "$process_name" >/dev/null 2>&1; then
        log "WARN" "Process $process_name already exists. Stopping..."
        pm2 stop "$process_name" || true
        pm2 delete "$process_name" || true
    fi
    
    # Start new process
    pm2 start "$script_path" \
        --name "$process_name" \
        --instances "${PM2_INSTANCES:-1}" \
        --max-memory-restart "${PM2_MAX_MEMORY_RESTART:-500M}" \
        --autorestart "${PM2_AUTORESTART:-true}" \
        --watch false \
        --merge-logs \
        --log-date-format "YYYY-MM-DD HH:mm:ss Z" || \
        error_exit "Failed to start PM2 process"
    
    log "INFO" "PM2 process $process_name started successfully."
}

setup_pm2_startup() {
    log "INFO" "Configuring PM2 startup script..."
    
    # Generate startup script
    local startup_cmd=$(pm2 startup systemd -u "$USER" --hp "$HOME" | grep "sudo env")
    
    if [[ -n "$startup_cmd" ]]; then
        log "INFO" "Executing PM2 startup command..."
        eval "$startup_cmd" || error_exit "Failed to setup PM2 startup"
    fi
    
    # Save current PM2 process list
    pm2 save || error_exit "Failed to save PM2 process list"
    
    log "INFO" "PM2 startup configuration completed."
}

setup_log_rotation() {
    log "INFO" "Setting up PM2 log rotation..."
    
    # Install pm2-logrotate if not already installed
    if ! pm2 describe pm2-logrotate >/dev/null 2>&1; then
        pm2 install pm2-logrotate || error_exit "Failed to install pm2-logrotate"
    fi
    
    # Configure log rotation settings
    pm2 set pm2-logrotate:max_days 3 || error_exit "Failed to set log retention days"
    pm2 set pm2-logrotate:compress true || error_exit "Failed to enable log compression"
    pm2 set pm2-logrotate:rotateInterval '0 0 * * *' || error_exit "Failed to set rotation interval"
    pm2 set pm2-logrotate:max_size 10M || error_exit "Failed to set max log size"
    
    log "INFO" "Log rotation configured: 3-day retention, daily rotation, compression enabled."
}

#==============================================================================
# Keymetrics Integration
#==============================================================================

setup_keymetrics() {
    local public_key="$1"
    local private_key="$2"
    local machine_name="$3"
    local ground_tag="$4"
    
    if [[ -z "$public_key" || -z "$private_key" ]]; then
        log "WARN" "Keymetrics keys not provided. Skipping Keymetrics integration."
        return 0
    fi
    
    log "INFO" "Setting up Keymetrics integration..."
    log "INFO" "Machine name: $machine_name"
    
    # Link to Keymetrics
    pm2 link "$public_key" "$private_key" "$machine_name" || \
        error_exit "Failed to link PM2 to Keymetrics"
    
    # Set ground tag if provided
    if [[ -n "$ground_tag" ]]; then
        pm2 set pm2:tags "$ground_tag" || \
            log "WARN" "Failed to set ground tag: $ground_tag"
    fi
    
    log "INFO" "Keymetrics integration completed successfully."
}

#==============================================================================
# Validation and Health Checks
#==============================================================================

validate_setup() {
    log "INFO" "Validating PM2 setup..."
    
    # Check if PM2 is running
    if ! pm2 ping >/dev/null 2>&1; then
        error_exit "PM2 daemon is not responding"
    fi
    
    # Check if our process is running
    local process_name="${SERVICE_NAME_PREFIX}-${GROUND_NAME}"
    if ! pm2 describe "$process_name" >/dev/null 2>&1; then
        error_exit "Process $process_name is not found in PM2"
    fi
    
    # Check process status
    local status=$(pm2 jlist | jq -r ".[] | select(.name==\"$process_name\") | .pm2_env.status")
    if [[ "$status" != "online" ]]; then
        error_exit "Process $process_name is not online (status: $status)"
    fi
    
    log "INFO" "PM2 setup validation completed successfully."
}

show_status() {
    log "INFO" "Current PM2 status:"
    pm2 status
    
    log "INFO" "Process details:"
    pm2 describe "${SERVICE_NAME_PREFIX}-${GROUND_NAME}" || true
    
    log "INFO" "Recent logs:"
    pm2 logs "${SERVICE_NAME_PREFIX}-${GROUND_NAME}" --lines 10 || true
}

#==============================================================================
# Main Execution Flow
#==============================================================================

show_usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Options:
    -g, --ground-name NAME       Ground name (default: $DEFAULT_GROUND_NAME)
    -p, --package-name NAME     NPM package name (default: $DEFAULT_PACKAGE_NAME)
    -n, --node-version VERSION  Node.js version (default: $DEFAULT_NODE_VERSION)
    -k, --keymetrics-keys       Prompt for Keymetrics keys
    --config-only              Create sample configuration file only
    --validate-only             Validate existing setup only
    -h, --help                  Show this help message

Examples:
    $0                          # Use default configuration
    $0 -g groundA -p my-streamer # Setup for groundA with custom package
    $0 --config-only            # Create sample configuration file
    $0 --validate-only          # Validate existing setup

Configuration:
    Create a configuration file at $CONFIG_FILE to customize settings.
    Use --config-only to generate a sample configuration file.

EOF
}

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -g|--ground-name)
                GROUND_NAME="$2"
                shift 2
                ;;
            -p|--package-name)
                PACKAGE_NAME="$2"
                shift 2
                ;;
            -n|--node-version)
                NODE_VERSION="$2"
                shift 2
                ;;
            -k|--keymetrics-keys)
                PROMPT_KEYMETRICS=true
                shift
                ;;
            --config-only)
                CONFIG_ONLY=true
                shift
                ;;
            --validate-only)
                VALIDATE_ONLY=true
                shift
                ;;
            -h|--help)
                show_usage
                exit 0
                ;;
            *)
                error_exit "Unknown option: $1. Use -h for help."
                ;;
        esac
    done
}

prompt_keymetrics_keys() {
    if [[ "${PROMPT_KEYMETRICS:-false}" == "true" ]]; then
        echo -n "Enter Keymetrics Public Key (or press Enter to skip): "
        read -r KEYMETRICS_PUBLIC_KEY
        
        if [[ -n "$KEYMETRICS_PUBLIC_KEY" ]]; then
            echo -n "Enter Keymetrics Private Key: "
            read -r KEYMETRICS_PRIVATE_KEY
        fi
    fi
}

main() {
    log "INFO" "Starting PM2 Streaming Service Setup for Ubuntu Linux"
    log "INFO" "Script version: 1.0.0"
    
    # Parse command line arguments
    parse_arguments "$@"
    
    # Handle special modes
    if [[ "${CONFIG_ONLY:-false}" == "true" ]]; then
        create_sample_config
        exit 0
    fi
    
    # System checks
    check_root
    check_ubuntu
    check_sudo
    
    # Load configuration
    load_config
    
    # Prompt for Keymetrics keys if requested
    prompt_keymetrics_keys
    
    # Handle validate-only mode
    if [[ "${VALIDATE_ONLY:-false}" == "true" ]]; then
        validate_setup
        show_status
        exit 0
    fi
    
    log "INFO" "Configuration:"
    log "INFO" "  Ground Name: $GROUND_NAME"
    log "INFO" "  Package Name: $PACKAGE_NAME"
    log "INFO" "  Node.js Version: $NODE_VERSION"
    log "INFO" "  Machine Name: $MACHINE_NAME"
    
    # System setup
    update_system
    install_dependencies
    install_nodejs "$NODE_VERSION"
    install_pm2
    
    # PM2 configuration
    create_runner_script "$PACKAGE_NAME"
    setup_pm2_process "$GROUND_NAME"
    setup_log_rotation
    setup_pm2_startup
    
    # Keymetrics integration
    setup_keymetrics "$KEYMETRICS_PUBLIC_KEY" "$KEYMETRICS_PRIVATE_KEY" "$MACHINE_NAME" "$GROUND_TAG"
    
    # Validation
    validate_setup
    
    log "INFO" "PM2 setup completed successfully!"
    log "INFO" "Process name: ${SERVICE_NAME_PREFIX}-${GROUND_NAME}"
    log "INFO" "Machine name: $MACHINE_NAME"
    
    show_status
    
    log "INFO" "Setup complete. The streaming service is now running under PM2 supervision."
    log "INFO" "Use 'pm2 status' to check process status."
    log "INFO" "Use 'pm2 logs ${SERVICE_NAME_PREFIX}-${GROUND_NAME}' to view logs."
}

# Execute main function with all arguments
main "$@"