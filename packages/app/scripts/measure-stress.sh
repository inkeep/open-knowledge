#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_measure-lib.sh"

usage() {
  cat <<'EOF'
Usage: bash scripts/measure-stress.sh --context "<why>" [--seed N]

Ad-hoc sampling wrapper for tests/stress/server-authoritative-stress.test.ts.
Samples the architectural CRDT residual in the 5-client × 30s stress-load
scenario, with optional seed replay for triaging a known-bad seed, and appends
one JSONL record to
specs/2026-04-16-bridge-correctness/evidence/residual-measurements.jsonl.

Every specs/ path in this message lives in Inkeep's internal tree and is absent
from the open-source repository. The script creates the evidence directory it
writes to, so a clone without them still measures; only the schema notes and the
trend history are unavailable.

Unlike measure-fuzz.sh, which sweeps N seeds in one run, this script measures one
seed per invocation — the underlying test is a 30-second multi-client
convergence scenario, not a seeded-PBT loop.

Required:
  --context "..."   Free-text annotation for the record's context field.

Optional:
  --seed N          STRESS_SEED override. Default: omitted, so the test picks its
                    own Date.now() seed; whichever seed ran is recorded.
  -h, --help        Show this message.

The test's run duration is hard-coded to 30s internally with no env knob, so this
script deliberately exposes no --duration flag rather than accepting one it
cannot honor. If the test ever parameterizes duration, add the flag here and in
the test body together.

Examples:
  bash scripts/measure-stress.sh --seed 42 --context "pre-PR-218 baseline"
  bash scripts/measure-stress.sh --context "investigate a residual rate shift"
  pnpm run measure:stress --seed 1776381158793 --context "reproduce a CI flake"

Output:
  Appends one record, then prints a summary — context, commit, host, stressSeed,
  outcome, durationMs, logFile — plus a replay command on failure. The record
  uses the measure-fuzz schema with these differences:
    script:       "deep-stress"
    seedCount:    1
    seedsFailed:  0 on pass, 1 on fail
    rate:         0.0000 on pass, 1.0000 on fail
    failingSeeds: [<seed>] on fail, [] on pass
    extra:        { stressSeed, outcome }, with no convergedLate and no failClasses
  A non-zero exit with an attributable seed records outcome "fail". The seed is
  attributable from --seed alone, so under an explicit --seed even a harness
  crash records a fail rather than aborting.
  A run that measured nothing appends NOTHING: the RESULT line is missing on a
  zero exit, a RESULT-pass is contradicted by a non-zero exit, or no seed could
  be attributed at all (no banner, no RESULT seed, no --seed).
  Full schema + query patterns: `bash scripts/measure-fuzz.sh --help` and
  specs/2026-04-16-bridge-correctness/evidence/residual-measurements-SCHEMA.md.

Exit codes:
  0   measurement appended, the stress run passed
  1   nothing measured: no RESULT line on a run the runner exited 0, or an outcome
      was classified but no seed could be attributed
  2   usage error: unknown flag, missing --context, non-integer --seed
  3   jq is not installed
  4   the derived workspace root lacks its packages/app + package.json markers
  5   neither date path produced a numeric epoch
  6   the JSONL append could not take its lock; the record was NOT committed
  *   otherwise the test runner's exit code: a stress failure or a crash with an
      attributable seed (record appended), or a RESULT-pass contradicted by a
      non-zero exit / a crash with no attributable seed (nothing appended)
EOF
}

SEED=""
CONTEXT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --seed)
      SEED="$2"; shift 2 ;;
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

if [[ -n "$SEED" ]]; then
  assert_numeric_flag "--seed" "$SEED" --signed
fi

require_jq
REPO_ROOT="$(resolve_repo_root)"

APP_DIR="$REPO_ROOT/packages/app"
LOG_DIR="$REPO_ROOT/specs/2026-04-16-bridge-correctness/evidence"
LOG_FILE="$LOG_DIR/residual-measurements.jsonl"
TEST_FILE="tests/stress/server-authoritative-stress.test.ts"

mkdir -p "$LOG_DIR"

if [[ -n "$SEED" ]]; then
  export STRESS_SEED="$SEED"
  echo "[measure-stress] seed-replay mode: STRESS_SEED=$SEED"
else
  unset STRESS_SEED
  echo "[measure-stress] fresh seed (test picks via Date.now())"
fi

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
COMMIT="$(git rev-parse --short HEAD)"
INVOKED_BY="${USER:-unknown}"
NODE_VERSION="$(node --version 2>/dev/null || echo unknown)"

HOST="$(detect_host)"

OUT_FILE="$(mktemp -t measure-stress-XXXXXX)"
trap 'rm -f "$OUT_FILE"' EXIT

