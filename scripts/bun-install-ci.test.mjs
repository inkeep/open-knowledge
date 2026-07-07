/**
 * Test contract for `bun-install-ci.sh`, the CI-side retry wrapper around
 * `bun install --frozen-lockfile`.
 *
 * Why this wrapper exists.
 *   Bun has no built-in retry for tarball-fetch / tarball-extract failures
 *   (tracker: oven-sh/bun#26879 — open as of 2026-05). A single transient
 *   registry/CDN hiccup during the network phase aborts the whole install
 *   with exit 1 and turns a CI job red on noise.
 *
 *   The wrapper retries the install on failure with backoff and emits
 *   GitHub Actions workflow-command annotations (::warning:: per retry,
 *   ::error:: on final exhaustion) so the noise is visible without
 *   masking persistent failures.
 *
 * What this test pins.
 *   1. Happy path — first attempt succeeds: wrapper exits 0 with no
 *      ::warning:: / ::error:: annotations. Common path stays clean.
 *   2. Flake recovery — first attempt fails with a tarball-error
 *      signature, second succeeds: wrapper exits 0 with exactly one
 *      ::warning::. This is the bug class we are absorbing.
 *   3. Exhaustion — all BUN_INSTALL_MAX_ATTEMPTS fail: wrapper exits
 *      non-zero with (N - 1) ::warning:: annotations followed by one
 *      ::error::. Bounded retry, no silent masking.
 *   4. Input validation — non-integer BUN_INSTALL_MAX_ATTEMPTS or
 *      BUN_INSTALL_RETRY_SLEEP_BASE exits 64 (EX_USAGE) in milliseconds.
 *
 * How the stub works.
 *   The wrapper consults `$BUN_INSTALL_CMD` (default: `bun install
 *   --frozen-lockfile`). The test sets `BUN_INSTALL_CMD` to a stub bash
 *   script that records each invocation against a counter file and
 *   exits per the behavior named in `$TEST_STUB_BEHAVIOR`. This lets us
 *   exercise the wrapper's control flow without touching a real registry.
 *
 *   `BUN_INSTALL_RETRY_SLEEP_BASE=0` is passed to keep test iterations
 *   instant; in prod the wrapper sleeps with exponential backoff between
 *   attempts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(SCRIPT_DIR, 'bun-install-ci.sh');

// Track stub tmp dirs created by each test so afterEach can clean them up.
// Dev machines accumulate /tmp/bun-install-ci-test-* otherwise; CI runners
// are ephemeral so cleanup is non-load-bearing there.
const cleanupDirs = [];

/**
 * Create a temp dir with an attempt-count file and a stub script that the
 * wrapper will invoke via `$BUN_INSTALL_CMD`. Behavior is selected at
 * invocation time via `$TEST_STUB_BEHAVIOR`.
 */
