#!/usr/bin/env bash
# The Workers Builds build command of both Builds connections: installs vp with
# the official installer, then the workspace, before the deploy command runs.
# Decision: vp is the CLI; pnpm resolves underneath; turbo still runs the tasks
# (docs/adr/0021-vp-is-the-cli-pnpm-resolves-underneath-turbo-still-runs-the-tasks.md)
set -euo pipefail

cd "$(dirname "$0")/../.."

# The version equals the root vite-plus devDependency; check-vp-version.mts
# fails check:static when they differ. The build image's Node stays, and vp
# manages pnpm at the root packageManager version.
export VP_HOME="$HOME/.vite-plus"
curl -fsSL https://vite.plus |
  VP_VERSION=1.8.0 VP_NODE_MANAGER=no VP_PNPM_MANAGER=yes bash

"$VP_HOME/bin/vp" --version
"$VP_HOME/bin/vp" install --frozen-lockfile
