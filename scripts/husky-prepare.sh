#!/usr/bin/env bash

set -euo pipefail

if [ ! -e .git ]; then
  exit 0
fi

if [ ! -f .husky/pre-commit ] && [ ! -f .husky/pre-push ]; then
  exit 0
fi

pnpm exec husky
chmod +x .husky/pre-commit .husky/pre-push 2>/dev/null || true
