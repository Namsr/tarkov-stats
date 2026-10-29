#!/usr/bin/env bash
# Four Rust HTTP runs across two pinned production images, in reversed orders. Linux only.
set -euo pipefail
baseline=''
candidate=''
baseline_revision=''
candidate_revision=''
baseline_sha=''
candidate_sha=''
output=''
rows=30000
iterations=20
while (($#)); do
  [[ $# -ge 2 ]] || { echo 'Every option needs a value.' >&2; exit 2; }
  case "$1" in
    --baseline) [[ -z $baseline ]] || exit 2; baseline=$2 ;;
    --candidate) [[ -z $candidate ]] || exit 2; candidate=$2 ;;
    --baseline-revision) [[ -z $baseline_revision ]] || exit 2; baseline_revision=$2 ;;
    --candidate-revision) [[ -z $candidate_revision ]] || exit 2; candidate_revision=$2 ;;
    --baseline-sha) [[ -z $baseline_sha ]] || exit 2; baseline_sha=$2 ;;
    --candidate-sha) [[ -z $candidate_sha ]] || exit 2; candidate_sha=$2 ;;
    --output) [[ -z $output ]] || exit 2; output=$2 ;;
    --rows) rows=$2 ;;
    --iterations) iterations=$2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift 2
done
[[ -n $output ]] || { echo 'Require --baseline and --candidate immutable image IDs, --baseline-revision/--candidate-revision, --baseline-sha/--candidate-sha and --output.' >&2; exit 2; }
for id in "$baseline" "$candidate"; do [[ $id =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'Image arguments must be immutable SHA-256 IDs.' >&2; exit 2; }; done
for revision in "$baseline_revision" "$candidate_revision"; do [[ $revision =~ ^[0-9a-f]{40}$ ]] || exit 2; done
for sha in "$baseline_sha" "$candidate_sha"; do [[ $sha =~ ^[0-9a-f]{64}$ ]] || exit 2; done
[[ $baseline != "$candidate" ]] || { echo 'Baseline and candidate must be different images.' >&2; exit 2; }
[[ $rows =~ ^[0-9]+$ && ${#rows} -le 7 ]] && ((10#$rows >= 5000 && 10#$rows <= 100000)) || { echo '--rows must be 5000..100000.' >&2; exit 2; }
[[ $iterations =~ ^[0-9]+$ && ${#iterations} -le 3 ]] && ((10#$iterations >= 4 && 10#$iterations <= 40)) || { echo '--iterations must be 4..40.' >&2; exit 2; }
[[ $(uname -s) == Linux ]] || { echo 'This experiment requires local Linux Docker.' >&2; exit 2; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
docker_binary=$(command -v docker)
# An inherited DOCKER_HOST/DOCKER_CONTEXT may target production. Explicitly
# selecting and checking default ensures only a local Unix socket is used.
docker() { timeout --signal=TERM --kill-after=5s 15s "$docker_binary" --context default "$@"; }
endpoint=$(docker context inspect default --format '{{(index .Endpoints "docker").Host}}')
[[ $endpoint == unix://* ]] || { echo 'Refusing a remote Docker endpoint.' >&2; exit 2; }
for role in baseline candidate; do
  if [[ $role == baseline ]]; then image_id=$baseline; revision=$baseline_revision; else image_id=$candidate; revision=$candidate_revision; fi
  [[ $(docker image inspect "$image_id" --format '{{.Id}}') == "$image_id" ]] || { echo "Missing pinned $role image." >&2; exit 2; }
  [[ $(docker image inspect "$image_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') == "$revision" ]] || { echo "Wrong $role revision." >&2; exit 2; }
done
[[ ! -e $output && ! -L $output ]] || { echo 'Output directory must not exist; prior evidence is preserved.' >&2; exit 2; }
mkdir -p -- "$output"
output=$(cd "$output" && pwd)
payload="$output/payload"
mkdir -p "$payload/scripts" "$payload/tests/fixtures"
for file in benchmark-rust-persistent-http.mjs benchmark-rust-http.mjs benchmark-worker-resources.mjs; do cp "$root/scripts/$file" "$payload/scripts/$file"; done
for file in rust-cohort-data.mjs rust-population-data.mjs next-cache-shim.mjs next-server-entry.mjs; do cp "$root/tests/fixtures/$file" "$payload/tests/fixtures/$file"; done
# No app/, lib/, server.js, start-web or .next mount: both HTTP implementations
# and the supervisor must come from the immutable production image itself.
active_id=''
active_name=''
worker_file=''
token=$(tr -d '-' < /proc/sys/kernel/random/uuid)
[[ $token =~ ^[0-9a-f]{32}$ ]] || { echo 'Unique ownership token required.' >&2; exit 1; }
cleanup() {
  if [[ -n $worker_file ]]; then rm -f -- "$worker_file"; fi
  if [[ -z $active_id && -n $active_name ]]; then
    found=$(docker inspect "$active_name" --format '{{index .Config.Labels "org.tarkovstats.population-proof"}} {{.Id}}' 2>/dev/null || true)
    read -r owner candidate <<< "$found"
    if [[ $owner == "$token" && $candidate =~ ^[0-9a-f]{64}$ ]]; then
      active_id=$candidate
    fi
  fi
  if [[ -n $active_id ]]; then
    if docker rm --force "$active_id" >/dev/null 2>&1; then active_id=''; active_name=''; fi
  fi
  if [[ -n $active_id || -n $active_name ]]; then
    printf '%s\n' 'owned container cleanup unconfirmed' > "$output/cleanup.txt"
  else
    printf '%s\n' 'no owned container remains' > "$output/cleanup.txt"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for round in 1 2; do
  roles=(baseline candidate)
  if ((round == 2)); then roles=(candidate baseline); fi
  for role in "${roles[@]}"; do
    if [[ $role == baseline ]]; then image_id=$baseline; revision=$baseline_revision; expected_sha=$baseline_sha; else image_id=$candidate; revision=$candidate_revision; expected_sha=$candidate_sha; fi
    stem="$output/persistent-round$round-$role"
    active_name="rust-population-image-pair-$round-$role-$token"
    echo "Rust Regular/PvE HTTP: repetition $round, $role (0.5 CPU, 896 MiB, no extra swap)" >&2
    # Only an ID returned by this successful create is eligible for cleanup.
    # A pre-existing name collision fails without deleting the existing object.
    active_id=$(docker create --pull never --name "$active_name" --label "org.tarkovstats.population-proof=$token" --network none --ipc private \
      --cpus 0.5 --memory 896m --memory-swap 896m --read-only --pids-limit 128 \
      --cap-drop ALL --security-opt no-new-privileges \
      --tmpfs /tmp:rw,noexec,nosuid,nodev,size=384m,mode=1777 \
      --tmpfs /app/.next/cache:rw,noexec,nosuid,nodev,size=32m,mode=0700,uid=1001,gid=1001 \
      --mount "type=bind,src=$payload/tests,dst=/app/tests,readonly" \
      --mount "type=bind,src=$payload/scripts/benchmark-rust-persistent-http.mjs,dst=/app/scripts/benchmark-rust-persistent-http.mjs,readonly" \
      --mount "type=bind,src=$payload/scripts/benchmark-rust-http.mjs,dst=/app/scripts/benchmark-rust-http.mjs,readonly" \
      --mount "type=bind,src=$payload/scripts/benchmark-worker-resources.mjs,dst=/app/scripts/benchmark-worker-resources.mjs,readonly" \
      --env BENCHMARK_RUST_PERSISTENT_HTTP_ISOLATED=1 --env "BENCHMARK_IMAGE_ID=$image_id" \
      --env "BENCHMARK_SOURCE_REVISION=$revision" --entrypoint node "$image_id" \
      --experimental-strip-types --experimental-sqlite scripts/benchmark-rust-persistent-http.mjs \
      --backend rust --comparison-role "$role" --rows "$rows" --iterations "$iterations" --repetition "$round")
    [[ $active_id =~ ^[0-9a-f]{64}$ ]] || { active_id=''; echo 'Invalid create result; refusing unowned cleanup.' >&2; exit 2; }
    # Extract from this exact created container, check the requested binary pin,
    # and delete the local copy before running the real image-owned code.
    worker_file="$stem.worker"
    docker cp "$active_id:/app/rust/cohort-worker/target/release/tarkov-cohort-worker" "$worker_file"
    actual_sha=$(sha256sum "$worker_file" | cut -d' ' -f1)
    rm -- "$worker_file"
    worker_file=''
    printf '%s\n' "$actual_sha" > "$stem.worker.sha256"
    [[ $actual_sha == "$expected_sha" ]] || { echo "$role worker SHA mismatch." >&2; exit 2; }
    set +e
    timeout --signal=TERM --kill-after=15s 720s "$docker_binary" --context default start --attach "$active_id" > "$stem.json" 2> "$stem.log"
    status=$?
    set -e
    docker inspect "$active_id" --format \
      '{"sourceRevision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"id":{{json .Id}},"imageId":{{json .Image}},"image":{{json .Config.Image}},"user":{{json .Config.User}},"exitCode":{{.State.ExitCode}},"running":{{.State.Running}},"startedAt":{{json .State.StartedAt}},"finishedAt":{{json .State.FinishedAt}},"oomKilled":{{.State.OOMKilled}},"network":{{json .HostConfig.NetworkMode}},"ipcMode":{{json .HostConfig.IpcMode}},"readOnly":{{.HostConfig.ReadonlyRootfs}},"memory":{{.HostConfig.Memory}},"memorySwap":{{.HostConfig.MemorySwap}},"nanoCpus":{{.HostConfig.NanoCpus}},"pidsLimit":{{.HostConfig.PidsLimit}},"privileged":{{.HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"portBindings":{{json .HostConfig.PortBindings}},"tmpfs":{{json .HostConfig.Tmpfs}},"mounts":{{json .Mounts}}}' > "$stem.inspect.json"
    if ((status != 0)); then tail -n 45 "$stem.log" >&2; echo "Experiment failed (exit $status); partial evidence retained at $output." >&2; exit "$status"; fi
    docker rm "$active_id" >/dev/null
    active_id=''; active_name=''
  done
done
cleanup
[[ $(cat "$output/cleanup.txt") == 'no owned container remains' ]] || exit 2
node "$root/scripts/summarize-rust-population-image-pair.mjs" "$output" "$baseline" "$baseline_revision" "$baseline_sha" "$candidate" "$candidate_revision" "$candidate_sha"
