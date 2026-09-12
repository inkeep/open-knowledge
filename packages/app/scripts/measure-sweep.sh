#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_measure-lib.sh"

usage() {
  cat <<'EOF'
Usage: bash scripts/measure-sweep.sh --context "<why>" [options]

Ad-hoc measurement of the project-scope Fix-all sweep. Drives one full sweep
through the real Problems panel against a prod-fidelity server and reports the
five numbers the shipping configuration's success metrics turn on: panel-open
time, full-sweep duration, successful-fix count, capacity-refusal count, and
main-thread blocked time. Each completed run appends one JSONL record to
specs/2026-07-30-fix-all-sweep-performance/evidence/sweep-measurements.jsonl —
the git history of that file IS the trend record, exactly like the sibling
measure:fuzz / measure:stress producers. Explicitly NOT a CI job: a sweep takes
tens of seconds and needs a large on-disk fixture.

Every specs/ path in this message lives in Inkeep's internal tree and is absent
from the open-source repository. The script creates the evidence directory it
writes to, so a clone without them still measures; only the schema notes and the
trend history are unavailable.

The measured configuration is the shipping stack (R1 collapse + R2 chunk + R3
pace/retry) built from the current worktree; the record labels it
"R1+R2+R3 (shipping)" so a reader never confuses it with the spec's earlier
single-lever numbers.

Required:
  --context "..."     Free-text annotation for the record's context field.

Optional:
  --fixture DIR       Content fixture to sweep. Default ~/ok-validation/realistic
                      (2,400 docs — scripts/make-sweep-fixture.mjs --preset
                      realistic). NEVER mutated: rsync'd to a scratch dir first.
  --sweep-timeout MS  Max wait for the sweep to finish. Default 300000.
  --skip-build        Reuse the current packages/cli + packages/app dist.
  --keep-scratch      Leave the scratch fixture copy on disk (debugging).
  -h, --help          Show this message.

Examples:
  bash scripts/measure-sweep.sh --context "shipping-config baseline"
  bash scripts/measure-sweep.sh --context "smoke" --fixture ~/ok-validation/small
  pnpm run measure:sweep --context "re-measure after retune"

Output:
  Prints the measured metrics, then each target as ✓ pass or ⚠ MISS:
    panelOpenWarmMs      < 1000
    sweepDurationMs      < 90000
    mainThreadBlockedPct < 5
    filesFailedTerminal  == 0
  Misses are surfaced prominently and recorded in the record's targetMisses
  array; they do not fail the run.
  On a completed sweep, appends one record (script "sweep-fixall") carrying
  timestamp, commit, script, config, fixture, context, metrics (the browser
  SWEEP_RESULT object verbatim), targets, targetMisses, durationMs, host,
  invokedBy, nodeVersion.
  A run whose browser measurement emitted no parseable SWEEP_RESULT, and a run
  whose sweep did not complete, both append NOTHING and exit non-zero — a run
  with no evidence is not a measurement.

Exit codes:
  0   sweep completed, record appended (target misses do NOT fail the run)
  2   usage error: unknown flag, missing --context, non-integer --sweep-timeout,
      or --fixture directory not found
  3   jq is not installed, or tsx is missing from node_modules/.bin
  4   the workspace-root markers are missing, the build failed, or the CLI binary
      is absent after the build
  5   no markdown docs under the copied fixture, or no numeric epoch was available
  6   the server exited before binding a port or never bound one within 60s, or
      the JSONL append could not take its lock
  7   the browser measurement produced no parseable SWEEP_RESULT
  8   the sweep did not finish within --sweep-timeout; the printed numbers are
      partial
EOF
}

CONTEXT=""
FIXTURE="$HOME/ok-validation/realistic"
SWEEP_TIMEOUT_MS=300000
SKIP_BUILD=0
KEEP_SCRATCH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --context)       CONTEXT="$2"; shift 2 ;;
    --fixture)       FIXTURE="$2"; shift 2 ;;
    --sweep-timeout) SWEEP_TIMEOUT_MS="$2"; shift 2 ;;
    --skip-build)    SKIP_BUILD=1; shift ;;
    --keep-scratch)  KEEP_SCRATCH=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "error: unknown flag: $1" >&2
      echo "run with --help for usage" >&2
      exit 2 ;;
  esac
done

if [[ -z "$CONTEXT" ]]; then
  echo "error: --context is required (free-text annotation for JSONL record)" >&2
  echo "example: --context 'shipping-config baseline'" >&2
  exit 2
fi
assert_numeric_flag "--sweep-timeout" "$SWEEP_TIMEOUT_MS"

FIXTURE="${FIXTURE/#\~/$HOME}"
if [[ ! -d "$FIXTURE" ]]; then
  echo "error: fixture dir not found: $FIXTURE" >&2
  exit 2
fi

