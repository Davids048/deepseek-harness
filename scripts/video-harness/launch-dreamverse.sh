#!/usr/bin/env bash
# Run the DreamVerse page on the video-harness runtime.
#
#   scripts/video-harness/launch-dreamverse.sh [dsh args]
#
# Reads the same environment as scripts/video-harness/launch.sh (VH_BACKEND_URL, VH_STATE_ROOT, VH_PUBLIC_URL, the
# agent model route) plus VH_DREAMVERSE_PORT (default 8093) and VH_TRUSTED_HOSTS. Provider keys come from VH_ENV_FILE
# (default /mnt/lustre/vlm-d1su/codes/fv-hub/.env) and are never printed. Build the client bundles first
# (`pnpm run build`, or `tsdown --env.DSH_BUILD_FACE client` inside each dreamverse-ui package).
set -euo pipefail

fork_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${VH_ENV_FILE:-/mnt/lustre/vlm-d1su/codes/fv-hub/.env}"
if [[ -r "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi

export DSH_HOME="${DSH_HOME:-$HOME/.local/state/dsh-video-harness}"
export VH_DEEPSEEK_BASE_URL="${VH_DEEPSEEK_BASE_URL:-http://10.244.6.153:30000/v1}"
export VH_DEEPSEEK_API_KEY="${VH_DEEPSEEK_API_KEY:-none}"
export VH_DREAMVERSE_PORT="${VH_DREAMVERSE_PORT:-8093}"
"$fork_root/scripts/video-harness/setup-dreamverse-profile.sh"

cd "$fork_root"
exec node --import tsx/esm apps/cli/src/bin.ts --profile video-harness-dreamverse --no-open "$@"
