#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "error: _measure-lib.sh is a library meant to be sourced, not executed directly." >&2
  echo "       Use measure-fuzz.sh or measure-stress.sh as the entry point." >&2
  exit 1
fi

epoch_ms() {
  local ms
  ms="$(date +%s%3N 2>/dev/null || true)"
  if [[ "$ms" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$ms"
    return 0
  fi
  local sec
  sec="$(date +%s 2>/dev/null || true)"
  if [[ "$sec" =~ ^[0-9]+$ ]]; then
    printf '%s000\n' "$sec"
    return 0
  fi
  echo "error: epoch_ms failed — both GNU and BSD date paths returned non-numeric output" >&2
  exit 5
}

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
    (
      trap "rmdir '$lockdir' 2>/dev/null || true" EXIT
      printf '%s\n' "$record" >> "$log"
    )
  fi
}

require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "error: jq is required (JSONL composition)" >&2
    echo "install: brew install jq  # or equivalent" >&2
    exit 3
  fi
}

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
