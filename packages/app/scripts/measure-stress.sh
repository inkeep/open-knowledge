#!/usr/bin/env bash
#
# measure-stress.sh — ad-hoc sampling wrapper for server-authoritative-stress.test.ts
#
# Purpose
# -------
# Sample the architectural CRDT residual in the 5-client × 30s stress load
# scenario, with optional seed replay for triaging known-bad seeds, and append
# a structured JSONL record to
# specs/2026-04-16-bridge-correctness/evidence/residual-measurements.jsonl.
#
# Unlike measure-fuzz.sh (which sweeps N seeds in one run), this script is
# typically run one seed at a time — the underlying test is a 30-second
# multi-client convergence scenario, not a seeded-PBT loop. Seed replay is
# powered by the STRESS_SEED env override shipped in PR #212.
#
# Usage
# -----
#   bash scripts/measure-stress.sh --seed 42 --context "pre-PR-218 baseline"
#   bash scripts/measure-stress.sh --context "investigate 2026-04 rate shift"
#   pnpm run measure:stress --seed 1776381158793 --context "reproduce CI flake"
#
# Flags
# -----
#   --seed N          STRESS_SEED override. Default: omitted (test uses its
#                     internal Date.now() seed, recorded in the JSONL).
#   --context "..."   Free-text annotation for the JSONL record's context
#                     field (required).
#
# The underlying test's run duration is hard-coded to 30s internally. There is
# no run-time override flag for duration — the script enforces no knob that
# the test does not honor, per feedback-driven principle "no config that lies."
# If a future test parameterizes duration, add a flag here that sets the
# corresponding env var.
#
# Output
# ------
# Same JSONL schema as measure-fuzz.sh, with these differences:
#   - script:       "deep-stress"
#   - seedCount:    1  (one run per invocation)
#   - seedsFailed:  0 on pass, 1 on fail
#   - outcome:      "pass" | "fail" (inside extra)
#   - failingSeeds: [<seed>] on a real test failure where the seed banner
#                   was captured; [] on pass
#   - extra:        { stressSeed: <seed>, outcome: "pass"|"fail" }
#
# A run that measured nothing appends nothing: harness crashed before its
# banner, RESULT line missing on a zero exit, RESULT-pass contradicted by
# a non-zero exit, or no attributable seed — each aborts with a diagnostic
# and a non-zero exit, leaving the log untouched.
#
# See measure-fuzz.sh for the full schema + query pattern examples.

set -euo pipefail

# Shared helpers — see measure-fuzz.sh for the rationale.
# shellcheck source=./_measure-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_measure-lib.sh"

# ── Defaults ───────────────────────────────────────────────────────────────
SEED=""
CONTEXT=""

# ── Arg parsing ────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --seed)
      SEED="$2"; shift 2 ;;
    --context)
      CONTEXT="$2"; shift 2 ;;
    -h|--help)
      # Print the full header comment block up to the first blank-comment-
      # line sentinel `^$`. Sentinel-based extraction so --help stays
      # accurate as the header grows.
      sed -n '1,/^$/p' "$0"; exit 0 ;;
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

# Validate --seed via shared helper (see _measure-lib.sh).
if [[ -n "$SEED" ]]; then
  assert_numeric_flag "--seed" "$SEED" --signed
fi

# ── Environment ────────────────────────────────────────────────────────────
require_jq
REPO_ROOT="$(resolve_repo_root)"

APP_DIR="$REPO_ROOT/packages/app"
LOG_DIR="$REPO_ROOT/specs/2026-04-16-bridge-correctness/evidence"
LOG_FILE="$LOG_DIR/residual-measurements.jsonl"
TEST_FILE="tests/stress/server-authoritative-stress.test.ts"

mkdir -p "$LOG_DIR"

# ── Compose test invocation ────────────────────────────────────────────────
if [[ -n "$SEED" ]]; then
  export STRESS_SEED="$SEED"
  echo "[measure-stress] seed-replay mode: STRESS_SEED=$SEED"
else
  unset STRESS_SEED
  echo "[measure-stress] fresh seed (test picks via Date.now())"
fi

# ── Capture metadata at run start ──────────────────────────────────────────
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
COMMIT="$(git rev-parse --short HEAD)"
INVOKED_BY="${USER:-unknown}"
NODE_VERSION="$(node --version 2>/dev/null || echo unknown)"

