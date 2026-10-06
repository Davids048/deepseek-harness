#!/usr/bin/env bash
# Run DeepSeek Harness from source with a video-harness profile.
#
#   scripts/video-harness/launch.sh web [dsh web args]          the chat page (default --port 8092 --no-open)
#   scripts/video-harness/launch.sh headless "<task>" [args]    one task, printed result, exit; add --session-id <id>
#                                                               to continue an earlier headless session
#
# Provider keys are sourced from DV_ENV_FILE (default /mnt/lustre/vlm-d1su/codes/fv-hub/.env) and never printed. The
# bundle patch (packages/bundle/dv/cordis.patch.yml) reads DV_BACKEND_URL, DV_STATE_ROOT, DV_PUBLIC_URL,
# DV_AGENT_PROVIDER, DV_AGENT_MODEL, DV_AGENT_REASONING, DV_AGENT_VISION, DV_DEEPSEEK_BASE_URL, and DV_DEEPSEEK_API_KEY
# from this environment. The agent model defaults to DeepSeek V4.1 on the cluster's SGLang server
# (http://10.244.6.153:30000/v1, no key); DV_AGENT_PROVIDER=groq DV_AGENT_MODEL=qwen/qwen3.8-27b is the fallback.
# DSH_HOME defaults to $HOME/.local/state/dsh-video-harness. Extra arguments are forwarded to dsh, for example
# --trusted-host <host>.
set -euo pipefail

fork_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
surface="${1:-web}"
shift || true

env_file="${DV_ENV_FILE:-/mnt/lustre/vlm-d1su/codes/fv-hub/.env}"
if [[ -r "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi

export DSH_HOME="${DSH_HOME:-$HOME/.local/state/dsh-video-harness}"
export DV_DEEPSEEK_BASE_URL="${DV_DEEPSEEK_BASE_URL:-http://10.244.6.153:30000/v1}"
# pi-ai's OpenAI-compatible route requires a bearer token even for a keyless server.
export DV_DEEPSEEK_API_KEY="${DV_DEEPSEEK_API_KEY:-none}"
"$fork_root/scripts/video-harness/setup-profile.sh"

cd "$fork_root"
case "$surface" in
  web)
    exec node --import tsx/esm apps/cli/src/bin.ts --profile video-harness --port "${DV_PORT:-8092}" --no-open "$@"
    ;;
  headless)
    exec node --import tsx/esm apps/cli/src/bin.ts --profile video-harness-headless "$@"
    ;;
  *)
    echo "usage: $0 web|headless [args]" >&2
    exit 2
    ;;
esac
