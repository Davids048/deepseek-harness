#!/usr/bin/env bash
# Create the `dreamverse-multiverse` dsh profile in $DSH_HOME/profiles/dreamverse-multiverse: a manifest that stacks the
# multiverse bundle on dsh-base, an empty profile patch (kept when it already exists), and a node_modules link to this
# checkout's packages/bundle/dreamverse-multiverse.
set -euo pipefail

: "${DSH_HOME:?DSH_HOME must name the harness home directory}"
fork_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
profile_dir="$DSH_HOME/profiles/dreamverse-multiverse"

mkdir -p "$profile_dir/node_modules/@dreamverse"
echo '{"name":"dsh-profile-dreamverse-multiverse","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@dreamverse/multiverse-bundle"]}}}' \
  > "$profile_dir/package.json"
[[ -e "$profile_dir/cordis.patch.yml" ]] || echo '[]' > "$profile_dir/cordis.patch.yml"
ln -sfn "$fork_root/packages/bundle/dreamverse-multiverse" "$profile_dir/node_modules/@dreamverse/multiverse-bundle"
