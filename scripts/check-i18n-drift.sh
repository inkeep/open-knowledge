#!/usr/bin/env bash
set -euo pipefail

unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE \
  GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_PREFIX

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$REPO_ROOT/packages/app"
LOCALES_DIR="packages/app/src/locales"

WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/check-i18n-drift.XXXXXX")"
CATALOGS="$WORK_ROOT/locales"
EXTRACTING=0
finish() {
  set +e
  if [ "$EXTRACTING" -eq 1 ]; then
    kill -TERM %1 2>/dev/null
    wait %1 2>/dev/null
  fi
  rm -rf "$WORK_ROOT"
}
trap finish EXIT
cp -Rp "$REPO_ROOT/$LOCALES_DIR" "$CATALOGS"
SEEDED="$(cd "$CATALOGS" && find . -type f | LC_ALL=C sort)"

node -e '
const { writeFileSync } = require("node:fs");
const [config, app, catalogs, out] = process.argv.slice(1);
const from = "<rootDir>/src/locales/";
writeFileSync(out, [
  `import config from ${JSON.stringify(config)};`,
  `const from = ${JSON.stringify(from)};`,
  "export default {",
  "  ...config,",
  `  rootDir: ${JSON.stringify(app)},`,
  "  catalogs: config.catalogs.map((catalog) => {",
  "    if (!catalog.path.startsWith(from)) throw new Error(`check-i18n-drift.sh can only redirect catalogs under ${from}, not ${catalog.path}`);",
  `    return { ...catalog, path: ${JSON.stringify(`${catalogs}/`)} + catalog.path.slice(from.length) };`,
  "  }),",
  "};",
  "",
].join("\n"));
' "$APP_DIR/lingui.config.ts" "$APP_DIR" "$CATALOGS" "$WORK_ROOT/lingui.config.mjs"

cd "$REPO_ROOT"
git ls-files -z -- "$LOCALES_DIR" >"$WORK_ROOT/tracked"
catalog_ids() {
  while IFS= read -r -d '' tracked; do
    case "$tracked" in
      */messages.po) ;;
      *) continue ;;
    esac
    copy="$CATALOGS/${tracked#"$LOCALES_DIR"/}"
    if [ -f "$copy" ]; then
      git hash-object --path="$tracked" "$copy"
    else
      echo missing
    fi
  done <"$WORK_ROOT/tracked"
}
catalog_ids >"$WORK_ROOT/before"
if [ ! -s "$WORK_ROOT/before" ]; then
  echo "ERROR: git lists no tracked catalog under $LOCALES_DIR, so the i18n drift check has nothing to compare." >&2
  exit 1
fi

cd "$APP_DIR"
in_copy() {
  LINGUI_CONFIG="$WORK_ROOT/lingui.config.mjs" node "$SCRIPT_DIR/run-in-own-process-group.mjs" "$@" >/dev/null &
  EXTRACTING=1
  local status=0
  wait %1 || status=$?
  EXTRACTING=0
  return "$status"
}
in_copy pnpm run --silent i18n:extract || exit $?

cd "$REPO_ROOT"
catalog_ids >"$WORK_ROOT/after"
DIFFERING=""
exec 3<"$WORK_ROOT/before" 4<"$WORK_ROOT/after"
while IFS= read -r -d '' tracked; do
  case "$tracked" in
    */messages.po) ;;
    *) continue ;;
  esac
  IFS= read -r before_id <&3
  IFS= read -r after_id <&4
  if [ "$before_id" != missing ] && [ "$before_id" != "$after_id" ]; then
    DIFFERING="$DIFFERING$tracked"$'\n'
  fi
done <"$WORK_ROOT/tracked"
exec 3<&- 4<&-
CREATED="$(comm -13 <(printf '%s\n' "$SEEDED") <(cd "$CATALOGS" && find . -type f | LC_ALL=C sort) | sed "s|^\./|$LOCALES_DIR/|")"
if [ -n "$DIFFERING" ] || [ -n "$CREATED" ]; then
  echo "ERROR: i18n catalog drift detected." >&2
  echo "" >&2
  echo "  The Lingui catalogs in the working tree are not what the extractor writes" >&2
  echo "  for the <Trans> and t\`...\` macros under packages/app/src: running it on a" >&2
  echo "  copy of $LOCALES_DIR changed them." >&2
  echo "" >&2
  echo "  Fix:" >&2
  echo "    cd public/open-knowledge/packages/app && pnpm run i18n" >&2
  echo "  then commit the updated .po catalogs." >&2
  if [ -n "$DIFFERING" ]; then
    echo "" >&2
    echo "  Catalog files the extractor changed:" >&2
    printf '%s' "$DIFFERING" | sed 's/^/    /' >&2
  fi
  if [ -n "$CREATED" ]; then
    echo "" >&2
    echo "  Catalog files the extractor created:" >&2
    printf '%s\n' "$CREATED" | sed 's/^/    /' >&2
  fi
  exit 1
fi
