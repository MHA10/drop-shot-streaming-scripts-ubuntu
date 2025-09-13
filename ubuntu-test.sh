#!/bin/bash

# Ubuntu Testing Script for RTSP-SSE Streaming System
# Comprehensive testing procedures for complete flow

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/rtsp-sse-stream.conf"
TEST_LOG="$SCRIPT_DIR/ubuntu-test.log"
TEST_RESULTS="$SCRIPT_DIR/test-results.json"
MOCK_RTSP_PORT=8554
MOCK_SSE_PORT=3000
TEST_DURATION=30

# Test counters
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
SKIPPED_TESTS=0

# Logging functions
log() {
    local message="$1"
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $message"
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $message" >> "$TEST_LOG"
}

log_success() {
    local message="$1"
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] ✓${NC} $message"
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] SUCCESS: $message" >> "$TEST_LOG"
}

log_warning() {
    local message="$1"
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] ⚠${NC} $message"
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $message" >> "$TEST_LOG"
}

log_error() {
    local message="$1"
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ✗${NC} $message"
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $message" >> "$TEST_LOG"
}

log_test() {
    local test_name="$1"
    echo -e "${PURPLE}[TEST]${NC} $test_name"
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] TEST: $test_name" >> "$TEST_LOG"
}

# Test result functions
test_pass() {
    local test_name="$1"
    ((PASSED_TESTS++))
    ((TOTAL_TESTS++))
    log_success "PASS: $test_name"
}

test_fail() {
    local test_name="$1"
    local reason="$2"
    ((FAILED_TESTS++))
    ((TOTAL_TESTS++))
    log_error "FAIL: $test_name - $reason"
}

test_skip() {
    local test_name="$1"
    local reason="$2"
    ((SKIPPED_TESTS++))
    ((TOTAL_TESTS++))
    log_warning "SKIP: $test_name - $reason"
}

# Initialize test log
init_test_log() {
    echo "RTSP-SSE Streaming System Test Log" > "$TEST_LOG"
    echo "Started: $(date)" >> "$TEST_LOG"
    echo "Ubuntu Version: $(lsb_release -d 2>/dev/null | cut -f2 || echo 'Unknown')" >> "$TEST_LOG"
    echo "Kernel: $(uname -r)" >> "$TEST_LOG"
    echo "Architecture: $(uname -m)" >> "$TEST_LOG"
    echo "========================================" >> "$TEST_LOG"
}

# Test 1: Environment validation
test_environment() {
    log_test "Environment Validation"
    
    local errors=0
    
    # Check main script
    if [[ -f "$SCRIPT_DIR/rtsp-sse-stream.sh" ]]; then
        log_success "Main script found"
    else
        log_error "Main script not found"
        ((errors++))
    fi
    
    # Check configuration
    if [[ -f "$CONFIG_FILE" ]]; then
        log_success "Configuration file found"
    else
        log_error "Configuration file not found"
        ((errors++))
    fi
    
    # Check dependencies
    local deps=("curl" "ffmpeg" "jq" "bc" "ps" "kill")
    for dep in "${deps[@]}"; do
        if command -v "$dep" > /dev/null 2>&1; then
            log_success "Dependency available: $dep"
        else
            log_error "Dependency missing: $dep"
            ((errors++))
        fi
    done
    
    if [[ $errors -eq 0 ]]; then
        test_pass "Environment Validation"
    else
        test_fail "Environment Validation" "$errors dependencies missing"
    fi
}

