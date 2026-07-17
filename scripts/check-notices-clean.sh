#!/usr/bin/env bash
#
# Run the THIRD_PARTY_NOTICES.md generator in --check mode and fail if the
# committed file does not match what the generator would produce against the
# currently-installed `node_modules/`. Mirrors the `check-knip-clean.sh`
# pattern so `bun run check` catches drift before push.
#
# Resolve the repo root from this script's location so callers from any cwd
# (e.g. `packages/cli` invoking via `prepublishOnly`) hit the same generator.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"
node scripts/generate-third-party-notices.mjs --check
