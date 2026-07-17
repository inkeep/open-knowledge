#!/usr/bin/env bash
#
# Fail if any changeset declares a `major` bump. Open Knowledge is pre-1.0:
# breaking changes ride as `minor`, and going to 1.0.0 is a deliberate team
# decision — not something a single changeset should trigger. The release
# math (scripts/compute-next-beta.mjs) would otherwise happily emit 1.0.0
# from a stray `major` frontmatter. Mirrors check-i18n-drift.sh so
# `pnpm run check` catches it before push.
#
# Canonical policy: .changeset/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

shopt -s nullglob
violations=()
for f in .changeset/*.md; do
  [[ "$(basename "$f")" == "README.md" ]] && continue
  # Extract the YAML frontmatter (between the first two `---` fences) and look
  # for a `<pkg>: major` bump line. Mirrors the frontmatter parse in
  # scripts/compute-next-beta.mjs (`/:\s*(patch|minor|major)\s*$/`), so body
  # prose mentioning "major" can't false-positive.
  fm="$(awk 'NR==1 && $0 !~ /^---/ {exit} /^---/{c++; next} c==1{print} c>=2{exit}' "$f")"
  if grep -Eq ':[[:space:]]*major[[:space:]]*$' <<<"$fm"; then
    violations+=("$f")
  fi
done

if (( ${#violations[@]} > 0 )); then
  echo "::error::Forbidden 'major' bump in changeset(s): ${violations[*]}" >&2
  echo "Open Knowledge is pre-1.0 — declare 'minor' for breaking changes, 'patch' for fixes." >&2
  echo "See .changeset/README.md. 1.0.0 is a deliberate team decision, not a single changeset." >&2
  exit 1
fi

echo "No 'major' bumps in changesets."
