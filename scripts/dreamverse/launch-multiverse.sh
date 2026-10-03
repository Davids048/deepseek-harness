#!/usr/bin/env bash
# Run DeepSeek Harness from source with the `dreamverse-multiverse` profile. DSH_HOME defaults to
# $HOME/.local/state/dsh-multiverse. The bundle patch (packages/bundle/dreamverse-multiverse/cordis.patch.yml) reads
# DREAMVERSE_GENERATION_URL, MULTIVERSE_BROWSER_PORT, and the other variables it names from this environment; extra
# arguments are forwarded to dsh (for example `--patch <overlay.yml>`).
set -euo pipefail

fork_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

export DSH_HOME="${DSH_HOME:-$HOME/.local/state/dsh-multiverse}"
"$fork_root/scripts/dreamverse/setup-multiverse-profile.sh"

cd "$fork_root"
exec node --import tsx/esm apps/cli/src/bin.ts --profile dreamverse-multiverse "$@"
