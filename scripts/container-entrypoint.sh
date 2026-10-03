#!/bin/sh
set -eu

PROJECT_DIR="${OK_PROJECT_DIR:-/data}"
cd "$PROJECT_DIR"

# volume owner can differ from the node user, git would refuse the repo
safe_dir_idx="${GIT_CONFIG_COUNT:-0}"
export GIT_CONFIG_COUNT=$((safe_dir_idx + 1))
export "GIT_CONFIG_KEY_${safe_dir_idx}=safe.directory"
export "GIT_CONFIG_VALUE_${safe_dir_idx}=${PROJECT_DIR}"

if [ ! -f "$PROJECT_DIR/.ok/config.yml" ]; then
  echo "[entrypoint] no .ok/config.yml in $PROJECT_DIR yet, running ok init" >&2
  ok init --no-mcp --no-skills --json < /dev/null >&2
fi

exec ok "$@"
