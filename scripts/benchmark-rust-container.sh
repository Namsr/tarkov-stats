#!/usr/bin/env bash
# Synthetic Linux-only benchmark. No production volumes, credentials or ports.
set -euo pipefail
image=${1:?Usage: benchmark-rust-container.sh IMAGE NEW_OUTPUT_DIRECTORY}
output=${2:?Usage: benchmark-rust-container.sh IMAGE NEW_OUTPUT_DIRECTORY}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[[ $(uname -s) == Linux ]] || { echo 'This benchmark requires Linux Docker.' >&2; exit 2; }
# Force and inspect a local context: an inherited remote DOCKER_HOST/context must
# never send this workload to the VPS being maintained in another chat.
docker_binary=$(command -v docker)
docker() { "$docker_binary" --context default "$@"; }
endpoint=$(docker context inspect default --format '{{(index .Endpoints "docker").Host}}')
[[ $endpoint == unix://* ]] || { echo 'Refusing a remote Docker endpoint.' >&2; exit 2; }
[[ ! -e $output ]] || { echo 'Output directory must not exist; previous reports are preserved.' >&2; exit 2; }
mkdir -p -- "$output"
output=$(cd "$output" && pwd)
payload="$output/payload"
mkdir -p "$payload/scripts" "$payload/tests/fixtures" "$payload/app/api/average/cohort"
for file in benchmark-rust-cohort.mjs benchmark-worker-resources.mjs; do cp "$root/scripts/$file" "$payload/scripts/$file"; done
for file in rust-cohort-data.mjs next-cache-shim.mjs; do cp "$root/tests/fixtures/$file" "$payload/tests/fixtures/$file"; done
cp "$root/app/api/average/cohort/route.ts" "$payload/app/api/average/cohort/route.ts"
rows=${BENCHMARK_ROWS:-30000}
iterations=${BENCHMARK_ITERATIONS:-20}
rounds=${BENCHMARK_ROUNDS:-2}
[[ $rounds =~ ^[1-3]$ ]] || { echo 'BENCHMARK_ROUNDS must be 1..3.' >&2; exit 2; }
active_container=''
cleanup() {
  if [[ -n $active_container ]]; then docker rm --force "$active_container" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
for mode in regular pve; do
  for ((round=1; round<=rounds; round++)); do
    # Reverse order between repetitions; each backend still gets a fresh process,
    # fixture, cgroup and high-water memory counter, with no shared live cache.
    backends=(typescript rust)
    if ((round % 2 == 0)); then backends=(rust typescript); fi
    for backend in "${backends[@]}"; do
      stem="$output/$mode-round$round-$backend"
      active_container="rust-cohort-bench-$mode-$round-$backend-$$"
      echo "Benchmark $mode round $round $backend (0.5 CPU, 384 MiB, no swap)"
      set +e
      timeout --signal=TERM --kill-after=15s 240s "$docker_binary" --context default run --pull never \
        --name "$active_container" --network none --cpus 0.5 \
        --memory 384m --memory-swap 384m --read-only --pids-limit 128 \
        --cap-drop ALL --security-opt no-new-privileges \
        --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777 \
        --mount "type=bind,src=$payload/app,dst=/app/app,readonly" \
        --mount "type=bind,src=$payload/tests,dst=/app/tests,readonly" \
        --mount "type=bind,src=$payload/scripts/benchmark-rust-cohort.mjs,dst=/app/scripts/benchmark-rust-cohort.mjs,readonly" \
        --mount "type=bind,src=$payload/scripts/benchmark-worker-resources.mjs,dst=/app/scripts/benchmark-worker-resources.mjs,readonly" \
        --entrypoint node "$image" --experimental-strip-types --experimental-sqlite \
        scripts/benchmark-rust-cohort.mjs --mode "$mode" --backend "$backend" \
        --rows "$rows" --iterations "$iterations" > "$stem.json" 2> "$stem.log"
      status=$?
      set -e
      docker inspect "$active_container" --format \
        '{"image":{{json .Config.Image}},"user":{{json .Config.User}},"exitCode":{{.State.ExitCode}},"oomKilled":{{.State.OOMKilled}},"network":{{json .HostConfig.NetworkMode}},"readOnly":{{.HostConfig.ReadonlyRootfs}},"memory":{{.HostConfig.Memory}},"memorySwap":{{.HostConfig.MemorySwap}},"nanoCpus":{{.HostConfig.NanoCpus}},"mounts":{{json .Mounts}}}' > "$stem.inspect.json"
      if ((status != 0)); then tail -n 35 "$stem.log" >&2; exit "$status"; fi
      docker rm "$active_container" >/dev/null
      active_container=''
    done
  done
done
node "$root/scripts/summarize-rust-container-benchmark.mjs" "$output" "$rounds"