require_jq
REPO_ROOT="$(resolve_repo_root)"
CLI_BIN="$REPO_ROOT/packages/cli/dist/cli.mjs"
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
SWEEP_SCRIPT="$REPO_ROOT/packages/app/tests/perf/sweep-measure.ts"
EVIDENCE_DIR="$REPO_ROOT/specs/2026-07-30-fix-all-sweep-performance/evidence"
LOG_FILE="$EVIDENCE_DIR/sweep-measurements.jsonl"

if [[ ! -f "$TSX_BIN" ]]; then
  echo "error: tsx not found at $TSX_BIN — run pnpm install in the OK subtree" >&2
  exit 3
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "[measure-sweep] building cli + app (turbo-cached)…"
  ( cd "$REPO_ROOT" && pnpm exec turbo run build \
      --filter=@inkeep/open-knowledge --filter=@inkeep/open-knowledge-app ) \
    || { echo "error: build failed — re-run 'pnpm build' to see output" >&2; exit 4; }
fi
if [[ ! -f "$CLI_BIN" ]]; then
  echo "error: CLI binary not found at $CLI_BIN after build" >&2
  exit 4
fi

SCRATCH="$(mktemp -d -t ok-sweep-XXXXXX)"
SERVER_LOG="$(mktemp -t ok-sweep-server-XXXXXX.log)"
SERVER_PID=""

cleanup() {
  local ec=$?
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[measure-sweep] stopping server (pid $SERVER_PID)…" >&2
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -0 "$SERVER_PID" 2>/dev/null && kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ "$KEEP_SCRATCH" -eq 1 ]]; then
    echo "[measure-sweep] scratch kept at $SCRATCH" >&2
  else
    rm -rf "$SCRATCH" 2>/dev/null || true
  fi
  if [[ $ec -ne 0 ]]; then
    echo "[measure-sweep] exited non-zero ($ec). Server log: $SERVER_LOG" >&2
  else
    rm -f "$SERVER_LOG" 2>/dev/null || true
  fi
  exit $ec
}
trap cleanup EXIT INT TERM

echo "[measure-sweep] copying fixture → $SCRATCH …"
rsync -a --exclude='.git' --exclude='.ok/local' "$FIXTURE/" "$SCRATCH/"

NAV_MD="$(find "$SCRATCH" -name '*.md' -not -path '*/.ok/*' | sort | head -1 || true)"
if [[ -z "$NAV_MD" ]]; then
  echo "error: no markdown docs found under $SCRATCH" >&2
  exit 5
fi
NAV_DOC="${NAV_MD#"$SCRATCH"/}"
NAV_DOC="${NAV_DOC%.md}"
DOC_COUNT="$(find "$SCRATCH" -name '*.md' -not -path '*/.ok/*' | wc -l | tr -d ' ')"
echo "[measure-sweep] fixture: $DOC_COUNT docs · nav-doc: $NAV_DOC"

echo "[measure-sweep] starting ok server on a kernel-assigned port…"
( cd "$SCRATCH" && exec node "$CLI_BIN" start --port 0 ) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

read_server_port() {
  local lock port
  lock="$(find "$SCRATCH/.ok" -name server.lock 2>/dev/null | head -1 || true)"
  [[ -z "$lock" ]] && return 1
  port="$(jq -r '.port // 0' "$lock" 2>/dev/null || echo 0)"
  [[ "$port" =~ ^[0-9]+$ ]] && (( port > 0 )) && { printf '%s\n' "$port"; return 0; }
  return 1
}

EDITOR_PORT=""
for i in $(seq 1 120); do
  if EDITOR_PORT="$(read_server_port)"; then
    echo "[measure-sweep] editor ready on port $EDITOR_PORT (after $((i))*0.5s)"
    break
  fi
  EDITOR_PORT=""
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "error: server exited before binding a port — log:" >&2
    tail -30 "$SERVER_LOG" >&2 || true
    exit 6
  fi
  sleep 0.5
done
if [[ -z "$EDITOR_PORT" ]]; then
  echo "error: server never bound an editor port within 60s — log:" >&2
  tail -30 "$SERVER_LOG" >&2 || true
  exit 6
fi

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
HOST="$(detect_host)"
INVOKED_BY="${USER:-unknown}"
NODE_VERSION="$(node --version 2>/dev/null || echo unknown)"
FIXTURE_TAG="$(basename "$FIXTURE")"

echo "[measure-sweep] driving the sweep (target http://localhost:$EDITOR_PORT)…"
START_MS="$(epoch_ms)"
set +e
MEAS_OUT="$(OK_SWEEP_DOC="$NAV_DOC" "$TSX_BIN" "$SWEEP_SCRIPT" \
  --target="http://localhost:$EDITOR_PORT" \
  --nav-doc="$NAV_DOC" \
  --sweep-timeout="$SWEEP_TIMEOUT_MS")"
