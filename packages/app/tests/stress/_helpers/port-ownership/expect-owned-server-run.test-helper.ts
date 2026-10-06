import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { type OwnershipCase, runOwnershipCase } from './run-case.test-helper.ts';

export async function expectOwnedServerRun(ownershipCase: OwnershipCase): Promise<void> {
  const { run, scratchReleased } = await runOwnershipCase(ownershipCase);
  const testInfo = test.info();
  expect(run.report, run.transcript).toBeDefined();
  const reportPath = testInfo.outputPath('inner-report.json');
  const eventsPath = testInfo.outputPath('socket-events.json');
  const transcriptPath = testInfo.outputPath('inner-transcript.txt');
  writeFileSync(reportPath, JSON.stringify(run.report));
  writeFileSync(eventsPath, JSON.stringify({ present: run.eventFilePresent, events: run.events }));
  writeFileSync(transcriptPath, run.transcript);
  await testInfo.attach('inner-report', {
    path: reportPath,
    contentType: 'application/json',
  });
  await testInfo.attach('socket-events', {
    path: eventsPath,
    contentType: 'application/json',
  });
  await testInfo.attach('inner-transcript', {
    path: transcriptPath,
    contentType: 'text/plain',
  });
  expect(run.eventFilePresent, run.transcript).toBe(true);
  expect(
    run.events.some(
      (event) =>
        typeof event === 'object' &&
        event !== null &&
        'event' in event &&
        (event.event === 'occupied' || event.event === 'vite-bind-takeover'),
    ),
    `${run.transcript}\n${JSON.stringify(run.events)}`,
  ).toBe(true);
  expect(run.signal, run.transcript).toBeNull();
  expect(run.stdioClosed, run.transcript).toBe(true);
  expect(run.errors, run.transcript).toEqual([]);
  expect(run.matchingSpecs, run.transcript).toHaveLength(1);
  expect(run.matchingSpecs[0]?.tests, run.transcript).toHaveLength(1);
  expect(run.matchingSpecs[0]?.tests[0]?.results, run.transcript).toHaveLength(1);
  expect(
    run.matchingSpecs[0]?.tests[0]?.results[0]?.status,
    `${run.transcript}\n${JSON.stringify(run.events)}`,
  ).toBe('passed');
  expect(run.exitCode, run.transcript).toBe(0);
  await expectScratchReleased(scratchReleased);
}

export async function expectScratchReleased(
  scratchReleased: Promise<Error | undefined>,
): Promise<void> {
  await test.step('scratch lease released', async () => {
    expect(await scratchReleased).toBeUndefined();
  });
}
