#!/bin/sh
# TarkovStats sequential profile queue driver (Etap B3).
#
# Versioned copy of /usr/local/sbin/tarkovstats-profile-queue (live checkout is
# /opt/tarkovstats-auto, compose project "tarkovstats"). Steps, order, RPS and
# the warmup batch size are identical to the live wrapper; the only behavior
# change is failure isolation: one mode failing no longer skips the remaining
# modes (the old `set -eu` aborted the chain, so e.g. a Regular FATAL skipped
# PvE/Arena/Seasonal entirely). Per-mode results go to the journal as
# MODE_RESULT lines, the run ends with QUEUE_SUMMARY, and the exit status stays
# nonzero when any mode failed so Restart=on-failure keeps firing.
#
# Server-local install (MANUAL, merge does NOT deploy this file):
#   cp /usr/local/sbin/tarkovstats-profile-queue \
#     /root/tarkovstats-profile-queue.bak-$(date +%F)
#   install -m 750 ops/profile-queue.sh /usr/local/sbin/tarkovstats-profile-queue
# Rollback: copy the backup back. No daemon-reload needed (the unit reads the
# file on every start). Verify with:
#   sh -n /usr/local/sbin/tarkovstats-profile-queue
#   systemctl status tarkovstats-profile-queue.service
#   journalctl -u tarkovstats-profile-queue.service --since "1 hour ago" | grep -E "MODE_RESULT|QUEUE_SUMMARY"
#
# Runs under tarkovstats-profile-queue.service, which holds the shared
# /run/tarkovstats-data-sync.lock. Do NOT re-enable the four disabled
# *-profile-sync timers on top of this queue (lock contention + doubled load).
set -u
umask 077
cd /opt/tarkovstats-auto
dc() { /usr/bin/docker compose -p tarkovstats -f docker-compose.vps.yml exec -T "$@"; }
node='node --experimental-strip-types --experimental-sqlite'
log=/var/log/tarkovstats-warmup-batch.json
failures=""

log_line() {
  printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$1" "$2"
}

record_failure() {
  failures="${failures:+$failures }$1:$2"
}

# Runs one queue step, always continues the chain. Usage:
#   run_mode <name> <command...>
run_mode() {
  _mode_name="$1"
  shift
  "$@"
  _mode_status=$?
  log_line MODE_RESULT "mode=$_mode_name status=$_mode_status"
  if [ "$_mode_status" -ne 0 ]; then
    record_failure "$_mode_name" "$_mode_status"
  fi
  sleep 1
  return 0
}

sleep 1

# 1. Parser-backfill batch (bounded by LEADERBOARD_WARMUP_MAX_PROFILES; the
# batch cap itself is tuned separately). A warmup failure is recorded and the
# freshness modes below still run.
while :; do
  dc -e LEADERBOARD_WARMUP_MAX_PROFILES=100000 web $node scripts/warmup-leaderboard-profiles.mjs > "$log"
  _warmup_status=$?
  if [ "$_warmup_status" -ne 0 ]; then
    log_line MODE_RESULT "mode=warmup status=$_warmup_status"
    record_failure warmup "$_warmup_status"
    break
  fi
  cat "$log"
  if ! state=$(tail -n 1 "$log" | python3 -c 'import json,sys; x=json.load(sys.stdin); b=x.get("bounded"); s=x.get("stopped"); p=x.get("processed"); assert type(b) is bool and s is False and type(p) is int and p>=0 and (not b or p>0); print("more" if b else "done")'); then
    log_line MODE_RESULT "mode=warmup status=state-parse-failed"
    record_failure warmup state-parse-failed
    break
  fi
  sleep 1
  [ "$state" = more ] || break
done

# 2-5. Freshness modes, strictly sequential, 1 RPS each (unchanged).
run_mode regular dc -e REGULAR_PROFILE_SYNC_RPS=1 web $node scripts/sync-regular-profiles.mjs
run_mode pve dc -e PVE_PROFILE_SYNC_RPS=1 web $node scripts/sync-pve-profiles.mjs
run_mode arena dc -e ARENA_PROFILE_SYNC_RPS=1 web $node scripts/sync-arena-profiles.mjs
run_mode seasonal dc -e SEASONAL_FEED_RPS=1 web $node scripts/sync-seasonal-profiles.mjs

if [ -n "$failures" ]; then
  log_line QUEUE_SUMMARY "ok=false failures=\"$failures\""
  exit 1
fi
log_line QUEUE_SUMMARY "ok=true"
exit 0
