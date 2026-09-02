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

unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE \
  GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_PREFIX

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCALES_DIR="packages/app/src/locales"

SNAPSHOT_ROOT="$(mktemp -d)"
SNAPSHOT_READY=0
CATALOGS_SETTLED=0
EXTRACT_PID=''
STAGED_RESTORE="$REPO_ROOT/$LOCALES_DIR.restore.$$"
restore_catalogs() {
  set +e
  if [ -n "$EXTRACT_PID" ]; then
    kill -- "-$EXTRACT_PID" 2>/dev/null
    wait "$EXTRACT_PID" 2>/dev/null
  fi
  if [ "$SNAPSHOT_READY" -eq 1 ] && [ "$CATALOGS_SETTLED" -eq 0 ]; then
    rm -rf "${STAGED_RESTORE:?}"
    if ! { cp -Rp "$SNAPSHOT_ROOT/locales" "${STAGED_RESTORE:?}" &&
      rm -rf "${REPO_ROOT:?}/$LOCALES_DIR" &&
      mv "${STAGED_RESTORE:?}" "${REPO_ROOT:?}/$LOCALES_DIR"; }; then
      echo "FATAL: could not restore $LOCALES_DIR. The pre-run catalogs are kept at" >&2
      echo "  $SNAPSHOT_ROOT/locales" >&2
      echo "Copy them back before running anything else." >&2
      rm -rf "${STAGED_RESTORE:?}"
      return
    fi
  fi
  rm -rf "$SNAPSHOT_ROOT"
}
trap restore_catalogs EXIT
cp -Rp "$REPO_ROOT/$LOCALES_DIR" "$SNAPSHOT_ROOT/locales"
SNAPSHOT_READY=1

cd "$REPO_ROOT"
UNTRACKED_BEFORE="$(git ls-files --others --exclude-standard -- "$LOCALES_DIR")"

cd "$REPO_ROOT/packages/app"
set -m
pnpm run --silent i18n >/dev/null &
EXTRACT_PID=$!
set +m
wait "$EXTRACT_PID"
EXTRACT_PID=''

cd "$REPO_ROOT"
UNTRACKED_AFTER="$(git ls-files --others --exclude-standard -- "$LOCALES_DIR")"
if ! git diff --quiet -- "$LOCALES_DIR" || [ "$UNTRACKED_BEFORE" != "$UNTRACKED_AFTER" ]; then
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
  if [ "$UNTRACKED_BEFORE" != "$UNTRACKED_AFTER" ]; then
    echo "  Catalog files the extractor created:" >&2
    comm -13 <(printf '%s\n' "$UNTRACKED_BEFORE" | sed '/^$/d' | sort -u) \
      <(printf '%s\n' "$UNTRACKED_AFTER" | sed '/^$/d' | sort -u) >&2
  fi
  exit 1
fi
CATALOGS_SETTLED=1