MEAS_EXIT=$?
set -e
END_MS="$(epoch_ms)"
DURATION_MS=$(( END_MS - START_MS ))

JSON="$(printf '%s\n' "$MEAS_OUT" | sed -n 's/^SWEEP_RESULT //p' | tail -1)"
if [[ -z "$JSON" ]] || ! jq -e . >/dev/null 2>&1 <<<"$JSON"; then
  echo "" >&2
  echo "error: the browser measurement produced no parseable SWEEP_RESULT (exit $MEAS_EXIT)." >&2
  echo "       Nothing measured — no record appended. Server log: $SERVER_LOG" >&2
  exit 7
fi

CHECKS_JSON="$(jq -c -n --argjson m "$JSON" '
  [ {name:"panelOpenWarmMs",     target:1000,  value:$m.panelOpenWarmMs,     cmp:"<"},
    {name:"sweepDurationMs",     target:90000, value:$m.sweepDurationMs,     cmp:"<"},
    {name:"mainThreadBlockedPct",target:5,     value:$m.mainThreadBlockedPct,cmp:"<"},
    {name:"filesFailedTerminal", target:0,     value:$m.filesFailedTerminal, cmp:"=="}
  ] | map(. + {miss: (if .cmp=="<" then (.value >= .target) else (.value != .target) end)})')"
MISSES_JSON="$(jq -c '[ .[] | select(.miss) | {name,target,value,cmp} ]' <<<"$CHECKS_JSON")"

mkdir -p "$EVIDENCE_DIR"
RECORD="$(jq -c -n \
  --arg timestamp "$TIMESTAMP" \
  --arg commit "$COMMIT" \
  --arg script "sweep-fixall" \
  --arg config "R1+R2+R3 (shipping)" \
  --arg fixture "$FIXTURE_TAG" \
  --arg context "$CONTEXT" \
  --argjson metrics "$JSON" \
  --argjson targets '{"panelOpenWarmMs":1000,"sweepDurationMs":90000,"mainThreadBlockedPct":5,"filesFailedTerminal":0}' \
  --argjson targetMisses "$MISSES_JSON" \
  --argjson durationMs "$DURATION_MS" \
  --arg host "$HOST" \
  --arg invokedBy "$INVOKED_BY" \
  --arg nodeVersion "$NODE_VERSION" \
  '{timestamp:$timestamp, commit:$commit, script:$script, config:$config, fixture:$fixture,
    context:$context, metrics:$metrics, targets:$targets, targetMisses:$targetMisses,
    durationMs:$durationMs, host:$host, invokedBy:$invokedBy, nodeVersion:$nodeVersion}')"

if [[ "$(jq -r '.sweepCompleted' <<<"$JSON")" == "true" ]]; then
  append_jsonl_atomic "$LOG_FILE" "$RECORD"
  APPENDED_TO_LOG=1
else
  APPENDED_TO_LOG=0
fi

echo ""
echo "──────── measure-sweep summary ────────"
echo "  context:    $CONTEXT"
echo "  commit:     $COMMIT   fixture: $FIXTURE_TAG   host: $HOST"
echo "  config:     R1+R2+R3 (shipping)"
jq -r '
  "  fixable files:        \(.fixableFileCount)",
  "  panel open (cold):    \(.panelOpenColdMs) ms  (incl. cold audit walk)",
  "  panel open (warm):    \(.panelOpenWarmMs) ms",
  "  full sweep:           \(.sweepDurationMs) ms  (completed=\(.sweepCompleted))",
  "  successful fixes:     \(.lintFixSuccess)",
  "  capacity 503s:        \(.lintFix503)  (transient; retried)",
  "  files failed:         \(.filesFailedTerminal)",
  "  main thread blocked:  \(.mainThreadBlockedMs) ms  (\(.mainThreadBlockedPct)% of sweep)"
' <<<"$JSON"
echo ""
echo "  targets:"
jq -r '.[] | "    " + (if .miss then "⚠ MISS " else "✓ pass " end) +
  .name + " " + .cmp + " " + (.target|tostring) + "  (got " + (.value|tostring) + ")"' <<<"$CHECKS_JSON"

MISS_COUNT="$(jq 'length' <<<"$MISSES_JSON")"
echo ""
if [[ "$MISS_COUNT" -gt 0 ]]; then
  echo "  ⚠ $MISS_COUNT target(s) MISSED — recorded in the JSONL and flagged above."
else
  echo "  ✓ all targets met."
fi
if [[ "$APPENDED_TO_LOG" -eq 1 ]]; then
  echo "  logFile:    $LOG_FILE"
else
  echo "  logFile:    (not appended — incomplete sweep is not a measurement)"
fi
echo ""

if [[ "$(jq -r '.sweepCompleted' <<<"$JSON")" != "true" ]]; then
  echo "error: the sweep did not complete within ${SWEEP_TIMEOUT_MS}ms — numbers above are partial." >&2
  exit 8
fi
