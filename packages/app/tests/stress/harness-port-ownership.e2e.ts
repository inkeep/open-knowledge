import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { runCleanupOrderControl } from './_helpers/port-ownership/cleanup-order-control.test-helper.ts';
import {
  expectOwnedServerRun,
  expectScratchReleased,
} from './_helpers/port-ownership/expect-owned-server-run.test-helper.ts';
import { runOwnerLossControl } from './_helpers/port-ownership/owner-loss.test-helper.ts';
import {
  type LeaseRoute,
  type OwnershipRun,
  runLeaseInheritanceProbe,
  runOwnershipCase,
} from './_helpers/port-ownership/run-case.test-helper.ts';

test.describe.configure({ retries: 0 });
test.use({ trace: 'retain-on-failure' });

const inheritedJsonOutput = {
  PLAYWRIGHT_JSON_OUTPUT_FILE: process.env.PLAYWRIGHT_JSON_OUTPUT_FILE,
  PLAYWRIGHT_JSON_OUTPUT_NAME: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME,
  PLAYWRIGHT_JSON_OUTPUT_DIR: process.env.PLAYWRIGHT_JSON_OUTPUT_DIR,
};

test.beforeEach(() => {
  process.env.PLAYWRIGHT_JSON_OUTPUT_FILE =
    inheritedJsonOutput.PLAYWRIGHT_JSON_OUTPUT_FILE || test.info().outputPath('outer.json');
  process.env.PLAYWRIGHT_JSON_OUTPUT_NAME =
    inheritedJsonOutput.PLAYWRIGHT_JSON_OUTPUT_NAME ?? 'outer-name.json';
  process.env.PLAYWRIGHT_JSON_OUTPUT_DIR =
    inheritedJsonOutput.PLAYWRIGHT_JSON_OUTPUT_DIR ?? test.info().outputPath('outer-json');
});

