#!/usr/bin/env bash

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR=$(dirname "$SOURCE")
  SOURCE=$(readlink "$SOURCE")
  [[ $SOURCE != /* ]] && SOURCE=$DIR/$SOURCE
done
BIN_DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"

ROOT_DIR="$(cd -P "$BIN_DIR/../../.." >/dev/null 2>&1 && pwd)"
ELECTRON=""
for NAME in openknowledge openknowledge-beta; do
  if [ -x "$ROOT_DIR/$NAME" ]; then
    ELECTRON="$ROOT_DIR/$NAME"
    break
  fi
done
CLI="$BIN_DIR/../dist/cli.mjs"

if [ ! -f "$CLI" ] || [ ! -x "$ELECTRON" ]; then
  echo "OpenKnowledge has been removed. Reinstall the OpenKnowledge package." >&2
  OK_INIT_COMMAND="ok init"
  case "$(basename "${BASH_SOURCE[0]}")" in *-beta) OK_INIT_COMMAND="ok-beta init" ;; esac
  case "$OK_CHANNEL" in [Bb][Ee][Tt][Aa]) OK_INIT_COMMAND="ok-beta init" ;; esac
  echo '{"error":"ok-bundle-missing","hint":"OpenKnowledge app appears to have been removed. Reinstall it, or remove OK entries from your MCP config and rerun '"$OK_INIT_COMMAND"'."}' >&2
  exit 69
fi

export OK_NODE_OPTIONS="$NODE_OPTIONS"
unset NODE_OPTIONS

ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI" "$@"
exit $?
