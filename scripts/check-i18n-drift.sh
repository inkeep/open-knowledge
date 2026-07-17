#!/usr/bin/env bash
#
# Run `lingui extract` (the canonical extractor wired via `pnpm run i18n` in
# packages/app) and fail if the committed catalogs at
# packages/app/src/locales/{en,pseudo}/messages.{po,json} do not match what the
# extractor would produce against the current `<Trans>` / t`...` macros under
# packages/app/src. Mirrors check-schema-snapshot-clean.sh so `pnpm check`
# catches drift before push.
#
# Canonical source: packages/app/src/**/*.{ts,tsx} (per packages/app/lingui.config.ts).
# Regenerate after adding strings:
#   cd packages/app && pnpm run i18n
#
# Lingui's CLI has no `--check` mode, so we run the real extract+compile+format
# path and compare against the working tree via `git diff --quiet`. The catalog
# files are content-stable for unchanged source, so a clean tree before this
# script stays clean after a no-drift run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCALES_DIR="packages/app/src/locales"

cd "$REPO_ROOT/packages/app"
pnpm run --silent i18n >/dev/null

cd "$REPO_ROOT"
if ! git diff --quiet -- "$LOCALES_DIR"; then
  echo "ERROR: i18n catalog drift detected." >&2
  echo "" >&2
  echo "  <Trans> or t\`...\` macros under packages/app/src have changed without" >&2
  echo "  regenerating the Lingui catalogs. Re-running the extractor produced a" >&2
  echo "  diff under $LOCALES_DIR." >&2
  echo "" >&2
  echo "  Fix:" >&2
  echo "    cd public/open-knowledge/packages/app && pnpm run i18n" >&2
  echo "  then commit the updated catalog files." >&2
  echo "" >&2
  echo "  Drift summary:" >&2
  git --no-pager diff --stat -- "$LOCALES_DIR" >&2
  exit 1
fi
