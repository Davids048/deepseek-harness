#!/usr/bin/env bash
# Run DeepSeek Harness from source with the `dreamverse` profile. The FastVideo checkout is FASTVIDEO_ROOT
# (default: /mnt/lustre/vlm-d1su/codes/fv-hub/fastvideo_ds8_dreamverse_dev), exported so that the bundle resolves the frontend root
# for the curated preset catalogs. DSH_HOME defaults to <FastVideo checkout>/run/port-dreamverse-v1/dsh-home, and
# DREAMVERSE_PROMPTS_LOCAL_DIR defaults to the reference developer template overlay. The bundle patch (packages/bundle/dreamverse/cordis.patch.yml) reads
# DREAMVERSE_GENERATION_URL, DREAMVERSE_BROWSER_PORT, and the other variables it names from this environment.
set -euo pipefail

fork_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export FASTVIDEO_ROOT="${FASTVIDEO_ROOT:-/mnt/lustre/vlm-d1su/codes/fv-hub/fastvideo_ds8_dreamverse_dev}"

export DSH_HOME="${DSH_HOME:-$FASTVIDEO_ROOT/run/port-dreamverse-v1/dsh-home}"
export DREAMVERSE_PROMPTS_LOCAL_DIR="${DREAMVERSE_PROMPTS_LOCAL_DIR:-$FASTVIDEO_ROOT/apps/dreamverse/dreamverse/prompts.local}"
"$fork_root/scripts/dreamverse/setup-profile.sh"

cd "$fork_root"
exec node --import tsx/esm apps/cli/src/bin.ts --profile dreamverse
