#!/bin/bash

# Performance Benchmarking Tools for RTSP-SSE Stream Script
# Measures resource usage, streaming performance, and system impact
# Compatible with macOS for development while targeting Linux deployment

set -euo pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Script configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
STREAM_SCRIPT="$PROJECT_ROOT/rtsp-sse-stream.sh"
CONFIG_FILE="$PROJECT_ROOT/rtsp-sse-stream.conf"
PERF_LOG="$SCRIPT_DIR/performance-benchmark.log"
PERF_REPORT="$SCRIPT_DIR/performance-report.json"
PERF_HTML="$SCRIPT_DIR/performance-report.html"

# Performance test configuration
TEST_DURATION="60"  # Default test duration in seconds
QUICK_TEST_DURATION="10"  # Quick test duration
SAMPLE_INTERVAL="1"  # Resource sampling interval in seconds
STRESS_CONNECTIONS="5"  # Number of concurrent connections for stress test
MEMORY_LIMIT="512M"  # Memory limit for testing
CPU_LIMIT="50"  # CPU limit percentage

# Test modes
QUICK_MODE="false"
STRESS_MODE="false"
VERBOSE="false"
CLEANUP_ONLY="false"

# Performance metrics storage
declare -A METRICS
declare -A BASELINE_METRICS
declare -A STRESS_METRICS

# Logging function
log() {
    local level="$1"
    local message="$2"
    local timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
    local color="$NC"
    
    case "$level" in
        "ERROR") color="$RED" ;;
        "WARN") color="$YELLOW" ;;
        "INFO") color="$GREEN" ;;
        "DEBUG") color="$CYAN" ;;
        "PERF") color="$MAGENTA" ;;
    esac
    
    echo -e "${color}[$timestamp] [$level] $message${NC}"
    echo "[$timestamp] [$level] $message" >> "$PERF_LOG"
}

# Check if running on macOS and adjust commands
setup_platform_commands() {
    if [[ "$(uname -s)" == "Darwin" ]]; then
        # macOS alternatives
        PS_CMD="ps -o pid,ppid,pcpu,pmem,vsz,rss,comm"
        TOP_CMD="top -l 1 -n 0"
        IOSTAT_CMD="iostat -c 1 1"
        NETSTAT_CMD="netstat -i"
        
        # Check for GNU tools via Homebrew
        if command -v gps >/dev/null 2>&1; then
            PS_CMD="gps -o pid,ppid,pcpu,pmem,vsz,rss,comm"
        fi
    else
        # Linux commands
        PS_CMD="ps -o pid,ppid,pcpu,pmem,vsz,rss,comm"
        TOP_CMD="top -b -n 1"
        IOSTAT_CMD="iostat -c 1 1"
        NETSTAT_CMD="cat /proc/net/dev"
    fi
}

# Get system information
get_system_info() {
    log "INFO" "Gathering system information..."
    
    local os_info="$(uname -a)"
    local cpu_info=""
    local memory_info=""
    local disk_info=""
    
    if [[ "$(uname -s)" == "Darwin" ]]; then
        cpu_info="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo 'Unknown CPU')"
        memory_info="$(sysctl -n hw.memsize 2>/dev/null | awk '{print $1/1024/1024/1024 " GB"}' || echo 'Unknown Memory')"
        disk_info="$(df -h / | tail -1 | awk '{print $2 " total, " $4 " available"}')"
    else
        cpu_info="$(grep 'model name' /proc/cpuinfo | head -1 | cut -d: -f2 | xargs || echo 'Unknown CPU')"
        memory_info="$(free -h | grep '^Mem:' | awk '{print $2}' || echo 'Unknown Memory')"
        disk_info="$(df -h / | tail -1 | awk '{print $2 " total, " $4 " available"}')"
    fi
    
    METRICS["system_os"]="$os_info"
    METRICS["system_cpu"]="$cpu_info"
    METRICS["system_memory"]="$memory_info"
    METRICS["system_disk"]="$disk_info"
    
    log "PERF" "System: $os_info"
    log "PERF" "CPU: $cpu_info"
    log "PERF" "Memory: $memory_info"
    log "PERF" "Disk: $disk_info"
}