HOST="$(detect_host)"

# ── Run test, capture output ───────────────────────────────────────────────
OUT_FILE="$(mktemp -t measure-stress-XXXXXX)"
trap 'rm -f "$OUT_FILE"' EXIT

echo "[measure-stress] running $TEST_FILE ..."

START_MS="$(epoch_ms)"

TEST_EXIT=0
(
  # Explicit exit: errexit is suppressed inside a piped compound, so a bare
  # failed cd would let the test run from the wrong cwd.
  cd "$APP_DIR" || exit 1
  # --conditions development resolves workspace deps from source exports
  # instead of an unbuilt dist/ (the fresh-worktree state) — without it the
  # run dies on missing build artifacts.
  pnpm exec vitest run "$TEST_FILE" 2>&1
) | tee "$OUT_FILE" || TEST_EXIT=$?

END_MS="$(epoch_ms)"
DURATION_MS=$(( END_MS - START_MS ))

# ── Parse results ──────────────────────────────────────────────────────────
# Two stable signals the stress test emits:
#
#   (1) Startup banner — printed BEFORE any setup work in the test body:
#         [server-authoritative stress] seed=<n>
#         [server-authoritative stress] seed=<n> (replay)
#       Emitted before the loop, so present unless a crash precedes the
#       banner. Primary source for stressSeed.
#
#   (2) Machine-parseable result line — printed AFTER all assertions pass:
#         [stress] RESULT outcome=pass seed=<n> edits=<n> convergenceMs=<n>
#       Written via `process.stdout.write`, stdout-only (never stderr), so
#       the grep below is unambiguous and insensitive to runner output drift.
#
# Parsing the test's own structured lines — not the runner's human summary —
# decouples the script from the runner's output format.

ACTUAL_SEED_BANNER="$(grep -oE '\[server-authoritative stress\] seed=[0-9]+' "$OUT_FILE" \
  | awk -F= '{print $2}' | head -1 || true)"
# Secondary source: the RESULT line carries the same seed. It is emitted only on
# a pass, so it cannot replace the banner for crash runs, but it keeps a passing
# run attributable if the banner is ever lost again.
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

# Machine-parseable result line — only emitted on a successful run (after
# all assertions pass). Absence = test failed or crashed before reaching
# the summary.
HAS_RESULT_PASS="$(grep -cE '^\[stress\] RESULT outcome=pass' "$OUT_FILE" || true)"
HAS_RESULT_PASS="${HAS_RESULT_PASS:-0}"

# Classify outcome:
#   "pass"  — test exit 0 AND the RESULT line printed
#   "fail"  — test exit != 0 AND the seed banner printed AND no RESULT
#             line (real test failure with a known seed for replay)
#   anything else — not a measurement. Either the harness never reached
#             its seed banner (setup failure, OOM, pre-banner crash), or
#             the evidence is contradictory: exit 0 without a RESULT line
#             (no tests matched, or the RESULT emission moved or its
#             format drifted), or a RESULT line with a non-zero exit
#             (post-test teardown failure). Abort without appending so
#             the trend log stays a record of true measurements.
#
# Note: on a successful run, exit code alone is not sufficient — a runner
# test that ran but reported an assertion failure still has exit != 0.
# A pass requires both the RESULT line AND exit 0; they corroborate.
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

# ── Compose extra (script-specific fields) ─────────────────────────────────
# SCHEMA.md promises a replayable stressSeed in every appended record. A
# classified run can reach this point seedless only when the banner regex
# matched nothing and no --seed pinned a value (banner format drift) — that
# run is unattributable, so abort rather than record a null seed.
if [[ -z "$ACTUAL_SEED" ]]; then
  echo "" >&2
  echo "error: outcome \"$OUTCOME\" but no seed was captured — the seed banner regex" >&2
  echo "       matched nothing and no --seed was given (banner format drift?)." >&2
  echo "       No record appended — fix the banner/regex pairing, then re-measure." >&2
  exit 1
fi
EXTRA_JSON="$(jq -c -n --argjson stressSeed "$ACTUAL_SEED" --arg outcome "$OUTCOME" \
  '{ stressSeed: $stressSeed, outcome: $outcome }')"

# ── Compose JSONL record ───────────────────────────────────────────────────
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

# ── Summary ────────────────────────────────────────────────────────────────
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