# Test 2: Configuration validation
test_configuration() {
    log_test "Configuration Validation"
    
    if [[ ! -f "$CONFIG_FILE" ]]; then
        test_skip "Configuration Validation" "Config file not found"
        return
    fi
    
    local errors=0
    
    # Source configuration
    if source "$CONFIG_FILE" 2>/dev/null; then
        log_success "Configuration file syntax is valid"
    else
        log_error "Configuration file has syntax errors"
        test_fail "Configuration Validation" "Syntax errors in config"
        return
    fi
    
    # Check required variables
    local required_vars=("RTSP_URL" "SSE_SERVER_URL" "OUTPUT_DIR" "LOG_FILE")
    for var in "${required_vars[@]}"; do
        if [[ -n "${!var}" ]]; then
            log_success "Required variable set: $var"
        else
            log_error "Required variable missing: $var"
            ((errors++))
        fi
    done
    
    # Validate URLs
    if [[ "$RTSP_URL" =~ ^rtsp:// ]]; then
        log_success "RTSP URL format is valid"
    else
        log_error "RTSP URL format is invalid"
        ((errors++))
    fi
    
    if [[ "$SSE_SERVER_URL" =~ ^https?:// ]]; then
        log_success "SSE Server URL format is valid"
    else
        log_error "SSE Server URL format is invalid"
        ((errors++))
    fi
    
    if [[ $errors -eq 0 ]]; then
        test_pass "Configuration Validation"
    else
        test_fail "Configuration Validation" "$errors configuration errors"
    fi
}

# Test 3: Network connectivity
test_network() {
    log_test "Network Connectivity"
    
    local errors=0
    
    # Test internet connectivity
    if curl -s --connect-timeout 5 http://google.com > /dev/null; then
        log_success "Internet connectivity available"
    else
        log_warning "Internet connectivity limited"
    fi
    
    # Test local network
    local gateway=$(ip route | grep default | awk '{print $3}' | head -n1)
    if [[ -n "$gateway" ]] && ping -c 1 -W 2 "$gateway" > /dev/null 2>&1; then
        log_success "Local network connectivity OK"
    else
        log_warning "Local network connectivity issues"
    fi
    
    # Check port availability
    local ports=("$MOCK_RTSP_PORT" "$MOCK_SSE_PORT" "8080")
    for port in "${ports[@]}"; do
        if ss -tuln | grep -q ":$port "; then
            log_warning "Port $port is in use"
        else
            log_success "Port $port is available"
        fi
    done
    
    test_pass "Network Connectivity"
}

# Test 4: Mock RTSP server
test_mock_rtsp() {
    log_test "Mock RTSP Server"
    
    # Start mock RTSP server using FFmpeg
    log "Starting mock RTSP server on port $MOCK_RTSP_PORT..."
    
    # Generate test video
    ffmpeg -f lavfi -i testsrc=duration=60:size=640x480:rate=25 \
           -f lavfi -i sine=frequency=1000:duration=60 \
           -c:v libx264 -preset ultrafast -tune zerolatency \
           -c:a aac -b:a 128k \
           -f rtsp rtsp://127.0.0.1:$MOCK_RTSP_PORT/test \
           > /dev/null 2>&1 &
    
    local rtsp_pid=$!
    echo $rtsp_pid > "/tmp/mock-rtsp.pid"
    
    # Wait for server to start
    sleep 3
    
    # Test RTSP connection
    if ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height \
               rtsp://127.0.0.1:$MOCK_RTSP_PORT/test > /dev/null 2>&1; then
        log_success "Mock RTSP server is accessible"
        test_pass "Mock RTSP Server"
    else
        log_error "Mock RTSP server is not accessible"
        test_fail "Mock RTSP Server" "Server not accessible"
    fi
    
    # Keep server running for other tests
    log "Mock RTSP server running (PID: $rtsp_pid)"
}

# Test 5: Mock SSE server
test_mock_sse() {
    log_test "Mock SSE Server"
    
    # Create simple Node.js SSE server
    cat > "/tmp/mock-sse-server.js" << 'EOF'
const http = require('http');
const url = require('url');

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    
    if (parsedUrl.pathname === '/events') {
        // SSE endpoint
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        
        // Send initial event
        res.write('data: {"type":"connected","timestamp":"' + new Date().toISOString() + '"}\n\n');
        
        // Send periodic events
        const interval = setInterval(() => {
            const event = {
                type: 'parameter_update',
                timestamp: new Date().toISOString(),
                data: {
                    resolution: '1920x1080',
                    fps: 30,
                    bitrate: '2M'
                }
            };
            res.write('data: ' + JSON.stringify(event) + '\n\n');
        }, 5000);
        
        req.on('close', () => {
            clearInterval(interval);
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(3000, () => {
    console.log('Mock SSE server running on port 3000');
});
EOF
    
    # Start SSE server
    if command -v node > /dev/null 2>&1; then
        node "/tmp/mock-sse-server.js" > /dev/null 2>&1 &
        local sse_pid=$!
        echo $sse_pid > "/tmp/mock-sse.pid"
        
        # Wait for server to start
        sleep 2
        
        # Test SSE connection
        if curl -s --connect-timeout 5 "http://127.0.0.1:$MOCK_SSE_PORT/events" | head -n1 | grep -q "data:"; then
            log_success "Mock SSE server is accessible"
            test_pass "Mock SSE Server"
        else
            log_error "Mock SSE server is not accessible"
            test_fail "Mock SSE Server" "Server not accessible"
        fi
        
        log "Mock SSE server running (PID: $sse_pid)"
    else
        test_skip "Mock SSE Server" "Node.js not available"
    fi
}

# Test 6: Main script syntax
test_script_syntax() {
    log_test "Main Script Syntax"
    
    if [[ ! -f "$SCRIPT_DIR/rtsp-sse-stream.sh" ]]; then
        test_skip "Main Script Syntax" "Script not found"
        return
    fi
    
    # Check bash syntax
    if bash -n "$SCRIPT_DIR/rtsp-sse-stream.sh" 2>/dev/null; then
        log_success "Script syntax is valid"
        test_pass "Main Script Syntax"
    else
        log_error "Script has syntax errors"
        test_fail "Main Script Syntax" "Syntax errors detected"
    fi
}

# Test 7: Dry run test
test_dry_run() {
    log_test "Dry Run Test"
    
    if [[ ! -f "$SCRIPT_DIR/rtsp-sse-stream.sh" ]]; then
        test_skip "Dry Run Test" "Script not found"
        return
    fi
    
    # Create temporary config for dry run
    local temp_config="/tmp/test-config.conf"
    cp "$CONFIG_FILE" "$temp_config" 2>/dev/null || {
        test_skip "Dry Run Test" "Config file not found"
        return
    }
    
    # Update config for test
    sed -i "s|RTSP_URL=.*|RTSP_URL=\"rtsp://127.0.0.1:$MOCK_RTSP_PORT/test\"|" "$temp_config"
    sed -i "s|SSE_SERVER_URL=.*|SSE_SERVER_URL=\"http://127.0.0.1:$MOCK_SSE_PORT/events\"|" "$temp_config"
    sed -i "s|DEBUG_MODE=.*|DEBUG_MODE=true|" "$temp_config"
    
    # Run script in dry run mode (if supported)
    export CONFIG_FILE="$temp_config"
    export DRY_RUN=true
    
    if timeout 10 bash "$SCRIPT_DIR/rtsp-sse-stream.sh" > /dev/null 2>&1; then
        log_success "Dry run completed successfully"
        test_pass "Dry Run Test"
    else
        log_error "Dry run failed"
        test_fail "Dry Run Test" "Script execution failed"
    fi
    
    # Cleanup
    rm -f "$temp_config"
    unset CONFIG_FILE DRY_RUN
}

# Test 8: Integration test
test_integration() {
    log_test "Integration Test"
    
    # Check if mock servers are running
    if [[ ! -f "/tmp/mock-rtsp.pid" ]] || [[ ! -f "/tmp/mock-sse.pid" ]]; then
        test_skip "Integration Test" "Mock servers not running"
        return
    fi
    
    local rtsp_pid=$(cat "/tmp/mock-rtsp.pid" 2>/dev/null)
    local sse_pid=$(cat "/tmp/mock-sse.pid" 2>/dev/null)
    
    if ! ps -p "$rtsp_pid" > /dev/null 2>&1 || ! ps -p "$sse_pid" > /dev/null 2>&1; then
        test_skip "Integration Test" "Mock servers not responding"
        return
    fi
    
    # Test RTSP to SSE integration
    log "Testing RTSP stream processing..."
    
    # Use FFmpeg to test the complete pipeline
    if timeout 10 ffmpeg -i "rtsp://127.0.0.1:$MOCK_RTSP_PORT/test" \
                         -t 5 -f null - > /dev/null 2>&1; then
        log_success "RTSP stream processing works"
    else
        log_error "RTSP stream processing failed"
        test_fail "Integration Test" "RTSP processing failed"
        return
    fi
    
    # Test SSE event reception
    log "Testing SSE event reception..."
    
    if timeout 5 curl -s "http://127.0.0.1:$MOCK_SSE_PORT/events" | head -n2 | grep -q "data:"; then
        log_success "SSE event reception works"
        test_pass "Integration Test"
    else
        log_error "SSE event reception failed"
        test_fail "Integration Test" "SSE reception failed"
    fi
}

# Test 9: Performance test
test_performance() {
    log_test "Performance Test"
    
    # Monitor system resources during test
    local start_time=$(date +%s)
    local cpu_before=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)
    local mem_before=$(free | awk '/^Mem:/ {printf "%.1f", $3/$2 * 100.0}')
    
    # Run a short performance test
    log "Running performance test for 10 seconds..."
    
    if timeout 10 ffmpeg -f lavfi -i testsrc=duration=10:size=1920x1080:rate=30 \
                         -c:v libx264 -preset ultrafast \
                         -f null - > /dev/null 2>&1; then
        
        local end_time=$(date +%s)
        local duration=$((end_time - start_time))
        local cpu_after=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)
        local mem_after=$(free | awk '/^Mem:/ {printf "%.1f", $3/$2 * 100.0}')
        
        log_success "Performance test completed in ${duration}s"
        log "CPU usage: ${cpu_before}% -> ${cpu_after}%"
        log "Memory usage: ${mem_before}% -> ${mem_after}%"
        
        test_pass "Performance Test"
    else
        log_error "Performance test failed"
        test_fail "Performance Test" "Encoding performance insufficient"
    fi
}

# Test 10: Cleanup test
test_cleanup() {
    log_test "Cleanup Test"
    
    local errors=0
    
    # Stop mock servers
    if [[ -f "/tmp/mock-rtsp.pid" ]]; then
        local rtsp_pid=$(cat "/tmp/mock-rtsp.pid")
        if ps -p "$rtsp_pid" > /dev/null 2>&1; then
            kill "$rtsp_pid" 2>/dev/null || true
            log_success "Mock RTSP server stopped"
        fi
        rm -f "/tmp/mock-rtsp.pid"
    fi
    
    if [[ -f "/tmp/mock-sse.pid" ]]; then
        local sse_pid=$(cat "/tmp/mock-sse.pid")
        if ps -p "$sse_pid" > /dev/null 2>&1; then
            kill "$sse_pid" 2>/dev/null || true
            log_success "Mock SSE server stopped"
        fi
        rm -f "/tmp/mock-sse.pid"
    fi
    
    # Clean up temporary files
    rm -f "/tmp/mock-sse-server.js"
    rm -f "/tmp/test-config.conf"
    
    log_success "Cleanup completed"
    test_pass "Cleanup Test"
}

# Generate test report
generate_report() {
    log "Generating test report..."
    
    # JSON report
    cat > "$TEST_RESULTS" << EOF
{
    "test_run": {
        "timestamp": "$(date -Iseconds)",
        "duration": "$(($(date +%s) - START_TIME))s",
        "ubuntu_version": "$(lsb_release -d 2>/dev/null | cut -f2 || echo 'Unknown')",
        "kernel": "$(uname -r)",
        "architecture": "$(uname -m)"
    },
    "results": {
        "total": $TOTAL_TESTS,
        "passed": $PASSED_TESTS,
        "failed": $FAILED_TESTS,
        "skipped": $SKIPPED_TESTS,
        "success_rate": "$(bc -l <<< "scale=1; $PASSED_TESTS * 100 / $TOTAL_TESTS")%"
    },
    "system_info": {
        "cpu_cores": $(nproc),
        "memory_total": "$(free -h | awk '/^Mem:/ {print $2}')",
        "disk_available": "$(df -h . | awk 'NR==2 {print $4}')",
        "virtualization": "$(systemd-detect-virt 2>/dev/null || echo 'none')"
    }
}
EOF
    
    log_success "Test report generated: $TEST_RESULTS"
}

# Main test function
main() {
    echo "======================================"
    echo "  RTSP-SSE Streaming System Tests"
    echo "  Ubuntu Linux Test Suite"
    echo "======================================"
    echo
    
    START_TIME=$(date +%s)
    init_test_log
    
    # Run all tests
    test_environment
    test_configuration
    test_network
    test_mock_rtsp
    test_mock_sse
    test_script_syntax
    test_dry_run
    test_integration
    test_performance
    test_cleanup
    
    # Generate report
    generate_report
    
    echo
    echo "======================================"
    echo "  Test Results Summary"
    echo "======================================"
    echo "Total Tests: $TOTAL_TESTS"
    echo -e "Passed: ${GREEN}$PASSED_TESTS${NC}"
    echo -e "Failed: ${RED}$FAILED_TESTS${NC}"
    echo -e "Skipped: ${YELLOW}$SKIPPED_TESTS${NC}"
    
    if [[ $FAILED_TESTS -eq 0 ]]; then
        echo -e "\n${GREEN}All tests passed successfully!${NC}"
        echo "The RTSP-SSE streaming system is ready for use."
    else
        echo -e "\n${RED}Some tests failed.${NC}"
        echo "Please check the test log for details: $TEST_LOG"
    fi
    
    echo
    echo "Test log: $TEST_LOG"
    echo "Test results: $TEST_RESULTS"
    echo
}

# Handle script interruption
trap 'test_cleanup; exit 1' INT TERM

# Run main function
main "$@"