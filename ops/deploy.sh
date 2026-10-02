#!/bin/sh
# Run under the existing deployment flock. Install separately after review.
set -eu
APP=/opt/tarkovstats-auto
cd "$APP"
compose() { docker compose -p tarkovstats -f "$APP/docker-compose.vps.yml" "$@"; }
container() { compose ps -q web; }
healthy() {
  health_cid=$(container)
  [ -n "$health_cid" ] || return 1
  health_ip=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' "$health_cid" | awk 'NF { print; exit }')
  [ -n "$health_ip" ] || return 1
  health_status=$(curl --silent --show-error --noproxy '*' --connect-timeout 2 --max-time 5 \
    --header 'Host: tarkovstats.ru' --output /dev/null --write-out '%{http_code}' \
    "http://$health_ip:3000/healthz") || return 1
  [ "$health_status" = 200 ]
}

# Never discard operator edits. Untracked secrets and local compose are retained.
git diff --quiet || { logger -t tarkovstats-deploy "deploy deferred: working tree dirty"; exit 0; }
git diff --cached --quiet || { logger -t tarkovstats-deploy "deploy deferred: index dirty"; exit 0; }
if ! git fetch --prune origin; then logger -t tarkovstats-deploy "git fetch failed, deferred"; exit 0; fi
previous=$(git rev-parse HEAD)
remote=$(git rev-parse origin/main)
cid=$(container)
deployed=
previous_image=
if [ -n "$cid" ]; then
  deployed=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$cid")
  previous_image=$(docker inspect --format '{{.Image}}' "$cid")
fi
state=/var/lib/tarkovstats-deploy
mkdir -p "$state"
chmod 700 "$state"
# Checkout HEAD can advance even when a build is killed. Only the running
# container's immutable build label proves which revision was deployed.
if [ "$deployed" = "$remote" ]; then
  if healthy; then
    rm -f "$state/unhealthy"
    exit 0
  fi
  # Confirm persistent application failure independently of Caddy. Restart the
  # existing image at most once per 15 minutes; never rebuild unchanged code.
  misses=0
  if [ -f "$state/unhealthy" ]; then
    read -r misses < "$state/unhealthy" || true
    case "${misses:-}" in
      ''|*[!0-9]*) misses=0 ;;
    esac
  fi
  misses=$((misses + 1))
  printf '%s\n' "$misses" > "$state/unhealthy"
  if [ "$misses" -lt 3 ]; then
    logger -t tarkovstats-deploy "health probe failed on deployed $remote; skipping rebuild ($misses/3)"
    exit 0
  fi
  exec 9>/run/tarkovstats-data-sync.lock
  if ! flock -n 9; then
    logger -t tarkovstats-deploy "web recovery deferred: profile sync or backup active"
    exit 75
  fi
  last_restart=0
  if [ -f "$state/restarted_at" ]; then
    read -r last_restart < "$state/restarted_at" || true
    case "${last_restart:-}" in
      ''|*[!0-9]*) last_restart=0 ;;
    esac
  fi
  now=$(date +%s)
  if [ "$(( now - last_restart ))" -lt 900 ]; then
    logger -t tarkovstats-deploy "web recovery deferred: restart cooldown on $remote"
    exit 0
  fi
  printf '%s\n' "$now" > "$state/restarted_at"
  rm -f "$state/unhealthy"
  logger -t tarkovstats-deploy "health probe failed $misses times on deployed $remote; restarting existing image"
  compose restart -t 10 web
  exit 0
fi
exec 9>/run/tarkovstats-data-sync.lock
if ! flock -n 9; then
  logger -t tarkovstats-deploy "deploy deferred: profile sync or backup active"
  exit 75
fi
if [ -f "$state/retry" ]; then
  read -r failed_revision retry_after < "$state/retry" || true
  case "${retry_after:-}" in
    ''|*[!0-9]*) ;;
    *) if [ "${failed_revision:-}" = "$remote" ] && [ "$(date +%s)" -lt "$retry_after" ]; then exit 0; fi;;
  esac
fi
success=0
starting=0
build_started=0
rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$success" -ne 1 ]; then
    # A one-minute timer must not repeatedly launch a failing heavy build.
    if printf '%s %s\n' "$remote" "$(( $(date +%s) + 900 ))" > "$state/retry.tmp"; then
      mv "$state/retry.tmp" "$state/retry" || true
    fi
    git reset --hard "$previous" || true
    if [ -n "$previous_image" ]; then
      docker image tag "$previous_image" tarkovstats-web || true
      if [ "$starting" -eq 1 ]; then compose up -d --no-build web || true; fi
    fi
    logger -t tarkovstats-deploy "deploy failed status=$status target=$remote; restored previous checkout/image"
  else
    # Successful deployments no longer need untagged images from older builds.
    # Preserve the last running image for a later manual rollback first.
    if [ -z "$previous_image" ] || docker image tag "$previous_image" tarkovstats-web-previous; then
      docker image prune -f --filter until=24h >/dev/null || true
    else
      logger -t tarkovstats-deploy "skipped image prune: could not retain previous image"
    fi
  fi
  # The timer also runs when no build is needed. Stop BuildKit only after a build
  # attempt so an idle check cannot interrupt another use of this builder.
  if [ "$build_started" -eq 1 ]; then
    if [ -n "${BUILDX_BUILDER:-}" ]; then
      docker buildx stop "$BUILDX_BUILDER" || true
    else
      logger -t tarkovstats-deploy "limited builder not reclaimed: BUILDX_BUILDER unset; install the deploy service drop-in"
    fi
  fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
git merge --ff-only origin/main
build_started=1
compose build --build-arg "SOURCE_REVISION=$remote" web
starting=1
compose up -d --no-build web
attempt=0
while [ "$attempt" -lt 30 ]; do
  cid=$(container)
  actual=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$cid" 2>/dev/null || true)
  if [ "$actual" = "$remote" ] && healthy; then
    success=1
    rm -f "$state/retry" || true
    logger -t tarkovstats-deploy "deployed $remote"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done
exit 1
