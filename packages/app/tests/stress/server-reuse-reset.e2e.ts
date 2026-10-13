import { mkdtempSync, rmSync } from 'node:fs';
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

test.describe.configure({ retries: 0 });

const LEAVES_STATE = 'a run leaves settings, content, agent state and browser storage behind';
const FINDS_NO_STATE =
  'a later run finds none of an earlier run’s settings, content or browser storage';
const LEAVES_UNACCOUNTED_STATE = 'a run leaves server state that no reset can account for';

let scratch: string;
let supervisor: RunningSupervisor | undefined;

test.beforeEach(async () => {
  test.setTimeout(600_000);
  scratch = mkdtempSync(join(tmpdir(), 'ok-reuse-reset-e2e-'));
  supervisor = await startSupervisor(scratch);
});

test.afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  rmSync(scratch, { recursive: true, force: true });
});

test('a reused server is reset to its booted state, and one it cannot prove reset is discarded for a fresh server', async () => {
  if (supervisor === undefined) throw new Error('the supervisor did not start');
  const { socketPath } = supervisor;

  const leaving = await runReuseCase(socketPath, LEAVES_STATE);
  expect(statusesOf(leaving), leaving.transcript).toEqual(['passed']);
  const [leasedURL] = annotationsOf(leaving, CASE_SERVER_ANNOTATION);
  expect(annotationsOf(leaving, SERVER_LEASE_ANNOTATION)).toEqual([
    `slot 0: started an owned server at ${leasedURL}`,
  ]);

  const finding = await runReuseCase(socketPath, FINDS_NO_STATE);
  expect(statusesOf(finding), finding.transcript).toEqual(['passed']);
  expect(annotationsOf(finding, SERVER_LEASE_ANNOTATION)).toEqual([
    `slot 0: reused the owned server at ${leasedURL}`,
  ]);
  expect(annotationsOf(finding, CASE_SERVER_ANNOTATION)).toEqual([leasedURL]);

  const unaccounted = await runReuseCase(socketPath, LEAVES_UNACCOUNTED_STATE);
  expect(statusesOf(unaccounted), unaccounted.transcript).toEqual(['passed']);
  expect(annotationsOf(unaccounted, SERVER_LEASE_ANNOTATION)).toEqual([
    `slot 0: reused the owned server at ${leasedURL}`,
  ]);
  expect(annotationsOf(unaccounted, CASE_SERVER_ANNOTATION)).toEqual([leasedURL]);

  const afterUnaccounted = await runReuseCase(socketPath, FINDS_NO_STATE);
  expect(statusesOf(afterUnaccounted), afterUnaccounted.transcript).toEqual(['passed']);
  expect(annotationsOf(afterUnaccounted, SERVER_LEASE_ANNOTATION)).toEqual([
    'slot 0: the leased server could not be reset (the reset left .ok/local/unrecognised-state.json is not in a freshly booted slot), so it was discarded and this worker starts its own server',
  ]);
  const [freshURL] = annotationsOf(afterUnaccounted, CASE_SERVER_ANNOTATION);
  expect(freshURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(freshURL).not.toBe(leasedURL);
});
