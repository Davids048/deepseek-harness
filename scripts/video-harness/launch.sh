#!/usr/bin/env bash
# Run DeepSeek Harness from source with a video-harness profile.
#
#   scripts/video-harness/launch.sh web [dsh web args]          the chat page (default --port 8092 --no-open)
#   scripts/video-harness/launch.sh headless "<task>" [args]    one task, printed result, exit; add --session-id <id>
#                                                               to continue an earlier headless session
#
# Provider keys are sourced from VH_ENV_FILE (default /mnt/lustre/vlm-d1su/codes/fv-hub/.env) and never printed. The
# bundle patch (packages/bundle/video-harness/cordis.patch.yml) reads VH_BACKEND_URL, VH_STATE_ROOT, VH_PUBLIC_URL,
# VH_AGENT_PROVIDER, VH_AGENT_MODEL, VH_AGENT_REASONING, VH_AGENT_VISION, VH_DEEPSEEK_BASE_URL, and VH_DEEPSEEK_API_KEY
# from this environment. The agent model defaults to DeepSeek V4.1 on the cluster's SGLang server
# (http://10.244.6.153:30000/v1, no key); VH_AGENT_PROVIDER=groq VH_AGENT_MODEL=qwen/qwen3.8-27b is the fallback.
# DSH_HOME defaults to $HOME/.local/state/dsh-video-harness. Extra arguments are forwarded to dsh, for example
# --trusted-host <host>.
set -euo pipefail

fork_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
surface="${1:-web}"
shift || true

env_file="${VH_ENV_FILE:-/mnt/lustre/vlm-d1su/codes/fv-hub/.env}"
if [[ -r "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi

export DSH_HOME="${DSH_HOME:-$HOME/.local/state/dsh-video-harness}"
export VH_DEEPSEEK_BASE_URL="${VH_DEEPSEEK_BASE_URL:-http://10.244.6.153:30000/v1}"
# pi-ai's OpenAI-compatible route requires a bearer token even for a keyless server.
export VH_DEEPSEEK_API_KEY="${VH_DEEPSEEK_API_KEY:-none}"
"$fork_root/scripts/video-harness/setup-profile.sh"

cd "$fork_root"
case "$surface" in
  web)
    exec node --import tsx/esm apps/cli/src/bin.ts --profile video-harness --port "${VH_PORT:-8092}" --no-open "$@"
    ;;
  headless)
    exec node --import tsx/esm apps/cli/src/bin.ts --profile video-harness-headless "$@"
    ;;
  *)
    echo "usage: $0 web|headless [args]" >&2
    exit 2
    ;;
esac