# Monitor resource usage
monitor_resources() {
    local duration="$1"
    local output_file="$2"
    local process_pattern="${3:-rtsp-sse-stream}"
    
    log "INFO" "Monitoring resources for ${duration}s (pattern: $process_pattern)..."
    
    local start_time="$(date +%s)"
    local end_time=$((start_time + duration))
    local sample_count=0
    local total_cpu=0
    local total_memory=0
    local max_cpu=0
    local max_memory=0
    local min_cpu=999
    local min_memory=999999
    
    echo "timestamp,pid,cpu_percent,memory_mb,vsz_mb,rss_mb" > "$output_file"
    
    while [[ "$(date +%s)" -lt "$end_time" ]]; do
        local current_time="$(date +%s)"
        
        # Find processes matching pattern
        local pids=()
        if command -v pgrep >/dev/null 2>&1; then
            mapfile -t pids < <(pgrep -f "$process_pattern" 2>/dev/null || true)
        else
            mapfile -t pids < <(ps aux | grep "$process_pattern" | grep -v grep | awk '{print $2}' || true)
        fi
        
        if [[ ${#pids[@]} -gt 0 ]]; then
            for pid in "${pids[@]}"; do
                if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
                    local ps_output
                    if ps_output="$(ps -p "$pid" -o pcpu,pmem,vsz,rss --no-headers 2>/dev/null)"; then
                        local cpu_percent="$(echo "$ps_output" | awk '{print $1}')"
                        local mem_percent="$(echo "$ps_output" | awk '{print $2}')"
                        local vsz_kb="$(echo "$ps_output" | awk '{print $3}')"
                        local rss_kb="$(echo "$ps_output" | awk '{print $4}')"
                        
                        # Convert to MB
                        local memory_mb="$(echo "$rss_kb" | awk '{print $1/1024}')"
                        local vsz_mb="$(echo "$vsz_kb" | awk '{print $1/1024}')"
                        
                        echo "$current_time,$pid,$cpu_percent,$memory_mb,$vsz_mb,$rss_kb" >> "$output_file"
                        
                        # Update statistics
                        ((sample_count++))
                        total_cpu="$(echo "$total_cpu + $cpu_percent" | bc -l 2>/dev/null || echo "$total_cpu")"
                        total_memory="$(echo "$total_memory + $memory_mb" | bc -l 2>/dev/null || echo "$total_memory")"
                        
                        # Update max values
                        if (( $(echo "$cpu_percent > $max_cpu" | bc -l 2>/dev/null || echo 0) )); then
                            max_cpu="$cpu_percent"
                        fi
                        if (( $(echo "$memory_mb > $max_memory" | bc -l 2>/dev/null || echo 0) )); then
                            max_memory="$memory_mb"
                        fi
                        
                        # Update min values
                        if (( $(echo "$cpu_percent < $min_cpu" | bc -l 2>/dev/null || echo 1) )); then
                            min_cpu="$cpu_percent"
                        fi
                        if (( $(echo "$memory_mb < $min_memory" | bc -l 2>/dev/null || echo 1) )); then
                            min_memory="$memory_mb"
                        fi
                    fi
                fi
            done
        else
            # No processes found, log zero usage
            echo "$current_time,0,0,0,0,0" >> "$output_file"
        fi
        
        sleep "$SAMPLE_INTERVAL"
    done
    
    # Calculate averages
    local avg_cpu=0
    local avg_memory=0
    if [[ $sample_count -gt 0 ]]; then
        avg_cpu="$(echo "$total_cpu / $sample_count" | bc -l 2>/dev/null || echo "0")"
        avg_memory="$(echo "$total_memory / $sample_count" | bc -l 2>/dev/null || echo "0")"
    fi
    
    # Store metrics
    METRICS["avg_cpu_percent"]="$avg_cpu"
    METRICS["avg_memory_mb"]="$avg_memory"
    METRICS["max_cpu_percent"]="$max_cpu"
    METRICS["max_memory_mb"]="$max_memory"
    METRICS["min_cpu_percent"]="$min_cpu"
    METRICS["min_memory_mb"]="$min_memory"
    METRICS["sample_count"]="$sample_count"
    
    log "PERF" "Resource monitoring completed: $sample_count samples"
    log "PERF" "CPU: avg=${avg_cpu}%, max=${max_cpu}%, min=${min_cpu}%"
    log "PERF" "Memory: avg=${avg_memory}MB, max=${max_memory}MB, min=${min_memory}MB"
}

# Test script startup performance
test_startup_performance() {
    log "INFO" "Testing script startup performance..."
    
    local startup_times=()
    local iterations=5
    
    for ((i=1; i<=iterations; i++)); do
        log "DEBUG" "Startup test iteration $i/$iterations"
        
        local start_time="$(date +%s%N)"
        
        # Test dry-run startup
        if timeout 30 bash "$STREAM_SCRIPT" --dry-run --config "$CONFIG_FILE" >/dev/null 2>&1; then
            local end_time="$(date +%s%N)"
            local duration_ms=$(( (end_time - start_time) / 1000000 ))
            startup_times+=("$duration_ms")
            log "DEBUG" "Startup iteration $i: ${duration_ms}ms"
        else
            log "WARN" "Startup test iteration $i failed"
            startup_times+=("9999")
        fi
        
        sleep 1
    done
    
    # Calculate startup statistics
    local total_time=0
    local min_time=999999
    local max_time=0
    
    for time in "${startup_times[@]}"; do
        total_time=$((total_time + time))
        if [[ $time -lt $min_time ]]; then
            min_time="$time"
        fi
        if [[ $time -gt $max_time ]]; then
            max_time="$time"
        fi
    done
    
    local avg_time=$((total_time / iterations))
    
    METRICS["startup_avg_ms"]="$avg_time"
    METRICS["startup_min_ms"]="$min_time"
    METRICS["startup_max_ms"]="$max_time"
    METRICS["startup_iterations"]="$iterations"
    
    log "PERF" "Startup performance: avg=${avg_time}ms, min=${min_time}ms, max=${max_time}ms"
}

# Test configuration loading performance
test_config_performance() {
    log "INFO" "Testing configuration loading performance..."
    
    local config_times=()
    local iterations=10
    
    # Create a temporary config file with various sizes
    local temp_config="$SCRIPT_DIR/temp-perf-config.conf"
    
    # Generate config with different sizes
    for size in "small" "medium" "large"; do
        case "$size" in
            "small")
                cp "$CONFIG_FILE" "$temp_config"
                ;;
            "medium")
                cp "$CONFIG_FILE" "$temp_config"
                # Add some comments and extra variables
                for ((i=1; i<=50; i++)); do
                    echo "# Performance test comment line $i" >> "$temp_config"
                    echo "TEST_VAR_$i=\"test_value_$i\"" >> "$temp_config"
                done
                ;;
            "large")
                cp "$CONFIG_FILE" "$temp_config"
                # Add many comments and variables
                for ((i=1; i<=200; i++)); do
                    echo "# Performance test comment line $i with some longer text to increase file size" >> "$temp_config"
                    echo "TEST_VAR_$i=\"test_value_$i_with_longer_content_for_performance_testing\"" >> "$temp_config"
                done
                ;;
        esac
        
        log "DEBUG" "Testing config loading performance with $size config"
        
        for ((i=1; i<=iterations; i++)); do
            local start_time="$(date +%s%N)"
            
            # Test config loading (source the file)
            if source "$temp_config" 2>/dev/null; then
                local end_time="$(date +%s%N)"
                local duration_us=$(( (end_time - start_time) / 1000 ))
                config_times+=("$duration_us")
            else
                config_times+=("9999")
            fi
        done
        
        # Calculate statistics for this size
        local total_time=0
        local count=0
        
        for time in "${config_times[@]}"; do
            if [[ $time -ne 9999 ]]; then
                total_time=$((total_time + time))
                ((count++))
            fi
        done
        
        if [[ $count -gt 0 ]]; then
            local avg_time=$((total_time / count))
            METRICS["config_${size}_avg_us"]="$avg_time"
            log "PERF" "Config loading ($size): avg=${avg_time}μs"
        fi
        
        config_times=()
    done
    
    rm -f "$temp_config"
}

