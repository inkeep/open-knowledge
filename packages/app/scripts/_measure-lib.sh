#!/usr/bin/env bash
#
# _measure-lib.sh — shared helpers for the measure-*.sh / perf-*.sh producer scripts
#
# Source this from any producer script after `set -euo pipefail` to pick
# up the functions below. Keeps host detection, epoch-ms resolution, JSONL
# append serialization, and numeric-flag validation in one place so a
# future schema change or portability fix touches one file, not each consumer.
#
# **This file is not directly invokable.** Source it. `bash _measure-lib.sh`
# exits 1 with a diagnostic.
#
# Convention: functions live in one place; callers set a handful of
# well-named variables (CONTEXT, SEED, etc.) before sourcing and consume
# the functions afterward. No hidden globals — every function is pure
# modulo its explicit arguments.

# Refuse to run as a standalone command — sourcing is the only supported
# invocation. Detects via BASH_SOURCE[0] (the script file) vs $0 (the
# invoking entry point); when they match, we're being run directly.
# shellcheck disable=SC2128
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "error: _measure-lib.sh is a library meant to be sourced, not executed directly." >&2
  echo "       Use measure-fuzz.sh or measure-stress.sh as the entry point." >&2
  exit 1
fi

# ── Portable epoch-ms ──────────────────────────────────────────────────────
# GNU `date +%s%3N` is preferred but macOS BSD `date` emits the literal
# string "%3N" instead of milliseconds. Detect format validity and fall
# back to seconds-times-1000 when the primary form doesn't work. Hard
# failure (both paths yield non-numeric) exits non-zero — timing
# infrastructure that silently returns 0 is worse than timing that
# loudly breaks (would record nonsensical durationMs in the JSONL).
epoch_ms() {
  local ms
  ms="$(date +%s%3N 2>/dev/null || true)"
  if [[ "$ms" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$ms"
    return 0
  fi
  # Fallback: seconds * 1000 (millisecond precision lost but still valid).
  local sec
  sec="$(date +%s 2>/dev/null || true)"
  if [[ "$sec" =~ ^[0-9]+$ ]]; then
    printf '%s000\n' "$sec"
    return 0
  fi
  echo "error: epoch_ms failed — both GNU and BSD date paths returned non-numeric output" >&2
  exit 5
}

# ── Host tag ───────────────────────────────────────────────────────────────
# Returns "ci-<runner>" on GitHub Actions, "local-macos" / "local-linux"
# on developer machines, or the lowercased kernel name as a fallback.
detect_host() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    printf '%s\n' "ci-${RUNNER_NAME:-${RUNNER_OS:-github}}"
  elif [[ "$(uname)" == "Darwin" ]]; then
    printf '%s\n' "local-macos"
  elif [[ "$(uname)" == "Linux" ]]; then
    printf '%s\n' "local-linux"
  else
    uname | tr '[:upper:]' '[:lower:]'
  fi
}

# ── Numeric-flag validation ────────────────────────────────────────────────
# Usage: assert_numeric_flag <flag-name> <value> [--signed]
# Exits 2 with a consistent error message on non-numeric input. Used to
# prevent STRESS_FUZZ_SEED=abc silently coercing to NaN→1 at the PRNG
# layer, producing deterministic-looking runs unrelated to the seed.
assert_numeric_flag() {
  local flag_name="$1"
  local value="$2"
  local signed="${3:-}"
  local pattern='^[0-9]+$'
  local label="a non-negative integer"
  if [[ "$signed" == "--signed" ]]; then
    pattern='^-?[0-9]+$'
    label="an integer"
  fi
  if [[ ! "$value" =~ $pattern ]]; then
    echo "error: $flag_name must be $label (got: $value)" >&2
    exit 2
  fi
}

# ── Atomic JSONL append ────────────────────────────────────────────────────
# Shell `>>` append is only atomic for payloads ≤ PIPE_BUF (4096 bytes on
# Linux) and is NOT atomic at any size on macOS. A fuzz record with many
# failing seeds + long --context can exceed 4 KB and would interleave with
# a concurrent measure:stress run appending to the same log, corrupting
# the JSONL trend record. Guard with flock on Linux; fall back to mkdir-
# based mutex on macOS (flock is not in the BSD toolchain).
#
# On lock failure (timeout, crash-left lockdir, filesystem error), the
# helper now EXITS NON-ZERO rather than warn-and-proceed. The JSONL is
# the spec-named evidence trail (NG6 of the CI signal quality spec) —
# silently dropping or non-atomically appending to it is worse than
# surfacing the failure to the caller who can decide whether to retry,
# investigate, or escalate.
#
# Stale-lock recovery: on the mkdir fallback path, if the lockdir exists
# and its mtime is older than 60s, treat it as a crashed-writer artifact
# (a Ctrl-C between mkdir and rmdir would leave this behind). Remove it
# and retry once before giving up. 60s is conservative — a real writer
# completes its jsonl append in well under a second.
#
# flock vs mkdir-mutex asymmetry (both paths hit the same 10-second
# timeout budget):
#   - `flock -w 10`: kernel-managed wait, no CPU cost while blocked.
#     Cheapest and preferred. Linux-only (flock is not in the BSD
#     toolchain).
#   - mkdir-mutex (macOS fallback): busy-waits with `sleep 0.1`
#     (100ms) polling, up to 100 iterations. CPU cost is negligible
#     at this polling frequency but NOT zero — the shell wakes ~10×/s
#     to re-attempt mkdir. Functional parity with flock for
#     correctness; lower efficiency under contention. Not worth
#     optimizing (concurrent measurement runs are rare and the budget
#     is bounded).
append_jsonl_atomic() {
  local log="$1"
  local record="$2"
  if command -v flock >/dev/null 2>&1; then
    local flock_exit=0
    (
      flock -x -w 10 9 || exit 7
      printf '%s\n' "$record" >> "$log"
    ) 9>> "$log" || flock_exit=$?
    if [[ "$flock_exit" -ne 0 ]]; then
      echo "error: append_jsonl_atomic failed to acquire flock on $log (exit $flock_exit)" >&2
      echo "       the record below was NOT committed to the trend log — rerun this invocation:" >&2
      echo "       $record" >&2
      exit 6
    fi
  else
    local lockdir="${log}.lock"
    # Stale-lock recovery: if the lockdir is older than 60s, it's almost
    # certainly from a crashed writer. `stat -f %m` (BSD) / `stat -c %Y`
    # (GNU) returns mtime; we use portable `find -prune` with `-mmin`.
    if [[ -d "$lockdir" ]]; then
      local stale
      stale="$(find "$lockdir" -maxdepth 0 -mmin +1 -print 2>/dev/null || true)"
      if [[ -n "$stale" ]]; then
        echo "warn: removing stale lockdir ($lockdir mtime > 60s) — likely from crashed writer" >&2
        rmdir "$lockdir" 2>/dev/null || true
      fi
    fi
    local i=0
    while ! mkdir "$lockdir" 2>/dev/null; do
      i=$((i + 1))
      if (( i >= 100 )); then
        echo "error: append_jsonl_atomic failed to acquire lockdir $lockdir after 10s" >&2
        echo "       the record below was NOT committed to the trend log — rerun this invocation:" >&2
        echo "       $record" >&2
        exit 6
      fi
      sleep 0.1
    done
    # Scope the lockdir-cleanup EXIT trap to a subshell so it cannot clobber
    # the caller's own EXIT trap. Setting `trap ... EXIT` here at function
    # scope would replace the caller's trap (e.g. measure-fuzz.sh's tmpfile
    # cleanup), and `trap - EXIT` afterward would not restore it — bash has
    # no native trap-stack. The subshell's trap fires on subshell exit
    # (success or failure), guaranteeing rmdir without touching the parent
    # script's trap state. Mirrors the flock branch above.
    (
      trap "rmdir '$lockdir' 2>/dev/null || true" EXIT
      printf '%s\n' "$record" >> "$log"
    )
  fi
}

# ── jq pre-flight ──────────────────────────────────────────────────────────
# Fail loud and early if the script's hard dependencies are missing. Keeps
# the callers symmetric — neither has to reimplement the check.
require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "error: jq is required (JSONL composition)" >&2
    echo "install: brew install jq  # or equivalent" >&2
    exit 3
  fi
}

# ── OK workspace root ──────────────────────────────────────────────────────
# Derive the workspace root structurally from this lib's own location
# (packages/app/scripts → three levels up). git's toplevel is the wrong
# oracle here: it coincides with the workspace root only in a standalone
# clone — inside the agents-private monorepo the toplevel is the monorepo
# root, one level above public/open-knowledge. Marker validation fails
# loud if the derived directory is not an OK workspace (e.g. the lib was
# copied somewhere with a different shape). The walk is physical
# (`cd -P`/`pwd -P`) so a symlinked invocation path — including macOS's
# /var → /private/var TMPDIR — resolves to one canonical root.
resolve_repo_root() {
  local lib_dir root
  lib_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  root="$(cd -P "$lib_dir/../../.." && pwd -P)"
  if [[ ! -d "$root/packages/app" || ! -f "$root/package.json" ]]; then
    echo "error: derived workspace root $root lacks packages/app + package.json markers" >&2
    exit 4
  fi
  printf '%s\n' "$root"
}
