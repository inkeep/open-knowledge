#!/usr/bin/env bash
#
# Conditional husky setup for Open Knowledge.
#
# Why this exists:
#   When OK is checked out as its own clone (inkeep/open-knowledge), `.git`
#   is at the OK root and husky correctly writes core.hooksPath to that
#   .git/config. Hooks fire from `<OK>/.husky/`. That's the design.
#
#   When OK lives inside the agents-private monorepo, OK has no own `.git`
#   — the actual `.git` is at the parent root. Husky walks up and finds the
#   parent's `.git`, then writes a core.hooksPath that points back at
#   `<parent>/public/open-knowledge/.husky/` — clobbering whatever the
#   parent had configured. After that, every `git push` from anywhere in
#   agents-private fires OK's standalone-clone hook
#   (`pnpm run format && pnpm run lint && pnpm run check`) instead of the
#   parent's intended `pnpm check:monorepo-traps && pnpm check:pre-push`.
#   Developers then either install node_modules in every subtree or skip
#   hooks with `--no-verify` (forbidden by the repo's Git Safety Protocol).
#
#   This guard skips husky entirely in the monorepo case so the parent's
#   own `.husky/` stays in charge of git hooks.
#
#   When OK is cloned from the public mirror (inkeep/open-knowledge),
#   `.git` is at the OK root (standalone-clone shape) but the Copybara
#   manifest does NOT include `.husky/pre-commit` or `.husky/pre-push` in
#   the mirror output. A fresh public clone therefore has no hook files
#   for husky to register. Running `pnpm exec husky` would only create empty
#   `_/` scaffolding and the chmod would silently no-op, leaving cruft.
#   The second guard skips husky entirely in that case.
#
# Discriminators:
#   1. Monorepo vs standalone: in a standalone clone `<OK>/.git` exists
#      (a directory for regular clones; a file pointing at the real gitdir
#      for `git worktree add` of the standalone clone). In the monorepo
#      `<OK>/.git` doesn't exist at all. `[ -e .git ]` is true in both
#      standalone shapes and false in the monorepo case.
#   2. Public mirror vs internal standalone (when standalone): if neither
#      `.husky/pre-commit` nor `.husky/pre-push` exists on disk, husky has
#      nothing to register, so skip.
#
# Tested by: scripts/check-husky-prepare-guard.sh

set -euo pipefail

if [ ! -e .git ]; then
  # OK is checked out as a subdirectory of an enclosing repo (the
  # agents-private monorepo). Don't touch the parent's git config.
  exit 0
fi

if [ ! -f .husky/pre-commit ] && [ ! -f .husky/pre-push ]; then
  # Fresh public-mirror clone — no hook files in the mirror output, so
  # husky has nothing to register. Skip to avoid empty scaffolding.
  exit 0
fi

pnpm exec husky
chmod +x .husky/pre-commit .husky/pre-push 2>/dev/null || true