# Test memory usage under different loads
test_memory_usage() {
    log "INFO" "Testing memory usage patterns..."
    
    local test_scenarios=("baseline" "normal_load" "high_load")
    
    for scenario in "${test_scenarios[@]}"; do
        log "DEBUG" "Testing memory usage: $scenario"
        
        local duration=30
        if [[ "$QUICK_MODE" == "true" ]]; then
            duration=10
        fi
        
        local memory_log="$SCRIPT_DIR/memory-${scenario}.csv"
        
        case "$scenario" in
            "baseline")
                # Just monitor system baseline
                monitor_resources "$duration" "$memory_log" "nonexistent_process"
                ;;
            "normal_load")
                # Start script in dry-run mode and monitor
                bash "$STREAM_SCRIPT" --dry-run --config "$CONFIG_FILE" &
                local script_pid=$!
                sleep 2  # Let it start
                monitor_resources "$duration" "$memory_log" "rtsp-sse-stream"
                kill "$script_pid" 2>/dev/null || true
                wait "$script_pid" 2>/dev/null || true
                ;;
            "high_load")
                # Start multiple instances
                local pids=()
                for ((i=1; i<=3; i++)); do
                    bash "$STREAM_SCRIPT" --dry-run --config "$CONFIG_FILE" &
                    pids+=("$!")
                done
                sleep 2
                monitor_resources "$duration" "$memory_log" "rtsp-sse-stream"
                for pid in "${pids[@]}"; do
                    kill "$pid" 2>/dev/null || true
                done
                for pid in "${pids[@]}"; do
                    wait "$pid" 2>/dev/null || true
                done
                ;;
        esac
        
        # Store scenario-specific metrics
        METRICS["memory_${scenario}_avg"]="${METRICS[avg_memory_mb]}"
        METRICS["memory_${scenario}_max"]="${METRICS[max_memory_mb]}"
        METRICS["cpu_${scenario}_avg"]="${METRICS[avg_cpu_percent]}"
        METRICS["cpu_${scenario}_max"]="${METRICS[max_cpu_percent]}"
    done
}

