#!/usr/bin/env bash
# Six private synthetic runs against the same built production image. No VPS.
set -euo pipefail
image=''
output=''
rows=30000
iterations=20
while (($#)); do
  [[ $# -ge 2 ]] || { echo 'Every option needs a value.' >&2; exit 2; }
  case "$1" in
    --image) [[ -z $image ]] || exit 2; image=$2 ;;
    --output) [[ -z $output ]] || exit 2; output=$2 ;;
    --rows) rows=$2 ;;
    --iterations) iterations=$2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift 2
done
[[ -n $image && -n $output ]] || { echo 'Usage: benchmark-rust-http-container.sh --image IMAGE --output NEW_DIRECTORY [--rows 30000 --iterations 20]' >&2; exit 2; }
[[ $rows =~ ^[0-9]+$ && ${#rows} -le 7 ]] && ((10#$rows >= 5000 && 10#$rows <= 1000000)) || { echo '--rows must be 5000..1000000.' >&2; exit 2; }
[[ $iterations =~ ^[0-9]+$ && ${#iterations} -le 3 ]] && ((10#$iterations >= 4 && 10#$iterations <= 100)) || { echo '--iterations must be 4..100.' >&2; exit 2; }
[[ $(uname -s) == Linux ]] || { echo 'This experiment requires local Linux Docker.' >&2; exit 2; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
docker_binary=$(command -v docker)
# An inherited DOCKER_HOST/DOCKER_CONTEXT may target production. Explicitly
# selecting and checking default ensures only a local Unix socket is used.
docker() { "$docker_binary" --context default "$@"; }
endpoint=$(docker context inspect default --format '{{(index .Endpoints "docker").Host}}')
[[ $endpoint == unix://* ]] || { echo 'Refusing a remote Docker endpoint.' >&2; exit 2; }
image_id=$(docker image inspect "$image" --format '{{.Id}}')
[[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'A local immutable image is required; images are never pulled.' >&2; exit 2; }
revision=$(docker image inspect "$image_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
[[ $revision =~ ^[0-9a-f]{40}$ ]] || { echo 'Image must carry its exact source revision label.' >&2; exit 2; }
[[ ! -e $output && ! -L $output ]] || { echo 'Output directory must not exist; prior evidence is preserved.' >&2; exit 2; }
mkdir -p -- "$output"
output=$(cd "$output" && pwd)
payload="$output/payload"
mkdir -p "$payload/scripts" "$payload/tests/fixtures"
for file in benchmark-rust-http.mjs benchmark-worker-resources.mjs; do cp "$root/scripts/$file" "$payload/scripts/$file"; done
for file in rust-cohort-data.mjs rust-arena-seasonal-data.mjs next-cache-shim.mjs next-server-entry.mjs; do cp "$root/tests/fixtures/$file" "$payload/tests/fixtures/$file"; done
# No app/, lib/, server.js, start-web or .next mount: both HTTP implementations
# and the supervisor must come from the immutable production image itself.
active_id=''
cleanup() {
  if [[ -n $active_id ]]; then docker rm --force "$active_id" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for round in 1 2; do
  backends=(typescript next-rust rust)
  if ((round == 2)); then backends=(rust next-rust typescript); fi
  for backend in "${backends[@]}"; do
    stem="$output/http-round$round-$backend"
    name="rust-http-bench-$round-$backend-$$"
    echo "Production HTTP: repetition $round, $backend (0.5 CPU, 896 MiB, no extra swap)" >&2
    # Only an ID returned by this successful create is eligible for cleanup.
    # A pre-existing name collision fails without deleting the existing object.
    active_id=$(docker create --pull never --name "$name" --network none --ipc private \
      --cpus 0.5 --memory 896m --memory-swap 896m --read-only --pids-limit 128 \
      --cap-drop ALL --security-opt no-new-privileges \
      --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777 \
      --tmpfs /app/.next/cache:rw,noexec,nosuid,nodev,size=32m,mode=0700,uid=1001,gid=1001 \
      --mount "type=bind,src=$payload/tests,dst=/app/tests,readonly" \
      --mount "type=bind,src=$payload/scripts/benchmark-rust-http.mjs,dst=/app/scripts/benchmark-rust-http.mjs,readonly" \
      --mount "type=bind,src=$payload/scripts/benchmark-worker-resources.mjs,dst=/app/scripts/benchmark-worker-resources.mjs,readonly" \
      --env BENCHMARK_RUST_HTTP_ISOLATED=1 --env "BENCHMARK_IMAGE_ID=$image_id" \
      --env "BENCHMARK_SOURCE_REVISION=$revision" --entrypoint node "$image_id" \
      --experimental-strip-types --experimental-sqlite scripts/benchmark-rust-http.mjs \
      --backend "$backend" --rows "$rows" --iterations "$iterations" --repetition "$round")
    [[ $active_id =~ ^[0-9a-f]{64}$ ]] || { active_id=''; echo 'Invalid create result; refusing unowned cleanup.' >&2; exit 2; }
    set +e
    timeout --signal=TERM --kill-after=15s 240s "$docker_binary" --context default start --attach "$active_id" > "$stem.json" 2> "$stem.log"
    status=$?
    set -e
    docker inspect "$active_id" --format \
      '{"sourceRevision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"id":{{json .Id}},"imageId":{{json .Image}},"image":{{json .Config.Image}},"user":{{json .Config.User}},"exitCode":{{.State.ExitCode}},"oomKilled":{{.State.OOMKilled}},"network":{{json .HostConfig.NetworkMode}},"ipcMode":{{json .HostConfig.IpcMode}},"readOnly":{{.HostConfig.ReadonlyRootfs}},"memory":{{.HostConfig.Memory}},"memorySwap":{{.HostConfig.MemorySwap}},"nanoCpus":{{.HostConfig.NanoCpus}},"pidsLimit":{{.HostConfig.PidsLimit}},"privileged":{{.HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"portBindings":{{json .HostConfig.PortBindings}},"tmpfs":{{json .HostConfig.Tmpfs}},"mounts":{{json .Mounts}}}' > "$stem.inspect.json"
    if ((status != 0)); then tail -n 45 "$stem.log" >&2; echo "Experiment failed (exit $status); partial evidence retained at $output." >&2; exit "$status"; fi
    docker rm "$active_id" >/dev/null
    active_id=''
  done
done
node "$root/scripts/summarize-rust-http-benchmark.mjs" "$output"
