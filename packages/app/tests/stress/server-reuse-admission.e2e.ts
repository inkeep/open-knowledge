import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { SERVER_LEASE_ANNOTATION } from './_helpers/reuse/lease-fixture.ts';
import {
  annotationsOf,
  CASE_SERVER_ANNOTATION,
  type RunningSupervisor,
  runReuseCase,
  startSupervisor,
  statusesOf,
} from './_helpers/reuse/reuse-run.test-helper.ts';
import { connectLeaseClient } from './_helpers/reuse/supervisor-socket.ts';
import { APP_PACKAGE_ROOT } from './_helpers/server-process.ts';
import { SETUP_NON_RESULT_ANNOTATION } from './_helpers/setup-non-result.ts';

test.describe.configure({ retries: 0 });

const SERVES_THE_APP = 'a leased worker server serves the app';
const SHUTS_DOWN_MID_TEST = 'the supervisor shuts down while a test holds its lease';
const LATER_IN_THE_RUN = 'a later test of the run whose supervisor shut down';
const CALL_MS = 60_000;
const SUPERVISOR_EXIT_MS = 60_000;

let scratch: string;
let supervisor: RunningSupervisor | undefined;

test.beforeEach(async () => {
  test.setTimeout(480_000);
  scratch = mkdtempSync(join(tmpdir(), 'ok-reuse-e2e-'));
  supervisor = await startSupervisor(scratch);
});

test.afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  rmSync(scratch, { recursive: true, force: true });
});

test('successive opted-in runs reuse the supervisor slot and a run finding it busy starts its own server', async () => {
  if (supervisor === undefined) throw new Error('the supervisor did not start');
  const { socketPath } = supervisor;

  const first = await runReuseCase(socketPath, SERVES_THE_APP);
  expect(statusesOf(first), first.transcript).toEqual(['passed']);
  const [started] = annotationsOf(first, SERVER_LEASE_ANNOTATION);
  expect(started, first.transcript).toMatch(
    /^slot 0: started an owned server at http:\/\/127\.0\.0\.1:\d+$/,
  );
  const leasedURL = started?.split(' at ')[1];
  expect(annotationsOf(first, CASE_SERVER_ANNOTATION)).toEqual([leasedURL]);

  const second = await runReuseCase(socketPath, SERVES_THE_APP);
  expect(statusesOf(second), second.transcript).toEqual(['passed']);
  expect(annotationsOf(second, SERVER_LEASE_ANNOTATION)).toEqual([
    `slot 0: reused the owned server at ${leasedURL}`,
  ]);
  expect(annotationsOf(second, CASE_SERVER_ANNOTATION)).toEqual([leasedURL]);

  const holder = await connectLeaseClient(socketPath, 5_000);
  try {
    const status = (await holder.status(CALL_MS)) as Array<{ config: string }>;
    const held = await holder.acquire(
      {
        worktree: realpathSync(join(APP_PACKAGE_ROOT, '..', '..')),
        config: status[0]?.config ?? '',
        run: 'outer-holder',
        slot: 0,
        workerServerEnv: {},
        serverMode: 'dev',
      },
      CALL_MS,
    );
    expect(held.kind).toBe('granted');

    const busy = await runReuseCase(socketPath, SERVES_THE_APP);
    expect(statusesOf(busy), busy.transcript).toEqual(['passed']);
    expect(annotationsOf(busy, SERVER_LEASE_ANNOTATION)).toEqual([
      'slot 0 was refused (busy: slot 0 is leased to run outer-holder), so this worker starts its own server',
    ]);
    const [busyServer] = annotationsOf(busy, CASE_SERVER_ANNOTATION);
    expect(busyServer).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(busyServer).not.toBe(leasedURL);
  } finally {
    holder.close();
  }
});

test('a supervisor that stops during a leased test turns that test into a declared non-result', async () => {
  if (supervisor === undefined) throw new Error('the supervisor did not start');
  const run = await runReuseCase(supervisor.socketPath, SHUTS_DOWN_MID_TEST);
  expect(statusesOf(run), run.transcript).toEqual(['failed']);
  expect(annotationsOf(run, SETUP_NON_RESULT_ANNOTATION)).toEqual([
    expect.stringMatching(/^the reused server's lease was lost during the test: /),
  ]);
  expect(await supervisor.exitWithin(SUPERVISOR_EXIT_MS), supervisor.transcript()).toEqual({
    code: 0,
    signal: null,
  });
});

test('a supervisor that stops during a leased test aborts its run, so a later test of that run is refused as a declared non-result', async () => {
  if (supervisor === undefined) throw new Error('the supervisor did not start');
  const run = await runReuseCase(supervisor.socketPath, SHUTS_DOWN_MID_TEST, LATER_IN_THE_RUN);
  expect(statusesOf(run), run.transcript).toEqual(['failed', 'failed']);
  const nonResults = annotationsOf(run, SETUP_NON_RESULT_ANNOTATION);
  expect(nonResults, run.transcript).toHaveLength(2);
  const [lost, refused] = nonResults;
  const lossPrefix = "the reused server's lease was lost during the test: ";
  expect(lost, run.transcript).toMatch(new RegExp(`^${lossPrefix}.`));
  const lossReason = lost?.slice(lossPrefix.length);
  expect(refused, run.transcript).toMatch(
    /^server reuse refused slot 0: run \S+ lost an earlier lease: .+, so this invocation gives no further verdicts$/,
  );
  expect(refused).toContain(`lost an earlier lease: ${lossReason}, so`);
  expect(annotationsOf(run, SERVER_LEASE_ANNOTATION), run.transcript).toEqual([
    expect.stringMatching(/^slot 0: started an owned server at http:\/\/127\.0\.0\.1:\d+$/),
  ]);
  expect(annotationsOf(run, CASE_SERVER_ANNOTATION)).toEqual([]);
});
