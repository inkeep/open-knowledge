#!/usr/bin/env bash
#
# Run the audit-framework schema-snapshot generator in --check mode and fail
# if the committed `packages/core/schema-snapshot.json` does not match what
# the generator would produce against the currently-installed schema +
# active mdast plugin chain. Mirrors the `check-knip-clean.sh` and
# `check-notices-clean.sh` patterns so `pnpm run check` catches drift
# before push.
#
# This snapshot is the canonical contract: drift here means downstream
# tooling reads stale schema data. The gate is what keeps the committed
# snapshot current.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"
# `pnpm exec` so tsx resolves from the workspace node_modules/.bin: a bare `tsx`
# is not on PATH in a plain CI shell under pnpm (unlike bun's global shim).
pnpm exec tsx packages/core/scripts/dump-schema.ts --check
