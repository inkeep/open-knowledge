#!/usr/bin/env bash

function app_realpath() {
  SOURCE=$1
  while [ -h "$SOURCE" ]; do
    DIR=$(dirname "$SOURCE")
    SOURCE=$(readlink "$SOURCE")
    [[ $SOURCE != /* ]] && SOURCE=$DIR/$SOURCE
  done
  SOURCE_DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"
  echo "${SOURCE_DIR%%${SOURCE_DIR#*.app}}"
}

if [ -n "$APP_BUNDLE_DIR" ]; then
  APP_PATH="$APP_BUNDLE_DIR"
else
  APP_PATH="$(app_realpath "${BASH_SOURCE[0]}")"
fi

if [ -z "$APP_PATH" ]; then
  echo "OpenKnowledge CLI cannot find its app bundle. Reinstall from the OpenKnowledge DMG." >&2
  echo "{\"error\":\"ok-wrapper-resolution-failed\",\"hint\":\"The ok.sh wrapper could not resolve its enclosing .app bundle. Reinstall OpenKnowledge from the DMG, or npm install -g @inkeep/open-knowledge for terminal access.\",\"source\":\"${BASH_SOURCE[0]}\"}" >&2
  exit 69
fi

CONTENTS="$APP_PATH/Contents"
ELECTRON="$CONTENTS/MacOS/OpenKnowledge"
CLI="$CONTENTS/Resources/cli/dist/cli.mjs"

if [ ! -f "$CLI" ] || [ ! -x "$ELECTRON" ]; then
  echo "OpenKnowledge has been removed. Reinstall from the OpenKnowledge DMG." >&2
  echo '{"error":"ok-bundle-missing","hint":"OpenKnowledge app appears to have been removed. Reinstall from the DMG, or remove OK entries from your MCP config and rerun ok init."}' >&2
  exit 69
fi

# UPSTREAM(electron@43.4.0): an ELECTRON_RUN_AS_NODE boot reads its own basename
#   via _NSGetExecutablePath() and SIGTRAPs on anything but "OpenKnowledge
#   Helper", so the executable literal below is fixed by Electron, not by us.
RUNTIME="$ELECTRON"
case "$1" in
  mcp|start)
    HELPER="$CONTENTS/Frameworks/OpenKnowledge Server.app/Contents/MacOS/OpenKnowledge Helper"
    if [ -x "$HELPER" ]; then
      RUNTIME="$HELPER"
    fi
    ;;
esac

export OK_NODE_OPTIONS="$NODE_OPTIONS"
unset NODE_OPTIONS

ELECTRON_RUN_AS_NODE=1 "$RUNTIME" "$CLI" "$@"
exit $?
