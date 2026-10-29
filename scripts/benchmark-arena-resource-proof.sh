#!/usr/bin/env bash
# Operator-only synthetic Arena comparison on an immutable locally loaded image.
set -euo pipefail
release_image_id='sha256:66b12d087fbcf4a2e133c8ca05032d78747d94983b5a236b41a37138a5dfc9fb'
production_image_id='sha256:d64895bb623aaa921ff775ae02b1a8dc4dca80b3d57fa8bdbba19b67f9edabc7'
release_tag='tarkovstats-web:0a705c50ae9764d72d714c00e7027ebebadadf22'
archive_sha='fd6848ec3753e626c8c9e6e5c5c569562e8f72a802a513a67be6dc069e7ce60a'
revision='0a705c50ae9764d72d714c00e7027ebebadadf22'
native_sha='f2e4ee25851e890a312fe29540778140bcac6de4059425fd3dcba54d5e62618c'
output=${1:?Usage: benchmark-arena-resource-proof.sh NEW_OUTPUT_DIRECTORY}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[[ $(uname -s) == Linux ]] || { echo 'Requires local Linux Docker.' >&2; exit 2; }
docker_binary=$(command -v docker)
docker() { timeout --signal=TERM --kill-after=5s 15s "$docker_binary" --context default "$@"; }
endpoint=$(docker context inspect default --format '{{(index .Endpoints "docker").Host}}')
[[ $endpoint == unix://* ]] || { echo 'Remote Docker endpoint refused.' >&2; exit 2; }
[[ ! -e $output && ! -L $output ]] || { echo 'Output already exists.' >&2; exit 2; }
mkdir -p -- "$output"
output=$(cd "$output" && pwd)
[[ ${PROOF_ARCHIVE_SHA256:-} == "$archive_sha" ]] || { echo 'Release archive SHA mismatch.' >&2; exit 1; }
image_id=$(docker image inspect "$release_tag" --format '{{.Id}}')
[[ $image_id == "$release_image_id" ]] || { echo 'Release image ID mismatch.' >&2; exit 1; }
[[ $(docker image inspect "$image_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') == "$revision" ]] || { echo 'Release revision mismatch.' >&2; exit 1; }
image_matches_production=false
if [[ $image_id == "$production_image_id" ]]; then image_matches_production=true; fi
printf '{"testedImageId":"%s","productionImageId":"%s","imageIdentityMatchesProduction":%s,"releaseTag":"%s","sourceRevision":"%s","archiveSha256":"%s"}\n' "$image_id" "$production_image_id" "$image_matches_production" "$release_tag" "$revision" "$archive_sha" > "$output/image-provenance.json"
active_id=''
active_name=''
token=$(tr -d '-' < /proc/sys/kernel/random/uuid)
[[ $token =~ ^[0-9a-f]{32}$ ]] || { echo 'Unique ownership token required.' >&2; exit 1; }
cleanup() {
  if [[ -z $active_id && -n $active_name ]]; then
    local found owner candidate
    found=$(docker inspect "$active_name" --format '{{index .Config.Labels "org.tarkovstats.arena-proof"}} {{.Id}}') || return 1
    read -r owner candidate <<< "$found"
    [[ $owner == "$token" && $candidate =~ ^[0-9a-f]{64}$ ]] || return 1
    active_id=$candidate
  fi
  if [[ -n $active_id ]]; then
    local remaining
    [[ $active_id =~ ^[0-9a-f]{64}$ ]] || return 1
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
active_name="arena-proof-hash-$token"
if created=$(docker create --pull never --name "$active_name" --label "org.tarkovstats.arena-proof=$token" --network none --ipc private --cpus 0.5 --memory 512m --memory-swap 512m --pids-limit 64 --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint sha256sum "$image_id" /app/rust/cohort-worker/target/release/tarkov-cohort-worker); then
  [[ $created =~ ^[0-9a-f]{64}$ ]] || { echo 'Invalid hash container ID.' >&2; exit 1; }
  active_id=$created
else
  echo 'Hash container create failed; resolving ownership.' >&2; exit 1
fi
hash_id=$active_id
hash_image_id=$(docker inspect "$hash_id" --format '{{.Image}}')
[[ $hash_image_id == "$image_id" ]] || { echo 'Hash container image mismatch.' >&2; exit 1; }
set +e
actual_native=$(timeout --signal=TERM --kill-after=5s 30s "$docker_binary" --context default start --attach "$active_id")
hash_status=$?
set -e
cleanup || { echo 'Hash container cleanup unconfirmed.' >&2; exit 1; }
[[ $hash_status == 0 && ${actual_native%% *} == "$native_sha" ]] || { echo 'Native binary mismatch or hash failure.' >&2; exit 1; }
printf '{"testedImageId":"%s","productionImageId":"%s","imageIdentityMatchesProduction":%s,"releaseTag":"%s","sourceRevision":"%s","nativeSha256":"%s","archiveSha256":"%s","hashContainerId":"%s","hashContainerImageId":"%s","hashContainerRemoved":true,"ownershipToken":"%s"}\n' "$image_id" "$production_image_id" "$image_matches_production" "$release_tag" "$revision" "$native_sha" "$archive_sha" "$hash_id" "$hash_image_id" "$token" > "$output/provenance.json"
payload="$output/payload"
mkdir -p "$payload/scripts" "$payload/tests/fixtures" "$payload/app/api/average/cohort" "$payload/app/api/seasonal/cohort"
cp "$root/scripts/benchmark-arena-resource-driver.mjs" "$payload/scripts/benchmark-rust-cohort.mjs"
cp "$root/scripts/benchmark-worker-resources.mjs" "$payload/scripts/benchmark-worker-resources.mjs"
sha256sum "$root/scripts/benchmark-arena-resource-driver.mjs" | cut -d' ' -f1 > "$output/driver-source.sha256"
sha256sum "$root/scripts/benchmark-rust-cohort.mjs" | cut -d' ' -f1 > "$output/driver-upstream.sha256"
if diff -u --label benchmark-rust-cohort.mjs --label benchmark-arena-resource-driver.mjs "$root/scripts/benchmark-rust-cohort.mjs" "$root/scripts/benchmark-arena-resource-driver.mjs" > "$output/driver.patch"; then
  echo 'Instrumented driver unexpectedly identical.' >&2; exit 1
else
  diff_status=$?; [[ $diff_status == 1 ]] || exit "$diff_status"
fi
for file in rust-cohort-data.mjs rust-arena-seasonal-data.mjs next-cache-shim.mjs next-server-entry.mjs; do cp "$root/tests/fixtures/$file" "$payload/tests/fixtures/$file"; done
cp "$root/app/api/average/cohort/route.ts" "$payload/app/api/average/cohort/route.ts"
cp "$root/app/api/seasonal/cohort/route.ts" "$payload/app/api/seasonal/cohort/route.ts"
for round in 1 2; do
  backends=(typescript rust)
  if ((round == 2)); then backends=(rust typescript); fi
  for backend in "${backends[@]}"; do
    stem="$output/arena-round$round-$backend"
    active_name="arena-proof-$round-$backend-$token"
    if created=$(docker create --pull never --name "$active_name" --label "org.tarkovstats.arena-proof=$token" --network none --ipc private \
      --cpus 0.5 --memory 512m --memory-swap 512m --read-only --pids-limit 64 \
      --cap-drop ALL --security-opt no-new-privileges \
      --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777 \
      --mount "type=bind,src=$payload/app,dst=/app/app,readonly" \
      --mount "type=bind,src=$payload/tests,dst=/app/tests,readonly" \
      --mount "type=bind,src=$payload/scripts/benchmark-rust-cohort.mjs,dst=/app/scripts/benchmark-rust-cohort.mjs,readonly" \
      --mount "type=bind,src=$payload/scripts/benchmark-worker-resources.mjs,dst=/app/scripts/benchmark-worker-resources.mjs,readonly" \
      --entrypoint node "$image_id" --experimental-strip-types --experimental-sqlite \
      scripts/benchmark-rust-cohort.mjs --mode arena --backend "$backend" --rows 100000 --iterations 20); then
      [[ $created =~ ^[0-9a-f]{64}$ ]] || { echo 'Invalid container ID.' >&2; exit 1; }
      active_id=$created
    else
      echo 'Container create failed; resolving ownership.' >&2; exit 1
    fi
    echo "Synthetic Arena: round $round, $backend" >&2
    started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    start_epoch=$(date +%s)
    set +e
    # Arena seeds two 100k mode populations, twice the physical fixture rows of PvE.
    timeout --signal=TERM --kill-after=15s 480s "$docker_binary" --context default start --attach "$active_id" > "$stem.json" 2> "$stem.log"
    status=$?
    set -e
    finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    end_epoch=$(date +%s)
    printf '{"startedAt":"%s","finishedAt":"%s","elapsedSeconds":%s}\n' "$started" "$finished" "$((end_epoch - start_epoch))" > "$stem.timing.json"
    docker inspect "$active_id" --format \
      '{"owner":{{json (index .Config.Labels "org.tarkovstats.arena-proof")}},"sourceRevision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"id":{{json .Id}},"imageId":{{json .Image}},"user":{{json .Config.User}},"exitCode":{{.State.ExitCode}},"oomKilled":{{.State.OOMKilled}},"network":{{json .HostConfig.NetworkMode}},"ipcMode":{{json .HostConfig.IpcMode}},"readOnly":{{.HostConfig.ReadonlyRootfs}},"memory":{{.HostConfig.Memory}},"memorySwap":{{.HostConfig.MemorySwap}},"nanoCpus":{{.HostConfig.NanoCpus}},"pidsLimit":{{.HostConfig.PidsLimit}},"privileged":{{.HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"portBindings":{{json .HostConfig.PortBindings}},"tmpfs":{{json .HostConfig.Tmpfs}},"mounts":{{json .Mounts}}}' > "$stem.inspect.json"
    cleanup || { echo 'Container cleanup unconfirmed.' >&2; exit 1; }
    printf '{"removed":true,"runnerExit":%s}\n' "$status" > "$stem.cleanup.json"
    if ((status != 0)); then echo "Run failed with status $status; continuing to preserve other observations." >&2; fi
  done
done
node "$root/scripts/summarize-arena-resource-proof.mjs" "$output"
