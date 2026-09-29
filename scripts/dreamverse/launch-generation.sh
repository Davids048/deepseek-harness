#!/usr/bin/env bash
# Run the DreamVerse generation backend (`python -m dreamverse_generation`) against the FastVideo checkout named by
# FASTVIDEO_ROOT (default: /mnt/lustre/vlm-d1su/codes/fv-hub/fastvideo_ds8_dreamverse_dev).
# Arguments are forwarded, for example: launch-generation.sh --preset <id> --mock --port 18310
set -euo pipefail

fork_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fastvideo_root="${FASTVIDEO_ROOT:-/mnt/lustre/vlm-d1su/codes/fv-hub/fastvideo_ds8_dreamverse_dev}"

export PYTHONPATH="$fastvideo_root:$fastvideo_root/apps/dreamverse:$fork_root/services/dreamverse-generation"
export FASTVIDEO_FFMPEG_BIN=/mnt/lustre/vlm-d1su/opt/ffmpeg-native/bin/ffmpeg
exec /mnt/lustre/vlm-d1su/codes/fv-hub/.venv-fv/bin/python -m dreamverse_generation "$@"
