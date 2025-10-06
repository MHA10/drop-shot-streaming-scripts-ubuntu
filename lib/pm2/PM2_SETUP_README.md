# PM2 Streaming Service Setup for Ubuntu Linux

This repository contains a comprehensive automation script for setting up PM2-managed streaming services across multiple Ubuntu Linux servers. The script automates the complete configuration process outlined in the flow document.

## 🚀 Quick Start

### Single Server Setup
```bash
# Basic setup with ground name
sudo ./setup-pm2-ubuntu.sh -g groundA

# With custom configuration
sudo ./setup-pm2-ubuntu.sh -g groundA -p streamer-node -n 18 -c /path/to/custom-config.conf
```

### Advanced Setup with Configuration
```bash
# Create a configuration file first
./setup-pm2-ubuntu.sh --config-only

# Edit the configuration file
nano pm2-config.conf

# Run the setup with your configuration
./setup-pm2-ubuntu.sh
```

## 🌍 Environment Variables

### DROPSHOT_GROUND_ID

The system now supports using the `DROPSHOT_GROUND_ID` environment variable to dynamically set the ground identifier. This provides flexibility for deployment automation and containerized environments.

#### Usage Examples

```bash
# Set environment variable and run setup
export DROPSHOT_GROUND_ID="court-alpha"
./setup-pm2-ubuntu.sh

# One-liner for quick deployment
DROPSHOT_GROUND_ID="court-beta" ./setup-pm2-ubuntu.sh

# Multi-server deployment with environment variable
export DROPSHOT_GROUND_ID="premium-court"
./deploy-multi-server.sh deploy-all
```

#### Configuration Priority

The system uses the following priority order for ground identification:

1. **Environment Variable**: `DROPSHOT_GROUND_ID` (highest priority)
2. **Command Line**: `-g, --ground-name` parameter
3. **Configuration File**: `GROUND_NAME` in `pm2-config.conf`
4. **Default Value**: `ground1` (fallback)

#### Benefits

- **Dynamic Deployment**: Set ground ID at runtime without modifying configuration files
- **Container Support**: Perfect for Docker and Kubernetes deployments
- **CI/CD Integration**: Easily integrate with automated deployment pipelines
- **Multi-Environment**: Use the same scripts across different environments

## 📋 Prerequisites

- **Operating System**: Ubuntu Linux (18.04 LTS or newer)
- **User Privileges**: Regular user account with sudo privileges
- **Network Access**: Internet connection for downloading packages
- **Disk Space**: At least 1GB free space for Node.js and dependencies

## 🛠 Features

### ✅ Automated Installation
- **Node.js**: Installs specified version via NodeSource repository
- **PM2**: Global installation with process management
- **Dependencies**: System packages (curl, wget, git, build-essential)
- **Log Rotation**: Automatic setup with 3-day retention

### ✅ Process Management
- **Auto-restart**: Automatic process restart on failure
- **Memory Management**: Configurable memory limits
- **Startup Scripts**: System boot integration
- **Health Monitoring**: Built-in validation and status checks

### ✅ Centralized Monitoring
- **Keymetrics Integration**: Optional cloud monitoring
- **Log Aggregation**: Centralized log viewing
- **Ground Tagging**: Filterable ground identification
- **Real-time Status**: Live process monitoring

## 📖 Usage Guide

### Command Line Options

```bash
Usage: ./setup-pm2-ubuntu.sh [OPTIONS]

Options:
    -g, --ground-name NAME      Ground name (default: ground1)
    -p, --package-name NAME     NPM package name (default: streamer-node)
    -n, --node-version VERSION  Node.js version (default: 18)
    -k, --keymetrics-keys       Prompt for Keymetrics keys
    --config-only              Create sample configuration file only
    --validate-only             Validate existing setup only
    -h, --help                  Show this help message
```

### Configuration File

Create a `pm2-config.conf` file to customize your setup:

```bash
# PM2 Streaming Service Configuration

# Ground identification using environment variable
# Set DROPSHOT_GROUND_ID before running the setup:
# export DROPSHOT_GROUND_ID="your-ground-id"
GROUND_NAME="${DROPSHOT_GROUND_ID:-ground1}"
MACHINE_NAME="${DROPSHOT_GROUND_ID:-ground1}-server"
GROUND_TAG="ground=${DROPSHOT_GROUND_ID:-ground1}"

# Package configuration
PACKAGE_NAME="streamer-node"

# Node.js version (18, 20, etc.)
NODE_VERSION="18"

# Keymetrics configuration (optional)
KEYMETRICS_PUBLIC_KEY="your_public_key_here"
KEYMETRICS_PRIVATE_KEY="your_private_key_here"

# Additional PM2 options
PM2_INSTANCES="1"
PM2_MAX_MEMORY_RESTART="4G"
```

## 🏗 Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Ubuntu Linux Server                      │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │   Node.js       │  │      PM2        │  │ Log Rotation │ │
│  │   Runtime       │  │   Process Mgr   │  │   (3 days)   │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐ │
│  │            Streaming Service Runner                     │ │
│  │         (run-streamer.sh + npx streamer-node)          │ │
│  └─────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              Keymetrics Integration                     │ │
│  │        (Optional Cloud Monitoring)                     │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## 🔧 Multi-Server Deployment

### Method 1: Using Environment Variables (Recommended)

The simplest approach using `DROPSHOT_GROUND_ID`:

```bash
# Deploy to Ground A
ssh user@server-a "export DROPSHOT_GROUND_ID='groundA' && ./setup-pm2-ubuntu.sh"

# Deploy to Ground B  
ssh user@server-b "export DROPSHOT_GROUND_ID='groundB' && ./setup-pm2-ubuntu.sh"

# Deploy to Premium Ground
ssh user@server-premium "export DROPSHOT_GROUND_ID='premium-ground' && ./setup-pm2-ubuntu.sh"
```

### Method 2: Using deploy-multi-server.sh Script

```bash
# Create servers configuration file
./deploy-multi-server.sh create-config

# Deploy to all configured servers
./deploy-multi-server.sh deploy-all

# Deploy to specific server
./deploy-multi-server.sh deploy-single groundA
```

### Method 3: Traditional Configuration Files

For each server, create a unique configuration:

```bash
# Server 1 (Ground A)
cat > ground-a-config.conf << EOF
GROUND_NAME="${DROPSHOT_GROUND_ID:-groundA}"
MACHINE_NAME="${DROPSHOT_GROUND_ID:-groundA}-server"
GROUND_TAG="ground=${DROPSHOT_GROUND_ID:-groundA}"
PACKAGE_NAME="streamer-node"
KEYMETRICS_PUBLIC_KEY="your_key"
KEYMETRICS_PRIVATE_KEY="your_key"
EOF
```

### Step 2: Deploy to Servers

```bash
# Copy files to each server
scp setup-pm2-ubuntu.sh ground-a-config.conf user@server-a:~/

# Execute with environment variable
ssh user@server-a "cd ~ && export DROPSHOT_GROUND_ID='groundA' && ./setup-pm2-ubuntu.sh"
```

### Step 3: Verify Deployment

```bash
# Check status on each server
ssh user@server-a "pm2 status"
ssh user@server-b "pm2 status"

# View logs
ssh user@server-a "pm2 logs streamer-groundA --lines 20"
ssh user@server-b "pm2 logs streamer-groundB --lines 20"
```

## 🔍 Monitoring and Management

### PM2 Commands

```bash
# View all processes
pm2 status

# View specific process
pm2 describe streamer-groundA

# View logs
pm2 logs streamer-groundA
pm2 logs streamer-groundA --lines 50

# Restart process
pm2 restart streamer-groundA

# Stop process
pm2 stop streamer-groundA

# Monitor in real-time
pm2 monit
```

### Log Management

```bash
# View current logs
pm2 logs

# Flush all logs
pm2 flush

# View log rotation status
pm2 describe pm2-logrotate

# Manual log rotation
pm2 reloadLogs
```

### System Integration

```bash
# Check if PM2 starts on boot
systemctl status pm2-$USER

# Manually save current process list
pm2 save

# Manually setup startup (if needed)
pm2 startup
```

## 🚨 Troubleshooting

### Common Issues

#### 1. Permission Denied
```bash
# Fix script permissions
chmod +x setup-pm2-ubuntu.sh

# Check sudo access
sudo -v
```

