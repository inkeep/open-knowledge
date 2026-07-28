#!/usr/bin/env bash

# Wrapper script shipped inside the OpenKnowledge Linux install at
# <install-root>/resources/cli/bin/ok.sh (this file is renamed by the
# electron-builder `linux.extraResources` rule). Re-uses the bundled
# Electron runtime as a Node host via ELECTRON_RUN_AS_NODE=1 — no separate
# Node install required. Linux sibling of the darwin ok.sh (which derives
# its paths from the .app bundle shape); layout here is the flat
# electron-builder Linux layout:
#
#   <root>/openknowledge            (Electron binary, linux.executableName)
#   <root>/resources/cli/bin/ok.sh  (this wrapper)
#   <root>/resources/cli/dist/cli.mjs
#
# deb installs place <root> at /opt/OpenKnowledge and symlink
# /usr/bin/ok -> this file (build/deb-postinst.sh). AppImage mounts are
# ephemeral, so PATH install from an AppImage is declined by path-install
# instead of pointing at a mount path that dies with the process.
#
# `set -e` deliberately omitted — matches ok.sh (the readlink loop handles
# failures inline and the final exit must propagate the CLI's code).

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR=$(dirname "$SOURCE")
  SOURCE=$(readlink "$SOURCE")
  [[ $SOURCE != /* ]] && SOURCE=$DIR/$SOURCE
done
BIN_DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"

# <root> = bin -> cli -> resources -> root
ROOT_DIR="$(cd -P "$BIN_DIR/../../.." >/dev/null 2>&1 && pwd)"
ELECTRON="$ROOT_DIR/openknowledge"
CLI="$BIN_DIR/../dist/cli.mjs"

if [ ! -f "$CLI" ] || [ ! -x "$ELECTRON" ]; then
  # Self-diagnose the uninstalled/moved lifecycle: MCP clients may hold this
  # wrapper path in their configs after the app is removed. Two-line stderr
  # (human-readable + machine-readable JSON) and exit 69 (EX_UNAVAILABLE),
  # mirroring ok.sh's ok-bundle-missing contract.
  echo "OpenKnowledge has been removed. Reinstall the OpenKnowledge package." >&2
  echo '{"error":"ok-bundle-missing","hint":"OpenKnowledge app appears to have been removed. Reinstall it, or remove OK entries from your MCP config and rerun ok init."}' >&2
  exit 69
fi

# Sanitize NODE_OPTIONS (VS Code pattern; mirrors ok.sh) — re-export under a
# scoped name so the CLI can opt to honor them explicitly.
export OK_NODE_OPTIONS="$NODE_OPTIONS"
unset NODE_OPTIONS

ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI" "$@"
exit $?
