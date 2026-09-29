#!/bin/sh
# Sequential freshness sync followed by one bounded parser-backfill batch.
# Install with the profile-queue Restart=no drop-in; timer retries next hour.
set -u
umask 077
cd /opt/tarkovstats-auto || exit 1
deadline=$(( $(date +%s) + 3300 ))
dc() { /usr/bin/docker compose -p tarkovstats -f docker-compose.vps.yml exec -T -e "PROFILE_QUEUE_DEADLINE_MS=$((deadline * 1000))" "$@"; }
node='node --experimental-strip-types --experimental-sqlite'
log=/var/log/tarkovstats-warmup-batch.json
# stderr is captured out of band: the state parser below reads the last line of
# $log as JSON, and a warning landing between that line and the end of the run
# would turn a healthy batch into state-parse-failed. Truncated every run.
warn=/var/log/tarkovstats-warmup-batch.warn
failures=""
# Retry only the failing mode once; preserve nonzero exit for observability.
RETRY_DELAY=10
# A retry is only worth starting if it still gets a real run window. Below this
# the bounded mode aborts at its first budget checkpoint and exits 0 without
# syncing anything, which would erase the failure the retry exists to rescue.
# Matches the 60s floor the sync scripts accept for *_MAX_RUN_MS.
RETRY_MIN_BUDGET=60

log_line() {
  printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$1" "$2"
}

record_failure() {
  failures="${failures:+$failures }$1:$2"
}

# Runs one queue step, always continues the chain. Usage:
#   run_mode <name> <command...>
# On failure the same mode is retried once after $RETRY_DELAY so transient
# errors (e.g. feed `terminated`) do not skip the mode until the next hour.
# The retry only runs when it would still have $RETRY_MIN_BUDGET seconds of run
# window; otherwise the first failure stands and is recorded.
run_mode() {
  _mode_name="$1"
  shift
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log_line MODE_RESULT "mode=$_mode_name status=deferred-budget"
    return 0
  fi
  "$@"
  _mode_status=$?
  # Seconds the retry would actually get, once the delay is paid.
  _retry_budget=$(( deadline - $(date +%s) - RETRY_DELAY ))
  if [ "$_mode_status" -ne 0 ] && [ "$_retry_budget" -ge "$RETRY_MIN_BUDGET" ]; then
    log_line MODE_RETRY "mode=$_mode_name attempt=1 status=$_mode_status retry_in=$RETRY_DELAY"
    sleep "$RETRY_DELAY"
    "$@"
    _mode_status=$?
  elif [ "$_mode_status" -ne 0 ]; then
    log_line MODE_RETRY "mode=$_mode_name attempt=skipped status=$_mode_status reason=insufficient-budget budget=${_retry_budget}s"
  fi
  log_line MODE_RESULT "mode=$_mode_name status=$_mode_status"
  if [ "$_mode_status" -ne 0 ]; then
    record_failure "$_mode_name" "$_mode_status"
  fi
  sleep 1
  return 0
}

run_mode arena dc -e ARENA_PROFILE_SYNC_RPS=2 -e ARENA_PROFILE_SYNC_CONCURRENCY=2 -e ARENA_PROFILE_SYNC_MAX_RUN_MS=1500000 web $node scripts/sync-arena-profiles.mjs
run_mode regular dc -e REGULAR_PROFILE_SYNC_RPS=1 -e REGULAR_PROFILE_SYNC_MAX_RUN_MS=1500000 web $node scripts/sync-regular-profiles.mjs
run_mode pve dc -e PVE_PROFILE_SYNC_RPS=1 -e PVE_PROFILE_SYNC_MAX_RUN_MS=480000 web $node scripts/sync-pve-profiles.mjs
run_mode seasonal dc -e SEASONAL_FEED_RPS=1 -e SEASONAL_FEED_MAX_RUN_MS=480000 web $node scripts/sync-seasonal-profiles.mjs

if [ "$(date +%s)" -lt "$deadline" ]; then
# One batch only; bounded=true means resume next scheduled run.
dc -e LEADERBOARD_WARMUP_MAX_PROFILES=100 -e LEADERBOARD_WARMUP_MAX_RUN_MS=180000 web $node scripts/warmup-leaderboard-profiles.mjs > "$log" 2> "$warn"
_warmup_status=$?
cat "$log"
# Replay stderr through log_line so a warmup warning reaches the journal in the
# same shape as every other queue line, instead of arriving unframed and unread.
if [ -s "$warn" ]; then
  warn_line=
  while IFS= read -r warn_line || [ -n "$warn_line" ]; do
    log_line WARMUP_WARN "$warn_line"
  done < "$warn"
fi
if [ "$_warmup_status" -ne 0 ]; then
  record_failure warmup "$_warmup_status"
elif ! state=$(tail -n 1 "$log" | python3 -c 'import json,sys; x=json.load(sys.stdin); b=x.get("bounded"); s=x.get("stopped"); p=x.get("processed"); assert type(b) is bool and type(s) is bool and type(p) is int and p>=0; print("stopped" if s else "done")'); then
  record_failure warmup state-parse-failed
elif [ "$state" = stopped ]; then
  log_line MODE_RESULT "mode=warmup status=stopped"
  exit 143
fi

fi

if [ -n "$failures" ]; then
  log_line QUEUE_SUMMARY "ok=false failures=\"$failures\""
  exit 1
fi
log_line QUEUE_SUMMARY "ok=true"
exit 0
