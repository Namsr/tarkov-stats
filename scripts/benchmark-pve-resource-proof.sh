#!/usr/bin/env bash
# Operator-only synthetic PvE comparison on an immutable locally loaded image.
set -euo pipefail
image_id='sha256:d64895bb623aaa921ff775ae02b1a8dc4dca80b3d57fa8bdbba19b67f9edabc7'
revision='0a705c50ae9764d72d714c00e7027ebebadadf22'
native_sha='f2e4ee25851e890a312fe29540778140bcac6de4059425fd3dcba54d5e62618c'
output=${1:?Usage: benchmark-pve-resource-proof.sh NEW_OUTPUT_DIRECTORY}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[[ $(uname -s) == Linux ]] || { echo 'Requires local Linux Docker.' >&2; exit 2; }
docker_binary=$(command -v docker)
docker() { timeout --signal=TERM --kill-after=5s 15s "$docker_binary" --context default "$@"; }
endpoint=$(docker context inspect default --format '{{(index .Endpoints "docker").Host}}')
[[ $endpoint == unix://* ]] || { echo 'Remote Docker endpoint refused.' >&2; exit 2; }
[[ ! -e $output && ! -L $output ]] || { echo 'Output already exists.' >&2; exit 2; }
mkdir -p -- "$output"
output=$(cd "$output" && pwd)
[[ $(docker image inspect "$image_id" --format '{{.Id}}') == "$image_id" ]] || exit 1
[[ $(docker image inspect "$image_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') == "$revision" ]] || exit 1
active_id=''
active_name=''
token=$(tr -d '-' < /proc/sys/kernel/random/uuid)
[[ $token =~ ^[0-9a-f]{32}$ ]] || { echo 'Unique ownership token required.' >&2; exit 1; }
cleanup() {
  if [[ -z $active_id && -n $active_name ]]; then
    found=$(docker inspect "$active_name" --format '{{index .Config.Labels "org.tarkovstats.pve-proof"}} {{.Id}}' 2>/dev/null || true)
    read -r owner candidate <<< "$found"
    if [[ $owner == "$token" && $candidate =~ ^[0-9a-f]{64}$ ]]; then active_id=$candidate; else echo 'Create outcome or cleanup unconfirmed.' >&2; fi
  fi
  if [[ -n $active_id ]]; then
    docker rm --force "$active_id" >/dev/null 2>&1 || echo 'Owned container cleanup unconfirmed.' >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
active_name="pve-proof-hash-$token"
active_id=$(docker create --pull never --name "$active_name" --label "org.tarkovstats.pve-proof=$token" --network none --ipc private --cpus 0.5 --memory 512m --memory-swap 512m --pids-limit 64 --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint sha256sum "$image_id" /app/rust/cohort-worker/target/release/tarkov-cohort-worker)
[[ $active_id =~ ^[0-9a-f]{64}$ ]] || { active_id=''; echo 'Invalid hash container ID.' >&2; exit 1; }
hash_id=$active_id
set +e
actual_native=$(timeout --signal=TERM --kill-after=5s 30s "$docker_binary" --context default start --attach "$active_id")
hash_status=$?
set -e
docker rm --force "$active_id" >/dev/null
if docker inspect "$active_id" >/dev/null 2>&1; then echo 'Hash container cleanup failed.' >&2; exit 1; fi
active_id=''; active_name=''
[[ $hash_status == 0 && ${actual_native%% *} == "$native_sha" ]] || { echo 'Native binary mismatch or hash failure.' >&2; exit 1; }
printf '{"imageId":"%s","sourceRevision":"%s","nativeSha256":"%s","archiveSha256":"%s","hashContainerId":"%s","hashContainerRemoved":true,"ownershipToken":"%s"}\n' "$image_id" "$revision" "$native_sha" "${PROOF_ARCHIVE_SHA256:?archive SHA required}" "$hash_id" "$token" > "$output/provenance.json"
payload="$output/payload"
mkdir -p "$payload/scripts" "$payload/tests/fixtures" "$payload/app/api/average/cohort" "$payload/app/api/seasonal/cohort"
for file in benchmark-rust-cohort.mjs benchmark-worker-resources.mjs; do cp "$root/scripts/$file" "$payload/scripts/$file"; done
for file in rust-cohort-data.mjs rust-arena-seasonal-data.mjs next-cache-shim.mjs next-server-entry.mjs; do cp "$root/tests/fixtures/$file" "$payload/tests/fixtures/$file"; done
cp "$root/app/api/average/cohort/route.ts" "$payload/app/api/average/cohort/route.ts"
cp "$root/app/api/seasonal/cohort/route.ts" "$payload/app/api/seasonal/cohort/route.ts"
for round in 1 2; do
  backends=(typescript rust)
  if ((round == 2)); then backends=(rust typescript); fi
  for backend in "${backends[@]}"; do
    stem="$output/pve-round$round-$backend"
    active_name="pve-proof-$round-$backend-$token"
    active_id=$(docker create --pull never --name "$active_name" --label "org.tarkovstats.pve-proof=$token" --network none --ipc private \
      --cpus 0.5 --memory 512m --memory-swap 512m --read-only --pids-limit 64 \
      --cap-drop ALL --security-opt no-new-privileges \
      --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777 \
      --mount "type=bind,src=$payload/app,dst=/app/app,readonly" \
      --mount "type=bind,src=$payload/tests,dst=/app/tests,readonly" \
      --mount "type=bind,src=$payload/scripts/benchmark-rust-cohort.mjs,dst=/app/scripts/benchmark-rust-cohort.mjs,readonly" \
      --mount "type=bind,src=$payload/scripts/benchmark-worker-resources.mjs,dst=/app/scripts/benchmark-worker-resources.mjs,readonly" \
      --entrypoint node "$image_id" --experimental-strip-types --experimental-sqlite \
      scripts/benchmark-rust-cohort.mjs --mode pve --backend "$backend" --rows 100000 --iterations 20)
    [[ $active_id =~ ^[0-9a-f]{64}$ ]] || { active_id=''; echo 'Invalid container ID.' >&2; exit 1; }
    echo "Synthetic PvE: round $round, $backend" >&2
    started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    start_epoch=$(date +%s)
    set +e
    timeout --signal=TERM --kill-after=15s 240s "$docker_binary" --context default start --attach "$active_id" > "$stem.json" 2> "$stem.log"
    status=$?
    set -e
    finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    end_epoch=$(date +%s)
    printf '{"startedAt":"%s","finishedAt":"%s","elapsedSeconds":%s}\n' "$started" "$finished" "$((end_epoch - start_epoch))" > "$stem.timing.json"
    docker inspect "$active_id" --format \
      '{"owner":{{json (index .Config.Labels "org.tarkovstats.pve-proof")}},"sourceRevision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"id":{{json .Id}},"imageId":{{json .Image}},"user":{{json .Config.User}},"exitCode":{{.State.ExitCode}},"oomKilled":{{.State.OOMKilled}},"network":{{json .HostConfig.NetworkMode}},"ipcMode":{{json .HostConfig.IpcMode}},"readOnly":{{.HostConfig.ReadonlyRootfs}},"memory":{{.HostConfig.Memory}},"memorySwap":{{.HostConfig.MemorySwap}},"nanoCpus":{{.HostConfig.NanoCpus}},"pidsLimit":{{.HostConfig.PidsLimit}},"privileged":{{.HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"portBindings":{{json .HostConfig.PortBindings}},"tmpfs":{{json .HostConfig.Tmpfs}},"mounts":{{json .Mounts}}}' > "$stem.inspect.json"
    docker rm --force "$active_id" >/dev/null
    if docker inspect "$active_id" >/dev/null 2>&1; then echo 'Owned container cleanup failed.' >&2; exit 1; fi
    active_id=''; active_name=''
    printf '{"removed":true,"runnerExit":%s}\n' "$status" > "$stem.cleanup.json"
    if ((status != 0)); then echo "Run failed with status $status; continuing to preserve other observations." >&2; fi
  done
done
node "$root/scripts/summarize-pve-resource-proof.mjs" "$output"
