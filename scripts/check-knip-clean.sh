#!/usr/bin/env bash
#
# Run `pnpm run knip` and fail if it mutated the working tree.
#
# As of Phase B (#500), the `knip` script no longer passes
# `--fix-type exports --fix-type types`, so knip should not modify
# files in normal operation — it only reports findings and exits
# non-zero on findings, which fails CI directly. This wrapper is
# kept as a defensive guard against the `--fix-type` flag being
# reintroduced in the future: auto-fixes in CI sandboxes never
# reach main, but they DO produce code biome rejects (e.g. `export
# { X } from 'foo'` → bare `;`, see PR #283), which then fails
# the subsequent `pnpm run lint`.
#
# Compares `git diff` before/after, exits non-zero if knip added new
# modifications. Developer WIP changes are preserved — only NEW
# mutations from knip trigger the failure. Review with `git diff` and
# either commit the cleanup or `git checkout --` to revert.

set -euo pipefail

before_diff=$(git diff)
pnpm run knip
after_diff=$(git diff)

if [ "$before_diff" != "$after_diff" ]; then
  echo ""
  echo "❌ knip auto-removed unused exports/types from the working tree."
  echo "   Review with:    git diff"
  echo "   Commit cleanup: git add -A && git commit"
  echo "   Revert:         git checkout -- ."
  echo ""
  exit 1
fi
