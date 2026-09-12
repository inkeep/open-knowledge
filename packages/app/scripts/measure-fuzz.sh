#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_measure-lib.sh"

usage() {
  cat <<'EOF'
Usage: bash scripts/measure-fuzz.sh --context "<why>" [options]

Ad-hoc sampling wrapper for tests/stress/bridge-convergence.fuzz.test.ts. Samples
the architectural CRDT residual rate across a seed budget and appends one JSONL
record to specs/2026-04-16-bridge-correctness/evidence/residual-measurements.jsonl.
The git history of that file IS the trend record — no CI automation flags rate
drift (accepted cost per NG6 in specs/2026-04-19-ci-signal-quality/SPEC.md).

Every specs/ path in this message lives in Inkeep's internal tree and is absent
from the open-source repository. The script creates the evidence directory it
writes to, so a clone without them still measures; only the schema notes and the
trend history are unavailable.

Required:
  --context "..."     Free-text annotation for the record's context field. This
                      is what lets a future reader understand WHY a measurement
                      was taken.

Optional:
  --seeds N           Total seed budget (default: 1000). Sets BRIDGE_FUZZ_SEEDS=N
                      on the test invocation.
  --seed-replay SEED  Single-seed replay. Sets STRESS_FUZZ_SEED=SEED and unsets
                      BRIDGE_FUZZ_SEEDS, so it overrides --seeds.
  -h, --help          Show this message.

Examples:
  bash scripts/measure-fuzz.sh --seeds 1000 --context "pre-PR-218 baseline"
  bash scripts/measure-fuzz.sh --seed-replay 1776559905522 --context "reproduce PR #206 failing seed"
  pnpm run measure:fuzz --seeds 100 --context "investigate fuzz rate shift"

Output:
  Appends one record (script "deep-fuzz") to the evidence log, then prints a
  summary — context, commit, host, outcome, seedCount, seedsFailed, rate,
  durationMs, logFile — plus a replay command per failing seed. A test failure is
  still a measurement: the record is appended and the script exits with the
  runner's code.
  A run that measured nothing appends NOTHING and leaves the trend log untouched:
  the RESULT line never appeared, or a clean-sweep RESULT was contradicted by a
  non-zero runner exit.

Record shape:
  Field-by-field contract in
  specs/2026-04-16-bridge-correctness/evidence/residual-measurements-SCHEMA.md.
  extra.outcome is "pass" (RESULT emitted, seedsFailed 0, runner exit 0) or
  "fail" (RESULT emitted, seedsFailed >= 1); nothing else is ever appended.
  extra.failClasses carries one {seed, class} entry per failing seed.

Exit codes:
  0   measurement appended, every seed passed
  1   nothing measured: no RESULT line on a run the runner exited 0
  2   usage error: unknown flag, missing --context, non-integer flag value
  3   jq is not installed
  4   the derived workspace root lacks its packages/app + package.json markers
  5   neither date path produced a numeric epoch
  6   the JSONL append could not take its lock; the record was NOT committed
  *   otherwise the test runner's exit code: seeds failed (record appended), the
      harness crashed before RESULT, or RESULT was contradicted post-hoc (both
      append nothing)

Query patterns over the evidence log:
  LOG=specs/2026-04-16-bridge-correctness/evidence/residual-measurements.jsonl

  7-day rolling average rate:
    jq -s 'sort_by(.timestamp) | map(select(.timestamp > (now - 7*86400 | todate))) | [.[].rate] | add/length' "$LOG"
  Runs above a 5% rate:
    jq 'select(.rate > 0.05)' "$LOG"
  Summary by script:
    jq -s 'group_by(.script) | map({script: .[0].script, runs: length, avgRate: (map(.rate) | add/length)})' "$LOG"
EOF
}

SEEDS=1000
SEED_REPLAY=""
CONTEXT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --seeds)
      SEEDS="$2"; shift 2 ;;
    --seed-replay)
      SEED_REPLAY="$2"; shift 2 ;;
    --context)
      CONTEXT="$2"; shift 2 ;;
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
  echo "example: --context 'pre-PR-218 baseline'" >&2
  exit 2
fi

