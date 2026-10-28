#!/usr/bin/env bash
# Browser-only synthetic comparison on an isolated Linux CI host, from one image.
# Backend processes execute image artifacts on the host: no container CPU/RSS claim.
set -euo pipefail
image=''
output=''
suite='arena'
suite_set=false
while (($#)); do
  [[ $# -ge 2 ]] || { echo 'Every option needs a value.' >&2; exit 2; }
  case "$1" in
    --image) [[ -z $image ]] || exit 2; image=$2 ;;
    --output) [[ -z $output ]] || exit 2; output=$2 ;;
    --suite) [[ $suite_set == false ]] || exit 2; suite_set=true; suite=$2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift 2
done
[[ $suite == arena || $suite == persistent || $suite == seasonal ]] || { echo "Invalid browser suite: $suite" >&2; exit 2; }
[[ -n $image && -n $output ]] || { echo 'Usage: benchmark-rust-arena-browser-image.sh --image IMAGE --output NEW_DIRECTORY' >&2; exit 2; }
[[ $(uname -s) == Linux && ${GITHUB_ACTIONS:-} == true ]] || { echo 'Run only on the Linux CI runner, never the active gaming PC.' >&2; exit 2; }
[[ $(node -p 'process.versions.node.split(".")[0]') == 22 ]] || { echo 'Node22 is required.' >&2; exit 2; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
docker_binary=$(command -v docker)
docker() { "$docker_binary" --context default "$@"; }
endpoint=$(docker context inspect default --format '{{(index .Endpoints "docker").Host}}')
[[ $endpoint == unix://* ]] || { echo 'Refusing a remote Docker daemon.' >&2; exit 2; }
image_id=$(docker image inspect "$image" --format '{{.Id}}')
[[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'A local immutable image is required; images are never pulled.' >&2; exit 2; }
revision=$(docker image inspect "$image_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
[[ $revision =~ ^[0-9a-f]{40}$ && $revision == "${GITHUB_SHA:-}" ]] || { echo 'Image must match this exact CI source revision.' >&2; exit 2; }
capability="org.tarkovstats.rust-arena-ui"
if [[ $suite == persistent || $suite == seasonal ]]; then capability="org.tarkovstats.rust-persistent-ui"; fi
[[ $(docker image inspect "$image_id" --format "{{index .Config.Labels \"$capability\"}}") == v1 ]] || { echo 'Image does not support the selected native UI boundary.' >&2; exit 2; }
if [[ $suite == seasonal ]]; then
  [[ $(docker image inspect "$image_id" --format '{{index .Config.Labels "org.tarkovstats.rust-seasonal-population"}}') == v1 ]] || { echo 'Image does not support Seasonal population.' >&2; exit 2; }
fi
[[ ! -e $output && ! -L $output ]] || { echo 'Output must be new; previous evidence is preserved.' >&2; exit 2; }
mkdir -p -- "$output"
output=$(cd "$output" && pwd)
build_root="$output/image-build"
runtime="$build_root/.next/standalone"
mkdir -p -- "$runtime"
owned_container=''
cleanup() { if [[ -n $owned_container ]]; then docker rm --force "$owned_container" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
owned_container=$(docker create --pull never --network none --read-only "$image_id")
[[ $owned_container =~ ^[0-9a-f]{64}$ ]] || { owned_container=''; echo 'Invalid owned container ID.' >&2; exit 2; }
# Never start this extraction container. All application payload comes from the
# immutable image, including source-worker support and the actual public assets.
docker cp "$owned_container:/app/." "$runtime/"
docker image inspect "$image_id" --format '{"imageId":{{json .Id}},"sourceRevision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"arenaCapability":{{json (index .Config.Labels "org.tarkovstats.rust-arena-ui")}},"persistentCapability":{{json (index .Config.Labels "org.tarkovstats.rust-persistent-ui")}},"seasonalCapability":{{json (index .Config.Labels "org.tarkovstats.rust-seasonal-population")}},"execution":"image artifacts on isolated Linux CI host; no container resource measurement"}' > "$output/image-provenance.json"
docker rm "$owned_container" >/dev/null
owned_container=''
# The public fixture reads Docker COPY metadata from a matching generated build
# root. Feed it the image's own support sources, never replacement checkout lib.
cp -- "$root/Dockerfile" "$build_root/Dockerfile"
for directory in scripts lib types; do
  [[ -d $runtime/$directory ]] || { echo "Missing image runtime directory: $directory" >&2; exit 2; }
  cp -a -- "$runtime/$directory" "$build_root/$directory"
done
[[ -f $runtime/server.js && -d $runtime/.next/static && -d $runtime/public ]] || { echo 'Incomplete actual image frontend.' >&2; exit 2; }
export NEXT_STANDALONE_ENTRY="$runtime/server.js"
export RUST_BACKEND_BIN="$runtime/rust/backend/target/release/tarkov-backend"
export RUST_COHORT_BIN="$runtime/rust/cohort-worker/target/release/tarkov-cohort-worker"
export RUST_UI_ASSETS="$runtime/public/_rust/arena"
export RUST_PERSISTENT_UI_ASSETS="$runtime/public/_rust/persistent"
assets_manifest="$RUST_UI_ASSETS/manifest.json"
if [[ $suite == persistent || $suite == seasonal ]]; then assets_manifest="$RUST_PERSISTENT_UI_ASSETS/manifest.json"; fi
[[ -x $RUST_BACKEND_BIN && -x $RUST_COHORT_BIN && -f $assets_manifest ]] || { echo 'Missing image native binaries/assets.' >&2; exit 2; }
export ARENA_BENCH_IMAGE="$image"
export ARENA_BENCH_IMAGE_ID="$image_id"
export ARENA_BENCH_IMAGE_NODE
ARENA_BENCH_IMAGE_NODE=$(timeout --signal=TERM --kill-after=5s 30s "$docker_binary" --context default run --rm --pull never --network none --entrypoint node "$image_id" --version)
[[ $ARENA_BENCH_IMAGE_NODE == v22.* ]] || { echo 'Production image is not Node22.' >&2; exit 2; }
export ARENA_BROWSER_OUTPUT="$output/evidence"
export PERSISTENT_BROWSER_OUTPUT="$output/evidence"
# Reserve up to two minutes for bounded CDP awaits and the fixture's60s reap
# before any hard stop; keep this inside the workflow's10minute step budget.
driver="scripts/benchmark-rust-arena-browser.mjs"
limit=300s
if [[ $suite == persistent || $suite == seasonal ]]; then driver="scripts/check-rust-persistent-browser.mjs"; limit=420s; fi
if [[ $suite == seasonal ]]; then export RUST_SEASONAL_BROWSER=true; else unset RUST_SEASONAL_BROWSER; fi
timeout --signal=TERM --kill-after=120s "$limit" node "$root/$driver"