test.afterEach(() => {
  for (const [name, value] of Object.entries(inheritedJsonOutput)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function attachLifetimeRun(run: OwnershipRun): Promise<void> {
  const testInfo = test.info();
  const path = testInfo.outputPath('lifetime-run.json');
  writeFileSync(
    path,
    JSON.stringify({
      exitCode: run.exitCode,
      signal: run.signal,
      lifetime: run.lifetime,
      transcript: run.transcript,
    }),
  );
  await testInfo.attach('lifetime-run', { path, contentType: 'application/json' });
}

test('nested runner releases owned setup resources on timeout', async () => {
  const { run, scratchReleased } = await runOwnershipCase({
    file: 'tests/stress/_helpers/port-ownership/lifetime.ownership-case.ts',
    name: 'nested lifetime control reaches its test body',
    caller: 'lifetime-timeout',
  });
  await attachLifetimeRun(run);
  expect(run.lifetime?.receipt, run.transcript).toBeDefined();
  expect(run.lifetime?.selfBoundFired, run.transcript).toBe(false);
  expect(run.exitCode, run.transcript).toBe(1);
  expect(run.stdioClosed, run.transcript).toBe(true);
  expect(run.lifetime?.servingAfterExit, JSON.stringify(run.lifetime)).toBe(false);
  await expectScratchReleased(scratchReleased);
});

test('nested runner releases owned setup resources on normal completion', async () => {
  const { run, scratchReleased } = await runOwnershipCase({
    file: 'tests/stress/_helpers/port-ownership/lifetime.ownership-case.ts',
    name: 'nested lifetime control reaches its test body',
    caller: 'lifetime-normal',
  });
  await attachLifetimeRun(run);
  expect(run.lifetime?.receipt, run.transcript).toBeDefined();
  expect(run.lifetime?.selfBoundFired, run.transcript).toBe(false);
  expect(run.matchingSpecs[0]?.tests[0]?.results[0]?.status, run.transcript).toBe('passed');
  expect(run.exitCode, run.transcript).toBe(0);
  expect(run.stdioClosed, run.transcript).toBe(true);
  expect(run.lifetime?.servingAfterExit, run.transcript).toBe(false);
  await expectScratchReleased(scratchReleased);
});

for (const progress of ['yield', 'exit'] as const) {
  test(`cleanup ordering releases a delayed writer after its peer ${progress}s`, async () => {
    const observed = await runCleanupOrderControl(
      test.info().outputPath('cleanup-order'),
      progress,
    );
    expect(observed.order).toEqual(['request', 'progress', 'acknowledgment']);
  });
}

test('cleanup ordering holds an unregistered remover until the pending write completes', async () => {
  const observed = await runCleanupOrderControl(test.info().outputPath('cleanup-order'), 'remover');
  expect(observed.removerExit).toEqual([0, null]);
  expect(observed.order).toEqual(['request', 'write-complete', 'acknowledgment']);
});

const LEASE_ROUTES: LeaseRoute[] = [
  { label: 'spawn', code: 0, signal: null, stdioLength: 3, stdout: 'spawn\n' },
  { label: 'fork', code: 0, signal: null, stdioLength: 4, stdout: 'fork\n', message: 'fork' },
  { label: 'execFile', code: 0, signal: null, stdioLength: 3, stdout: 'execFile\n' },
  { label: 'exec', code: 0, signal: null, stdioLength: 3, stdout: 'exec\n' },
  { label: 'spawnSync', code: 0, signal: null, stdioLength: 3, stdout: 'spawnSync\n' },
  { label: 'execFileSync', code: 0, signal: null, stdout: 'execFileSync\n' },
  { label: 'execSync', code: 0, signal: null, stdout: 'execSync\n' },
];

test('scratch lease reaches descendants through every spawn entry point', async () => {
  const probe = await runLeaseInheritanceProbe();
  const diagnostics = JSON.stringify(probe);
  expect([...probe.labels].sort(), diagnostics).toEqual(
    [...LEASE_ROUTES.map(({ label }) => label), 'after-owner-release'].sort(),
  );
  expect(probe.routes, diagnostics).toEqual(LEASE_ROUTES);
  expect(probe.driverExit, diagnostics).toEqual([0, null]);
  expect(probe.readerExit, diagnostics).toEqual([0, null]);
});

test('nested runner releases owned setup resources when its owner exits', async () => {
  const result = await runOwnerLossControl(test.info().outputPath('cleanup-order'));
  await test.info().attach('cleanup-ordering', {
    path: test.info().outputPath('cleanup-order/capabilities.json'),
    contentType: 'application/json',
  });
  const path = test.info().outputPath('owner-loss-run.json');
  writeFileSync(path, JSON.stringify(result));
  await test.info().attach('owner-loss-run', { path, contentType: 'application/json' });
  expect(result.receipt.nonce).toBeTruthy();
  expect(result.driverExit, result.transcript).toBe(0);
  expect(result.driverSignal, result.transcript).toBeNull();
  expect(result.witnessClosed, JSON.stringify(result)).toBe(true);
  expect(result.servingAfterOwnerExit, JSON.stringify(result)).toBe(false);
  expect(result.scratchGone, JSON.stringify(result)).toBe(true);
  if (result.ordering.native) {
    expect(result.ordering.order, JSON.stringify(result.ordering.events)).toEqual([
      'server:before-record',
      'server:ack:before-record',
      'server:after-record',
      'server:ack:after-record',
      'unregistered:remove',
      'unregistered:ack:remove',
    ]);
  } else {
    test.info().annotations.push({
      type: 'cleanup-ordering',
      description: `native cleanup ordering is unavailable on ${process.platform}; this run used natural timing`,
    });
  }
});

test('automatically selected worker server owns its endpoint', async () => {
  await expectOwnedServerRun({
    file: 'tests/stress/_helpers/port-ownership/worker.ownership-case.ts',
    name: 'worker server owns its advertised endpoint',
    caller: 'fixtures.ts',
  });
});

test('automatically selected warm-cache server publishes a seed', async () => {
  await expectOwnedServerRun({
    file: 'tests/stress/_helpers/port-ownership/warm-cache.ownership-case.ts',
    name: 'warm cache owns a serving endpoint before publishing its seed',
    caller: 'global-warm-cache.ts',
  });
});

for (const family of ['IPv4', 'IPv6']) {
  for (const collision of [
    'an unavailable candidate',
    'a bind contender',
    'a released bind contender',
  ]) {
    const name = `records ownership evidence after ${collision} on ${family}`;
    test(name, async () => {
      await expectOwnedServerRun({
        file: 'tests/stress/_helpers/port-ownership/recording.ownership-case.ts',
        name,
        caller: 'vite-bind-interception',
      });
    });
  }
}
