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
  # Restarting HTTP-only web cannot interrupt collectors in separate containers.
  # Keep the old guard until the operator installs the isolation configuration.
  if ! docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$cid" |
      grep -qx 'WEB_BACKGROUND_WORKERS=false'; then
    exec 9>/run/tarkovstats-data-sync.lock
    if ! flock -n 9; then
      logger -t tarkovstats-deploy "web recovery deferred: profile sync or backup active"
      exit 75
    fi
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
download_dir=
candidate="tarkovstats-web:$remote"
rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$success" -ne 1 ]; then
    # A one-minute timer must not repeatedly retry a broken image/deployment.
    if printf '%s %s\n' "$remote" "$(( $(date +%s) + 900 ))" > "$state/retry.tmp"; then
      mv "$state/retry.tmp" "$state/retry" || true
    fi
    git reset --hard "$previous" || true
    if [ -n "$previous_image" ]; then
      docker image tag "$previous_image" tarkovstats-web || true
      if [ "$starting" -eq 1 ]; then compose up -d --no-build web || true; fi
    fi
    logger -t tarkovstats-deploy "deploy failed status=$status target=$remote; restored previous checkout/image"
  elif [ "$starting" -eq 1 ]; then
    # Successful deployments no longer need untagged images from older builds.
    # Preserve the last running image for a later manual rollback first.
    if [ -z "$previous_image" ] || docker image tag "$previous_image" tarkovstats-web-previous; then
      docker image prune -f --filter until=24h >/dev/null || true
    else
      logger -t tarkovstats-deploy "skipped image prune: could not retain previous image"
    fi
  fi
  # Only the latest/previous tags are retained; never prune the last good image.
  docker image rm "$candidate" >/dev/null 2>&1 || true
  if [ -n "$download_dir" ]; then
    rm -f "$download_dir/web.tar.gz" "$download_dir/web.tar.gz.sha256"
    rmdir "$download_dir" || true
  fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Publish the release only after both assets upload. A missing release means
# CI is still building; keep the running container and checkout, retry next tick.
umask 077
download_dir=$(mktemp -d "$state/image.XXXXXX")
asset_url="https://github.com/Namsr/tarkov-stats/releases/download/container-$remote"
if ! curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 10 --max-time 30 --output "$download_dir/web.tar.gz.sha256" \
  "$asset_url/web.tar.gz.sha256"; then
  success=1
  logger -t tarkovstats-deploy "deploy deferred: ready image unavailable for $remote"
  exit 0
fi
# Reject arbitrary checksum filenames rather than letting them read host files.
checksum=$(cat "$download_dir/web.tar.gz.sha256")
[ "$(printf '%s\n' "$checksum" | wc -l)" -eq 1 ]
printf '%s\n' "$checksum" | LC_ALL=C grep -Eq '^[a-f0-9]{64}  web\.tar\.gz$'
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 10 --max-time 300 --output "$download_dir/web.tar.gz" \
  "$asset_url/web.tar.gz"
(cd "$download_dir" && sha256sum --check web.tar.gz.sha256)
docker image load --input "$download_dir/web.tar.gz"
image_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$candidate")
[ "$image_revision" = "$remote" ]
docker image tag "$candidate" tarkovstats-web:latest
git merge --ff-only origin/main
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
