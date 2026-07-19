#!/usr/bin/env bash
#
# measure-fuzz.sh — ad-hoc sampling wrapper for bridge-convergence.fuzz.test.ts
#
# Purpose
# -------
# Sample the architectural CRDT residual rate across an arbitrary seed budget
# and append a structured JSONL record to
# specs/2026-04-16-bridge-correctness/evidence/residual-measurements.jsonl.
# The git history of that file IS the trend record — no CI automation exists
# to flag rate drift (accepted cost per NG6 in
# specs/2026-04-19-ci-signal-quality/SPEC.md).
#
# Usage
# -----
#   bash scripts/measure-fuzz.sh --seeds 1000 --context "pre-PR-218 baseline"
#   bash scripts/measure-fuzz.sh --seed-replay 1776559905522 --context "reproduce PR #206 failing seed"
#   bun run measure:fuzz --seeds 100 --context "investigate fuzz rate shift"
#
# Flags
# -----
#   --seeds N          Total seed budget (default: 1000 — matches AGENTS.md
#                      §Measurement scripts canonical example and the
#                      pre-merge bridge-touching-PR convention). Maps to
#                      BRIDGE_FUZZ_SEEDS=N on the test invocation.
#   --seed-replay SEED Single-seed replay mode — invokes with
#                      STRESS_FUZZ_SEED=SEED. Overrides --seeds.
#   --context "..."    Free-text annotation for the JSONL record's context
#                      field (required — this is what lets future readers
#                      understand WHY a measurement was taken).
#
# Output
# ------
# On success:
#   - Appends one JSONL record to
#     specs/2026-04-16-bridge-correctness/evidence/residual-measurements.jsonl
#   - Prints human-readable summary to stdout (seed count, pass/fail, rate,
#     failing seeds with replay commands).
# On test failure:
#   - Still appends JSONL record (failure is a valid measurement).
#   - Exit code matches the test runner (non-zero).
# On a non-measurement (RESULT line never emitted, or a clean-sweep RESULT
# contradicted by a non-zero runner exit):
#   - Appends NOTHING — a run whose evidence is missing or self-
#     contradictory is not a measurement. Exits non-zero with a diagnostic.
#
# JSONL schema (see specs/2026-04-16-bridge-correctness/evidence/residual-measurements-SCHEMA.md)
# ---------------------------------------------------------------------------
#   {
#     "timestamp":   "2026-04-19T14:23:15Z",   // ISO 8601 UTC at run start
#     "commit":      "abc1234",                // short git SHA
#     "script":      "deep-fuzz",              // fixed for this script
#     "seedCount":   500,
#     "seedsFailed": 23,
#     "convergedLate": 0,                      // seeds that settled within tolerance late
#     "rate":        0.046,                    // seedsFailed / seedCount
#     "invokedBy":   "ci-user",                // $USER or CI identifier
#     "context":     "pre-PR-218 baseline",
#     "failingSeeds":[1776559905522],
#     "durationMs":  8912000,
#     "host":        "local-macos",
#     "bunVersion":  "1.3.11",
#     "extra":       { "outcome": "pass",      // "pass" | "fail"
#                      "failClasses": [] }     // per-failing-seed oracle class
#   }                                          //   [{seed, class}, ...]
#
# outcome field (in extra)
# ------------------------
#   "pass"  — RESULT line emitted, seedsFailed == 0, runner exit 0
#   "fail"  — RESULT line emitted, seedsFailed >= 1 (replayable seeds in
#             failingSeeds array)
#   A run whose RESULT line never appeared (setup failure, OOM, worker
#   death) — or whose clean-sweep RESULT is contradicted by a non-zero
#   runner exit — aborts without appending. Appended records carry only
#   "pass" | "fail".
#
# Query patterns (same as script header for discoverability via `head`)
# ---------------------------------------------------------------------
#   # 7-day rolling average rate across all runs:
#   jq -s 'sort_by(.timestamp) | map(select(.timestamp > (now - 7*86400 | todate))) | [.[].rate] | add/length' \
#     specs/2026-04-16-bridge-correctness/evidence/residual-measurements.jsonl
#
#   # Recent spikes (>5% rate):
#   jq 'select(.rate > 0.05)' specs/2026-04-16-bridge-correctness/evidence/residual-measurements.jsonl
#
#   # Summary by script:
#   jq -s 'group_by(.script) | map({script: .[0].script, runs: length, avgRate: (map(.rate) | add/length)})' \
#     specs/2026-04-16-bridge-correctness/evidence/residual-measurements.jsonl

set -euo pipefail

# Shared helpers — keeps host detection, epoch-ms resolution, JSONL
# append serialization, and numeric-flag validation in one place. See
# `_measure-lib.sh` for each function's contract.
# shellcheck source=./_measure-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_measure-lib.sh"

