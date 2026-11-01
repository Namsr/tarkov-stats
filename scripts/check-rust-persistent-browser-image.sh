#!/usr/bin/env bash
# Paired PvE observations and full persistent correctness; uses the same exact-image extraction/provenance/cleanup as Arena.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
exec bash "$root/scripts/benchmark-rust-arena-browser-image.sh" --suite persistent "$@"