# Test network performance simulation
test_network_performance() {
    log "INFO" "Testing network performance simulation..."
    
    # Test SSE connection performance with mock server
    local mock_server_script="$SCRIPT_DIR/mock-sse-server.js"
    
    if [[ ! -f "$mock_server_script" ]]; then
        log "WARN" "Mock SSE server not found, skipping network performance test"
        return 0
    fi
    
    # Start mock SSE server
    log "DEBUG" "Starting mock SSE server for network testing..."
    node "$mock_server_script" --port 3001 --scenario stress &
    local server_pid=$!
    sleep 3  # Let server start
    
    # Test connection performance
    local connection_times=()
    local iterations=10
    
    for ((i=1; i<=iterations; i++)); do
        local start_time="$(date +%s%N)"
        
        if curl -s --max-time 5 "http://localhost:3001/events" >/dev/null 2>&1; then
            local end_time="$(date +%s%N)"
            local duration_ms=$(( (end_time - start_time) / 1000000 ))
            connection_times+=("$duration_ms")
            log "DEBUG" "Connection test $i: ${duration_ms}ms"
        else
            connection_times+=("9999")
            log "DEBUG" "Connection test $i: failed"
        fi
        
        sleep 1
    done
    
    # Calculate connection statistics
    local total_time=0
    local successful_connections=0
    local min_time=999999
    local max_time=0
    
    for time in "${connection_times[@]}"; do
        if [[ $time -ne 9999 ]]; then
            total_time=$((total_time + time))
            ((successful_connections++))
            if [[ $time -lt $min_time ]]; then
                min_time="$time"
            fi
            if [[ $time -gt $max_time ]]; then
                max_time="$time"
            fi
        fi
    done
    
    if [[ $successful_connections -gt 0 ]]; then
        local avg_time=$((total_time / successful_connections))
        local success_rate=$(( (successful_connections * 100) / iterations ))
        
        METRICS["network_avg_ms"]="$avg_time"
        METRICS["network_min_ms"]="$min_time"
        METRICS["network_max_ms"]="$max_time"
        METRICS["network_success_rate"]="$success_rate"
        
        log "PERF" "Network performance: avg=${avg_time}ms, success=${success_rate}%"
    else
        METRICS["network_avg_ms"]="0"
        METRICS["network_success_rate"]="0"
        log "WARN" "All network connection tests failed"
    fi
    
    # Clean up mock server
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
}

# Run stress test
run_stress_test() {
    log "INFO" "Running stress test with $STRESS_CONNECTIONS concurrent connections..."
    
    local stress_duration=60
    if [[ "$QUICK_MODE" == "true" ]]; then
        stress_duration=20
    fi
    
    local pids=()
    local stress_log="$SCRIPT_DIR/stress-test.csv"
    
    # Start multiple script instances
    for ((i=1; i<=STRESS_CONNECTIONS; i++)); do
        log "DEBUG" "Starting stress test instance $i"
        bash "$STREAM_SCRIPT" --dry-run --config "$CONFIG_FILE" &
        pids+=("$!")
        sleep 1  # Stagger startup
    done
    
    sleep 5  # Let all instances start
    
    # Monitor during stress test
    monitor_resources "$stress_duration" "$stress_log" "rtsp-sse-stream"
    
    # Store stress test metrics
    STRESS_METRICS["stress_avg_cpu"]="${METRICS[avg_cpu_percent]}"
    STRESS_METRICS["stress_max_cpu"]="${METRICS[max_cpu_percent]}"
    STRESS_METRICS["stress_avg_memory"]="${METRICS[avg_memory_mb]}"
    STRESS_METRICS["stress_max_memory"]="${METRICS[max_memory_mb]}"
    STRESS_METRICS["stress_connections"]="$STRESS_CONNECTIONS"
    STRESS_METRICS["stress_duration"]="$stress_duration"
    
    # Clean up stress test instances
    log "DEBUG" "Cleaning up stress test instances..."
    for pid in "${pids[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    
    for pid in "${pids[@]}"; do
        wait "$pid" 2>/dev/null || true
    done
    
    log "PERF" "Stress test completed: ${STRESS_CONNECTIONS} connections for ${stress_duration}s"
    log "PERF" "Stress CPU: avg=${STRESS_METRICS[stress_avg_cpu]}%, max=${STRESS_METRICS[stress_max_cpu]}%"
    log "PERF" "Stress Memory: avg=${STRESS_METRICS[stress_avg_memory]}MB, max=${STRESS_METRICS[stress_max_memory]}MB"
}