# ── Defaults ───────────────────────────────────────────────────────────────
SEEDS=1000
SEED_REPLAY=""
CONTEXT=""

# ── Arg parsing ────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --seeds)
      SEEDS="$2"; shift 2 ;;
    --seed-replay)
      SEED_REPLAY="$2"; shift 2 ;;
    --context)
      CONTEXT="$2"; shift 2 ;;
    -h|--help)
      # Print the full header comment block — from line 1 through the
      # first blank-comment-line sentinel `^$` after the `Query patterns`
      # heading. Using a sentinel (rather than a fixed line range) keeps
      # --help accurate when the header grows.
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

# Validate numeric inputs via shared helper. Non-numeric inputs would
# export a non-numeric env to the child `bun test` and silently coerce
# to NaN→1 at the PRNG layer.
assert_numeric_flag "--seeds" "$SEEDS"
if [[ -n "$SEED_REPLAY" ]]; then
  assert_numeric_flag "--seed-replay" "$SEED_REPLAY" --signed
fi

# ── Environment ────────────────────────────────────────────────────────────
require_jq
REPO_ROOT="$(resolve_repo_root)"

APP_DIR="$REPO_ROOT/packages/app"
LOG_DIR="$REPO_ROOT/specs/2026-04-16-bridge-correctness/evidence"
LOG_FILE="$LOG_DIR/residual-measurements.jsonl"
TEST_FILE="tests/stress/bridge-convergence.fuzz.test.ts"

mkdir -p "$LOG_DIR"

# ── Compose test invocation ────────────────────────────────────────────────
if [[ -n "$SEED_REPLAY" ]]; then
  export STRESS_FUZZ_SEED="$SEED_REPLAY"
  unset BRIDGE_FUZZ_SEEDS
  echo "[measure-fuzz] seed-replay mode: STRESS_FUZZ_SEED=$SEED_REPLAY"
else
  export BRIDGE_FUZZ_SEEDS="$SEEDS"
  unset STRESS_FUZZ_SEED
  echo "[measure-fuzz] sampling mode: BRIDGE_FUZZ_SEEDS=$SEEDS"
fi

# ── Capture metadata at run start ──────────────────────────────────────────
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
COMMIT="$(git rev-parse --short HEAD)"
INVOKED_BY="${USER:-unknown}"
BUN_VERSION="$(bun --version 2>/dev/null || echo unknown)"

HOST="$(detect_host)"

# ── Run test, capture output ───────────────────────────────────────────────
OUT_FILE="$(mktemp -t measure-fuzz-XXXXXX)"
trap 'rm -f "$OUT_FILE"' EXIT

echo "[measure-fuzz] running $TEST_FILE ..."

START_MS="$(epoch_ms)"

# We want the test to run but don't want its exit code to kill the script —
# a test failure is a valid measurement; the classifier below decides what,
# if anything, gets recorded.
TEST_EXIT=0
(
  # Explicit exit: errexit is suppressed inside a piped compound, so a bare
  # failed cd would let bun test run from the wrong cwd.
  cd "$APP_DIR" || exit 1
  # --conditions development resolves workspace deps from source exports
  # instead of an unbuilt dist/ (the fresh-worktree state) — without it the
  # run dies on missing build artifacts.
  bun test --conditions development "$TEST_FILE" 2>&1
) | tee "$OUT_FILE" || TEST_EXIT=$?

END_MS="$(epoch_ms)"
DURATION_MS=$(( END_MS - START_MS ))

# ── Parse results ──────────────────────────────────────────────────────────
# Preferred signal: the machine-parseable RESULT line emitted by
# `bridge-convergence.fuzz.test.ts`'s after-all hook:
#   [fuzz] RESULT seeds=<n> passed=<n> failed=<n> failingSeeds=[<s1>,<s2>,...]
# Written via `process.stdout.write`, stdout-only. Parsing this decouples
# the script from bun's human-readable `N pass / N fail` format (which is
# fragile to bun output drift and stderr conflation via 2>&1). Mirrors
# `measure-stress.sh`'s RESULT-line strategy for sibling-script symmetry.
#
# When RESULT is missing the test crashed before the after-all hook could
# run — the classifier below aborts the script without appending.

# Optional appended field (newer harness): converged-late count — seeds that
# exhausted the convergence budget but settled within tolerance. Counted as
# passes by the harness; recorded here as a perf signal.
# (`.*` not `[^\n]*`: grep is line-oriented so `.` cannot cross a newline,
# and in POSIX ERE `[^\n]` is a bracket expression excluding literal `\`/`n`
# — it stops at the `n` in `failingSeeds` and the anchor never reaches the
# appended fields on GNU grep.)
CONVERGED_LATE="$(grep -oE '^\[fuzz\] RESULT .*convergedLate=[0-9]+' "$OUT_FILE" | grep -oE 'convergedLate=[0-9]+' | tail -1 | cut -d= -f2 || true)"
CONVERGED_LATE="${CONVERGED_LATE:-0}"