assert_numeric_flag "--seeds" "$SEEDS"
if [[ -n "$SEED_REPLAY" ]]; then
  assert_numeric_flag "--seed-replay" "$SEED_REPLAY" --signed
fi

require_jq
REPO_ROOT="$(resolve_repo_root)"

APP_DIR="$REPO_ROOT/packages/app"
LOG_DIR="$REPO_ROOT/specs/2026-04-16-bridge-correctness/evidence"
LOG_FILE="$LOG_DIR/residual-measurements.jsonl"
TEST_FILE="tests/stress/bridge-convergence.fuzz.test.ts"

mkdir -p "$LOG_DIR"

if [[ -n "$SEED_REPLAY" ]]; then
  export STRESS_FUZZ_SEED="$SEED_REPLAY"
  unset BRIDGE_FUZZ_SEEDS
  echo "[measure-fuzz] seed-replay mode: STRESS_FUZZ_SEED=$SEED_REPLAY"
else
  export BRIDGE_FUZZ_SEEDS="$SEEDS"
  unset STRESS_FUZZ_SEED
  echo "[measure-fuzz] sampling mode: BRIDGE_FUZZ_SEEDS=$SEEDS"
fi

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
COMMIT="$(git rev-parse --short HEAD)"
INVOKED_BY="${USER:-unknown}"
NODE_VERSION="$(node --version 2>/dev/null || echo unknown)"

HOST="$(detect_host)"

OUT_FILE="$(mktemp -t measure-fuzz-XXXXXX)"
trap 'rm -f "$OUT_FILE"' EXIT

echo "[measure-fuzz] running $TEST_FILE ..."

START_MS="$(epoch_ms)"

TEST_EXIT=0
(
  cd "$APP_DIR" || exit 1
  pnpm exec vitest run "$TEST_FILE" 2>&1
) | tee "$OUT_FILE" || TEST_EXIT=$?

END_MS="$(epoch_ms)"
DURATION_MS=$(( END_MS - START_MS ))

CONVERGED_LATE="$(grep -oE '^\[fuzz\] RESULT .*convergedLate=[0-9]+' "$OUT_FILE" | grep -oE 'convergedLate=[0-9]+' | tail -1 | cut -d= -f2 || true)"
CONVERGED_LATE="${CONVERGED_LATE:-0}"

FAIL_CLASSES_RAW="$(grep -oE '^\[fuzz\] RESULT .*failClasses=\[[0-9a-z:,-]*\]' "$OUT_FILE" | grep -oE 'failClasses=\[[0-9a-z:,-]*\]' | tail -1 | sed -E 's/^failClasses=\[//; s/\]$//' || true)"
FAIL_CLASSES_JSON="$(jq -c -n --arg raw "$FAIL_CLASSES_RAW" \
  '[ $raw | select(length > 0) | split(",")[] | split(":") | { seed: (.[0] | tonumber), class: (.[1] // "unknown") } ]')"

FUZZ_RESULT_LINE="$(grep -oE '^\[fuzz\] RESULT seeds=[0-9]+ passed=[0-9]+ failed=[0-9]+ failingSeeds=\[[0-9,]*\]' "$OUT_FILE" | tail -1 || true)"

if [[ -n "$FUZZ_RESULT_LINE" ]]; then
  RESULT_SEEDS="$(echo "$FUZZ_RESULT_LINE" | grep -oE 'seeds=[0-9]+' | awk -F= '{print $2}')"
  RESULT_PASSED="$(echo "$FUZZ_RESULT_LINE" | grep -oE 'passed=[0-9]+' | awk -F= '{print $2}')"
  RESULT_FAILED="$(echo "$FUZZ_RESULT_LINE" | grep -oE 'failed=[0-9]+' | awk -F= '{print $2}')"
  RESULT_SEEDS_ARR="$(echo "$FUZZ_RESULT_LINE" | sed -E 's/.*failingSeeds=\[(.*)\]$/\1/')"
  SEED_COUNT="$RESULT_SEEDS"
  SEEDS_FAILED="$RESULT_FAILED"
  SEEDS_PASSED="$RESULT_PASSED"
  if [[ -z "$RESULT_SEEDS_ARR" ]]; then
    FAILING_SEEDS_JSON="[]"
  else
    FAILING_SEEDS_JSON="[$RESULT_SEEDS_ARR]"
  fi
  if [[ "$SEEDS_FAILED" == "0" && "$TEST_EXIT" -eq 0 ]]; then
    OUTCOME="pass"
  elif [[ "$SEEDS_FAILED" != "0" ]]; then
    OUTCOME="fail"
  else
    echo "" >&2
    echo "error: RESULT reported a clean sweep (failed=0) but the runner exited $TEST_EXIT" >&2
    echo "       — post-RESULT failure (teardown error, sibling test). The run cannot be" >&2
    echo "       certified clean. No record appended — the trend log is untouched." >&2
    exit "$TEST_EXIT"
  fi
