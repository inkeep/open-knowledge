#!/usr/bin/env bash

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
