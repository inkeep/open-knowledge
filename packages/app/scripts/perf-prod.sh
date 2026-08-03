#!/usr/bin/env bash
#
# perf-prod.sh — prod-fidelity perf measurement wrapper.
#
# Orchestrates build → start CLI → run perf:profile N times → tear down.
# Gives developers a one-command path to measure against the built artifact
# (equivalent to what ships to users) instead of `pnpm run dev` (Vite HMR
# + transform overhead, uncomparable).
#
# Usage:
#   packages/app/scripts/perf-prod.sh --scenario=<name> [--runs=5] [--env="KEY=value"]
#
# Examples:
#   # G2 regression-gate capture (canonical reference per V2 SPEC §11):
#   packages/app/scripts/perf-prod.sh --scenario=cold-pool-warm \
#     --env="OK_PERF_BIG_DOC=STORIES"
#
#   # G4 mode-toggle with 10 runs:
#   packages/app/scripts/perf-prod.sh --scenario=mode-toggle --runs=10
#
# What it does (precedent #22 shell-script conventions):
#   1. Runs `pnpm run build` from repo root (turbo-cached; no-op when clean).
#   2. Starts TWO CLI processes on kernel-assigned ports:
#        a. `open-knowledge start --port 0` — collab server (Hocuspocus +
#           /api/*). Polls `.ok/server.lock` for bound port.
#        b. `open-knowledge ui --port 0` — React asset server + /api/config
#           proxy. Reads server.lock to derive collab URL for the SPA.
#           Polls `.ok/ui.lock` for bound port.
#      Post-2026-04-16 CLI split: `ok start` is collab-only (no static
#      assets), `ok ui` is the sole server of the React bundle. Playwright
#      must navigate against the UI port, NOT the collab port.
#   3. Runs `pnpm run perf:profile --scenario=<name> --target=http://localhost:<ui-port> --headless`
#      N times. Results land at `packages/app/tests/perf/results/<scenario>.<ts>.json`.
#   4. Sends SIGTERM to both processes; CLI's CC8 shutdown ordering releases
#      both locks cleanly. Waits up to 5s for both locks to disappear.
#   5. Parses the N most recent result files, extracts the scenario's
#      primary metric, reports individual values + median.
#
# Exit codes:
#   0 — N runs completed, median reported
#   1 — usage error (missing --scenario, bad flag value)
#   2 — build failure
#   3 — server failed to start / lock never populated
#   4 — perf:profile run failure
#   5 — results parsing / median computation failure
#
# Not a replacement for the CI-based baseline-capture protocol — see
# packages/app/tests/stress/perf-baseline-update.md §"Local prod-fidelity
# dry-run." Runner hardware differs; local medians are directional signal
# only.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_measure-lib.sh
source "$HERE/_measure-lib.sh"

# ── Arg parsing ──────────────────────────────────────────────────────────────

SCENARIO=""
RUNS=5
EXTRA_ENV=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario=*) SCENARIO="${1#--scenario=}"; shift ;;
    --runs=*)     RUNS="${1#--runs=}"; shift ;;
    --env=*)      EXTRA_ENV="${1#--env=}"; shift ;;
    -h|--help)
      sed -n '3,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "error: unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$SCENARIO" ]]; then
  echo "error: --scenario=<name> is required" >&2
  echo "       available scenarios (packages/app/tests/perf/scenarios/):" >&2
  ls "$HERE/../tests/perf/scenarios/" 2>/dev/null | grep '\.ts$' | sed 's/\.ts$//' | sed 's/^/         /' >&2
  exit 1
fi
assert_numeric_flag --runs "$RUNS"
if (( RUNS < 1 )); then
  echo "error: --runs must be >= 1 (got $RUNS)" >&2
  exit 1
fi

require_jq
REPO_ROOT="$(resolve_repo_root)"

CLI_BIN="$REPO_ROOT/packages/cli/dist/cli.mjs"
SERVER_LOCK="$REPO_ROOT/.ok/server.lock"
UI_LOCK="$REPO_ROOT/.ok/ui.lock"
RESULTS_DIR="$REPO_ROOT/packages/app/tests/perf/results"

# ── 1. Build (turbo-cached) ──────────────────────────────────────────────────

echo "[perf-prod] Building app + cli (turbo cache-friendly; no-op when clean)…"
cd "$REPO_ROOT"
if ! pnpm run build >/dev/null 2>&1; then
  echo "error: pnpm run build failed — re-run manually to see output:" >&2
  echo "       cd $REPO_ROOT && pnpm run build" >&2
  exit 2