else
  echo "" >&2
  if [[ "$TEST_EXIT" -eq 0 ]]; then
    echo "error: runner exited 0 but the harness RESULT line never appeared — no tests" >&2
    echo "       matched, or the RESULT emission moved or its format drifted." >&2
  else
    echo "error: harness crashed before emitting its result line." >&2
  fi
  echo "       Nothing was measured. No record appended — the trend log is untouched." >&2
  echo "       Full output above." >&2
  if [[ "$TEST_EXIT" -ne 0 ]]; then
    exit "$TEST_EXIT"
  fi
  exit 1
fi

if [[ "$SEED_COUNT" == "0" ]]; then
  RATE="0.0000"
else
  RATE="$(LC_ALL=C awk -v a="$SEEDS_FAILED" -v b="$SEED_COUNT" 'BEGIN{ printf "%.4f", a/b }')"
fi

EXTRA_JSON="$(jq -c -n --arg outcome "$OUTCOME" --argjson failClasses "$FAIL_CLASSES_JSON" \
  '{ outcome: $outcome, failClasses: $failClasses }')"

RECORD="$(jq -c -n \
  --arg timestamp   "$TIMESTAMP" \
  --arg commit      "$COMMIT" \
  --arg script      "deep-fuzz" \
  --argjson seedCount   "$SEED_COUNT" \
  --argjson seedsFailed "$SEEDS_FAILED" \
  --argjson convergedLate "$CONVERGED_LATE" \
  --argjson rate        "$RATE" \
  --arg invokedBy   "$INVOKED_BY" \
  --arg context     "$CONTEXT" \
  --argjson failingSeeds "$FAILING_SEEDS_JSON" \
  --argjson durationMs   "$DURATION_MS" \
  --arg host        "$HOST" \
  --arg nodeVersion "$NODE_VERSION" \
  --argjson extra   "$EXTRA_JSON" \
  '{
     timestamp: $timestamp,
     commit: $commit,
     script: $script,
     seedCount: $seedCount,
     seedsFailed: $seedsFailed,
     convergedLate: $convergedLate,
     rate: $rate,
     invokedBy: $invokedBy,
     context: $context,
     failingSeeds: $failingSeeds,
     durationMs: $durationMs,
     host: $host,
     nodeVersion: $nodeVersion,
     extra: $extra
   }')"

append_jsonl_atomic "$LOG_FILE" "$RECORD"

echo ""
echo "──────── measure-fuzz summary ────────"
echo "  context:      $CONTEXT"
echo "  commit:       $COMMIT"
echo "  host:         $HOST"
echo "  outcome:      $OUTCOME"
echo "  seedCount:    $SEED_COUNT"
echo "  seedsFailed:  $SEEDS_FAILED"
echo "  rate:         $RATE"
echo "  durationMs:   $DURATION_MS"
echo "  logFile:      $LOG_FILE"
echo ""

if [[ "$SEEDS_FAILED" != "0" ]]; then
  FAILING_SEEDS_LIST="$(jq -r '.[]' <<< "$FAILING_SEEDS_JSON" 2>/dev/null || true)"
  if [[ -n "$FAILING_SEEDS_LIST" ]]; then
    echo "──────── failing seed replay commands ────────"
    while IFS= read -r seed; do
      [[ -z "$seed" ]] && continue
      echo "  STRESS_FUZZ_SEED=$seed pnpm exec vitest run $TEST_FILE  # in $APP_DIR"
    done <<< "$FAILING_SEEDS_LIST"
    echo ""
  fi
fi

exit "$TEST_EXIT"