# Generate performance report
generate_performance_report() {
    log "INFO" "Generating performance report..."
    
    local timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    
    # Generate JSON report
    cat > "$PERF_REPORT" << EOF
{
  "performance_report": {
    "timestamp": "$timestamp",
    "test_configuration": {
      "duration": "$TEST_DURATION",
      "quick_mode": $QUICK_MODE,
      "stress_mode": $STRESS_MODE,
      "sample_interval": "$SAMPLE_INTERVAL",
      "stress_connections": "$STRESS_CONNECTIONS"
    },
    "system_info": {
      "os": "${METRICS[system_os]}",
      "cpu": "${METRICS[system_cpu]}",
      "memory": "${METRICS[system_memory]}",
      "disk": "${METRICS[system_disk]}"
    },
    "startup_performance": {
      "average_ms": "${METRICS[startup_avg_ms]:-0}",
      "minimum_ms": "${METRICS[startup_min_ms]:-0}",
      "maximum_ms": "${METRICS[startup_max_ms]:-0}",
      "iterations": "${METRICS[startup_iterations]:-0}"
    },
    "resource_usage": {
      "baseline": {
        "cpu_avg_percent": "${METRICS[cpu_baseline_avg]:-0}",
        "cpu_max_percent": "${METRICS[cpu_baseline_max]:-0}",
        "memory_avg_mb": "${METRICS[memory_baseline_avg]:-0}",
        "memory_max_mb": "${METRICS[memory_baseline_max]:-0}"
      },
      "normal_load": {
        "cpu_avg_percent": "${METRICS[cpu_normal_load_avg]:-0}",
        "cpu_max_percent": "${METRICS[cpu_normal_load_max]:-0}",
        "memory_avg_mb": "${METRICS[memory_normal_load_avg]:-0}",
        "memory_max_mb": "${METRICS[memory_normal_load_max]:-0}"
      },
      "high_load": {
        "cpu_avg_percent": "${METRICS[cpu_high_load_avg]:-0}",
        "cpu_max_percent": "${METRICS[cpu_high_load_max]:-0}",
        "memory_avg_mb": "${METRICS[memory_high_load_avg]:-0}",
        "memory_max_mb": "${METRICS[memory_high_load_max]:-0}"
      }
    },
    "network_performance": {
      "connection_avg_ms": "${METRICS[network_avg_ms]:-0}",
      "connection_min_ms": "${METRICS[network_min_ms]:-0}",
      "connection_max_ms": "${METRICS[network_max_ms]:-0}",
      "success_rate_percent": "${METRICS[network_success_rate]:-0}"
    },
    "configuration_loading": {
      "small_config_avg_us": "${METRICS[config_small_avg_us]:-0}",
      "medium_config_avg_us": "${METRICS[config_medium_avg_us]:-0}",
      "large_config_avg_us": "${METRICS[config_large_avg_us]:-0}"
    }
EOF
    
    # Add stress test results if available
    if [[ "$STRESS_MODE" == "true" ]] && [[ -n "${STRESS_METRICS[stress_avg_cpu]:-}" ]]; then
        cat >> "$PERF_REPORT" << EOF
,
    "stress_test": {
      "connections": "${STRESS_METRICS[stress_connections]}",
      "duration_seconds": "${STRESS_METRICS[stress_duration]}",
      "cpu_avg_percent": "${STRESS_METRICS[stress_avg_cpu]}",
      "cpu_max_percent": "${STRESS_METRICS[stress_max_cpu]}",
      "memory_avg_mb": "${STRESS_METRICS[stress_avg_memory]}",
      "memory_max_mb": "${STRESS_METRICS[stress_max_memory]}"
    }
EOF
    fi
    
    cat >> "$PERF_REPORT" << EOF
  }
}
EOF
    
    log "INFO" "JSON performance report generated: $PERF_REPORT"
}