fi

if [[ ! -x "$CLI_BIN" && ! -f "$CLI_BIN" ]]; then
  echo "error: CLI binary not found at $CLI_BIN after build" >&2
  exit 2
fi

# ── 2. Start both CLI processes in background ───────────────────────────────
#
# Post-2026-04-16 CLI split: `ok start` is the collab server (Hocuspocus +
# /api/*), `ok ui` is a sibling process that serves the built React bundle
# from packages/app/dist + proxies /api/config pointing at the start lock.
# Neither is sufficient alone — the app needs ui's static assets to load the
# SPA, and ui needs start's server.lock to bootstrap HocuspocusProvider.
# Playwright must navigate against the UI port, NOT the collab port.
#
# Start `ok start` first so its server.lock exists before `ok ui` runs its
# /api/config derivation. A silently-failing ui (no collab target) would
# produce a React app that paints but never hydrates content.

# Remove stale locks from crashed prior runs. The CLI has stale-PID recovery
# but starting clean is simpler; skip only when the lock references a live pid.
for lock in "$SERVER_LOCK" "$UI_LOCK"; do
  if [[ -f "$lock" ]]; then
    STALE_PID="$(jq -r '.pid // "0"' "$lock" 2>/dev/null || echo "0")"
    if [[ "$STALE_PID" != "0" ]] && ! kill -0 "$STALE_PID" 2>/dev/null; then
      echo "[perf-prod] Removing stale $(basename "$lock") from dead pid $STALE_PID"
      rm -f "$lock"
    fi
  fi
done

SERVER_LOG="$(mktemp -t perf-prod-server.XXXXXX.log)"
UI_LOG="$(mktemp -t perf-prod-ui.XXXXXX.log)"

