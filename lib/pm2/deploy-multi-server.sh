#!/bin/bash

#==============================================================================
# Multi-Server PM2 Deployment Script
# Automates deployment of PM2 streaming services across multiple Ubuntu servers
#
# Environment Variables:
#   DROPSHOT_GROUND_ID - Ground identifier (can be set on target servers)
#
# Author: Muhammad Hamza Ashraf
# Date: $(date +%Y-%m-%d)
# Version: 1.0.0
#==============================================================================

set -euo pipefail

# Color codes for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m' # No Color

# Script configuration
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SERVERS_CONFIG="${SCRIPT_DIR}/servers.conf"
readonly DEPLOYMENT_LOG="${SCRIPT_DIR}/deployment.log"

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
    
    # Also log to file
    echo "[$timestamp] [$level] $message" >> "$DEPLOYMENT_LOG"
}

error_exit() {
    log "ERROR" "$1"
    exit 1
}

#==============================================================================
# Configuration Management
#==============================================================================

create_sample_servers_config() {
    cat > "$SERVERS_CONFIG" << 'EOF'
# Multi-Server Configuration File
# Format: SERVER_NAME:SSH_HOST:SSH_USER:GROUND_NAME:PACKAGE_NAME:NODE_VERSION:KEYMETRICS_PUBLIC:KEYMETRICS_PRIVATE
#
# Example entries:
# ground-a:192.168.1.10:ubuntu:groundA:streamer-node:18:pub_key:priv_key
# ground-b:192.168.1.11:ubuntu:groundB:streamer-node:18:pub_key:priv_key
# premium-ground:192.168.1.12:ubuntu:premium:streamer-node-premium:20:pub_key:priv_key

# Add your server configurations below:
# ground-a:192.168.1.10:ubuntu:groundA:streamer-node:18::
# ground-b:192.168.1.11:ubuntu:groundB:streamer-node:18::
EOF
    log "INFO" "Sample servers configuration created at $SERVERS_CONFIG"
    log "INFO" "Please edit this file and add your server details."
}

validate_servers_config() {
    if [[ ! -f "$SERVERS_CONFIG" ]]; then
        log "ERROR" "Servers configuration file not found: $SERVERS_CONFIG"
        log "INFO" "Creating sample configuration file..."
        create_sample_servers_config
        error_exit "Please configure your servers in $SERVERS_CONFIG and run again."
    fi
    
    # Check if file has any non-comment, non-empty lines
    if ! grep -v '^#' "$SERVERS_CONFIG" | grep -v '^[[:space:]]*$' >/dev/null; then
        error_exit "No server configurations found in $SERVERS_CONFIG. Please add your servers."
    fi
    
    log "INFO" "Servers configuration file validated."
}

#==============================================================================
# SSH and Connectivity
#==============================================================================

