#!/usr/bin/env bash
set -euo pipefail

: "${SYSTEM_METRICS_ENDPOINT:?SYSTEM_METRICS_ENDPOINT is required}"
: "${SYSTEM_METRICS_INGEST_TOKEN:?SYSTEM_METRICS_INGEST_TOKEN is required}"

for required_command in awk curl df; do
  command -v "$required_command" >/dev/null 2>&1 || {
    echo "system metrics collector: missing $required_command" >&2
    exit 1
  }
done

read -r _ cpu_user cpu_nice cpu_system cpu_idle cpu_iowait cpu_irq cpu_softirq cpu_steal _ < /proc/stat
read -r load_1 load_5 load_15 _ < /proc/loadavg
read -r uptime_seconds _ < /proc/uptime

read -r memory_total_kb memory_available_kb swap_total_kb swap_free_kb < <(
  awk '
    /^MemTotal:/ { total=$2 }
    /^MemAvailable:/ { available=$2 }
    /^MemFree:/ { free=$2 }
    /^Buffers:/ { buffers=$2 }
    /^Cached:/ { cached=$2 }
    /^SwapTotal:/ { swap_total=$2 }
    /^SwapFree:/ { swap_free=$2 }
    END {
      if (!available) available=free+buffers+cached
      printf "%.0f %.0f %.0f %.0f\n", total, available, swap_total, swap_free
    }
  ' /proc/meminfo
)

read -r disk_total_bytes disk_used_bytes disk_available_bytes < <(
  df -B1 -P / | awk 'NR == 2 { printf "%.0f %.0f %.0f\n", $2, $3, $4 }'
)

disk_read_sectors=0
disk_write_sectors=0
for stat_file in /sys/block/*/stat; do
  device_path=${stat_file%/stat}
  device_name=${device_path##*/}
  case "$device_name" in
    loop*|ram*|zram*|dm-*|md*) continue ;;
  esac
  read -r _ _ read_sectors _ _ _ write_sectors _ < "$stat_file"
  disk_read_sectors=$((disk_read_sectors + read_sectors))
  disk_write_sectors=$((disk_write_sectors + write_sectors))
done

read -r network_rx_bytes network_tx_bytes < <(
  awk '
    NR > 2 {
      gsub(/:/, " ")
      if ($1 != "lo") { rx += $2; tx += $10 }
    }
    END { printf "%.0f %.0f\n", rx, tx }
  ' /proc/net/dev
)

memory_total_bytes=$((memory_total_kb * 1024))
memory_available_bytes=$((memory_available_kb * 1024))
swap_total_bytes=$((swap_total_kb * 1024))
swap_free_bytes=$((swap_free_kb * 1024))

payload=$(printf '{"uptimeSeconds":%s,"load1":%s,"load5":%s,"load15":%s,"cpuUser":%s,"cpuNice":%s,"cpuSystem":%s,"cpuIdle":%s,"cpuIowait":%s,"cpuIrq":%s,"cpuSoftirq":%s,"cpuSteal":%s,"memoryTotalBytes":%s,"memoryAvailableBytes":%s,"swapTotalBytes":%s,"swapFreeBytes":%s,"diskTotalBytes":%s,"diskUsedBytes":%s,"diskAvailableBytes":%s,"diskReadSectors":%s,"diskWriteSectors":%s,"networkRxBytes":%s,"networkTxBytes":%s}' \
  "$uptime_seconds" "$load_1" "$load_5" "$load_15" \
  "$cpu_user" "$cpu_nice" "$cpu_system" "$cpu_idle" "$cpu_iowait" "$cpu_irq" "$cpu_softirq" "$cpu_steal" \
  "$memory_total_bytes" "$memory_available_bytes" "$swap_total_bytes" "$swap_free_bytes" \
  "$disk_total_bytes" "$disk_used_bytes" "$disk_available_bytes" "$disk_read_sectors" "$disk_write_sectors" \
  "$network_rx_bytes" "$network_tx_bytes")

curl --fail --silent --show-error --max-time 20 \
  --request POST \
  --header "Authorization: Bearer ${SYSTEM_METRICS_INGEST_TOKEN}" \
  --header "Content-Type: application/json" \
  --data-binary "$payload" \
  "$SYSTEM_METRICS_ENDPOINT"