echo "[measure-stress] running $TEST_FILE ..."

START_MS="$(epoch_ms)"

TEST_EXIT=0
(
  cd "$APP_DIR" || exit 1
  pnpm exec vitest run "$TEST_FILE" 2>&1
) | tee "$OUT_FILE" || TEST_EXIT=$?

END_MS="$(epoch_ms)"
DURATION_MS=$(( END_MS - START_MS ))

ACTUAL_SEED_BANNER="$(grep -oE '\[server-authoritative stress\] seed=[0-9]+' "$OUT_FILE" \
  | awk -F= '{print $2}' | head -1 || true)"
ACTUAL_SEED_RESULT="$(grep -oE '^\[stress\] RESULT .*seed=[0-9]+' "$OUT_FILE" \
  | grep -oE 'seed=[0-9]+' | awk -F= '{print $2}' | head -1 || true)"
if [[ -n "$ACTUAL_SEED_BANNER" ]]; then
  ACTUAL_SEED="$ACTUAL_SEED_BANNER"
elif [[ -n "$ACTUAL_SEED_RESULT" ]]; then
  ACTUAL_SEED="$ACTUAL_SEED_RESULT"
elif [[ -n "$SEED" ]]; then
  ACTUAL_SEED="$SEED"
else
  ACTUAL_SEED=""
fi

HAS_RESULT_PASS="$(grep -cE '^\[stress\] RESULT outcome=pass' "$OUT_FILE" || true)"
HAS_RESULT_PASS="${HAS_RESULT_PASS:-0}"

SEED_COUNT=1
if [[ "$TEST_EXIT" -eq 0 && "$HAS_RESULT_PASS" -ge 1 ]]; then
  OUTCOME="pass"
  SEEDS_FAILED=0
  RATE="0.0000"
  FAILING_SEEDS_JSON="[]"
elif [[ "$TEST_EXIT" -ne 0 && -n "$ACTUAL_SEED" && "$HAS_RESULT_PASS" -eq 0 ]]; then
  OUTCOME="fail"
  SEEDS_FAILED=1
  RATE="1.0000"
  FAILING_SEEDS_JSON="$(jq -c -n --argjson s "$ACTUAL_SEED" '[$s]')"
else
  echo "" >&2
  if [[ "$TEST_EXIT" -eq 0 ]]; then
    echo "error: runner exited 0 but the harness RESULT line never appeared — no tests" >&2
    echo "       matched, or the RESULT emission moved or its format drifted." >&2
  elif [[ "$HAS_RESULT_PASS" -ge 1 ]]; then
    echo "error: RESULT line printed but the runner exited $TEST_EXIT — post-test failure" >&2
    echo "       (teardown error, sibling test). The run cannot be attributed." >&2
  else
    echo "error: harness crashed before emitting its seed banner or result line." >&2
  fi
  echo "       Nothing was measured. No record appended — the trend log is untouched." >&2
  echo "       Full output above." >&2
  if [[ "$TEST_EXIT" -ne 0 ]]; then
    exit "$TEST_EXIT"
  fi
  exit 1
fi

if [[ -z "$ACTUAL_SEED" ]]; then
  echo "" >&2
  echo "error: outcome \"$OUTCOME\" but no seed was captured — the seed banner regex" >&2
  echo "       matched nothing and no --seed was given (banner format drift?)." >&2
  echo "       No record appended — fix the banner/regex pairing, then re-measure." >&2
  exit 1
fi
EXTRA_JSON="$(jq -c -n --argjson stressSeed "$ACTUAL_SEED" --arg outcome "$OUTCOME" \
  '{ stressSeed: $stressSeed, outcome: $outcome }')"

RECORD="$(jq -c -n \
  --arg timestamp   "$TIMESTAMP" \
  --arg commit      "$COMMIT" \
  --arg script      "deep-stress" \
  --argjson seedCount   "$SEED_COUNT" \
  --argjson seedsFailed "$SEEDS_FAILED" \
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
echo "──────── measure-stress summary ────────"
echo "  context:      $CONTEXT"
echo "  commit:       $COMMIT"
echo "  host:         $HOST"
echo "  stressSeed:   $ACTUAL_SEED"
echo "  outcome:      $OUTCOME"
echo "  durationMs:   $DURATION_MS"
echo "  logFile:      $LOG_FILE"
echo ""

if [[ "$OUTCOME" == "fail" ]]; then
  echo "──────── failure replay command ────────"
  echo "  STRESS_SEED=$ACTUAL_SEED pnpm exec vitest run $TEST_FILE  # in $APP_DIR"
  echo ""
fi

exit "$TEST_EXIT"
