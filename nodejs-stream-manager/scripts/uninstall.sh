#!/bin/bash

# Node.js Stream Manager Uninstall Script
# This script removes the stream manager service and cleans up all files

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PROJECT_DIR="/opt/stream-manager"
SERVICE_USER="stream-manager"
LOG_DIR="/var/log/stream-manager"
DATA_DIR="/var/lib/stream-manager"
SERVICE_NAME="stream-manager"

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This script must be run as root (use sudo)"
        exit 1
    fi
}

confirm_uninstall() {
    echo -e "${YELLOW}WARNING: This will completely remove the Stream Manager service and all its data.${NC}"
    echo "The following will be removed:"
    echo "  - Service: $SERVICE_NAME"
    echo "  - User: $SERVICE_USER"
    echo "  - Project directory: $PROJECT_DIR"
    echo "  - Log directory: $LOG_DIR"
    echo "  - Data directory: $DATA_DIR"
    echo
    read -p "Are you sure you want to continue? (yes/no): " -r
    
    if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
        log_info "Uninstall cancelled"
        exit 0
    fi
}

backup_data() {
    log_info "Creating backup of configuration and data..."
    
    BACKUP_DIR="/tmp/stream-manager-backup-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$BACKUP_DIR"
    
    # Backup configuration
    if [[ -d "$PROJECT_DIR/config" ]]; then
        cp -r "$PROJECT_DIR/config" "$BACKUP_DIR/"
        log_info "Configuration backed up to $BACKUP_DIR/config"
    fi
    
    # Backup data
    if [[ -d "$DATA_DIR" ]]; then
        cp -r "$DATA_DIR" "$BACKUP_DIR/data"
        log_info "Data backed up to $BACKUP_DIR/data"
    fi
    
    # Backup logs (last 100 lines of each log file)
    if [[ -d "$LOG_DIR" ]]; then
        mkdir -p "$BACKUP_DIR/logs"
        for log_file in "$LOG_DIR"/*.log; do
            if [[ -f "$log_file" ]]; then
                tail -100 "$log_file" > "$BACKUP_DIR/logs/$(basename "$log_file")"
            fi
        done
        log_info "Recent logs backed up to $BACKUP_DIR/logs"
    fi
    
    log_success "Backup created at: $BACKUP_DIR"
}

stop_service() {
    log_info "Stopping and disabling service..."
    
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        systemctl stop "$SERVICE_NAME"
        log_info "Service stopped"
    fi
    
    if systemctl is-enabled --quiet "$SERVICE_NAME"; then
        systemctl disable "$SERVICE_NAME"
        log_info "Service disabled"
    fi
    
    log_success "Service stopped and disabled"
}

remove_systemd_service() {
    log_info "Removing systemd service..."
    
    if [[ -f "/etc/systemd/system/$SERVICE_NAME.service" ]]; then
        rm -f "/etc/systemd/system/$SERVICE_NAME.service"
        systemctl daemon-reload
        log_success "Systemd service removed"
    else
        log_warning "Systemd service file not found"
    fi
}

remove_logrotate() {
    log_info "Removing logrotate configuration..."
    
    if [[ -f "/etc/logrotate.d/$SERVICE_NAME" ]]; then
        rm -f "/etc/logrotate.d/$SERVICE_NAME"
        log_success "Logrotate configuration removed"
    else
        log_warning "Logrotate configuration not found"
    fi
}

remove_monitoring_script() {
    log_info "Removing monitoring script..."
    
    if [[ -f "/usr/local/bin/stream-manager-monitor" ]]; then
        rm -f "/usr/local/bin/stream-manager-monitor"
        log_success "Monitoring script removed"
    else
        log_warning "Monitoring script not found"
    fi
}

kill_processes() {
    log_info "Terminating any remaining processes..."
    
    # Kill any FFmpeg processes started by the service user
    if id "$SERVICE_USER" &>/dev/null; then
        pkill -u "$SERVICE_USER" -f ffmpeg || true
        pkill -u "$SERVICE_USER" -f node || true
        sleep 2
        pkill -9 -u "$SERVICE_USER" || true
        log_info "Processes terminated"
    fi
}

remove_directories() {
    log_info "Removing directories..."
    
    # Remove project directory
    if [[ -d "$PROJECT_DIR" ]]; then
        rm -rf "$PROJECT_DIR"
        log_info "Project directory removed: $PROJECT_DIR"
    fi
    
    # Remove log directory
    if [[ -d "$LOG_DIR" ]]; then
        rm -rf "$LOG_DIR"
        log_info "Log directory removed: $LOG_DIR"
    fi
    
    # Remove data directory
    if [[ -d "$DATA_DIR" ]]; then
        rm -rf "$DATA_DIR"
        log_info "Data directory removed: $DATA_DIR"
    fi
    
    log_success "Directories removed"
}

remove_user() {
    log_info "Removing service user..."
    
    if id "$SERVICE_USER" &>/dev/null; then
        userdel "$SERVICE_USER" || true
        log_success "User $SERVICE_USER removed"
    else
        log_warning "User $SERVICE_USER not found"
    fi
}

cleanup_firewall() {
    log_info "Cleaning up firewall rules..."
    
    if command -v ufw &> /dev/null; then
        # Remove application port rule (if it exists)
        ufw delete allow 3000/tcp 2>/dev/null || true
        log_info "Firewall rules cleaned up"
    else
        log_warning "UFW not installed, skipping firewall cleanup"
    fi
}

remove_nodejs() {
    read -p "Do you want to remove Node.js as well? (yes/no): " -r
    
    if [[ $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
        log_info "Removing Node.js..."
        apt remove -y nodejs npm
        apt autoremove -y
        log_success "Node.js removed"
    else
        log_info "Keeping Node.js installed"
    fi
}

cleanup_swap() {
    log_info "Checking swap configuration..."
    
    if [[ -f /swapfile ]] && grep -q "/swapfile" /etc/fstab; then
        read -p "Remove the 1GB swap file created during installation? (yes/no): " -r
        
        if [[ $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
            swapoff /swapfile
            rm -f /swapfile
            sed -i '/\/swapfile/d' /etc/fstab
            log_success "Swap file removed"
        else
            log_info "Keeping swap file"
        fi
    fi
}

print_summary() {
    log_success "Uninstall completed successfully!"
    echo
    echo "=== Uninstall Summary ==="
    echo "✓ Service stopped and removed"
    echo "✓ User account removed"
    echo "✓ Directories cleaned up"
    echo "✓ Configuration files removed"
    echo "✓ Processes terminated"
    echo
    
    if [[ -n "$BACKUP_DIR" ]] && [[ -d "$BACKUP_DIR" ]]; then
        echo "=== Backup Location ==="
        echo "Your data has been backed up to: $BACKUP_DIR"
        echo "You can safely delete this backup if you don't need it."
        echo
    fi
    
    echo "=== Manual Cleanup (if needed) ==="
    echo "The following may need manual cleanup:"
    echo "- Any custom firewall rules"
    echo "- Any custom cron jobs"
    echo "- Any additional configuration files you created"
    echo
}

# Main uninstall process
main() {
    log_info "Starting Node.js Stream Manager uninstall..."
    
    check_root
    confirm_uninstall
    backup_data
    stop_service
    remove_systemd_service
    remove_logrotate
    remove_monitoring_script
    kill_processes
    remove_directories
    remove_user
    cleanup_firewall
    cleanup_swap
    remove_nodejs
    
    print_summary
}

# Run main function
main "$@"