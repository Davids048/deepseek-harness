#!/usr/bin/env bash
# Run the DreamVerse generation backend: `fastvideo serve` with the streaming_v2 serve config
# scripts/dreamverse/h3-ref2va.serve.yaml, importing FastVideo from the checkout named by FASTVIDEO_ROOT
# (default: /mnt/lustre/vlm-d1su/codes/fv-hub/streaming_v2). Arguments are forwarded to `fastvideo serve`.
set -euo pipefail

fork_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fastvideo_root="${FASTVIDEO_ROOT:-/mnt/lustre/vlm-d1su/codes/fv-hub/streaming_v2}"

export PYTHONPATH="$fastvideo_root"
export FASTVIDEO_FFMPEG_BIN=/mnt/lustre/vlm-d1su/opt/ffmpeg-native/bin/ffmpeg
exec /mnt/lustre/vlm-d1su/codes/fv-hub/.venv-fv/bin/fastvideo serve --config "$fork_root/scripts/dreamverse/h3-ref2va.serve.yaml" "$@"