# Generate HTML performance report
generate_html_report() {
    log "INFO" "Generating HTML performance report..."
    
    cat > "$PERF_HTML" << 'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RTSP-SSE Stream Script - Performance Report</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }
        .header h1 {
            margin: 0;
            font-size: 2.5em;
        }
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            padding: 30px;
        }
        .metric-card {
            background: white;
            border: 1px solid #e9ecef;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .metric-title {
            font-size: 1.1em;
            font-weight: bold;
            color: #333;
            margin-bottom: 15px;
            border-bottom: 2px solid #ff6b6b;
            padding-bottom: 5px;
        }
        .metric-value {
            font-size: 2em;
            font-weight: bold;
            color: #ff6b6b;
            margin-bottom: 5px;
        }
        .metric-label {
            color: #666;
            font-size: 0.9em;
        }
        .chart-container {
            padding: 30px;
            border-top: 1px solid #e9ecef;
        }
        .chart-wrapper {
            position: relative;
            height: 400px;
            margin-bottom: 30px;
        }
        .system-info {
            background: #f8f9fa;
            padding: 20px;
            margin: 20px;
            border-radius: 8px;
            border-left: 4px solid #ff6b6b;
        }
        .system-info h3 {
            margin-top: 0;
            color: #333;
        }
        .system-info p {
            margin: 5px 0;
            color: #666;
        }
        .performance-grade {
            text-align: center;
            padding: 20px;
            margin: 20px;
            border-radius: 8px;
            font-size: 1.2em;
            font-weight: bold;
        }
        .grade-excellent { background: #d4edda; color: #155724; }
        .grade-good { background: #d1ecf1; color: #0c5460; }
        .grade-fair { background: #fff3cd; color: #856404; }
        .grade-poor { background: #f8d7da; color: #721c24; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📊 Performance Report</h1>
            <p>RTSP-SSE Stream Script - Performance Benchmarking Results</p>
            <p>Generated on $(date)</p>
        </div>
        
        <div class="system-info">
            <h3>🖥️ System Information</h3>
            <p><strong>OS:</strong> ${METRICS[system_os]}</p>
            <p><strong>CPU:</strong> ${METRICS[system_cpu]}</p>
            <p><strong>Memory:</strong> ${METRICS[system_memory]}</p>
            <p><strong>Disk:</strong> ${METRICS[system_disk]}</p>
        </div>
        
EOF
    
    # Calculate performance grade
    local startup_time="${METRICS[startup_avg_ms]:-1000}"
    local cpu_usage="${METRICS[cpu_normal_load_avg]:-50}"
    local memory_usage="${METRICS[memory_normal_load_avg]:-100}"
    
    local grade="fair"
    local grade_text="Fair Performance"
    
    if [[ "$(echo "$startup_time < 500" | bc -l 2>/dev/null || echo 0)" == "1" ]] && 
       [[ "$(echo "$cpu_usage < 20" | bc -l 2>/dev/null || echo 0)" == "1" ]] && 
       [[ "$(echo "$memory_usage < 50" | bc -l 2>/dev/null || echo 0)" == "1" ]]; then
        grade="excellent"
        grade_text="Excellent Performance 🌟"
    elif [[ "$(echo "$startup_time < 1000" | bc -l 2>/dev/null || echo 0)" == "1" ]] && 
         [[ "$(echo "$cpu_usage < 40" | bc -l 2>/dev/null || echo 0)" == "1" ]] && 
         [[ "$(echo "$memory_usage < 100" | bc -l 2>/dev/null || echo 0)" == "1" ]]; then
        grade="good"
        grade_text="Good Performance 👍"
    elif [[ "$(echo "$startup_time > 2000" | bc -l 2>/dev/null || echo 1)" == "1" ]] || 
         [[ "$(echo "$cpu_usage > 80" | bc -l 2>/dev/null || echo 1)" == "1" ]] || 
         [[ "$(echo "$memory_usage > 200" | bc -l 2>/dev/null || echo 1)" == "1" ]]; then
        grade="poor"
        grade_text="Poor Performance ⚠️"
    fi
    
    cat >> "$PERF_HTML" << EOF
        <div class="performance-grade grade-$grade">
            Overall Performance Grade: $grade_text
        </div>
        
        <div class="metrics-grid">
            <div class="metric-card">
                <div class="metric-title">⚡ Startup Performance</div>
                <div class="metric-value">${METRICS[startup_avg_ms]:-0}</div>
                <div class="metric-label">Average startup time (ms)</div>
            </div>
            
            <div class="metric-card">
                <div class="metric-title">🔥 CPU Usage</div>
                <div class="metric-value">${METRICS[cpu_normal_load_avg]:-0}%</div>
                <div class="metric-label">Average CPU usage</div>
            </div>
            
            <div class="metric-card">
                <div class="metric-title">💾 Memory Usage</div>
                <div class="metric-value">${METRICS[memory_normal_load_avg]:-0}</div>
                <div class="metric-label">Average memory (MB)</div>
            </div>
            
            <div class="metric-card">
                <div class="metric-title">🌐 Network Performance</div>
                <div class="metric-value">${METRICS[network_avg_ms]:-0}</div>
                <div class="metric-label">Average connection time (ms)</div>
            </div>
EOF
    
    # Add stress test metrics if available
    if [[ "$STRESS_MODE" == "true" ]] && [[ -n "${STRESS_METRICS[stress_avg_cpu]:-}" ]]; then
        cat >> "$PERF_HTML" << EOF
            
            <div class="metric-card">
                <div class="metric-title">🔥 Stress Test CPU</div>
                <div class="metric-value">${STRESS_METRICS[stress_avg_cpu]}%</div>
                <div class="metric-label">CPU under ${STRESS_METRICS[stress_connections]} connections</div>
            </div>
            
            <div class="metric-card">
                <div class="metric-title">💾 Stress Test Memory</div>
                <div class="metric-value">${STRESS_METRICS[stress_avg_memory]}</div>
                <div class="metric-label">Memory under ${STRESS_METRICS[stress_connections]} connections (MB)</div>
            </div>
EOF
    fi
    
    cat >> "$PERF_HTML" << 'EOF'
        </div>
        
        <div class="chart-container">
            <h2>📈 Performance Charts</h2>
            
            <div class="chart-wrapper">
                <canvas id="resourceChart"></canvas>
            </div>
            
            <div class="chart-wrapper">
                <canvas id="startupChart"></canvas>
            </div>
        </div>
    </div>
    
    <script>
        // Resource Usage Chart
        const resourceCtx = document.getElementById('resourceChart').getContext('2d');
        new Chart(resourceCtx, {
            type: 'bar',
            data: {
                labels: ['Baseline', 'Normal Load', 'High Load'],
                datasets: [{
                    label: 'CPU Usage (%)',
                    data: [
EOF
    
    echo "                        ${METRICS[cpu_baseline_avg]:-0}," >> "$PERF_HTML"
    echo "                        ${METRICS[cpu_normal_load_avg]:-0}," >> "$PERF_HTML"
    echo "                        ${METRICS[cpu_high_load_avg]:-0}" >> "$PERF_HTML"
    
    cat >> "$PERF_HTML" << 'EOF'
                    ],
                    backgroundColor: 'rgba(255, 107, 107, 0.6)',
                    borderColor: 'rgba(255, 107, 107, 1)',
                    borderWidth: 1
                }, {
                    label: 'Memory Usage (MB)',
                    data: [
EOF
    
    echo "                        ${METRICS[memory_baseline_avg]:-0}," >> "$PERF_HTML"
    echo "                        ${METRICS[memory_normal_load_avg]:-0}," >> "$PERF_HTML"
    echo "                        ${METRICS[memory_high_load_avg]:-0}" >> "$PERF_HTML"
    
    cat >> "$PERF_HTML" << 'EOF'
                    ],
                    backgroundColor: 'rgba(54, 162, 235, 0.6)',
                    borderColor: 'rgba(54, 162, 235, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    title: {
                        display: true,
                        text: 'Resource Usage Comparison'
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true
                    }
                }
            }
        });
        
        // Startup Performance Chart
        const startupCtx = document.getElementById('startupChart').getContext('2d');
        new Chart(startupCtx, {
            type: 'line',
            data: {
                labels: ['Min', 'Average', 'Max'],
                datasets: [{
                    label: 'Startup Time (ms)',
                    data: [
EOF
    
    echo "                        ${METRICS[startup_min_ms]:-0}," >> "$PERF_HTML"
    echo "                        ${METRICS[startup_avg_ms]:-0}," >> "$PERF_HTML"
    echo "                        ${METRICS[startup_max_ms]:-0}" >> "$PERF_HTML"
    
    cat >> "$PERF_HTML" << 'EOF'
                    ],
                    backgroundColor: 'rgba(75, 192, 192, 0.2)',
                    borderColor: 'rgba(75, 192, 192, 1)',
                    borderWidth: 2,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    title: {
                        display: true,
                        text: 'Startup Performance Distribution'
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true
                    }
                }
            }
        });
    </script>
</body>
</html>
EOF
    
    log "INFO" "HTML performance report generated: $PERF_HTML"
}

# Display performance summary
display_summary() {
    echo
    echo "==========================================="
    echo "      PERFORMANCE BENCHMARK RESULTS"
    echo "==========================================="
    echo
    
    echo "🖥️  System Information:"
    echo "   OS: ${METRICS[system_os]}"
    echo "   CPU: ${METRICS[system_cpu]}"
    echo "   Memory: ${METRICS[system_memory]}"
    echo
    
    echo "⚡ Startup Performance:"
    echo "   Average: ${METRICS[startup_avg_ms]:-0}ms"
    echo "   Range: ${METRICS[startup_min_ms]:-0}ms - ${METRICS[startup_max_ms]:-0}ms"
    echo
    
    echo "📊 Resource Usage (Normal Load):"
    echo "   CPU: ${METRICS[cpu_normal_load_avg]:-0}% (max: ${METRICS[cpu_normal_load_max]:-0}%)"
    echo "   Memory: ${METRICS[memory_normal_load_avg]:-0}MB (max: ${METRICS[memory_normal_load_max]:-0}MB)"
    echo
    
    echo "🌐 Network Performance:"
    echo "   Connection Time: ${METRICS[network_avg_ms]:-0}ms"
    echo "   Success Rate: ${METRICS[network_success_rate]:-0}%"
    echo
    
    if [[ "$STRESS_MODE" == "true" ]] && [[ -n "${STRESS_METRICS[stress_avg_cpu]:-}" ]]; then
        echo "🔥 Stress Test (${STRESS_METRICS[stress_connections]} connections):"
        echo "   CPU: ${STRESS_METRICS[stress_avg_cpu]}% (max: ${STRESS_METRICS[stress_max_cpu]}%)"
        echo "   Memory: ${STRESS_METRICS[stress_avg_memory]}MB (max: ${STRESS_METRICS[stress_max_memory]}MB)"
        echo
    fi
    
    echo "📁 Reports Generated:"
    echo "   📄 JSON: $PERF_REPORT"
    echo "   🌐 HTML: $PERF_HTML"
    echo "   📋 Log: $PERF_LOG"
    echo
    
    log "INFO" "Performance benchmarking completed successfully!"
}

# Cleanup function
cleanup() {
    log "INFO" "Performing cleanup..."
    
    # Kill any remaining processes
    pkill -f "rtsp-sse-stream" 2>/dev/null || true
    pkill -f "mock-sse-server" 2>/dev/null || true
    
    # Clean up temporary files
    rm -f "$SCRIPT_DIR"/temp-*.conf 2>/dev/null || true
    rm -f "$SCRIPT_DIR"/*.csv 2>/dev/null || true
    
    log "INFO" "Cleanup completed"
}

# Show usage information
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Performance Benchmarking Tools for RTSP-SSE Stream Script

OPTIONS:
    --quick               Run quick performance tests (shorter duration)
    --stress              Include stress testing with multiple connections
    --duration=SECONDS    Set test duration (default: 60s, quick: 10s)
    --connections=N       Set number of stress test connections (default: 5)
    --verbose             Enable verbose output
    --cleanup-only        Only perform cleanup and exit
    --help                Show this help message

TEST CATEGORIES:
    - System information gathering
    - Script startup performance
    - Configuration loading performance
    - Resource usage monitoring (baseline, normal, high load)
    - Network performance simulation
    - Stress testing (optional)

OUTPUT FILES:
    - Performance log: $PERF_LOG
    - JSON report: $PERF_REPORT
    - HTML report: $PERF_HTML
    - Resource monitoring CSV files

EXAMPLES:
    $0                    # Run full performance benchmark
    $0 --quick            # Run quick performance tests
    $0 --stress           # Include stress testing
    $0 --duration=120     # Run 2-minute tests
    $0 --connections=10   # Stress test with 10 connections

EOF
}

# Main function
main() {
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --quick)
                QUICK_MODE="true"
                TEST_DURATION="$QUICK_TEST_DURATION"
                shift
                ;;
            --stress)
                STRESS_MODE="true"
                shift
                ;;
            --duration=*)
                TEST_DURATION="${1#*=}"
                shift
                ;;
            --connections=*)
                STRESS_CONNECTIONS="${1#*=}"
                shift
                ;;
            --verbose)
                VERBOSE="true"
                shift
                ;;
            --cleanup-only)
                CLEANUP_ONLY="true"
                shift
                ;;
            --help)
                usage
                exit 0
                ;;
            *)
                log "ERROR" "Unknown option: $1"
                usage
                exit 1
                ;;
        esac
    done
    
    # Set up signal handlers
    trap cleanup EXIT
    trap 'log "INFO" "Received interrupt signal"; exit 1' INT TERM
    
    # Handle cleanup-only mode
    if [[ "$CLEANUP_ONLY" == "true" ]]; then
        cleanup
        exit 0
    fi
    
    # Initialize
    log "INFO" "Starting RTSP-SSE Stream Script Performance Benchmarking"
    echo "Performance Benchmark Log - $(date)" > "$PERF_LOG"
    
    # Setup platform-specific commands
    setup_platform_commands
    
    # Check if main script exists
    if [[ ! -f "$STREAM_SCRIPT" ]]; then
        log "ERROR" "Main script not found: $STREAM_SCRIPT"
        exit 1
    fi
    
    if [[ ! -f "$CONFIG_FILE" ]]; then
        log "ERROR" "Configuration file not found: $CONFIG_FILE"
        exit 1
    fi
    
    # Run performance tests
    log "INFO" "Running performance benchmark suite..."
    
    get_system_info
    test_startup_performance
    test_config_performance
    test_memory_usage
    test_network_performance
    
    if [[ "$STRESS_MODE" == "true" ]]; then
        run_stress_test
    fi
    
    # Generate reports
    generate_performance_report
    generate_html_report
    
    # Display summary
    display_summary
    
    log "INFO" "Performance benchmarking completed successfully!"
}

# Run main function if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi