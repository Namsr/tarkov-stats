#!/bin/sh
# One isolated worker; nightly gets up to five hours, temporary catch-up one.
set -eu
umask 077
cd /opt/tarkovstats-auto || exit 1
now=$(date +%s)
case "${1:-nightly}" in
  nightly)
    # Leave the morning backup/publications their own window, even after late indexes.
    night_end=$(TZ=Europe/Moscow date -d 'today 07:00:00' +%s)
    seconds=$((night_end - now))
    [ "$seconds" -gt 0 ] || exit 75
    [ "$seconds" -le 18000 ] || seconds=18000
    ;;
  catchup) seconds=3600 ;;
  *) printf 'Unknown profile queue mode: %s\n' "$1" >&2; exit 2 ;;
esac
deadline=$(( (now + seconds) * 1000 ))
/usr/local/sbin/tarkovstats-run-background \
  -e "PROFILE_QUEUE_DEADLINE_MS=$deadline" \
  worker nice -n 19 node --experimental-strip-types --experimental-sqlite scripts/run-profile-queue.mjs

# Only an actually completed worker retires recovery. Failed feeds, a deadline
# or a skipped ExecCondition cannot reach this point under set -e.
if /usr/bin/systemctl is-enabled --quiet tarkovstats-profile-catchup.timer; then
  /usr/bin/systemctl disable --now tarkovstats-profile-catchup.timer
fi
