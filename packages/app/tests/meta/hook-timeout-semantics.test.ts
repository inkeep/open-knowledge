import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK_SLEEP_MS = 1500;
const TIGHT_BUDGET_MS = 500;
const AMPLE_BUDGET_MS = 30_000;
const PER_TEST_TIMEOUT_MS = 20_000;

interface RunResult {
  exitCode: number;
  output: string;
}

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
      expect(output).toContain('hook timed out');
      expect(output).toContain('undefined is not an object');
      expect(output).toContain('server.cleanup');
    },
    PER_TEST_TIMEOUT_MS,
  );

  test(
    'the per-hook second argument owns the hook budget (shrink direction: overrides a larger default)',
    () => {
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