function setupStub() {
  const tmp = mkdtempSync(join(tmpdir(), 'bun-install-ci-test-'));
  cleanupDirs.push(tmp);
  const counterFile = join(tmp, 'attempt-count');
  const stubPath = join(tmp, 'stub-bun-install.sh');
  writeFileSync(counterFile, '0', 'utf8');
  writeFileSync(
    stubPath,
    `#!/usr/bin/env bash
set -euo pipefail
attempt=$(cat "$TEST_COUNTER_FILE")
attempt=$((attempt + 1))
echo "$attempt" > "$TEST_COUNTER_FILE"
case "$TEST_STUB_BEHAVIOR" in
  always-pass)
    echo "stub: pass on attempt $attempt"
    exit 0
    ;;
  fail-then-pass)
    if [ "$attempt" -le 1 ]; then
      echo 'error: Fail extracting tarball for "@img/sharp-libvips-linux-x64"' >&2
      exit 1
    fi
    echo "stub: pass on attempt $attempt"
    exit 0
    ;;
  always-fail)
    echo 'error: Fail extracting tarball for "@img/sharp-libvips-linux-x64"' >&2
    exit 1
    ;;
  always-fail-code)
    # Generic-passthrough probe — exit with whatever code the test supplies
    # in TEST_FAIL_EXIT_CODE (default 1). Used by the passthrough test that
    # proves \`exit "$rc"\` is not hardcoded.
    echo "stub: synthetic non-1 failure (exit \${TEST_FAIL_EXIT_CODE:-1})" >&2
    exit "\${TEST_FAIL_EXIT_CODE:-1}"
    ;;
  hang-then-pass)
    # Attempt 1 blocks far past the wrapper's BUN_INSTALL_ATTEMPT_TIMEOUT so
    # the watchdog must kill it; attempt 2 succeeds. Trap TERM to exit promptly
    # (and reap the inner sleep) so the SIGTERM path resolves cleanly.
    if [ "$attempt" -le 1 ]; then
      sleep "\${TEST_HANG_SECONDS:-30}" & sleep_pid=$!
      trap 'kill "$sleep_pid" 2>/dev/null; exit 143' TERM
      wait "$sleep_pid"
      exit 0
    fi
    echo "stub: pass on attempt $attempt"
    exit 0
    ;;
  always-hang)
    # Every attempt hangs until the watchdog SIGTERMs it.
    sleep "\${TEST_HANG_SECONDS:-30}" & sleep_pid=$!
    trap 'kill "$sleep_pid" 2>/dev/null; exit 143' TERM
    wait "$sleep_pid"
    exit 0
    ;;
  always-hang-ignore-term)
    # Ignore SIGTERM so the watchdog must escalate to SIGKILL. Loop short
    # sleeps (rather than one long sleep) so the orphan the uncatchable SIGKILL
    # leaves behind is bounded to ~1s instead of the full hang duration.
    trap '' TERM
    while :; do sleep 1; done
    ;;
  *)
    echo "stub: unknown TEST_STUB_BEHAVIOR='$TEST_STUB_BEHAVIOR'" >&2
    exit 2
    ;;
esac
`,
    'utf8',
  );
  chmodSync(stubPath, 0o755);
  return { tmp, counterFile, stubPath };
}

function runWrapper({
  behavior,
  stubPath,
  counterFile,
  maxAttempts = 3,
  retrySleepBase = 0,
  extraEnv = {},
  timeoutMs,
}) {
  return spawnSync('bash', [WRAPPER], {
    env: {
      ...process.env,
      BUN_INSTALL_CMD: stubPath,
      BUN_INSTALL_MAX_ATTEMPTS: String(maxAttempts),
      BUN_INSTALL_RETRY_SLEEP_BASE: String(retrySleepBase),
      TEST_STUB_BEHAVIOR: behavior,
      TEST_COUNTER_FILE: counterFile,
      ...extraEnv,
    },
    encoding: 'utf8',
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });
}