test_ssh_connection() {
    local host="$1"
    local user="$2"
    
    log "DEBUG" "Testing SSH connection to $user@$host"
    
    if ssh -o ConnectTimeout=10 -o BatchMode=yes "$user@$host" "echo 'SSH connection successful'" >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

copy_files_to_server() {
    local host="$1"
    local user="$2"
    local config_content="$3"
    
    log "INFO" "Copying files to $user@$host"
    
    # Copy main setup script
    if ! scp -o ConnectTimeout=30 "${SCRIPT_DIR}/setup-pm2-ubuntu.sh" "$user@$host:~/"; then
        log "ERROR" "Failed to copy setup script to $user@$host"
        return 1
    fi
    
    # Create and copy configuration file
    echo "$config_content" | ssh "$user@$host" "cat > ~/pm2-config.conf"
    
    # Make script executable
    ssh "$user@$host" "chmod +x ~/setup-pm2-ubuntu.sh"
    
    log "INFO" "Files copied successfully to $user@$host"
    return 0
}

#==============================================================================
# Deployment Functions
#==============================================================================

deploy_to_server() {
    local server_name="$1"
    local host="$2"
    local user="$3"
    local ground_name="$4"
    local package_name="$5"
    local node_version="$6"
    local keymetrics_public="$7"
    local keymetrics_private="$8"
    
    log "INFO" "Starting deployment to $server_name ($user@$host)"
    
    # Test SSH connection
    if ! test_ssh_connection "$host" "$user"; then
        log "ERROR" "Cannot connect to $user@$host via SSH"
        return 1
    fi
    
    # Generate configuration content
    local config_content=$(cat << EOF
# PM2 Configuration for $server_name
# Ground ID from environment variable DROPSHOT_GROUND_ID
# Set the environment variable before running the setup:
# export DROPSHOT_GROUND_ID="$ground_name"
# If not set, falls back to default value
GROUND_NAME="\${DROPSHOT_GROUND_ID:-$ground_name}"
MACHINE_NAME="\${DROPSHOT_GROUND_ID:-$ground_name}-server"
GROUND_TAG="ground=\${DROPSHOT_GROUND_ID:-$ground_name}"
PACKAGE_NAME="$package_name"
NODE_VERSION="$node_version"
KEYMETRICS_PUBLIC_KEY="$keymetrics_public"
KEYMETRICS_PRIVATE_KEY="$keymetrics_private"
PM2_INSTANCES="1"
PM2_MAX_MEMORY_RESTART="4G"
EOF
)
    
    # Copy files to server
    if ! copy_files_to_server "$host" "$user" "$config_content"; then
        log "ERROR" "Failed to copy files to $server_name"
        return 1
    fi
    
    # Execute setup script on remote server with environment variable
    log "INFO" "Executing PM2 setup on $server_name with DROPSHOT_GROUND_ID=$ground_name"
    if ssh "$user@$host" "cd ~ && export DROPSHOT_GROUND_ID='$ground_name' && ./setup-pm2-ubuntu.sh"; then
        log "INFO" "PM2 setup completed successfully on $server_name"
        return 0
    else
        log "ERROR" "PM2 setup failed on $server_name"
        return 1
    fi
}

validate_deployment() {
    local server_name="$1"
    local host="$2"
    local user="$3"
    local ground_name="$4"
    
    log "INFO" "Validating deployment on $server_name"
    
    # Check if PM2 is running
    if ! ssh "$user@$host" "pm2 ping >/dev/null 2>&1"; then
        log "ERROR" "PM2 is not running on $server_name"
        return 1
    fi
    
    # Check if our process exists
    local process_name="streamer-$ground_name"
    if ! ssh "$user@$host" "pm2 describe '$process_name' >/dev/null 2>&1"; then
        log "ERROR" "Process $process_name not found on $server_name"
        return 1
    fi
    
    # Check process status
    local status=$(ssh "$user@$host" "pm2 jlist | jq -r '.[] | select(.name==\"$process_name\") | .pm2_env.status'")
    if [[ "$status" != "online" ]]; then
        log "ERROR" "Process $process_name is not online on $server_name (status: $status)"
        return 1
    fi
    
    log "INFO" "Deployment validation successful on $server_name"
    return 0
}

#==============================================================================
# Monitoring and Management
#==============================================================================

show_all_status() {
    log "INFO" "Checking status across all servers..."
    
    while IFS=':' read -r server_name host user ground_name package_name node_version keymetrics_public keymetrics_private; do
        # Skip comments and empty lines
        [[ "$server_name" =~ ^#.*$ ]] && continue
        [[ -z "$server_name" ]] && continue
        
        echo
        log "INFO" "=== Status for $server_name ($user@$host) ==="
        
        if test_ssh_connection "$host" "$user"; then
            ssh "$user@$host" "pm2 status" || log "ERROR" "Failed to get PM2 status from $server_name"
        else
            log "ERROR" "Cannot connect to $server_name"
        fi
    done < "$SERVERS_CONFIG"
}

show_all_logs() {
    local lines="${1:-20}"
    
    log "INFO" "Showing logs from all servers (last $lines lines)..."
    
    while IFS=':' read -r server_name host user ground_name package_name node_version keymetrics_public keymetrics_private; do
        # Skip comments and empty lines
        [[ "$server_name" =~ ^#.*$ ]] && continue
        [[ -z "$server_name" ]] && continue
        
        echo
        log "INFO" "=== Logs for $server_name ($user@$host) ==="
        
        if test_ssh_connection "$host" "$user"; then
            ssh "$user@$host" "pm2 logs streamer-$ground_name --lines $lines" || \
                log "ERROR" "Failed to get logs from $server_name"
        else
            log "ERROR" "Cannot connect to $server_name"
        fi
    done < "$SERVERS_CONFIG"
}

restart_all_services() {
    log "INFO" "Restarting services on all servers..."
    
    while IFS=':' read -r server_name host user ground_name package_name node_version keymetrics_public keymetrics_private; do
        # Skip comments and empty lines
        [[ "$server_name" =~ ^#.*$ ]] && continue
        [[ -z "$server_name" ]] && continue
        
        log "INFO" "Restarting service on $server_name"
        
        if test_ssh_connection "$host" "$user"; then
            ssh "$user@$host" "pm2 restart streamer-$ground_name" || \
                log "ERROR" "Failed to restart service on $server_name"
        else
            log "ERROR" "Cannot connect to $server_name"
        fi
    done < "$SERVERS_CONFIG"
}

#==============================================================================
# Main Execution Flow
#==============================================================================

show_usage() {
    cat << EOF
Usage: $0 [COMMAND] [OPTIONS]

Commands:
    deploy              Deploy PM2 setup to all configured servers
    deploy-single NAME  Deploy to a specific server by name
    status              Show PM2 status from all servers
    logs [LINES]        Show logs from all servers (default: 20 lines)
    restart             Restart services on all servers
    validate            Validate deployments on all servers
    config              Create sample servers configuration file
    
Options:
    -h, --help          Show this help message
    -v, --verbose       Enable verbose logging

Examples:
    $0 deploy                    # Deploy to all servers
    $0 deploy-single ground-a     # Deploy to specific server
    $0 status                    # Check status of all servers
    $0 logs 50                   # Show last 50 log lines from all servers
    $0 restart                   # Restart all services
    $0 validate                  # Validate all deployments

Configuration:
    Edit $SERVERS_CONFIG to configure your servers.
    Use '$0 config' to create a sample configuration file.

EOF
}

deploy_all_servers() {
    log "INFO" "Starting deployment to all configured servers..."
    
    local success_count=0
    local total_count=0
    local failed_servers=()
    
    while IFS=':' read -r server_name host user ground_name package_name node_version keymetrics_public keymetrics_private; do
        # Skip comments and empty lines
        [[ "$server_name" =~ ^#.*$ ]] && continue
        [[ -z "$server_name" ]] && continue
        
        ((total_count++))
        
        echo
        log "INFO" "=== Deploying to $server_name ($user@$host) ==="
        
        if deploy_to_server "$server_name" "$host" "$user" "$ground_name" "$package_name" "$node_version" "$keymetrics_public" "$keymetrics_private"; then
            ((success_count++))
            log "INFO" "✅ Deployment successful: $server_name"
        else
            failed_servers+=("$server_name")
            log "ERROR" "❌ Deployment failed: $server_name"
        fi
    done < "$SERVERS_CONFIG"
    
    echo
    log "INFO" "=== Deployment Summary ==="
    log "INFO" "Total servers: $total_count"
    log "INFO" "Successful deployments: $success_count"
    log "INFO" "Failed deployments: $((total_count - success_count))"
    
    if [[ ${#failed_servers[@]} -gt 0 ]]; then
        log "ERROR" "Failed servers: ${failed_servers[*]}"
        return 1
    else
        log "INFO" "All deployments completed successfully!"
        return 0
    fi
}

deploy_single_server() {
    local target_server="$1"
    
    log "INFO" "Deploying to single server: $target_server"
    
    while IFS=':' read -r server_name host user ground_name package_name node_version keymetrics_public keymetrics_private; do
        # Skip comments and empty lines
        [[ "$server_name" =~ ^#.*$ ]] && continue
        [[ -z "$server_name" ]] && continue
        
        if [[ "$server_name" == "$target_server" ]]; then
            log "INFO" "Found server configuration for $target_server"
            deploy_to_server "$server_name" "$host" "$user" "$ground_name" "$package_name" "$node_version" "$keymetrics_public" "$keymetrics_private"
            return $?
        fi
    done < "$SERVERS_CONFIG"
    
    error_exit "Server '$target_server' not found in configuration file."
}

validate_all_deployments() {
    log "INFO" "Validating deployments on all servers..."
    
    local success_count=0
    local total_count=0
    
    while IFS=':' read -r server_name host user ground_name package_name node_version keymetrics_public keymetrics_private; do
        # Skip comments and empty lines
        [[ "$server_name" =~ ^#.*$ ]] && continue
        [[ -z "$server_name" ]] && continue
        
        ((total_count++))
        
        if validate_deployment "$server_name" "$host" "$user" "$ground_name"; then
            ((success_count++))
        fi
    done < "$SERVERS_CONFIG"
    
    log "INFO" "Validation complete: $success_count/$total_count servers validated successfully"
    
    if [[ $success_count -eq $total_count ]]; then
        return 0
    else
        return 1
    fi
}

main() {
    local command="${1:-}"
    
    case "$command" in
        "deploy")
            validate_servers_config
            deploy_all_servers
            ;;
        "deploy-single")
            local server_name="${2:-}"
            if [[ -z "$server_name" ]]; then
                error_exit "Please specify a server name. Usage: $0 deploy-single SERVER_NAME"
            fi
            validate_servers_config
            deploy_single_server "$server_name"
            ;;
        "status")
            validate_servers_config
            show_all_status
            ;;
        "logs")
            local lines="${2:-20}"
            validate_servers_config
            show_all_logs "$lines"
            ;;
        "restart")
            validate_servers_config
            restart_all_services
            ;;
        "validate")
            validate_servers_config
            validate_all_deployments
            ;;
        "config")
            create_sample_servers_config
            ;;
        "-h"|"--help"|"help"|"")
            show_usage
            ;;
        *)
            error_exit "Unknown command: $command. Use -h for help."
            ;;
    esac
}

# Initialize logging
echo "=== Multi-Server PM2 Deployment Started at $(date) ===" >> "$DEPLOYMENT_LOG"

# Execute main function
main "$@"