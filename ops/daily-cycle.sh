#!/bin/sh
# One daily cycle. Child services own their locks, worker limits and deadlines.
set -eu
umask 077
cycle_day=$(TZ=Europe/Moscow date +%F)
status=0

run_service() {
  printf 'CYCLE_START %s\n' "$1"
  if systemctl start "tarkovstats-$1.service"; then
    printf 'CYCLE_DONE %s\n' "$1"
  else
    status=1
    printf 'CYCLE_FAILED %s\n' "$1" >&2
  fi
}

wait_until() {
  target=$(TZ=Europe/Moscow date -d "$cycle_day $1" +%s)
  printf 'CYCLE_NOT_BEFORE %s %s Europe/Moscow\n' "$cycle_day" "$1"
  while :; do
    remaining=$((target - $(date +%s)))
    [ "$remaining" -gt 0 ] || break
    # Recheck wall time after clock corrections without holding a writer lock.
    [ "$remaining" -le 60 ] || remaining=60
    sleep "$remaining"
  done
}

# Attempt every index even if one source is unavailable; preserve its old data.
for mode in player seasonal pve arena; do
  run_service "$mode-index-sync"
done

wait_until 02:00:00
# This is the only profile invocation. A deadline or error must not replay it.
run_service profile-queue

wait_until 04:20:00
# Publish saved profiles even when some index/profile jobs left unfinished work.
run_service leaderboard-materialize

wait_until 05:30:00
run_service publications
printf 'CYCLE_SUMMARY status=%s\n' "$status"
exit "$status"
