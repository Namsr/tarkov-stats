#!/usr/bin/env bash
# One cold metadata request per namespace, against the exact production image.
# Linux CI only. No benchmark, production data, host ports or transport overrides.
set -euo pipefail
image=''
output=''
while (($#)); do
  [[ $# -ge 2 ]] || { echo 'Every option needs a value.' >&2; exit 2; }
  case "$1" in
    --image) [[ -z $image ]] || exit 2; image=$2 ;;
    --output) [[ -z $output ]] || exit 2; output=$2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift 2
done
[[ -n $image && -n $output ]] || { echo 'Usage: check-rust-cold-https-image.sh --image IMAGE --output NEW_DIRECTORY' >&2; exit 2; }
[[ $(uname -s) == Linux && ${GITHUB_ACTIONS:-} == true ]] || { echo 'Run only on the isolated Linux CI runner.' >&2; exit 2; }
[[ ! -e $output && ! -L $output ]] || { echo 'Output must be new.' >&2; exit 2; }
mkdir -p -- "$output"
output=$(cd "$output" && pwd)
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
docker_binary=$(command -v docker || true)
docker() { "$docker_binary" --context default "$@"; }
owned=''; image_id=''; revision=''; head_sha=${PROBE_HEAD_SHA:-}; status=1; exit_code=''; oom=''; container_image=''; removed=false
finish() {
  local previous=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n $owned ]]; then
    container_image=$(docker inspect "$owned" --format '{{.Image}}' 2>/dev/null)
    exit_code=$(docker inspect "$owned" --format '{{.State.ExitCode}}' 2>/dev/null)
    oom=$(docker inspect "$owned" --format '{{.State.OOMKilled}}' 2>/dev/null)
    if docker rm --force "$owned" >/dev/null 2>&1; then
      if ! docker inspect "$owned" >/dev/null 2>&1; then removed=true; fi
    fi
  fi
  PROBE_RESULT="$output/probe.tmp" PROBE_OUTPUT="$output/evidence.json" PROBE_WRAPPER_STATUS="$status" \
  PROBE_IMAGE_ID="$image_id" PROBE_CONTAINER_IMAGE="$container_image" PROBE_SOURCE_REVISION="$revision" \
  PROBE_HEAD_SHA="$head_sha" PROBE_CONTAINER_EXIT="$exit_code" PROBE_OOM="$oom" PROBE_REMOVED="$removed" PROBE_DRIVER="$root/scripts/verify-rust-cold-https.mjs" node --input-type=module <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const { validateProbeReport } = await import(pathToFileURL(process.env.PROBE_DRIVER).href);
let raw = null;
try { raw = JSON.parse(fs.readFileSync(process.env.PROBE_RESULT, 'utf8')); } catch {}
const text = value => typeof value === 'string' ? value : null;
const number = value => Number.isFinite(value) ? value : null;
const mode = value => value && typeof value === 'object' ? { status: number(value.status), stale: typeof value.stale === 'boolean' ? value.stale : null,
  count: number(value.count), fileBytes: number(value.fileBytes), payloadBytes: number(value.payloadBytes) } : null;
const probe = raw && typeof raw === 'object' ? { schemaVersion: number(raw.schemaVersion), outcome: text(raw.outcome), phase: text(raw.phase), failure: text(raw.failure),
  sourceRevision: text(raw.sourceRevision), reviewedHead: text(raw.reviewedHead), imageId: text(raw.imageId), backendSha256: text(raw.backendSha256),
  caBundleSha256: text(raw.caBundleSha256), caBundleBytes: number(raw.caBundleBytes), health: { before: number(raw.health?.before), after: number(raw.health?.after) }, modes: { regular: mode(raw.modes?.regular), seasonal: mode(raw.modes?.seasonal) },
  cleanup: { backendStopped: raw.cleanup?.backendStopped === true, backendExit: text(raw.cleanup?.backendExit) } } : null;
const evidence = { schemaVersion: 1, imageId: process.env.PROBE_IMAGE_ID || null, containerImageId: process.env.PROBE_CONTAINER_IMAGE || null,
  sourceRevision: process.env.PROBE_SOURCE_REVISION || null, reviewedHead: process.env.PROBE_HEAD_SHA || null,
  wrapperExit: Number(process.env.PROBE_WRAPPER_STATUS), containerExit: process.env.PROBE_CONTAINER_EXIT === '' ? null : Number(process.env.PROBE_CONTAINER_EXIT),
  oomKilled: process.env.PROBE_OOM === 'true', containerRemoved: process.env.PROBE_REMOVED === 'true', probe };
let reportValid = false;
try { validateProbeReport(probe, { imageId: process.env.PROBE_IMAGE_ID, sourceRevision: process.env.PROBE_SOURCE_REVISION, reviewedHead: process.env.PROBE_HEAD_SHA }); reportValid = true; }
catch { /* Keep the failure evidence without including rejected payloads. */ }
const passed = reportValid && evidence.wrapperExit === 0 && evidence.containerExit === 0 && !evidence.oomKilled && evidence.containerRemoved && evidence.containerImageId === evidence.imageId;
evidence.outcome = passed ? 'passed' : 'failed';
fs.writeFileSync(process.env.PROBE_OUTPUT, JSON.stringify(evidence, null, 2) + '\n');
if (!passed) process.exitCode = 1;
NODE
  local write_status=$?
  rm -f -- "$output/probe.tmp" "$output/engine.tmp"
  if ((previous != 0 || status != 0 || write_status != 0)) || [[ $removed != true || $oom != false || $exit_code != 0 || $container_image != "$image_id" ]]; then exit 1; fi
  exit 0
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[[ -n $docker_binary ]] || { echo 'Docker unavailable.' >&2; exit 2; }
endpoint=$(docker context inspect default --format '{{(index .Endpoints "docker").Host}}')
[[ $endpoint == unix://* ]] || { echo 'Refusing a remote Docker daemon.' >&2; exit 2; }
revision=${GITHUB_SHA:-}
[[ $revision =~ ^[0-9a-f]{40}$ && $head_sha =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid source identity.' >&2; exit 2; }
if [[ $head_sha != "$revision" ]]; then
  git cat-file -p "$revision" | grep -Fxq "parent $head_sha" || { echo 'Reviewed head is not a parent of the tested merge.' >&2; exit 2; }
fi
image_id=$(docker image inspect "$image" --format '{{.Id}}')
[[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'A local immutable image is required.' >&2; exit 2; }
[[ $(docker image inspect "$image_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') == "$revision" ]] || { echo 'Image revision mismatch.' >&2; exit 2; }
[[ $(docker image inspect "$image_id" --format '{{.Config.User}}') == nextjs ]] || { echo 'Expected image nonroot user.' >&2; exit 2; }
owned=$(docker create --pull never --network bridge --read-only --memory 512m --memory-swap 512m --cpus 0.5 --pids-limit 64 \
  --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /data:rw,noexec,nosuid,nodev,size=32m,uid=1001,gid=1001,mode=0700 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
  --mount "type=bind,source=$root/scripts/verify-rust-cold-https.mjs,target=/probe.mjs,readonly" \
  --env PROBE_COLD_REFERENCE=true --env "PROBE_SOURCE_REVISION=$revision" --env "PROBE_HEAD_SHA=$head_sha" --env "PROBE_IMAGE_ID=$image_id" \
  --entrypoint node "$image_id" --experimental-sqlite /probe.mjs)
[[ $owned =~ ^[0-9a-f]{64}$ ]] || { owned=''; echo 'Invalid owned container identity.' >&2; exit 2; }
set +e
timeout --signal=TERM --kill-after=5s 70s "$docker_binary" --context default start --attach "$owned" >"$output/probe.tmp" 2>"$output/engine.tmp"
status=$?
set -e
