#!/usr/bin/env bash
# Bounded synthetic local-Linux experiment against the actual production image.
set -euo pipefail
image=${1:?Usage: benchmark-axis-materialization.sh IMAGE NEW_OUTPUT_DIRECTORY}
output=${2:?Usage: benchmark-axis-materialization.sh IMAGE NEW_OUTPUT_DIRECTORY}
[[ $(uname -s) == Linux ]] || { echo 'Requires Linux Docker.' >&2; exit 2; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
docker_binary=$(command -v docker)
docker() { timeout --signal=TERM --kill-after=5s 15s "$docker_binary" --context default "$@"; }
endpoint=$(docker context inspect default --format '{{(index .Endpoints "docker").Host}}')
[[ $endpoint == unix://* ]] || { echo 'Refusing a remote Docker endpoint.' >&2; exit 2; }
image_id=$(docker image inspect "$image" --format '{{.Id}}')
[[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'Local immutable image required.' >&2; exit 2; }
revision=$(docker image inspect "$image_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
[[ $revision =~ ^[0-9a-f]{40}$ ]] || { echo 'Image source revision missing.' >&2; exit 2; }
[[ ! -e $output && ! -L $output ]] || { echo 'Output already exists.' >&2; exit 2; }
mkdir -p -- "$output"
output=$(cd "$output" && pwd)
active_id=''
active_name=''
token=$(tr -d '-' < /proc/sys/kernel/random/uuid)
[[ $token =~ ^[0-9a-f]{32}$ ]] || { echo 'Unique ownership token required.' >&2; exit 1; }
cleanup() {
  if [[ -z $active_id && -n $active_name ]]; then
    local found owner candidate
    found=$(docker inspect "$active_name" --format '{{index .Config.Labels "org.tarkovstats.axis-materialization"}} {{.Id}}') || return 1
    read -r owner candidate <<< "$found"
    [[ $owner == "$token" && $candidate =~ ^[0-9a-f]{64}$ ]] || return 1
    active_id=$candidate
  fi
  if [[ -n $active_id ]]; then
    local remaining
    [[ $active_id =~ ^[0-9a-f]{64}$ ]] || return 1
    # An interrupted removal may have succeeded. Only a successful listing
    # proving this exact ID absent can establish cleanup.
    docker rm --force "$active_id" >/dev/null 2>&1 || true
    remaining=$(docker container ls --all --no-trunc --filter "id=$active_id" --format '{{.ID}}') || return 1
    [[ -z $remaining ]] || return 1
    active_id=''; active_name=''
  fi
  [[ -z $active_name ]]
}
on_exit() {
  local status=$?
  trap - EXIT
  if ! cleanup; then
    echo 'Owned container cleanup unconfirmed; inspect the local Docker daemon.' >&2
    printf '{"removed":false,"reason":"cleanup unconfirmed"}\n' > "$output/cleanup.json"
    ((status != 0)) || status=1
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for round in 1 2; do
  backends=(typescript rust)
  if ((round == 2)); then backends=(rust typescript); fi
  for backend in "${backends[@]}"; do
    stem="$output/round$round-$backend"
    active_name="axis-materialization-$round-$backend-$token"
    if created=$(docker create --pull never --name "$active_name" --label "org.tarkovstats.axis-materialization=$token" --network none --ipc private \
      --cpus 0.5 --memory 512m --memory-swap 512m --read-only --pids-limit 128 \
      --cap-drop ALL --security-opt no-new-privileges \
      --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777 \
      --mount "type=bind,src=$root/scripts/benchmark-axis-materialization.mjs,dst=/tmp/axis-driver.mjs,readonly" \
      --mount "type=bind,src=$root/scripts/benchmark-worker-resources.mjs,dst=/tmp/axis-resources.mjs,readonly" \
      --env "AXIS_PREDICTION_MATERIALIZER=$backend" --env "BENCHMARK_IMAGE_ID=$image_id" \
      --env "BENCHMARK_SOURCE_REVISION=$revision" --entrypoint node "$image_id" \
      --experimental-strip-types --experimental-sqlite /tmp/axis-driver.mjs); then
      [[ $created =~ ^[0-9a-f]{64}$ ]] || { echo 'Invalid container ID.' >&2; exit 2; }
      active_id=$created
    else
      echo 'Container creation failed or timed out; resolving ownership.' >&2
      exit 1
    fi
    echo "Axis synthetic materialization: round $round, $backend" >&2
    set +e
    timeout --signal=TERM --kill-after=10s 120s "$docker_binary" --context default start --attach "$active_id" > "$stem.json" 2> "$stem.log"
    status=$?
    set -e
    docker inspect "$active_id" --format \
      '{"sourceRevision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"id":{{json .Id}},"imageId":{{json .Image}},"user":{{json .Config.User}},"exitCode":{{.State.ExitCode}},"oomKilled":{{.State.OOMKilled}},"network":{{json .HostConfig.NetworkMode}},"ipcMode":{{json .HostConfig.IpcMode}},"readOnly":{{.HostConfig.ReadonlyRootfs}},"memory":{{.HostConfig.Memory}},"memorySwap":{{.HostConfig.MemorySwap}},"nanoCpus":{{.HostConfig.NanoCpus}},"pidsLimit":{{.HostConfig.PidsLimit}},"privileged":{{.HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"portBindings":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}}}' > "$stem.inspect.json"
    cleanup || { echo 'Container cleanup unconfirmed.' >&2; exit 1; }
    printf '{"removed":true,"runnerExit":%s}\n' "$status" > "$stem.cleanup.json"
    if ((status != 0)); then tail -n 35 "$stem.log" >&2; echo "Run failed; partial evidence retained in $output." >&2; exit "$status"; fi
  done
done
node "$root/scripts/summarize-axis-materialization.mjs" "$output"
