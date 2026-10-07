#!/bin/sh
# One isolated worker coordinates resumable, sequential rounds for at most one hour.
set -eu
umask 077
cd /opt/tarkovstats-auto || exit 1
deadline=$(( ($(date +%s) + 3600) * 1000 ))
exec /usr/local/sbin/tarkovstats-run-background \
  -e "PROFILE_QUEUE_DEADLINE_MS=$deadline" \
  worker nice -n 19 node --experimental-strip-types --experimental-sqlite scripts/run-profile-queue.mjs