#### 2. Node.js Installation Fails
```bash
# Manual Node.js installation
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version
npm --version
```

#### 3. PM2 Process Not Starting
```bash
# Check PM2 daemon
pm2 ping

# Restart PM2 daemon
pm2 kill
pm2 resurrect

# Check process logs
pm2 logs streamer-groundA --err
```

#### 4. Environment Variable Issues
```bash
# Check if DROPSHOT_GROUND_ID is set
echo "DROPSHOT_GROUND_ID: $DROPSHOT_GROUND_ID"

# Verify configuration loading
grep -n "DROPSHOT_GROUND_ID" pm2-config.conf

# Test environment variable expansion
bash -c 'export DROPSHOT_GROUND_ID="test-ground"; echo "Ground: ${DROPSHOT_GROUND_ID:-ground1}"'

# Check PM2 process with correct ground name
pm2 describe streamer-${DROPSHOT_GROUND_ID:-ground1}A
```

#### 5. Configuration Priority Debug
```bash
# Show all configuration sources
echo "1. Environment Variable: $DROPSHOT_GROUND_ID"
echo "2. Config File GROUND_NAME: $(grep GROUND_NAME pm2-config.conf | cut -d'=' -f2)"
echo "3. Default fallback: ground1"

# Verify which value is being used
./setup-pm2-ubuntu.sh --validate-only
```

#### 4. Keymetrics Connection Issues
```bash
# Check network connectivity
curl -I https://app.keymetrics.io

# Verify keys
pm2 web

# Re-link to Keymetrics
pm2 unlink
pm2 link <public_key> <private_key> <machine_name>
```

### Validation Commands

```bash
# Validate setup
./setup-pm2-ubuntu.sh --validate-only

# Check system status
systemctl status pm2-$USER
pm2 status
pm2 describe streamer-groundA

# Test runner script manually
./run-streamer.sh
```

## 📊 Performance Considerations

### Resource Requirements

| Component | CPU | Memory | Disk |
|-----------|-----|--------|------|
| Node.js Runtime | 0.1-0.5 cores | 50-100MB | 200MB |
| PM2 Daemon | 0.05 cores | 20-50MB | 50MB |
| Streaming Service | 0.2-1.0 cores | 100-500MB | Variable |
| Log Storage | - | - | 100MB/day |

### Optimization Tips

1. **Memory Management**: Set appropriate `PM2_MAX_MEMORY_RESTART` values
2. **Log Rotation**: Keep 3-day retention to balance debugging and disk usage
3. **Process Monitoring**: Use Keymetrics for centralized monitoring
4. **Network Optimization**: Ensure stable internet connection for streaming
5. **System Updates**: Keep Ubuntu and Node.js updated for security

## 🔐 Security Best Practices

### Environment Security
- Never commit Keymetrics keys to version control
- Use environment variables for sensitive configuration
- Regularly update system packages
- Monitor process logs for suspicious activity

### Network Security
- Configure firewall rules for required ports
- Use SSH key authentication for server access
- Implement VPN for server management if needed
- Monitor network traffic for anomalies

## 📝 Logging and Auditing

### Log Locations
- **PM2 Logs**: `~/.pm2/logs/`
- **Setup Logs**: `/var/log/pm2-setup.log`
- **System Logs**: `/var/log/syslog`

### Log Analysis
```bash
# View setup logs
sudo tail -f /var/log/pm2-setup.log

# View PM2 logs
pm2 logs --timestamp

# Search for errors
pm2 logs | grep -i error

# Export logs for analysis
pm2 logs --json > logs-export.json
```

## 🤝 Support and Maintenance

### Regular Maintenance Tasks

1. **Weekly**: Check process status and logs
2. **Monthly**: Update system packages
3. **Quarterly**: Review and update Node.js version
4. **As Needed**: Update streaming package to latest version

### Getting Help

1. **Validate Setup**: Run `./setup-pm2-ubuntu.sh --validate-only`
2. **Check Logs**: Review PM2 and system logs
3. **Test Manually**: Run the streaming service directly
4. **Contact Support**: Provide logs and configuration details

---

**Author**: Muhammad Hamza Ashraf  
**Version**: 1.0.0  
**Last Updated**: $(date +%Y-%m-%d)  
**License**: MIT

