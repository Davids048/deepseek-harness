#!/usr/bin/env bash
# Run DeepSeek Harness from source with the `dreamverse` profile. DSH_HOME defaults to
# <FastVideo checkout>/run/port-dreamverse-v1/dsh-home, where the FastVideo checkout is FASTVIDEO_ROOT
# (default: /mnt/lustre/vlm-d1su/codes/fv-hub/fastvideo_ds8_dreamverse_dev). The bundle patch (packages/bundle/dreamverse/cordis.patch.yml) reads
# DREAMVERSE_GENERATION_URL, DREAMVERSE_BROWSER_PORT, and the other variables it names from this environment.
set -euo pipefail

fork_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fastvideo_root="${FASTVIDEO_ROOT:-/mnt/lustre/vlm-d1su/codes/fv-hub/fastvideo_ds8_dreamverse_dev}"

export DSH_HOME="${DSH_HOME:-$fastvideo_root/run/port-dreamverse-v1/dsh-home}"
"$fork_root/scripts/dreamverse/setup-profile.sh"

cd "$fork_root"
exec node --import tsx/esm apps/cli/src/bin.ts --profile dreamverse
