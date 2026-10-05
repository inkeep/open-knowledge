import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectOwnedServerRun } from './_helpers/port-ownership/expect-owned-server-run.test-helper.ts';
import { runOwnerLossControl } from './_helpers/port-ownership/owner-loss.test-helper.ts';
import {
  type OwnershipRun,
  runOwnershipCase,
} from './_helpers/port-ownership/run-case.test-helper.ts';

test.describe.configure({ retries: 0 });
test.use({ trace: 'retain-on-failure' });

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
  const run = await runOwnershipCase({
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
});

test('nested runner releases owned setup resources on normal completion', async () => {
  const run = await runOwnershipCase({
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
});

test('nested runner releases owned setup resources when its owner exits', async () => {
  const result = await runOwnerLossControl();
  const path = test.info().outputPath('owner-loss-run.json');
  writeFileSync(path, JSON.stringify(result));
  await test.info().attach('owner-loss-run', { path, contentType: 'application/json' });
  expect(result.receipt.nonce).toBeTruthy();
  expect(result.driverExit, result.transcript).toBe(0);
  expect(result.driverSignal, result.transcript).toBeNull();
  expect(result.witnessClosed, JSON.stringify(result)).toBe(true);
  expect(result.servingAfterOwnerExit, JSON.stringify(result)).toBe(false);
  expect(result.scratchGone, JSON.stringify(result)).toBe(true);
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
