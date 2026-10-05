#!/usr/bin/env bash
# Create the `video-harness-dreamverse` dsh profile in $DSH_HOME/profiles: dsh-base plus the DreamVerse-page bundle of
# this checkout (packages/bundle/video-harness-dreamverse), linked into the profile's node_modules.
set -euo pipefail

: "${DSH_HOME:?DSH_HOME must name the harness home directory}"
fork_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
profile_dir="$DSH_HOME/profiles/video-harness-dreamverse"
mkdir -p "$profile_dir/node_modules/@video-harness"
echo '{"name":"dsh-profile-video-harness-dreamverse","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@video-harness/dreamverse-bundle"]}}}' \
  > "$profile_dir/package.json"
[[ -e "$profile_dir/cordis.patch.yml" ]] || echo '[]' > "$profile_dir/cordis.patch.yml"
ln -sfn "$fork_root/packages/bundle/video-harness-dreamverse" "$profile_dir/node_modules/@video-harness/dreamverse-bundle"
