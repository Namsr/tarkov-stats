#!/bin/sh
# Callers hold data-sync (and leaderboard when needed) for the entire job.
set -eu
APP=/opt/tarkovstats-auto
cd "$APP"
slice=tarkovstats-background.slice
# Docker can create a missing parent without our limits. Fail closed instead.
systemctl is-active --quiet "$slice"
[ "$(systemctl show --property=MemoryMax --value "$slice")" = 536870912 ]
[ "$(systemctl show --property=MemorySwapMax --value "$slice")" = 268435456 ]
exec 8>/run/tarkovstats-background-job.lock
flock -n 8 || exit 75
cid=$(docker compose -p tarkovstats -f "$APP/docker-compose.vps.yml" ps -q web)
[ -n "$cid" ]
TARKOVSTATS_WORKER_IMAGE=$(docker inspect --format '{{.Image}}' "$cid")
[ -n "$TARKOVSTATS_WORKER_IMAGE" ]
export TARKOVSTATS_WORKER_IMAGE
job=tarkovstats-background-job
cli=
cleanup() {
  trap - EXIT HUP INT TERM
  # Also covers Docker CLI failures and a signal between spawn and $! capture.
  # The job lock remains held until cleanup finishes.
  docker stop -t 30 "$job" >/dev/null 2>&1 || true
  if [ -n "$cli" ]; then
    kill "$cli" 2>/dev/null || true
    wait "$cli" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# Immutable live image avoids mixing a new collector with the old HTTP revision.
docker compose -p tarkovstats -f "$APP/docker-compose.vps.yml" run \
  --rm --no-deps --no-build --pull never -T --name "$job" "$@" &
cli=$!
status=0
wait "$cli" || status=$?
cli=
exit "$status"