## Configuration File

The script uses a configuration file (`pm2-config.conf`) with the following structure:

```bash
# Ground Identification Settings
GROUND_NAME="groundA"
MACHINE_NAME="groundA-server"
GROUND_TAG="ground=groundA"

# Package configuration
PACKAGE_NAME="streamer-node"

# Node.js version (18, 20, etc.)
NODE_VERSION="18"

# Keymetrics configuration (optional)
KEYMETRICS_PUBLIC_KEY="your_public_key_here"
KEYMETRICS_PRIVATE_KEY="your_private_key_here"

# Additional PM2 options
PM2_INSTANCES="1"
PM2_MAX_MEMORY_RESTART="500M"
```

## Command Line Options

| Option | Short | Description | Example |
|--------|-------|-------------|---------|
| `--ground-name` | `-g` | Ground identifier | `-g groundA` |

### Configuration Parameters

#### Ground Identification
- `GROUND_NAME`: Unique identifier for the ground
- `MACHINE_NAME`: Server machine name (typically `{ground}-server`)
- `GROUND_TAG`: Tag for process identification (`ground={name}`)

### Example Configurations

#### Standard Ground
```bash
GROUND_NAME="groundA"
MACHINE_NAME="groundA-server"
GROUND_TAG="ground=groundA"

# Package configuration
PACKAGE_NAME="streamer-node"

# Node.js version (18, 20, etc.)
NODE_VERSION="18"

# Keymetrics configuration (optional)
KEYMETRICS_PUBLIC_KEY="your_public_key_here"
KEYMETRICS_PRIVATE_KEY="your_private_key_here"

# Additional PM2 options
PM2_INSTANCES="1"
PM2_MAX_MEMORY_RESTART="500M"
```

#### Premium Ground
```bash
GROUND_NAME="premium"
MACHINE_NAME="premium-server"
GROUND_TAG="ground=premium"

# Package configuration
PACKAGE_NAME="streamer-node"

# Node.js version (18, 20, etc.)
NODE_VERSION="18"

# Keymetrics configuration (optional)
KEYMETRICS_PUBLIC_KEY="your_public_key_here"
KEYMETRICS_PRIVATE_KEY="your_private_key_here"

# Additional PM2 options
PM2_INSTANCES="1"
PM2_MAX_MEMORY_RESTART="500M"
```

## Multi-Server Deployment

### Configuration Format
```
# Format: SERVER_NAME:SSH_HOST:SSH_USER:GROUND_NAME:PACKAGE_NAME:NODE_VERSION:KEYMETRICS_PUBLIC:KEYMETRICS_PRIVATE

# Examples:
ground-a:192.168.1.10:ubuntu:groundA:streamer-node:18:pub_key:priv_key
ground-b:192.168.1.11:ubuntu:groundB:streamer-node:18:pub_key:priv_key
premium-ground:192.168.1.12:ubuntu:premium:streamer-node-premium:20:pub_key:priv_key

# Package configuration
PACKAGE_NAME="streamer-node"

# Node.js version (18, 20, etc.)
NODE_VERSION="18"

# Keymetrics configuration (optional)
KEYMETRICS_PUBLIC_KEY="your_public_key_here"
KEYMETRICS_PRIVATE_KEY="your_private_key_here"

# Additional PM2 options
PM2_INSTANCES="1"
PM2_MAX_MEMORY_RESTART="500M"
```

### Deployment Commands
```bash
# Deploy to all servers
./deploy-multi-server.sh deploy

# Deploy to specific server
./deploy-multi-server.sh deploy-single ground-a

# Package configuration
PACKAGE_NAME="streamer-node"

# Node.js version (18, 20, etc.)
NODE_VERSION="18"

# Keymetrics configuration (optional)
KEYMETRICS_PUBLIC_KEY="your_public_key_here"
KEYMETRICS_PRIVATE_KEY="your_private_key_here"

# Additional PM2 options
PM2_INSTANCES="1"
PM2_MAX_MEMORY_RESTART="500M"
```

### Monitoring Commands
```bash
# Single Server
```bash
# Check PM2 status
pm2 status

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for specific ground
pm2 logs streamer-groundA

# View logs for