# Optional appended field (newer harness): per-failing-seed oracle class —
# `failClasses=[<seed>:<class>,...]` where class is one of the harness's
# failure classes (content-preservation | oracle-e | convergence-stalled
# | bridge-invariant | byte-budget | origin | setup | other). Parsed into
# extra.failClasses so trend-record readers can attribute each failure to an
# oracle without a manual seed replay. Empty (or absent, on an older harness)
# parses to [].
FAIL_CLASSES_RAW="$(grep -oE '^\[fuzz\] RESULT .*failClasses=\[[0-9a-z:,-]*\]' "$OUT_FILE" | grep -oE 'failClasses=\[[0-9a-z:,-]*\]' | tail -1 | sed -E 's/^failClasses=\[//; s/\]$//' || true)"
FAIL_CLASSES_JSON="$(jq -c -n --arg raw "$FAIL_CLASSES_RAW" \
  '[ $raw | select(length > 0) | split(",")[] | split(":") | { seed: (.[0] | tonumber), class: (.[1] // "unknown") } ]')"

FUZZ_RESULT_LINE="$(grep -oE '^\[fuzz\] RESULT seeds=[0-9]+ passed=[0-9]+ failed=[0-9]+ failingSeeds=\[[0-9,]*\]' "$OUT_FILE" | tail -1 || true)"

# Outcome classifier (parallels measure-stress.sh's pass/fail):
#   "pass"  — RESULT line printed, failed=0, test exit 0
#   "fail"  — RESULT line printed, failed>=1 (real seed failures with
#             replayable seeds in failingSeeds array)
#   anything else — not a measurement: no RESULT line (the harness
#             crashed before afterAll could emit — setup failure, OOM,
#             worker death), or a clean-sweep RESULT contradicted by a
#             non-zero exit (post-RESULT teardown failure, sibling test).
#             Abort without appending so the trend log stays a record of
#             true measurements.
if [[ -n "$FUZZ_RESULT_LINE" ]]; then
  # Parse each field by name (not by position) via separate grep passes —
  # robust against future field reorderings (within reason — extending the
  # format still requires updating this regex, but position changes don't).
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

# rate with 4-digit precision. Use awk for portability; Bun/bash arithmetic
# doesn't do floats. Division-by-zero guard. `LC_ALL=C` is load-bearing —
# without it, awk's `%.4f` honors the current locale's LC_NUMERIC and emits
# `0,0460` on e.g. de_DE.UTF-8, producing invalid JSON when jq reads the
# record back. Force C locale for numeric formatting only.
if [[ "$SEED_COUNT" == "0" ]]; then
  RATE="0.0000"
else
  RATE="$(LC_ALL=C awk -v a="$SEEDS_FAILED" -v b="$SEED_COUNT" 'BEGIN{ printf "%.4f", a/b }')"
fi

# ── Compose extra (script-specific fields) ─────────────────────────────────
# `outcome` parallels measure-stress.sh so `jq 'select(.extra.outcome=="fail")'`
# works uniformly across both producers. Per SCHEMA.md, extending `extra`
# does not require a schema version bump — readers ignore unknown keys.
EXTRA_JSON="$(jq -c -n --arg outcome "$OUTCOME" --argjson failClasses "$FAIL_CLASSES_JSON" \
  '{ outcome: $outcome, failClasses: $failClasses }')"

# ── Compose JSONL record ───────────────────────────────────────────────────
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
  --arg bunVersion  "$BUN_VERSION" \
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
     bunVersion: $bunVersion,
     extra: $extra
   }')"

append_jsonl_atomic "$LOG_FILE" "$RECORD"

# ── Summary ────────────────────────────────────────────────────────────────
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
  # Derive replay commands from FAILING_SEEDS_JSON (authoritative) — always
  # populated from the parsed RESULT line, the only seed source.
  FAILING_SEEDS_LIST="$(jq -r '.[]' <<< "$FAILING_SEEDS_JSON" 2>/dev/null || true)"
  if [[ -n "$FAILING_SEEDS_LIST" ]]; then
    echo "──────── failing seed replay commands ────────"
    while IFS= read -r seed; do
      [[ -z "$seed" ]] && continue
      echo "  STRESS_FUZZ_SEED=$seed bun test --conditions development $TEST_FILE  # in $APP_DIR"
    done <<< "$FAILING_SEEDS_LIST"
    echo ""
  fi
fi

# Propagate test exit code so CI / users see failure signal.
exit "$TEST_EXIT"
