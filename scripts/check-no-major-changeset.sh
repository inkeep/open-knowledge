#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

shopt -s nullglob
violations=()
for f in .changeset/*.md; do
  [[ "$(basename "$f")" == "README.md" ]] && continue
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
