/**
 * Semantics pin for Bun's lifecycle-hook timeout behavior — the mechanism
 * the hook-timeout STOP rule (`tests/integration/hook-timeout-stop-rules.test.ts`)
 * depends on. Bun does not document hook timeout semantics at all
 * (bun.com/docs/test/lifecycle is silent on the default, on `--timeout`
 * applicability to hooks, and on the Jest-style per-hook second argument),
 * so these subprocess probes are the only authority. GREEN from day one by
 * design: this file guards against Bun semantic drift across upgrades and
 * documents the failure shape; the RED contract lives in the scan test.
 *
 * Pinned semantics (against whichever Bun binary runs this suite — a Bun
 * upgrade that changes hook-timeout behavior turns these probes RED):
 *   1. The invocation's `--timeout` budget governs `beforeAll`; a hook
 *      exceeding it fails the whole file AND produces the misleading
 *      downstream shape (unconditional `afterAll` cleanup on the
 *      never-assigned `server` throws an unrelated-looking TypeError).
 *   2. The per-hook second argument owns the hook budget — it overrides the
 *      invocation budget in BOTH directions (shrinks below it, and grants
 *      headroom above it). This is what makes `beforeAll(fn, TIMEOUT)`
 *      invocation-independent: even a hostile/absent `--timeout` cannot
 *      starve a protected boot hook.
 *
 * Why per-hook args (not `setDefaultTimeout` in the bunfig preload): probes
 * confirmed `setDefaultTimeout` DOES govern `beforeAll`, but it also raises
 * every per-TEST budget process-wide, converting real test hangs from 5s
 * failures into 30s ones. The per-hook argument raises only hook budgets and
 * leaves test budgets at the invocation's value.
 *
 * Determinism: the slow hook sleeps HOOK_SLEEP_MS (1500) against a
 * TIGHT_BUDGET_MS (500) budget — a 3x margin in the kill direction, and
 * sleep() can only over-sleep under load, never under-sleep, so the hook can
 * never finish inside the tight budget. In the headroom direction the
 * AMPLE_BUDGET_MS (30_000) budget is 20x the sleep — both margins absorb
 * scheduling jitter on loaded hosts. Each subprocess runs in its own mkdtemp
 * cwd (outside the repo, so the repo bunfig preload does not apply) —
 * hermetic, parallel-safe, cleaned up in finally.
 *
 * Every test here passes an explicit per-test timeout — the same discipline
 * the STOP rule enforces for hooks — because this file is also reached by
 * flag-less direct `bun test` invocations.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK_SLEEP_MS = 1500;
const TIGHT_BUDGET_MS = 500;
const AMPLE_BUDGET_MS = 30_000;
// Subprocess spawn + ~1.5s sleep + reporter overhead; the margin absorbs
// scheduling jitter on loaded hosts.
const PER_TEST_TIMEOUT_MS = 20_000;

interface RunResult {
  exitCode: number;
  output: string;
}

/**
 * Write `fixtureSource` to a fresh tmpdir and run it through the same bun
 * binary executing this test (`process.execPath`), returning combined
 * stdout+stderr. cwd is the tmpdir so no repo bunfig/preload leaks in.
 */
function runBunTestFixture(fixtureSource: string, extraArgs: string[]): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'ok-hook-timeout-semantics-'));
  try {
    const fixture = join(dir, 'fixture.test.ts');
    writeFileSync(fixture, fixtureSource);
    const result = Bun.spawnSync({
      cmd: [process.execPath, 'test', ...extraArgs, fixture],
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: result.exitCode,
      output: `${result.stdout.toString()}\n${result.stderr.toString()}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const UNPROTECTED_BOOT_FIXTURE = `
import { afterAll, beforeAll, expect, test } from 'bun:test';
let server: { cleanup: () => Promise<void> } | undefined;
beforeAll(async () => {
  await Bun.sleep(${HOOK_SLEEP_MS});
  server = { cleanup: async () => {} };
});
afterAll(async () => {
  // Mirrors the integration suites' unconditional cleanup on a
  // possibly-undefined server — the misdirection amplifier.
  // @ts-expect-error intentional: reproduce the secondary error shape
  await server.cleanup();
});
test('t', () => {
  expect(1).toBe(1);
});
`;

describe('hook-timeout semantics — Bun lifecycle-hook timeout behavior', () => {
  test(
    'a beforeAll exceeding the invocation budget fails the suite with the misleading downstream shape',
    () => {
      const { exitCode, output } = runBunTestFixture(UNPROTECTED_BOOT_FIXTURE, [
        '--timeout',
        String(TIGHT_BUDGET_MS),
      ]);
      expect(exitCode).not.toBe(0);
      // Bun reports the kill as a hook timeout (it currently mislabels the
      // hook kind as "beforeEach/afterEach" even for beforeAll — assert only
      // on the stable mechanism phrase, not the label).
      expect(output).toContain('hook timed out');
      // The amplifier: afterAll's unconditional cleanup on the never-assigned
      // server throws the unrelated-looking TypeError that misdirects triage.
      expect(output).toContain('undefined is not an object');
      expect(output).toContain('server.cleanup');
    },
    PER_TEST_TIMEOUT_MS,
  );

  test(
    'the per-hook second argument owns the hook budget (shrink direction: overrides a larger default)',
    () => {
      // No --timeout flag: the invocation budget is Bun's 5s default. A
      // per-hook arg SMALLER than it must still kill the hook — proving the
      // argument (not the invocation) owns the budget.
      const fixture = `
import { beforeAll, expect, test } from 'bun:test';
beforeAll(async () => {
  await Bun.sleep(${HOOK_SLEEP_MS});
}, ${TIGHT_BUDGET_MS});
test('t', () => {
  expect(1).toBe(1);
});
`;
      const { exitCode, output } = runBunTestFixture(fixture, []);
      expect(exitCode).not.toBe(0);
      expect(output).toContain('hook timed out');
    },
    PER_TEST_TIMEOUT_MS,
  );

  test(
    'the per-hook second argument grants headroom over a hostile invocation budget',
    () => {
      // --timeout 500 would kill the 1500ms hook (first test above proves
      // that); an ample per-hook arg must win. This is the
      // invocation-independence guarantee the protected hook shape relies on.
      const fixture = `
import { beforeAll, expect, test } from 'bun:test';
beforeAll(async () => {
  await Bun.sleep(${HOOK_SLEEP_MS});
}, ${AMPLE_BUDGET_MS});
test('runs after slow but protected beforeAll', () => {
  expect(1).toBe(1);
});
`;
      const { exitCode, output } = runBunTestFixture(fixture, [
        '--timeout',
        String(TIGHT_BUDGET_MS),
      ]);
      expect(output).toContain('1 pass');
      expect(exitCode).toBe(0);
    },
    PER_TEST_TIMEOUT_MS,
  );
});