function combinedOutput(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function countMatches(haystack, needle) {
  return (haystack.match(new RegExp(needle, 'g')) ?? []).length;
}

describe('bun-install-ci.sh — retry wrapper for `bun install --frozen-lockfile`', () => {
  afterEach(() => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; ignore EBUSY/ENOENT.
      }
    }
  });

  test('wrapper script exists and is executable', () => {
    if (!existsSync(WRAPPER)) {
      throw new Error(
        `expected wrapper at ${WRAPPER}; not present.\n` +
          `(RED state — implementation lands in Task 4 of fix-sharp-tarball-flake.)`,
      );
    }
    const stat = statSync(WRAPPER);
    // Owner execute bit at minimum; CI runners need exec perms either way.
    expect(stat.mode & 0o100).toBeGreaterThan(0);
  });

  test('happy path: first-attempt success → exit 0, no annotations', () => {
    const ctx = setupStub();
    const result = runWrapper({ ...ctx, behavior: 'always-pass' });

    expect(result.status).toBe(0);
    const out = combinedOutput(result);
    expect(out).not.toContain('::warning::');
    expect(out).not.toContain('::error::');
  });

  test('flake recovery: tarball error then success on attempt 2 → exit 0 with exactly one ::warning::', () => {
    const ctx = setupStub();
    const result = runWrapper({ ...ctx, behavior: 'fail-then-pass' });

    expect(result.status).toBe(0);
    const out = combinedOutput(result);
    expect(countMatches(out, '::warning::')).toBe(1);
    expect(out).not.toContain('::error::');
  });

  test('exhaustion: all 3 attempts fail → exit 1 (passthrough) with 2 ::warning::s + 1 ::error::', () => {
    const ctx = setupStub();
    const result = runWrapper({ ...ctx, behavior: 'always-fail', maxAttempts: 3 });

    // Stub exits 1; wrapper does `exit "$rc"` so the install's exit code
    // passes through. Pin this contract — a future change that wraps the
    // exit (e.g., always-1 on any failure regardless of underlying rc)
    // would silently lose downstream's ability to distinguish bun's
    // exit codes.
    expect(result.status).toBe(1);
    const out = combinedOutput(result);
    expect(countMatches(out, '::warning::')).toBe(2);
    expect(countMatches(out, '::error::')).toBe(1);
  });

  // The exhaustion test above asserts exit 1, but stub exits 1 — a
  // regression that replaced `exit "$rc"` with a hardcoded `exit 1`
  // would still pass it. This test pins the passthrough as GENERIC by
  // stubbing a non-1 exit code (42 — arbitrary, picked to avoid
  // collision with common exit codes like 0/1/2/64/127) and asserting
  // the wrapper bubbles it up unchanged. MAX_ATTEMPTS=1 keeps the test
  // fast (no retry sleep iterations).
  test('exit-code passthrough is generic: stub exit 42 → wrapper exit 42', () => {
    const ctx = setupStub();
    const result = runWrapper({
      ...ctx,
      behavior: 'always-fail-code',
      maxAttempts: 1,
      extraEnv: { TEST_FAIL_EXIT_CODE: '42' },
    });

    expect(result.status).toBe(42);
  });

  // MAX_ATTEMPTS=1 corner. Two branches the other tests don't exercise:
  //   (a) singular noun on the ::error:: annotation ("attempt" not
  //       "attempts"), driven by the small bash ternary at the exhaustion
  //       point;
  //   (b) zero-warning exhaustion path — the retry loop body that emits
  //       ::warning:: never runs because attempt 1 hits the >= check on
  //       its first pass.
  // Without this test, refactoring the exhaustion block could regress
  // either branch silently.
  test('MAX_ATTEMPTS=1: single attempt fails → exit 1, 0 ::warning::s, 1 ::error:: with singular noun', () => {
    const ctx = setupStub();
    const result = runWrapper({ ...ctx, behavior: 'always-fail', maxAttempts: 1 });

    expect(result.status).toBe(1);
    const out = combinedOutput(result);
    expect(countMatches(out, '::warning::')).toBe(0);
    expect(countMatches(out, '::error::')).toBe(1);
    // Singular noun. "1 attempts" would be ungrammatical; the ternary at
    // the exhaustion point picks "attempt" when MAX is 1.
    expect(out).toMatch(/after 1 attempt\b/);
    expect(out).not.toMatch(/after 1 attempts\b/);
  });

  // Input validation. The previous loop used `[ -ge ]` to detect exhaustion,
  // which silently returns false on non-integer rhs and produced an unbounded
  // retry loop when the knob was misconfigured. The wrapper now validates env
  // at entry and exits 64 (EX_USAGE). The 2 s timeout below is the safety
  // net: if validation regresses to the prior shape, the always-fail stub
  // would loop forever and the test would time out instead of asserting.
  test('input validation: non-integer BUN_INSTALL_MAX_ATTEMPTS exits 64 in milliseconds', () => {
    const ctx = setupStub();
    const result = runWrapper({
      ...ctx,
      behavior: 'always-fail',
      extraEnv: { BUN_INSTALL_MAX_ATTEMPTS: 'abc' },
      timeoutMs: 2000,
    });

    expect(result.signal).toBeNull();
    expect(result.status).toBe(64);
    const out = combinedOutput(result);
    expect(out).toContain('::error::');
    expect(out).toContain('BUN_INSTALL_MAX_ATTEMPTS');
  });

  test('input validation: MAX_ATTEMPTS=0 exits 64 (the bash `[ 1 -ge 0 ]` corner)', () => {
    const ctx = setupStub();
    const result = runWrapper({
      ...ctx,
      behavior: 'always-fail',
      extraEnv: { BUN_INSTALL_MAX_ATTEMPTS: '0' },
      timeoutMs: 2000,
    });

    expect(result.signal).toBeNull();
    expect(result.status).toBe(64);
    // Match the sibling non-integer test's annotation-content assertions
    // so both validation cases pin the same shape — exit code alone would
    // miss a regression where the script returns 64 but prints nothing.
    const out = combinedOutput(result);
    expect(out).toContain('::error::');
    expect(out).toContain('BUN_INSTALL_MAX_ATTEMPTS');
  });

  test('input validation: non-integer BUN_INSTALL_RETRY_SLEEP_BASE exits 64', () => {
    const ctx = setupStub();
    const result = runWrapper({
      ...ctx,
      behavior: 'always-fail',
      extraEnv: { BUN_INSTALL_RETRY_SLEEP_BASE: '1.5' },
      timeoutMs: 2000,
    });

    expect(result.signal).toBeNull();
    expect(result.status).toBe(64);
    const out = combinedOutput(result);
    // Match both sibling validation tests' shape — assert the ::error::
    // annotation as well as the env-var name. A regression that drops
    // the ::error:: emit but keeps the exit 64 would pass an env-var-only
    // assertion and the operator-facing CI annotation would silently
    // disappear.
    expect(out).toContain('::error::');
    expect(out).toContain('BUN_INSTALL_RETRY_SLEEP_BASE');
  });

  // Per-attempt timeout watchdog. A bun install can HANG (not fail-fast) on a
  // cold cache; a retry-on-exit-only wrapper never engages and the hang rides
  // the GitHub job to its `timeout-minutes` cap, which cancels (no retry). The
  // watchdog converts a hang into a retryable exit-124. The 20s spawnSync
  // safety net below means a watchdog regression (never kills) fails the test
  // by timeout instead of hanging the suite.
  //
  // BUN_INSTALL_ATTEMPT_TIMEOUT is 3s (not 1s) deliberately: the *passing*
  // attempt must finish well inside the budget even on a saturated runner, or
  // the watchdog kills it and the warning count flakes. 3s gives ~3x headroom
  // over the instant stub while the 30s hang still trips the budget reliably.
  test('timeout recovery: attempt 1 hangs (killed by watchdog) then attempt 2 passes → exit 0 with one timeout ::warning::', () => {
    const ctx = setupStub();
    const result = runWrapper({
      ...ctx,
      behavior: 'hang-then-pass',
      maxAttempts: 3,
      extraEnv: { BUN_INSTALL_ATTEMPT_TIMEOUT: '3', BUN_INSTALL_KILL_GRACE: '1' },
      timeoutMs: 20000,
    });

    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    const out = combinedOutput(result);
    expect(countMatches(out, '::warning::')).toBe(1);
    expect(out).toContain('timed out after 3s');
    expect(out).not.toContain('::error::');
  }, 30000); // Bun per-test timeout > the 3s budget + retries + the 20s spawnSync net

  test('timeout exhaustion: every attempt hangs → exit 124 with (N-1) ::warning::s + 1 ::error::', () => {
    const ctx = setupStub();
    const result = runWrapper({
      ...ctx,
      behavior: 'always-hang',
      maxAttempts: 2,
      extraEnv: { BUN_INSTALL_ATTEMPT_TIMEOUT: '3', BUN_INSTALL_KILL_GRACE: '1' },
      timeoutMs: 20000,
    });

    // 124 is the GNU `timeout` convention; the wrapper normalizes the 143/137
    // a watchdog kill produces so downstream sees a stable "timed out" code.
    expect(result.signal).toBeNull();
    expect(result.status).toBe(124);
    const out = combinedOutput(result);
    expect(countMatches(out, '::warning::')).toBe(1);
    expect(countMatches(out, '::error::')).toBe(1);
    expect(out).toContain('timed out after 3s');
  }, 30000); // 2 attempts x 3s budget exceeds Bun's 5s default per-test timeout

  // The SIGTERM-responsive hang tests above exercise the graceful kill. This
  // one ignores SIGTERM so the watchdog must escalate to SIGKILL after the
  // grace window — proving the escalation fires and 137 also normalizes to 124.
  test('SIGKILL escalation: a SIGTERM-ignoring hang is force-killed and normalized to exit 124', () => {
    const ctx = setupStub();
    const result = runWrapper({
      ...ctx,
      behavior: 'always-hang-ignore-term',
      maxAttempts: 1,
      extraEnv: {
        BUN_INSTALL_ATTEMPT_TIMEOUT: '3',
        BUN_INSTALL_KILL_GRACE: '1',
      },
      timeoutMs: 20000,
    });

    expect(result.signal).toBeNull();
    expect(result.status).toBe(124);
    expect(countMatches(combinedOutput(result), '::error::')).toBe(1);
  }, 30000); // 3s budget + 1s grace + SIGKILL can edge past Bun's 5s default

  // Escape hatch: BUN_INSTALL_ATTEMPT_TIMEOUT=0 disables the watchdog and runs
  // the install on the direct (non-backgrounded) path. Happy install still
  // succeeds cleanly — pins that disabling the watchdog doesn't perturb the
  // common path.
  test('timeout disabled (BUN_INSTALL_ATTEMPT_TIMEOUT=0): direct path, happy install exits 0 with no annotations', () => {
    const ctx = setupStub();
    const result = runWrapper({
      ...ctx,
      behavior: 'always-pass',
      extraEnv: { BUN_INSTALL_ATTEMPT_TIMEOUT: '0' },
    });

    expect(result.status).toBe(0);
    const out = combinedOutput(result);
    expect(out).not.toContain('::warning::');
    expect(out).not.toContain('::error::');
  });

  // Direct path (TIMEOUT=0) must still retry on ordinary install failure.
  // Without this test, a refactor that drops the `|| rc=$?` from
  // `run_install "$@" || rc=$?` (turning it into `run_install "$@"; rc=$?`)
  // would let `set -e` abort the wrapper on the first non-zero install exit
  // and silently lose retry behavior for users running with the watchdog
  // disabled. The annotation must name "failed (exit 1)" rather than
  // "timed out" so the wrong-branch regression (timed branch dispatched
  // while TIMEOUT=0) also surfaces here.
  test('timeout disabled + failure: direct path still retries and recovers', () => {
    const ctx = setupStub();
    const result = runWrapper({
      ...ctx,
      behavior: 'fail-then-pass',
      maxAttempts: 2,
      extraEnv: { BUN_INSTALL_ATTEMPT_TIMEOUT: '0' },
    });

    expect(result.status).toBe(0);
    const out = combinedOutput(result);
    expect(countMatches(out, '::warning::')).toBe(1);
    expect(out).toContain('failed (exit 1)');
    expect(out).not.toContain('timed out');
    expect(out).not.toContain('::error::');
  });

  test('input validation: non-integer BUN_INSTALL_ATTEMPT_TIMEOUT exits 64', () => {
    const ctx = setupStub();
    const result = runWrapper({
      ...ctx,
      behavior: 'always-pass',
      extraEnv: { BUN_INSTALL_ATTEMPT_TIMEOUT: 'soon' },
      timeoutMs: 2000,
    });

    expect(result.signal).toBeNull();
    expect(result.status).toBe(64);
    const out = combinedOutput(result);
    expect(out).toContain('::error::');
    expect(out).toContain('BUN_INSTALL_ATTEMPT_TIMEOUT');
  });

  test('input validation: non-integer BUN_INSTALL_KILL_GRACE exits 64', () => {
    const ctx = setupStub();
    const result = runWrapper({
      ...ctx,
      behavior: 'always-pass',
      extraEnv: { BUN_INSTALL_KILL_GRACE: '1.5' },
      timeoutMs: 2000,
    });

    expect(result.signal).toBeNull();
    expect(result.status).toBe(64);
    const out = combinedOutput(result);
    expect(out).toContain('::error::');
    expect(out).toContain('BUN_INSTALL_KILL_GRACE');
  });
});
