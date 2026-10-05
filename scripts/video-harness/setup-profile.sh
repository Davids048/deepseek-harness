#!/usr/bin/env bash
# Create the two video-harness dsh profiles in $DSH_HOME/profiles: `video-harness` stacks the bundle on dsh-base and
# dsh-web-app (the chat page), `video-harness-headless` on dsh-base and dsh-headless (one task per process). Each gets
# a manifest, an empty profile patch (kept when it already exists), and a node_modules link to this checkout's
# packages/bundle/video-harness.
set -euo pipefail

: "${DSH_HOME:?DSH_HOME must name the harness home directory}"
fork_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

make_profile() {
  local name="$1" surface="$2"
  local profile_dir="$DSH_HOME/profiles/$name"
  mkdir -p "$profile_dir/node_modules/@video-harness"
  echo "{\"name\":\"dsh-profile-$name\",\"private\":true,\"dsh\":{\"profile\":{\"bundles\":[\"@deepseek-ai/dsh-base\",\"$surface\",\"@video-harness/bundle\"]}}}" \
    > "$profile_dir/package.json"
  [[ -e "$profile_dir/cordis.patch.yml" ]] || echo '[]' > "$profile_dir/cordis.patch.yml"
  ln -sfn "$fork_root/packages/bundle/video-harness" "$profile_dir/node_modules/@video-harness/bundle"
}

make_profile video-harness '@deepseek-ai/dsh-web-app'
make_profile video-harness-headless '@deepseek-ai/dsh-headless'
