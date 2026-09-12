#!/usr/bin/env bash

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR=$(dirname "$SOURCE")
  SOURCE=$(readlink "$SOURCE")
  [[ $SOURCE != /* ]] && SOURCE=$DIR/$SOURCE
done
BIN_DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"

ROOT_DIR="$(cd -P "$BIN_DIR/../../.." >/dev/null 2>&1 && pwd)"
ELECTRON="$ROOT_DIR/openknowledge"
CLI="$BIN_DIR/../dist/cli.mjs"

if [ ! -f "$CLI" ] || [ ! -x "$ELECTRON" ]; then
  echo "OpenKnowledge has been removed. Reinstall the OpenKnowledge package." >&2
  echo '{"error":"ok-bundle-missing","hint":"OpenKnowledge app appears to have been removed. Reinstall it, or remove OK entries from your MCP config and rerun ok init."}' >&2
  exit 69
fi

export OK_NODE_OPTIONS="$NODE_OPTIONS"
unset NODE_OPTIONS

ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI" "$@"
exit $?
