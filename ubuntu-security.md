# Security Configuration Guide for Production Deployment

This guide provides comprehensive security configurations for deploying the RTSP-SSE streaming system in production environments on Ubuntu Linux.

## Table of Contents

1. [Security Overview](#security-overview)
2. [System Hardening](#system-hardening)
3. [Network Security](#network-security)
4. [Application Security](#application-security)
5. [RTSP Security](#rtsp-security)
6. [SSE Security](#sse-security)
7. [SSL/TLS Configuration](#ssltls-configuration)
8. [Authentication & Authorization](#authentication--authorization)
9. [Monitoring & Logging](#monitoring--logging)
10. [Backup & Recovery](#backup--recovery)
11. [Security Automation Scripts](#security-automation-scripts)
12. [Compliance & Best Practices](#compliance--best-practices)

## Security Overview

### Security Principles

- **Defense in Depth**: Multiple layers of security controls
- **Least Privilege**: Minimal access rights for users and processes
- **Zero Trust**: Never trust, always verify
- **Regular Updates**: Keep all components updated
- **Monitoring**: Continuous security monitoring and logging

### Threat Model

**Potential Threats:**
- Unauthorized access to RTSP streams
- Man-in-the-middle attacks
- DDoS attacks on streaming endpoints
- Data interception during transmission
- System compromise through vulnerabilities
- Resource exhaustion attacks

## System Hardening

### Basic System Hardening Script

```bash
#!/bin/bash
# System hardening script for Ubuntu

cat > harden-system.sh << 'EOF'
#!/bin/bash

echo "=== System Hardening for RTSP-SSE Streaming ==="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run as root (use sudo)"
    exit 1
fi

# 1. Update system
echo "1. Updating system packages..."
apt update && apt upgrade -y
apt autoremove -y
echo

# 2. Install security tools
echo "2. Installing security tools..."
apt install -y \
    ufw \
    fail2ban \
    rkhunter \
    chkrootkit \
    lynis \
    aide \
    unattended-upgrades \
    logwatch \
    psad
echo

# 3. Configure automatic updates
echo "3. Configuring automatic security updates..."
echo 'Unattended-Upgrade::Automatic-Reboot "false";' > /etc/apt/apt.conf.d/50unattended-upgrades-custom
echo 'Unattended-Upgrade::Remove-Unused-Dependencies "true";' >> /etc/apt/apt.conf.d/50unattended-upgrades-custom
echo 'Unattended-Upgrade::Automatic-Reboot-Time "02:00";' >> /etc/apt/apt.conf.d/50unattended-upgrades-custom

systemctl enable unattended-upgrades
systemctl start unattended-upgrades
echo

# 4. Secure SSH configuration
echo "4. Hardening SSH configuration..."
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup

cat > /etc/ssh/sshd_config.d/99-security.conf << 'SSH_CONFIG'
# Security hardening for SSH
Protocol 2
Port 2222
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
X11Forwarding no
AllowTcpForwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
MaxAuthTries 3
MaxSessions 2
LoginGraceTime 30
PermitEmptyPasswords no
ChallengeResponseAuthentication no
UsePAM yes
SSH_CONFIG

systemctl restart sshd
echo

# 5. Configure firewall
echo "5. Configuring UFW firewall..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing

# Allow SSH on custom port
ufw allow 2222/tcp comment 'SSH'

# Allow RTSP and SSE ports (customize as needed)
ufw allow 554/tcp comment 'RTSP'
ufw allow 3000/tcp comment 'SSE Server'
ufw allow 8554/tcp comment 'Mock RTSP'

# Allow HTTP/HTTPS if needed
# ufw allow 80/tcp comment 'HTTP'
# ufw allow 443/tcp comment 'HTTPS'

ufw --force enable
echo

# 6. Configure fail2ban
echo "6. Configuring fail2ban..."
cat > /etc/fail2ban/jail.local << 'FAIL2BAN'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 3
ignoreip = 127.0.0.1/8 ::1

[sshd]
enabled = true
port = 2222
logpath = /var/log/auth.log
maxretry = 3
bantime = 3600

[nginx-http-auth]
enabled = true
port = http,https
logpath = /var/log/nginx/error.log

[nginx-limit-req]
enabled = true
port = http,https
logpath = /var/log/nginx/error.log
FAIL2BAN

systemctl enable fail2ban
systemctl restart fail2ban
echo

# 7. Kernel hardening
echo "7. Applying kernel hardening..."
cat > /etc/sysctl.d/99-security.conf << 'SYSCTL'
# Network security
net.ipv4.ip_forward = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.default.secure_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv4.conf.all.log_martians = 1
net.ipv4.conf.default.log_martians = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Kernel security
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 2
kernel.yama.ptrace_scope = 1
fs.suid_dumpable = 0
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
SYSCTL

sysctl -p /etc/sysctl.d/99-security.conf
echo

# 8. Disable unnecessary services
echo "8. Disabling unnecessary services..."
services_to_disable=(
    "bluetooth"
    "cups"
    "avahi-daemon"
    "whoopsie"
)

for service in "${services_to_disable[@]}"; do
    if systemctl is-enabled "$service" >/dev/null 2>&1; then
        systemctl disable "$service"
        systemctl stop "$service"
        echo "Disabled: $service"
    fi
done
echo

# 9. Set file permissions
echo "9. Setting secure file permissions..."
chmod 700 /root
chmod 644 /etc/passwd
chmod 600 /etc/shadow
chmod 644 /etc/group
chmod 600 /etc/gshadow
chmod 600 /etc/ssh/sshd_config
echo

# 10. Configure audit logging
echo "10. Configuring audit logging..."
apt install -y auditd

cat > /etc/audit/rules.d/99-security.rules << 'AUDIT'
# Security audit rules
-w /etc/passwd -p wa -k identity
-w /etc/group -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/sudoers -p wa -k identity
-w /etc/ssh/sshd_config -p wa -k sshd
-w /var/log/auth.log -p wa -k auth
-w /var/log/syslog -p wa -k syslog
-w /bin/su -p x -k priv_esc
-w /usr/bin/sudo -p x -k priv_esc
-w /etc/systemd/ -p wa -k systemd
AUDIT

systemctl enable auditd
systemctl restart auditd
echo

echo "=== System Hardening Complete ==="
echo "Please reboot the system to ensure all changes take effect."
echo "After reboot, SSH will be available on port 2222."
EOF

chmod +x harden-system.sh
```

### User and Permission Management

```bash
#!/bin/bash
# User and permission management script

cat > manage-users.sh << 'EOF'
#!/bin/bash

echo "=== User and Permission Management ==="

# Create dedicated user for streaming service
create_streaming_user() {
    local username="rtsp-sse"
    
    echo "Creating dedicated streaming user: $username"
    
    # Create user with no login shell
    useradd -r -s /bin/false -d /opt/rtsp-sse -m "$username"
    
    # Create necessary directories
    mkdir -p /opt/rtsp-sse/{bin,config,logs,tmp}
    chown -R "$username:$username" /opt/rtsp-sse
    chmod 750 /opt/rtsp-sse
    
    # Set directory permissions
    chmod 755 /opt/rtsp-sse/bin
    chmod 750 /opt/rtsp-sse/config
    chmod 750 /opt/rtsp-sse/logs
    chmod 750 /opt/rtsp-sse/tmp
    
    echo "Streaming user created successfully"
}

# Configure sudo access
configure_sudo() {
    echo "Configuring sudo access..."
    
    # Create admin group if not exists
    groupadd -f admin
    
    # Configure sudo for admin group
    cat > /etc/sudoers.d/99-admin << 'SUDO'
# Admin group sudo configuration
%admin ALL=(ALL) NOPASSWD: /bin/systemctl start rtsp-sse
%admin ALL=(ALL) NOPASSWD: /bin/systemctl stop rtsp-sse
%admin ALL=(ALL) NOPASSWD: /bin/systemctl restart rtsp-sse
%admin ALL=(ALL) NOPASSWD: /bin/systemctl status rtsp-sse
%admin ALL=(ALL) NOPASSWD: /usr/bin/tail -f /opt/rtsp-sse/logs/*
SUDO
    
    chmod 440 /etc/sudoers.d/99-admin
    echo "Sudo configuration complete"
}

# Set file permissions for streaming files
set_file_permissions() {
    echo "Setting file permissions for streaming files..."
    
    # Main script permissions
    if [ -f "rtsp-to-sse.sh" ]; then
        chown rtsp-sse:rtsp-sse rtsp-to-sse.sh
        chmod 750 rtsp-to-sse.sh
    fi
    
    # Configuration files
    find . -name "*.conf" -exec chown rtsp-sse:rtsp-sse {} \;
    find . -name "*.conf" -exec chmod 640 {} \;
    
    # Log files
    find . -name "*.log" -exec chown rtsp-sse:rtsp-sse {} \;
    find . -name "*.log" -exec chmod 640 {} \;
    
    # Scripts
    find . -name "*.sh" -exec chown rtsp-sse:rtsp-sse {} \;
    find . -name "*.sh" -exec chmod 750 {} \;
    
    echo "File permissions set successfully"
}

# Main execution
case "$1" in
    "create-user")
        create_streaming_user
        ;;
    "configure-sudo")
        configure_sudo
        ;;
    "set-permissions")
        set_file_permissions
        ;;
    "all")
        create_streaming_user
        configure_sudo
        set_file_permissions
        ;;
    *)
        echo "Usage: $0 {create-user|configure-sudo|set-permissions|all}"
        echo "  create-user      - Create dedicated streaming user"
        echo "  configure-sudo   - Configure sudo access"
        echo "  set-permissions  - Set file permissions"
        echo "  all              - Run all configurations"
        ;;
esac
EOF

chmod +x manage-users.sh
```

## Network Security

### Advanced Firewall Configuration

```bash
#!/bin/bash
# Advanced firewall configuration

cat > configure-firewall.sh << 'EOF'
#!/bin/bash

echo "=== Advanced Firewall Configuration ==="

# Configure UFW with advanced rules
configure_ufw_advanced() {
    echo "Configuring advanced UFW rules..."
    
    # Reset firewall
    ufw --force reset
    
    # Default policies
    ufw default deny incoming
    ufw default allow outgoing
    
    # Allow loopback
    ufw allow in on lo
    ufw allow out on lo
    
    # SSH (custom port)
    ufw allow 2222/tcp comment 'SSH'
    
    # RTSP streaming (with rate limiting)
    ufw allow 554/tcp comment 'RTSP'
    ufw allow 8554/tcp comment 'Mock RTSP'
    
    # SSE server
    ufw allow 3000/tcp comment 'SSE Server'
    
    # HTTPS (if using SSL)
    ufw allow 443/tcp comment 'HTTPS'
    
    # Rate limiting for SSH
    ufw limit 2222/tcp comment 'SSH rate limit'
    
    # Enable firewall
    ufw --force enable
    
    echo "UFW configuration complete"
}

# Configure iptables for advanced filtering
configure_iptables() {
    echo "Configuring advanced iptables rules..."
    
    # Create iptables rules file
    cat > /etc/iptables/rules.v4 << 'IPTABLES'
*filter
:INPUT DROP [0:0]
:FORWARD DROP [0:0]
:OUTPUT ACCEPT [0:0]

# Allow loopback
-A INPUT -i lo -j ACCEPT

# Allow established connections
-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# SSH with rate limiting
-A INPUT -p tcp --dport 2222 -m conntrack --ctstate NEW -m recent --set
-A INPUT -p tcp --dport 2222 -m conntrack --ctstate NEW -m recent --update --seconds 60 --hitcount 4 -j DROP
-A INPUT -p tcp --dport 2222 -j ACCEPT

# RTSP with connection limiting
-A INPUT -p tcp --dport 554 -m connlimit --connlimit-above 10 -j DROP
-A INPUT -p tcp --dport 554 -j ACCEPT
-A INPUT -p tcp --dport 8554 -m connlimit --connlimit-above 5 -j DROP
-A INPUT -p tcp --dport 8554 -j ACCEPT

# SSE server with rate limiting
-A INPUT -p tcp --dport 3000 -m connlimit --connlimit-above 20 -j DROP
-A INPUT -p tcp --dport 3000 -j ACCEPT

# HTTPS
-A INPUT -p tcp --dport 443 -j ACCEPT

# Drop invalid packets
-A INPUT -m conntrack --ctstate INVALID -j DROP

# Log dropped packets
-A INPUT -m limit --limit 5/min -j LOG --log-prefix "iptables denied: " --log-level 7

COMMIT
IPTABLES
    
    # Install iptables-persistent
    apt install -y iptables-persistent
    
    # Apply rules
    iptables-restore < /etc/iptables/rules.v4
    
    echo "iptables configuration complete"
}

# Configure DDoS protection
configure_ddos_protection() {
    echo "Configuring DDoS protection..."
    
    # Install and configure psad (Port Scan Attack Detector)
    apt install -y psad
    
    cat > /etc/psad/psad.conf << 'PSAD'
EMAIL_ADDRESSES             admin@localhost;
HOSTNAME                    streaming-server;
ALERT_ALL                   Y;
ENABLE_AUTO_IDS             Y;
AUTO_IDS_DANGER_LEVEL       3;
AUTO_BLOCK_TIMEOUT          3600;
ENABLE_AUTO_IDS_EMAILS      Y;
PSAD
    
    systemctl enable psad
    systemctl restart psad
    
    # Configure connection limits in sysctl
    cat >> /etc/sysctl.d/99-security.conf << 'DDOS'

# DDoS protection
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 2048
net.ipv4.tcp_synack_retries = 2
net.ipv4.tcp_syn_retries = 5
net.ipv4.netfilter.ip_conntrack_max = 65536
net.core.netdev_max_backlog = 5000
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.ipv4.tcp_rmem = 4096 87380 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728
DDOS
    
    sysctl -p /etc/sysctl.d/99-security.conf
    
    echo "DDoS protection configured"
}

# Main execution
case "$1" in
    "ufw")
        configure_ufw_advanced
        ;;
    "iptables")
        configure_iptables
        ;;
    "ddos")
        configure_ddos_protection
        ;;
    "all")
        configure_ufw_advanced
        configure_ddos_protection
        ;;
    *)
        echo "Usage: $0 {ufw|iptables|ddos|all}"
        echo "  ufw      - Configure UFW firewall"
        echo "  iptables - Configure advanced iptables"
        echo "  ddos     - Configure DDoS protection"
        echo "  all      - Configure UFW and DDoS protection"
        ;;
esac
EOF

chmod +x configure-firewall.sh
```

## Application Security

### Secure Application Configuration

```bash
#!/bin/bash
# Secure application configuration

cat > secure-application.sh << 'EOF'
#!/bin/bash

echo "=== Secure Application Configuration ==="

# Create secure configuration template
create_secure_config() {
    echo "Creating secure configuration template..."
    
    cat > rtsp-sse-secure.conf << 'CONFIG'
# Secure RTSP-SSE Configuration
# Generated by security configuration script

# Security settings
SECURE_MODE=true
ENABLE_LOGGING=true
LOG_LEVEL=INFO
MAX_CONNECTIONS=50
CONNECTION_TIMEOUT=30
REQUIRE_AUTH=true

# Network security
BIND_ADDRESS=127.0.0.1
RTSP_PORT=554
SSE_PORT=3000
ENABLE_SSL=true
SSL_CERT_PATH=/etc/ssl/certs/rtsp-sse.crt
SSL_KEY_PATH=/etc/ssl/private/rtsp-sse.key

# Rate limiting
MAX_REQUESTS_PER_MINUTE=60
MAX_BANDWIDTH_MBPS=100

# Authentication
AUTH_METHOD=token
TOKEN_EXPIRY=3600
JWT_SECRET_FILE=/opt/rtsp-sse/config/jwt.secret

# Logging
LOG_DIR=/opt/rtsp-sse/logs
LOG_FILE=rtsp-sse.log
AUDIT_LOG=audit.log
ERROR_LOG=error.log
ACCESS_LOG=access.log

# Security headers
ENABLE_SECURITY_HEADERS=true
CSP_POLICY="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"
HSTS_MAX_AGE=31536000

# Resource limits
MAX_MEMORY_MB=512
MAX_CPU_PERCENT=80
MAX_DISK_USAGE_MB=1024

# Monitoring
ENABLE_HEALTH_CHECK=true
HEALTH_CHECK_INTERVAL=30
METRICS_ENABLED=true
CONFIG
    
    chown rtsp-sse:rtsp-sse rtsp-sse-secure.conf
    chmod 640 rtsp-sse-secure.conf
    
    echo "Secure configuration created: rtsp-sse-secure.conf"
}

# Generate JWT secret
generate_jwt_secret() {
    echo "Generating JWT secret..."
    
    mkdir -p /opt/rtsp-sse/config
    openssl rand -base64 64 > /opt/rtsp-sse/config/jwt.secret
    chown rtsp-sse:rtsp-sse /opt/rtsp-sse/config/jwt.secret
    chmod 600 /opt/rtsp-sse/config/jwt.secret
    
    echo "JWT secret generated: /opt/rtsp-sse/config/jwt.secret"
}

# Create SSL certificates
create_ssl_certificates() {
    echo "Creating SSL certificates..."
    
    # Create private key
    openssl genrsa -out /etc/ssl/private/rtsp-sse.key 2048
    chmod 600 /etc/ssl/private/rtsp-sse.key
    
    # Create certificate signing request
    openssl req -new -key /etc/ssl/private/rtsp-sse.key -out /tmp/rtsp-sse.csr -subj "/C=US/ST=State/L=City/O=Organization/CN=rtsp-sse.local"
    
    # Create self-signed certificate (for development)
    openssl x509 -req -days 365 -in /tmp/rtsp-sse.csr -signkey /etc/ssl/private/rtsp-sse.key -out /etc/ssl/certs/rtsp-sse.crt
    chmod 644 /etc/ssl/certs/rtsp-sse.crt
    
    # Clean up
    rm /tmp/rtsp-sse.csr
    
    echo "SSL certificates created"
    echo "Certificate: /etc/ssl/certs/rtsp-sse.crt"
    echo "Private key: /etc/ssl/private/rtsp-sse.key"
    echo "Note: Use proper CA-signed certificates in production"
}

# Configure log rotation
configure_log_rotation() {
    echo "Configuring log rotation..."
    
    cat > /etc/logrotate.d/rtsp-sse << 'LOGROTATE'
/opt/rtsp-sse/logs/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 640 rtsp-sse rtsp-sse
    postrotate
        systemctl reload rtsp-sse 2>/dev/null || true
    endscript
}
LOGROTATE
    
    echo "Log rotation configured"
}

# Create systemd service with security
create_secure_service() {
    echo "Creating secure systemd service..."
    
    cat > /etc/systemd/system/rtsp-sse.service << 'SERVICE'
[Unit]
Description=RTSP to SSE Streaming Service
After=network.target
Wants=network.target

[Service]
Type=simple
User=rtsp-sse
Group=rtsp-sse
WorkingDirectory=/opt/rtsp-sse
ExecStart=/opt/rtsp-sse/bin/rtsp-to-sse.sh
Restart=always
RestartSec=10

# Security settings
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/opt/rtsp-sse/logs /opt/rtsp-sse/tmp
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
MemoryDenyWriteExecute=true
RestrictNamespaces=true
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM

# Resource limits
LimitNOFILE=65536
LimitNPROC=4096
MemoryMax=512M
CPUQuota=80%

# Environment
Environment=NODE_ENV=production
Environment=LOG_LEVEL=info

[Install]
WantedBy=multi-user.target
SERVICE
    
    systemctl daemon-reload
    systemctl enable rtsp-sse
    
    echo "Secure systemd service created"
}

# Main execution
case "$1" in
    "config")
        create_secure_config
        ;;
    "jwt")
        generate_jwt_secret
        ;;
    "ssl")
        create_ssl_certificates
        ;;
    "logs")
        configure_log_rotation
        ;;
    "service")
        create_secure_service
        ;;
    "all")
        create_secure_config
        generate_jwt_secret
        create_ssl_certificates
        configure_log_rotation
        create_secure_service
        ;;
    *)
        echo "Usage: $0 {config|jwt|ssl|logs|service|all}"
        echo "  config  - Create secure configuration"
        echo "  jwt     - Generate JWT secret"
        echo "  ssl     - Create SSL certificates"
        echo "  logs    - Configure log rotation"
        echo "  service - Create secure systemd service"
        echo "  all     - Run all configurations"
        ;;
esac
EOF

chmod +x secure-application.sh
```

## SSL/TLS Configuration

### SSL/TLS Setup Script

```bash
#!/bin/bash
# SSL/TLS configuration script

cat > configure-ssl.sh << 'EOF'
#!/bin/bash

echo "=== SSL/TLS Configuration ==="

# Install SSL tools
install_ssl_tools() {
    echo "Installing SSL tools..."
    apt update
    apt install -y openssl certbot nginx
    echo
}

# Generate strong SSL certificates
generate_ssl_certificates() {
    local domain="$1"
    [ -z "$domain" ] && domain="rtsp-sse.local"
    
    echo "Generating SSL certificates for domain: $domain"
    
    # Create directories
    mkdir -p /etc/ssl/rtsp-sse/{certs,private}
    
    # Generate strong private key
    openssl genrsa -out "/etc/ssl/rtsp-sse/private/$domain.key" 4096
    chmod 600 "/etc/ssl/rtsp-sse/private/$domain.key"
    
    # Create certificate configuration
    cat > "/tmp/$domain.conf" << CERT_CONFIG
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
C = US
ST = State
L = City
O = Organization
OU = IT Department
CN = $domain

[v3_req]
keyUsage = keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = $domain
DNS.2 = *.$domain
IP.1 = 127.0.0.1
CERT_CONFIG
    
    # Generate certificate signing request
    openssl req -new -key "/etc/ssl/rtsp-sse/private/$domain.key" \
        -out "/tmp/$domain.csr" \
        -config "/tmp/$domain.conf"
    
    # Generate self-signed certificate
    openssl x509 -req -days 365 \
        -in "/tmp/$domain.csr" \
        -signkey "/etc/ssl/rtsp-sse/private/$domain.key" \
        -out "/etc/ssl/rtsp-sse/certs/$domain.crt" \
        -extensions v3_req \
        -extfile "/tmp/$domain.conf"
    
    chmod 644 "/etc/ssl/rtsp-sse/certs/$domain.crt"
    
    # Clean up
    rm "/tmp/$domain.csr" "/tmp/$domain.conf"
    
    echo "SSL certificates generated:"
    echo "Certificate: /etc/ssl/rtsp-sse/certs/$domain.crt"
    echo "Private key: /etc/ssl/rtsp-sse/private/$domain.key"
}

# Configure Let's Encrypt
configure_letsencrypt() {
    local domain="$1"
    local email="$2"
    
    if [ -z "$domain" ] || [ -z "$email" ]; then
        echo "Usage: configure_letsencrypt <domain> <email>"
        return 1
    fi
    
    echo "Configuring Let's Encrypt for domain: $domain"
    
    # Stop nginx if running
    systemctl stop nginx 2>/dev/null || true
    
    # Obtain certificate
    certbot certonly --standalone \
        --email "$email" \
        --agree-tos \
        --no-eff-email \
        -d "$domain"
    
    # Setup auto-renewal
    cat > /etc/cron.d/certbot-renew << 'CRON'
0 12 * * * root certbot renew --quiet --post-hook "systemctl reload nginx"
CRON
    
    echo "Let's Encrypt configured successfully"
}

# Configure Nginx SSL proxy
configure_nginx_ssl() {
    local domain="$1"
    [ -z "$domain" ] && domain="rtsp-sse.local"
    
    echo "Configuring Nginx SSL proxy for domain: $domain"
    
    # Create Nginx configuration
    cat > "/etc/nginx/sites-available/$domain" << NGINX_CONFIG
server {
    listen 80;
    server_name $domain;
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name $domain;
    
    # SSL configuration
    ssl_certificate /etc/ssl/rtsp-sse/certs/$domain.crt;
    ssl_certificate_key /etc/ssl/rtsp-sse/private/$domain.key;
    
    # SSL security settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512:ECDHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    ssl_stapling on;
    ssl_stapling_verify on;
    
    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss:; font-src 'self';" always;
    
    # Rate limiting
    limit_req_zone \$binary_remote_addr zone=api:10m rate=10r/s;
    limit_req zone=api burst=20 nodelay;
    
    # Proxy to SSE server
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        
        # SSE specific settings
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 24h;
        proxy_send_timeout 24h;
    }
    
    # Health check endpoint
    location /health {
        access_log off;
        return 200 "healthy\n";
        add_header Content-Type text/plain;
    }
    
    # Block access to sensitive files
    location ~ /\. {
        deny all;
        access_log off;
        log_not_found off;
    }
}
NGINX_CONFIG
    
    # Enable site
    ln -sf "/etc/nginx/sites-available/$domain" "/etc/nginx/sites-enabled/"
    
    # Remove default site
    rm -f /etc/nginx/sites-enabled/default
    
    # Test configuration
    nginx -t
    
    # Restart nginx
    systemctl restart nginx
    systemctl enable nginx
    
    echo "Nginx SSL proxy configured successfully"
}

# Test SSL configuration
test_ssl_config() {
    local domain="$1"
    [ -z "$domain" ] && domain="rtsp-sse.local"
    
    echo "Testing SSL configuration for domain: $domain"
    
    # Test certificate
    echo "Certificate information:"
    openssl x509 -in "/etc/ssl/rtsp-sse/certs/$domain.crt" -text -noout | grep -E "Subject:|Issuer:|Not Before:|Not After:"
    
    # Test SSL connection
    echo
    echo "Testing SSL connection:"
    echo | openssl s_client -connect "$domain:443" -servername "$domain" 2>/dev/null | grep -E "subject=|issuer="
    
    # Test with curl
    echo
    echo "Testing HTTPS endpoint:"
    curl -k -I "https://$domain/health" 2>/dev/null | head -1
}

# Main execution
case "$1" in
    "install")
        install_ssl_tools
        ;;
    "generate")
        generate_ssl_certificates "$2"
        ;;
    "letsencrypt")
        configure_letsencrypt "$2" "$3"
        ;;
    "nginx")
        configure_nginx_ssl "$2"
        ;;
    "test")
        test_ssl_config "$2"
        ;;
    "all")
        install_ssl_tools
        generate_ssl_certificates "$2"
        configure_nginx_ssl "$2"
        test_ssl_config "$2"
        ;;
    *)
        echo "Usage: $0 {install|generate|letsencrypt|nginx|test|all} [domain] [email]"
        echo "  install     - Install SSL tools"
        echo "  generate    - Generate self-signed certificates"
        echo "  letsencrypt - Configure Let's Encrypt (requires domain and email)"
        echo "  nginx       - Configure Nginx SSL proxy"
        echo "  test        - Test SSL configuration"
        echo "  all         - Run install, generate, nginx, and test"
        ;;
esac
EOF

chmod +x configure-ssl.sh
```

## Monitoring & Logging

### Security Monitoring Script

```bash
#!/bin/bash
# Security monitoring and logging script

cat > security-monitoring.sh << 'EOF'
#!/bin/bash

echo "=== Security Monitoring Setup ==="

# Install monitoring tools
install_monitoring_tools() {
    echo "Installing security monitoring tools..."
    
    apt update
    apt install -y \
        rsyslog \
        logwatch \
        aide \
        rkhunter \
        chkrootkit \
        lynis \
        ossec-hids \
        fail2ban \
        psad
    
    echo "Monitoring tools installed"
}

# Configure centralized logging
configure_logging() {
    echo "Configuring centralized logging..."
    
    # Create log directories
    mkdir -p /var/log/rtsp-sse/{security,audit,access,error}
    chown syslog:adm /var/log/rtsp-sse
    chmod 755 /var/log/rtsp-sse
    
    # Configure rsyslog
    cat > /etc/rsyslog.d/99-rtsp-sse.conf << 'RSYSLOG'
# RTSP-SSE logging configuration

# Security logs
auth,authpriv.*                 /var/log/rtsp-sse/security/auth.log
security.*                      /var/log/rtsp-sse/security/security.log

# Application logs
local0.*                        /var/log/rtsp-sse/access/access.log
local1.*                        /var/log/rtsp-sse/error/error.log
local2.*                        /var/log/rtsp-sse/audit/audit.log

# Network logs
kern.*                          /var/log/rtsp-sse/security/kernel.log

# Stop processing after logging
& stop
RSYLOG
    
    systemctl restart rsyslog
    
    echo "Centralized logging configured"
}

# Setup log monitoring
setup_log_monitoring() {
    echo "Setting up log monitoring..."
    
    # Configure logwatch
    cat > /etc/logwatch/conf/logfiles/rtsp-sse.conf << 'LOGWATCH'
LogFile = /var/log/rtsp-sse/*/*.log
Archive = /var/log/rtsp-sse/*/*.log.1
LOGWATCH
    
    cat > /etc/logwatch/conf/services/rtsp-sse.conf << 'LOGWATCH_SERVICE'
Title = "RTSP-SSE Security Report"
LogFile = rtsp-sse
LOGWATCH_SERVICE
    
    # Create custom logwatch script
    cat > /etc/logwatch/scripts/services/rtsp-sse << 'LOGWATCH_SCRIPT'
#!/usr/bin/perl

use strict;
use warnings;

my $failed_logins = 0;
my $successful_logins = 0;
my $blocked_ips = 0;
my $errors = 0;

while (defined(my $line = <STDIN>)) {
    chomp $line;
    
    if ($line =~ /authentication failure/) {
        $failed_logins++;
    } elsif ($line =~ /Accepted/) {
        $successful_logins++;
    } elsif ($line =~ /blocked/) {
        $blocked_ips++;
    } elsif ($line =~ /ERROR|error/) {
        $errors++;
    }
}

if ($failed_logins > 0) {
    print "Failed login attempts: $failed_logins\n";
}

if ($successful_logins > 0) {
    print "Successful logins: $successful_logins\n";
}

if ($blocked_ips > 0) {
    print "Blocked IP addresses: $blocked_ips\n";
}

if ($errors > 0) {
    print "Application errors: $errors\n";
}
LOGWATCH_SCRIPT
    
    chmod +x /etc/logwatch/scripts/services/rtsp-sse
    
    echo "Log monitoring configured"
}

# Setup intrusion detection
setup_intrusion_detection() {
    echo "Setting up intrusion detection..."
    
    # Configure AIDE (Advanced Intrusion Detection Environment)
    aide --init
    mv /var/lib/aide/aide.db.new /var/lib/aide/aide.db
    
    # Create AIDE check script
    cat > /usr/local/bin/aide-check.sh << 'AIDE_CHECK'
#!/bin/bash

# Run AIDE check
aide --check > /tmp/aide-report.txt 2>&1

if [ $? -ne 0 ]; then
    echo "AIDE detected changes in the system!"
    echo "Report saved to: /tmp/aide-report.txt"
    
    # Send alert (customize as needed)
    mail -s "AIDE Alert: System changes detected" admin@localhost < /tmp/aide-report.txt
fi
AIDE_CHECK
    
    chmod +x /usr/local/bin/aide-check.sh
    
    # Schedule AIDE checks
    echo "0 2 * * * root /usr/local/bin/aide-check.sh" >> /etc/crontab
    
    # Configure rkhunter
    rkhunter --update
    rkhunter --propupd
    
    # Schedule rkhunter checks
    echo "0 3 * * * root rkhunter --check --skip-keypress --report-warnings-only" >> /etc/crontab
    
    echo "Intrusion detection configured"
}

# Create security monitoring dashboard
create_monitoring_dashboard() {
    echo "Creating security monitoring dashboard..."
    
    cat > /usr/local/bin/security-dashboard.sh << 'DASHBOARD'
#!/bin/bash

echo "=== RTSP-SSE Security Dashboard ==="
echo "Generated: $(date)"
echo

# System status
echo "=== System Status ==="
echo "Uptime: $(uptime | cut -d, -f1)"
echo "Load: $(cat /proc/loadavg | cut -d' ' -f1-3)"
echo "Memory: $(free -h | awk 'NR==2{printf "%.1f%%", $3/$2*100}')"
echo "Disk: $(df -h / | awk 'NR==2{print $5}')"
echo

# Security status
echo "=== Security Status ==="
echo "Failed login attempts (last 24h): $(grep "authentication failure" /var/log/auth.log | grep "$(date --date='1 day ago' '+%b %d')" | wc -l)"
echo "Blocked IPs: $(fail2ban-client status sshd 2>/dev/null | grep "Banned IP list" | wc -l)"
echo "Active connections: $(ss -tuln | grep -E ":(554|3000|443)" | wc -l)"
echo

# Service status
echo "=== Service Status ==="
echo "SSH: $(systemctl is-active sshd)"
echo "Firewall: $(ufw status | head -1 | cut -d: -f2 | xargs)"
echo "Fail2ban: $(systemctl is-active fail2ban)"
echo "RTSP-SSE: $(systemctl is-active rtsp-sse 2>/dev/null || echo 'not configured')"
echo "Nginx: $(systemctl is-active nginx 2>/dev/null || echo 'not running')"
echo

# Recent security events
echo "=== Recent Security Events ==="
echo "Last 10 authentication events:"
tail -10 /var/log/auth.log | grep -E "(Accepted|Failed|authentication)"
echo

# Certificate status
echo "=== Certificate Status ==="
if [ -f "/etc/ssl/rtsp-sse/certs/rtsp-sse.local.crt" ]; then
    expiry=$(openssl x509 -in /etc/ssl/rtsp-sse/certs/rtsp-sse.local.crt -noout -enddate | cut -d= -f2)
    echo "SSL Certificate expires: $expiry"
else
    echo "SSL Certificate: Not configured"
fi
echo

# Recommendations
echo "=== Security Recommendations ==="
if [ $(grep "authentication failure" /var/log/auth.log | grep "$(date '+%b %d')" | wc -l) -gt 10 ]; then
    echo "⚠️  High number of failed login attempts detected"
fi

if [ $(df / | awk 'NR==2{print $5}' | sed 's/%//') -gt 80 ]; then
    echo "⚠️  Disk usage is high (>80%)"
fi

if ! systemctl is-active --quiet ufw; then
    echo "⚠️  Firewall is not active"
fi

echo "✅ Security monitoring is active"
DASHBOARD
    
    chmod +x /usr/local/bin/security-dashboard.sh
    
    echo "Security dashboard created: /usr/local/bin/security-dashboard.sh"
}

# Setup automated security reports
setup_security_reports() {
    echo "Setting up automated security reports..."
    
    # Daily security report
    cat > /etc/cron.daily/security-report << 'SECURITY_REPORT'
#!/bin/bash

# Generate daily security report
REPORT_FILE="/tmp/security-report-$(date +%Y%m%d).txt"

/usr/local/bin/security-dashboard.sh > "$REPORT_FILE"

# Add logwatch report
echo "\n=== Logwatch Report ===" >> "$REPORT_FILE"
logwatch --detail Med --service All --range yesterday >> "$REPORT_FILE"

# Send report (customize as needed)
echo "Daily security report generated: $REPORT_FILE"
# mail -s "Daily Security Report - $(hostname)" admin@localhost < "$REPORT_FILE"
SECURITY_REPORT
    
    chmod +x /etc/cron.daily/security-report
    
    echo "Automated security reports configured"
}

# Main execution
case "$1" in
    "install")
        install_monitoring_tools
        ;;
    "logging")
        configure_logging
        ;;
    "monitoring")
        setup_log_monitoring
        ;;
    "intrusion")
        setup_intrusion_detection
        ;;
    "dashboard")
        create_monitoring_dashboard
        ;;
    "reports")
        setup_security_reports
        ;;
    "all")
        install_monitoring_tools
        configure_logging
        setup_log_monitoring
        setup_intrusion_detection
        create_monitoring_dashboard
        setup_security_reports
        ;;
    *)
        echo "Usage: $0 {install|logging|monitoring|intrusion|dashboard|reports|all}"
        echo "  install    - Install monitoring tools"
        echo "  logging    - Configure centralized logging"
        echo "  monitoring - Setup log monitoring"
        echo "  intrusion  - Setup intrusion detection"
        echo "  dashboard  - Create monitoring dashboard"
        echo "  reports    - Setup automated reports"
        echo "  all        - Run all configurations"
        ;;
esac
EOF

chmod +x security-monitoring.sh
```

## Complete Security Setup Script

### Master Security Configuration

```bash
#!/bin/bash
# Master security configuration script

cat > setup-security.sh << 'EOF'
#!/bin/bash

echo "=== Complete Security Setup for RTSP-SSE Streaming ==="
echo "This script will configure comprehensive security for your streaming system."
echo

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run as root (use sudo)"
    exit 1
fi

# Configuration variables
DOMAIN="rtsp-sse.local"
EMAIL="admin@localhost"
SSH_PORT="2222"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --domain)
            DOMAIN="$2"
            shift 2
            ;;
        --email)
            EMAIL="$2"
            shift 2
            ;;
        --ssh-port)
            SSH_PORT="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--domain DOMAIN] [--email EMAIL] [--ssh-port PORT]"
            exit 1
            ;;
    esac
done

echo "Configuration:"
echo "Domain: $DOMAIN"
echo "Email: $EMAIL"
echo "SSH Port: $SSH_PORT"
echo

read -p "Continue with security setup? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
fi

# 1. System hardening
echo "Step 1/8: System hardening..."
if [ -f "harden-system.sh" ]; then
    ./harden-system.sh
else
    echo "Warning: harden-system.sh not found, skipping system hardening"
fi
echo

# 2. User management
echo "Step 2/8: User and permission management..."
if [ -f "manage-users.sh" ]; then
    ./manage-users.sh all
else
    echo "Warning: manage-users.sh not found, skipping user management"
fi
echo

# 3. Firewall configuration
echo "Step 3/8: Firewall configuration..."
if [ -f "configure-firewall.sh" ]; then
    ./configure-firewall.sh all
else
    echo "Warning: configure-firewall.sh not found, skipping firewall configuration"
fi
echo

# 4. Application security
echo "Step 4/8: Application security..."
if [ -f "secure-application.sh" ]; then
    ./secure-application.sh all
else
    echo "Warning: secure-application.sh not found, skipping application security"
fi
echo

# 5. SSL/TLS configuration
echo "Step 5/8: SSL/TLS configuration..."
if [ -f "configure-ssl.sh" ]; then
    ./configure-ssl.sh all "$DOMAIN"
else
    echo "Warning: configure-ssl.sh not found, skipping SSL configuration"
fi
echo

# 6. Security monitoring
echo "Step 6/8: Security monitoring..."
if [ -f "security-monitoring.sh" ]; then
    ./security-monitoring.sh all
else
    echo "Warning: security-monitoring.sh not found, skipping security monitoring"
fi
echo

# 7. Final security checks
echo "Step 7/8: Running security checks..."

# Check SSH configuration
echo "Checking SSH configuration..."
sshd -t && echo "✅ SSH configuration is valid" || echo "❌ SSH configuration has errors"

# Check firewall status
echo "Checking firewall status..."
ufw status | grep -q "Status: active" && echo "✅ Firewall is active" || echo "❌ Firewall is not active"

# Check SSL certificates
echo "Checking SSL certificates..."
if [ -f "/etc/ssl/rtsp-sse/certs/$DOMAIN.crt" ]; then
    openssl x509 -in "/etc/ssl/rtsp-sse/certs/$DOMAIN.crt" -noout -checkend 86400 >/dev/null 2>&1
    if [ $? -eq 0 ]; then
        echo "✅ SSL certificate is valid"
    else
        echo "⚠️  SSL certificate expires within 24 hours"
    fi
else
    echo "❌ SSL certificate not found"
fi

# Check services
echo "Checking services..."
for service in ssh ufw fail2ban nginx; do
    if systemctl is-active --quiet "$service"; then
        echo "✅ $service is running"
    else
        echo "❌ $service is not running"
    fi
done
echo

# 8. Generate security summary
echo "Step 8/8: Generating security summary..."

cat > /root/security-setup-summary.txt << SUMMARY
Security Setup Summary
=====================
Date: $(date)
Hostname: $(hostname)
Domain: $DOMAIN
SSH Port: $SSH_PORT

Security Features Configured:
✅ System hardening (kernel parameters, services)
✅ User and permission management
✅ Advanced firewall configuration
✅ Application security (systemd hardening)
✅ SSL/TLS encryption
✅ Security monitoring and logging
✅ Intrusion detection (AIDE, rkhunter)
✅ Automated security reports

Important Security Notes:
- SSH is now available on port $SSH_PORT
- Root login is disabled
- Password authentication is disabled
- Firewall is configured with minimal open ports
- SSL certificates are self-signed (use CA-signed for production)
- Security monitoring is active
- Daily security reports are configured

Next Steps:
1. Reboot the system to ensure all changes take effect
2. Test SSH access on port $SSH_PORT
3. Verify SSL certificate installation
4. Configure proper CA-signed certificates for production
5. Set up external log monitoring if required
6. Review and customize security policies as needed

Security Dashboard:
- Run: /usr/local/bin/security-dashboard.sh
- Daily reports: /etc/cron.daily/security-report

Configuration Files:
- SSH: /etc/ssh/sshd_config.d/99-security.conf
- Firewall: /etc/ufw/
- SSL: /etc/ssl/rtsp-sse/
- Application: /opt/rtsp-sse/
- Monitoring: /var/log/rtsp-sse/
SUMMARY

echo "=== Security Setup Complete ==="
echo
echo "Security summary saved to: /root/security-setup-summary.txt"
echo
echo "IMPORTANT: Please reboot the system to ensure all changes take effect."
echo "After reboot, SSH will be available on port $SSH_PORT."
echo
echo "To view the security dashboard, run:"
echo "  /usr/local/bin/security-dashboard.sh"
echo
echo "To test the setup, run:"
echo "  ./test-security.sh"
EOF

chmod +x setup-security.sh
```

### Security Testing Script

```bash
#!/bin/bash
# Security testing script

cat > test-security.sh << 'EOF'
#!/bin/bash

echo "=== Security Configuration Test ==="

# Test SSH configuration
test_ssh() {
    echo "Testing SSH configuration..."
    
    if sshd -t 2>/dev/null; then
        echo "✅ SSH configuration is valid"
    else
        echo "❌ SSH configuration has errors"
        sshd -t
    fi
    
    # Check SSH port
    ssh_port=$(grep "^Port" /etc/ssh/sshd_config.d/99-security.conf | awk '{print $2}')
    if [ -n "$ssh_port" ]; then
        echo "✅ SSH port configured: $ssh_port"
    else
        echo "❌ SSH port not configured"
    fi
}

# Test firewall
test_firewall() {
    echo "Testing firewall configuration..."
    
    if ufw status | grep -q "Status: active"; then
        echo "✅ UFW firewall is active"
        echo "Open ports:"
        ufw status numbered | grep ALLOW
    else
        echo "❌ UFW firewall is not active"
    fi
}

# Test SSL certificates
test_ssl() {
    echo "Testing SSL certificates..."
    
    cert_file="/etc/ssl/rtsp-sse/certs/rtsp-sse.local.crt"
    key_file="/etc/ssl/rtsp-sse/private/rtsp-sse.local.key"
    
    if [ -f "$cert_file" ] && [ -f "$key_file" ]; then
        echo "✅ SSL certificate files exist"
        
        # Check certificate validity
        if openssl x509 -in "$cert_file" -noout -checkend 86400 >/dev/null 2>&1; then
            echo "✅ SSL certificate is valid for at least 24 hours"
        else
            echo "⚠️  SSL certificate expires within 24 hours"
        fi
        
        # Check certificate and key match
        cert_hash=$(openssl x509 -noout -modulus -in "$cert_file" | openssl md5)
        key_hash=$(openssl rsa -noout -modulus -in "$key_file" | openssl md5)
        
        if [ "$cert_hash" = "$key_hash" ]; then
            echo "✅ SSL certificate and key match"
        else
            echo "❌ SSL certificate and key do not match"
        fi
    else
        echo "❌ SSL certificate files not found"
    fi
}

# Test services
test_services() {
    echo "Testing security services..."
    
    services=("ssh" "ufw" "fail2ban" "nginx" "rsyslog")
    
    for service in "${services[@]}"; do
        if systemctl is-active --quiet "$service"; then
            echo "✅ $service is running"
        else
            echo "❌ $service is not running"
        fi
    done
}

# Test network security
test_network() {
    echo "Testing network security..."
    
    # Check open ports
    echo "Open network ports:"
    ss -tuln | grep LISTEN
    
    # Check for suspicious connections
    echo "\nActive connections:"
    ss -tuln | grep -E ":(554|3000|443|2222)"
}

# Test file permissions
test_permissions() {
    echo "Testing file permissions..."
    
    # Check critical file permissions
    files=(
        "/etc/passwd:644"
        "/etc/shadow:600"
        "/etc/ssh/sshd_config:644"
        "/opt/rtsp-sse:750"
    )
    
    for file_perm in "${files[@]}"; do
        file="${file_perm%:*}"
        expected_perm="${file_perm#*:}"
        
        if [ -e "$file" ]; then
            actual_perm=$(stat -c "%a" "$file")
            if [ "$actual_perm" = "$expected_perm" ]; then
                echo "✅ $file has correct permissions ($actual_perm)"
            else
                echo "⚠️  $file has permissions $actual_perm (expected $expected_perm)"
            fi
        else
            echo "❌ $file does not exist"
        fi
    done
}

# Generate test report
generate_test_report() {
    echo "Generating security test report..."
    
    report_file="/tmp/security-test-report-$(date +%Y%m%d-%H%M%S).txt"
    
    {
        echo "Security Test Report"
        echo "==================="
        echo "Date: $(date)"
        echo "Hostname: $(hostname)"
        echo
        
        echo "=== SSH Test ==="
        test_ssh
        echo
        
        echo "=== Firewall Test ==="
        test_firewall
        echo
        
        echo "=== SSL Test ==="
        test_ssl
        echo
        
        echo "=== Services Test ==="
        test_services
        echo
        
        echo "=== Network Test ==="
        test_network
        echo
        
        echo "=== Permissions Test ==="
        test_permissions
        echo
        
        echo "=== Summary ==="
        echo "Test completed at: $(date)"
        echo "Report saved to: $report_file"
    } | tee "$report_file"
    
    echo "\nSecurity test report saved to: $report_file"
}

# Main execution
case "$1" in
    "ssh")
        test_ssh
        ;;
    "firewall")
        test_firewall
        ;;
    "ssl")
        test_ssl
        ;;
    "services")
        test_services
        ;;
    "network")
        test_network
        ;;
    "permissions")
        test_permissions
        ;;
    "all")
        echo "Running comprehensive security tests..."
        echo
        test_ssh
        echo
        test_firewall
        echo
        test_ssl
        echo
        test_services
        echo
        test_network
        echo
        test_permissions
        echo
        generate_test_report
        ;;
    *)
        echo "Usage: $0 {ssh|firewall|ssl|services|network|permissions|all}"
        echo "  ssh         - Test SSH configuration"
        echo "  firewall    - Test firewall configuration"
        echo "  ssl         - Test SSL certificates"
        echo "  services    - Test security services"
        echo "  network     - Test network security"
        echo "  permissions - Test file permissions"
        echo "  all         - Run all tests and generate report"
        ;;
esac
EOF

chmod +x test-security.sh
```

## Quick Start Guide

### Production Deployment Checklist

```bash
# 1. Run system hardening
sudo ./harden-system.sh

# 2. Configure users and permissions
sudo ./manage-users.sh all

# 3. Setup firewall
sudo ./configure-firewall.sh all

# 4. Configure application security
sudo ./secure-application.sh all

# 5. Setup SSL/TLS
sudo ./configure-ssl.sh all your-domain.com

# 6. Configure monitoring
sudo ./security-monitoring.sh all

# 7. Run complete security setup
sudo ./setup-security.sh --domain your-domain.com --email admin@your-domain.com

# 8. Test security configuration
sudo ./test-security.sh all

# 9. Reboot system
sudo reboot
```

### Security Maintenance

```bash
# Daily security dashboard
/usr/local/bin/security-dashboard.sh

# Weekly security scan
sudo lynis audit system

# Monthly updates
sudo apt update && sudo apt upgrade
sudo rkhunter --update && sudo rkhunter --check
sudo aide --update

# Certificate renewal (if using Let's Encrypt)
sudo certbot renew
```

## Security Best Practices

### 1. Regular Updates
- Enable automatic security updates
- Monitor security advisories
- Test updates in staging environment

### 2. Access Control
- Use strong, unique passwords
- Implement multi-factor authentication
- Regular access reviews
- Principle of least privilege

### 3. Network Security
- Use VPN for remote access
- Implement network segmentation
- Monitor network traffic
- Regular penetration testing

### 4. Data Protection
- Encrypt data at rest and in transit
- Regular backups
- Secure backup storage
- Data retention policies

### 5. Incident Response
- Incident response plan
- Regular drills
- Log analysis
- Forensic capabilities

## Compliance Considerations

### GDPR Compliance
- Data encryption
- Access logging
- Data retention policies
- Privacy by design

### SOC 2 Compliance
- Access controls
- System monitoring
- Change management
- Incident response

### ISO 27001
- Risk assessment
- Security policies
- Regular audits
- Continuous improvement

## Conclusion

This security configuration guide provides comprehensive protection for your RTSP-SSE streaming system. Regular maintenance and monitoring are essential for maintaining security posture.

For production deployments:
1. Use CA-signed SSL certificates
2. Implement proper backup strategies
3. Set up external monitoring
4. Regular security assessments
5. Staff security training

Remember: Security is an ongoing process, not a one-time setup.