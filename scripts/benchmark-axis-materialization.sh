#!/usr/bin/env bash
# Bounded synthetic local-Linux experiment against the actual production image.
set -euo pipefail
image=${1:?Usage: benchmark-axis-materialization.sh IMAGE NEW_OUTPUT_DIRECTORY}
output=${2:?Usage: benchmark-axis-materialization.sh IMAGE NEW_OUTPUT_DIRECTORY}
[[ $(uname -s) == Linux ]] || { echo 'Requires Linux Docker.' >&2; exit 2; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
docker_binary=$(command -v docker)
docker() { "$docker_binary" --context default "$@"; }
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
cleanup() { if [[ -n $active_id ]]; then docker rm --force "$active_id" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for round in 1 2; do
  backends=(typescript rust)
  if ((round == 2)); then backends=(rust typescript); fi
  for backend in "${backends[@]}"; do
    stem="$output/round$round-$backend"
    name="axis-materialization-$round-$backend-$$"
    active_id=$(docker create --pull never --name "$name" --network none --ipc private \
      --cpus 0.5 --memory 512m --memory-swap 512m --read-only --pids-limit 128 \
      --cap-drop ALL --security-opt no-new-privileges \
      --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777 \
      --mount "type=bind,src=$root/scripts/benchmark-axis-materialization.mjs,dst=/tmp/axis-driver.mjs,readonly" \
      --mount "type=bind,src=$root/scripts/benchmark-worker-resources.mjs,dst=/tmp/axis-resources.mjs,readonly" \
      --env "AXIS_PREDICTION_MATERIALIZER=$backend" --env "BENCHMARK_IMAGE_ID=$image_id" \
      --env "BENCHMARK_SOURCE_REVISION=$revision" --entrypoint node "$image_id" \
      --experimental-strip-types --experimental-sqlite /tmp/axis-driver.mjs)
    [[ $active_id =~ ^[0-9a-f]{64}$ ]] || { active_id=''; echo 'Invalid container ID.' >&2; exit 2; }
    echo "Axis synthetic materialization: round $round, $backend" >&2
    set +e
    timeout --signal=TERM --kill-after=10s 120s "$docker_binary" --context default start --attach "$active_id" > "$stem.json" 2> "$stem.log"
    status=$?
    set -e
    docker inspect "$active_id" --format \
      '{"sourceRevision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"id":{{json .Id}},"imageId":{{json .Image}},"user":{{json .Config.User}},"exitCode":{{.State.ExitCode}},"oomKilled":{{.State.OOMKilled}},"network":{{json .HostConfig.NetworkMode}},"ipcMode":{{json .HostConfig.IpcMode}},"readOnly":{{.HostConfig.ReadonlyRootfs}},"memory":{{.HostConfig.Memory}},"memorySwap":{{.HostConfig.MemorySwap}},"nanoCpus":{{.HostConfig.NanoCpus}},"pidsLimit":{{.HostConfig.PidsLimit}},"privileged":{{.HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"portBindings":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}}}' > "$stem.inspect.json"
    docker rm --force "$active_id" >/dev/null
    if docker inspect "$active_id" >/dev/null 2>&1; then echo 'Container cleanup failed.' >&2; exit 1; fi
    active_id=''
    printf '{"removed":true,"runnerExit":%s}\n' "$status" > "$stem.cleanup.json"
    if ((status != 0)); then tail -n 35 "$stem.log" >&2; echo "Run failed; partial evidence retained in $output." >&2; exit "$status"; fi
  done
done
node "$root/scripts/summarize-axis-materialization.mjs" "$output"