# Pre-flight WORKAROUND for the totalist/sirv broken-symlink crash.
#
# `ok ui` serves its content tree via `sirv` → `totalist@3.0.1`, which
# does synchronous statSync on every entry and propagates ENOENT. A
# single broken symlink anywhere under the walked tree crashes the UI
# on startup before it binds a port — leaving an orphan `ui.lock` with
# `port: 0` and the misleading error "UI did not bind within 2s; run
# `ok clean`". `/review-local`'s plugin bundle at
# `tmp/ship/pr-review-plugin/skills/` routinely creates broken symlinks
# (relative paths like `../../../plugins/eng/skills/<name>` that assume
# a non-monorepo layout).
#
# Auto-clean scoped to `tmp/` only — it's gitignored (never legitimate
# content) and is where review-local/ship artifacts accumulate. Broader
# scans of node_modules/ would hit legitimate cross-package symlinks.
#
# TODO: replace with upstream totalist fix — see tmp/ship/
# totalist-sirv-crash-brief.md for the full repro + fix options. The
# brief proposes a `pnpm patch totalist@3.0.1` that wraps readdirSync +
# statSync in try/catch (ENOENT/EACCES/ENOTDIR → skip). Once that patch
# lands, this pre-flight becomes dead code and can be deleted.
if [[ -d "$REPO_ROOT/tmp" ]]; then
  BROKEN_LINKS=()
  while IFS= read -r -d '' link; do
    if [[ ! -e "$link" ]]; then
      BROKEN_LINKS+=("$link")
    fi
  done < <(find "$REPO_ROOT/tmp" -type l -print0 2>/dev/null)
  if (( ${#BROKEN_LINKS[@]} > 0 )); then
    echo "[perf-prod] Removing ${#BROKEN_LINKS[@]} broken symlink(s) under tmp/ (would crash ok ui):"
    for link in "${BROKEN_LINKS[@]}"; do
      echo "  $link"
      rm -f "$link"
    done
  fi
fi

echo "[perf-prod] Starting open-knowledge (collab server) on kernel-assigned port…"
node "$CLI_BIN" start --port 0 >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  local ec=$?
  for proc in "UI:$UI_PID" "SERVER:$SERVER_PID"; do
    local label="${proc%%:*}"
    local pid="${proc##*:}"
    [[ -z "$pid" || "$pid" == "$proc" ]] && continue
    if kill -0 "$pid" 2>/dev/null; then
      echo "[perf-prod] Stopping $label (pid $pid)…"
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  # Wait up to 5s for both to exit + locks to release. Termination order
  # doesn't matter — each owns its own lock and releases it on SIGTERM per
  # the CLI's CC8 shutdown protocol.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    local alive=0
    [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null && alive=$((alive + 1))
    [[ -n "${UI_PID:-}" ]] && kill -0 "$UI_PID" 2>/dev/null && alive=$((alive + 1))
    if (( alive == 0 )) && [[ ! -f "$SERVER_LOCK" && ! -f "$UI_LOCK" ]]; then break; fi
    sleep 0.5
  done
  # Force-kill any remaining processes.
  for pid in "${UI_PID:-}" "${SERVER_PID:-}"; do
    [[ -z "$pid" ]] && continue
    if kill -0 "$pid" 2>/dev/null; then
      echo "[perf-prod] WARN: pid $pid did not exit on SIGTERM; sending SIGKILL" >&2
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  if [[ $ec -ne 0 ]]; then
    echo "[perf-prod] Script exited non-zero ($ec). Logs:" >&2
    echo "  server: $SERVER_LOG" >&2
    echo "  ui:     $UI_LOG" >&2
  else
    rm -f "$SERVER_LOG" "$UI_LOG" 2>/dev/null || true
  fi
  exit $ec
}
UI_PID=""
trap cleanup EXIT INT TERM

# ── 3. Wait for server lock, then start ui, then wait for ui lock ────────────

wait_for_lock() {
  local lock="$1"
  local pid="$2"
  local label="$3"
  local log="$4"
  local port=""
  # NOTE: informational messages go to stderr (>&2); only the port number
  # goes to stdout. Caller captures this function via `PORT="$(wait_for_lock ...)"`,
  # so any stdout write other than the port number would corrupt the value.
  for i in $(seq 1 60); do
    if [[ -f "$lock" ]]; then
      port="$(jq -r '.port // 0' "$lock" 2>/dev/null || echo "0")"
      if [[ "$port" =~ ^[0-9]+$ ]] && (( port > 0 )); then
        echo "[perf-prod] $label listening on port $port (after ${i} * 0.5s = $((i*500))ms)" >&2
        printf '%s\n' "$port"
        return 0
      fi
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "error: $label process exited before binding a port — log:" >&2
      tail -30 "$log" >&2 || true
      return 1
    fi
    sleep 0.5
  done
  echo "error: $label lock never populated with a real port after 30s — log:" >&2
  tail -30 "$log" >&2 || true
  return 1
}

echo "[perf-prod] Waiting for $SERVER_LOCK with a bound port…"
COLLAB_PORT="$(wait_for_lock "$SERVER_LOCK" "$SERVER_PID" "collab server" "$SERVER_LOG")" || exit 3

# Now start the UI server. It reads server.lock (already populated) to derive
# /api/config's collabUrl. Use port 0 for kernel-assigned; respects
# resolveUiLockCollision (US-005 lock handling).
echo "[perf-prod] Starting open-knowledge ui (React asset server) on kernel-assigned port…"
node "$CLI_BIN" ui --port 0 >"$UI_LOG" 2>&1 &
UI_PID=$!

echo "[perf-prod] Waiting for $UI_LOCK with a bound port…"
PORT="$(wait_for_lock "$UI_LOCK" "$UI_PID" "ui server" "$UI_LOG")" || exit 3

# ── 4. Run perf:profile N times ──────────────────────────────────────────────

APP_DIR="$REPO_ROOT/packages/app"
cd "$APP_DIR"

run_start_ts="$(epoch_ms)"
run_failures=0
for i in $(seq 1 "$RUNS"); do
  echo "[perf-prod] Run $i/$RUNS — scenario=$SCENARIO target=http://localhost:$PORT"
  # Build the env-prefix command. `env $EXTRA_ENV` takes zero or more
  # KEY=value tokens space-separated. An empty string is a no-op.
  if [[ -n "$EXTRA_ENV" ]]; then
    # shellcheck disable=SC2086
    if ! env $EXTRA_ENV pnpm run perf:profile --scenario="$SCENARIO" --target="http://localhost:$PORT" --headless; then
      run_failures=$((run_failures + 1))
      echo "[perf-prod] WARN: run $i exited non-zero — continuing" >&2
    fi
  else
    if ! pnpm run perf:profile --scenario="$SCENARIO" --target="http://localhost:$PORT" --headless; then
      run_failures=$((run_failures + 1))
      echo "[perf-prod] WARN: run $i exited non-zero — continuing" >&2
    fi
  fi
done

if (( run_failures == RUNS )); then
  echo "error: all $RUNS runs failed — see logs above" >&2
  exit 4
fi
if (( run_failures > 0 )); then
  echo "[perf-prod] NOTE: $run_failures/$RUNS runs failed (median computed from remaining)" >&2
fi

# ── 5. Extract primary metric + median ───────────────────────────────────────

# Map scenario → jq path for the metric we care about most. When a
# scenario doesn't have a canonical primary metric, the script reports
# all result filenames and leaves median computation to the caller.
# Names here must match exactly what the scenario emits via
# ctx.recordMetric(...). Verified against packages/app/tests/perf/scenarios/
# on 2026-04-21 — `warm-switch-cached` emits `warmSwitchCachedMs` (not
# `warmSwitchMs` — that's the separate `warm-switch` scenario).
case "$SCENARIO" in
  warm-switch-cached)      METRIC=".metrics.warmSwitchCachedMs" ;;
  cold-pool-warm)          METRIC=".metrics.coldPoolWarmMs" ;;
  cold-load-with-fallback) METRIC=".metrics.interactiveReadyMs" ;;
  cold-load-big-doc)       METRIC=".metrics.coldLoadMs" ;;
  mode-toggle)             METRIC=".metrics.modeToggleMs" ;;
  warm-switch)             METRIC=".metrics.warmSwitchMs" ;;
  outline-polling)         METRIC=".metrics.hoverToOutlineMs" ;;
  *)                       METRIC="" ;;
