#!/bin/sh
# Run under the existing deployment flock. Install separately after review.
set -eu
APP=/opt/tarkovstats-auto
cd "$APP"
compose() { docker compose -p tarkovstats -f "$APP/docker-compose.vps.yml" "$@"; }
container() { compose ps -q web; }
healthy() {
  [ -n "$(container)" ] && compose exec -T web node -e \
    'fetch("http://127.0.0.1:3000", {signal: AbortSignal.timeout(5000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
}

# Never discard operator edits. Untracked secrets and local compose are retained.
git diff --quiet
git diff --cached --quiet
git fetch --prune origin
previous=$(git rev-parse HEAD)
remote=$(git rev-parse origin/main)
cid=$(container)
deployed=
previous_image=
if [ -n "$cid" ]; then
  deployed=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$cid")
  previous_image=$(docker inspect --format '{{.Image}}' "$cid")
fi
# Checkout HEAD can advance even when a build is killed. Only the running
# container's immutable build label proves which revision was deployed.
if [ "$deployed" = "$remote" ] && healthy; then exit 0; fi
state=/var/lib/tarkovstats-deploy
mkdir -p "$state"
chmod 700 "$state"
if [ -f "$state/retry" ]; then
  read -r failed_revision retry_after < "$state/retry" || true
  case "${retry_after:-}" in
    ''|*[!0-9]*) ;;
    *) if [ "${failed_revision:-}" = "$remote" ] && [ "$(date +%s)" -lt "$retry_after" ]; then exit 0; fi;;
  esac
fi
success=0
starting=0
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
  fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
git merge --ff-only origin/main
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