esac

# Find the N most-recent result files for this scenario that were
# modified AFTER run_start_ts (the script's launch epoch). Excludes
# pre-existing results from older measurement sessions.
cd "$RESULTS_DIR"
# shellcheck disable=SC2012  # ls with -t is intentional; file names have no spaces/newlines.
latest_files="$(ls -t "$SCENARIO".*.json 2>/dev/null | head -n "$RUNS" || true)"
if [[ -z "$latest_files" ]]; then
  echo "error: no result files found for scenario=$SCENARIO in $RESULTS_DIR" >&2
  exit 5
fi

echo ""
echo "[perf-prod] ===== SUMMARY — $SCENARIO ====="
echo "[perf-prod] Runs: $RUNS (failures: $run_failures)"
echo "[perf-prod] Results: $RESULTS_DIR"
echo ""
if [[ -z "$METRIC" ]]; then
  echo "[perf-prod] No primary metric registered for this scenario — listing result files:"
  echo "$latest_files" | sed 's/^/  /'
  echo ""
  echo "[perf-prod] To extract a custom metric: jq '.metrics.<field>' <result-file>"
else
  echo "[perf-prod] Primary metric: $METRIC"
  echo ""
  values=""
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    v="$(jq -r "$METRIC // -1" "$f" 2>/dev/null || echo "-1")"
    printf '[perf-prod]   %s: %s ms\n' "$f" "$v"
    values+="$v"$'\n'
  done <<< "$latest_files"

  # Compute median of non-negative values. Negative values (scenario
  # sentinel for "could not measure") are excluded from the median but
  # still reported above as -1 for visibility.
  #
  # Portability note (precedent #22(d)): GNU awk has `asort()`, BSD awk
  # (macOS default) does not. The POSIX-compatible path is an explicit
  # insertion sort over the collected array — a handful of lines, no
  # external dependency. `LC_ALL=C` keeps `.`-as-decimal-separator so a
  # non-US locale doesn't break numeric parsing.
  median="$(printf '%s' "$values" | LC_ALL=C awk '
    /^-?[0-9]+(\.[0-9]+)?$/ && $1 >= 0 { a[c++] = $1 + 0 }
    END {
      if (c == 0) { print "NO_VALID_VALUES"; exit }
      # Insertion sort — portable across BSD awk + gawk + mawk.
      for (i = 1; i < c; i++) {
        key = a[i]
        j = i - 1
        while (j >= 0 && a[j] > key) {
          a[j+1] = a[j]
          j--
        }
        a[j+1] = key
      }
      if (c % 2 == 1) { print a[(c-1)/2] }
      else { print (a[c/2-1] + a[c/2]) / 2 }
    }
  ')"
  echo ""
  if [[ "$median" == "NO_VALID_VALUES" ]]; then
    echo "[perf-prod] WARN: no valid (non-negative) values to compute median from" >&2
  else
    printf '[perf-prod] MEDIAN: %s ms\n' "$median"
  fi
fi
echo ""
echo "[perf-prod] NOTE: For the canonical baseline capture, follow the CI-based"
echo "[perf-prod]       protocol in packages/app/tests/stress/perf-baseline-update.md."
echo "[perf-prod]       Local medians are directional signal, not the authority."

# Cleanup runs via the trap.
