import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import type { PtyOsObservation, PtyOsUnavailableReason } from '../../src/utility/pty-host.ts';
import {
  collectWindowsOsState,
  WINDOWS_OS_MAX_BUDGET_MS,
  WINDOWS_OS_MAX_RESULT_BYTES,
} from './windows-os-state.test-helper.ts';
import { assertBoundedWindowsOsState } from './windows-os-state-contract.test-helper.ts';

const helperExitFailed = {
  'not-observed': false,
  'observed-before-request': true,
  'observed-after-request': false,
  'cooperative-deadline': false,
  'cooperative-owner-loss': true,
} as const satisfies Record<PtyOsObservation['helper']['exit'], boolean>;

const reasonShowsHelperFailure = {
  deadline: () => false,
  'no-budget': () => false,
  'unsupported-platform': () => true,
  'query-start-failed': (result) => result.helper.reason !== 'deadline',
  'query-exited': (result) => helperExitFailed[result.helper.exit],
  'invalid-json': () => true,
  'invalid-shape': (result) => result.status === 'unavailable',
  'output-limit': () => true,
  'owner-loss': () => false,
  'process-absent': () => false,
  'access-unavailable': () => false,
  'identity-changed': () => false,
  'worker-request-deadline': () => false,
  'worker-unavailable': () => false,
  'console-identity-unavailable': () => false,
} satisfies Record<PtyOsUnavailableReason, (result: PtyOsObservation) => boolean>;

function assertHelperDidNotFail(result: PtyOsObservation): void {
  assert.ok(result.reason === null || !reasonShowsHelperFailure[result.reason](result));
}

function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('owned proof process did not settle')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        reject(new Error('owned proof process failed'));
      },
    );
  });
}

function watchClose(child: ChildProcess): Promise<number | null> {
  child.on('error', () => undefined);
  return new Promise((resolve) => {
    child.once('close', (code) => resolve(code));
  });
}

export async function runWindowsOsStateProof(): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `process.send('ready'); process.on('message', value => { if (value === 'release') process.exit(0) }); process.on('disconnect', () => process.exit(0)); setTimeout(() => process.exit(0), 30000)`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, shell: false },
  );
  const childExit = watchClose(child);
  const childReady = new Promise<unknown>((resolve) => {
    child.once('message', (value) => resolve(value));
    child.once('error', () => resolve(null));
    child.once('close', () => resolve(null));
  });
  const pid = child.pid;
  let childStdoutBytes = 0;
  let childStderrBytes = 0;
  child.stdout?.on('data', (chunk: Buffer) => {
    childStdoutBytes = Math.min(32 * 1024 + 1, childStdoutBytes + chunk.byteLength);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    childStderrBytes = Math.min(32 * 1024 + 1, childStderrBytes + chunk.byteLength);
  });
  let worker: Worker | null = null;
  let workerExit: Promise<number> | null = null;
  let proofFailed = false;
  let proofError: unknown;
  let cleanupFailure: 'subject' | 'worker' | null = null;
  try {
    assert.ok(pid && pid > 0);
    worker = new Worker(
      `const { parentPort } = require('node:worker_threads'); const timer = setTimeout(() => process.exit(0), 30000); parentPort.postMessage('ready'); parentPort.on('message', value => { if (value === 'release') { clearTimeout(timer); parentPort.close() } })`,
      { eval: true },
    );
    const ownedWorker = worker;
    workerExit = new Promise<number>((resolve) => {
      ownedWorker.on('error', () => undefined);
      ownedWorker.once('exit', (code) => resolve(code));
    });
    const workerReady = new Promise<unknown>((resolve) => {
      ownedWorker.once('message', (value) => resolve(value));
      ownedWorker.once('error', () => resolve(null));
      ownedWorker.once('exit', () => resolve(null));
    });
    const readyMessage = await bounded(childReady, 8_000);
    assert.equal(readyMessage, 'ready');
    const workerReadyMessage = await bounded(workerReady, 8_000);
    assert.equal(workerReadyMessage, 'ready');
    const result = await collectWindowsOsState({
      pid,
      parentPid: process.pid,
      worker,
      budgetMs: WINDOWS_OS_MAX_BUDGET_MS,
    });
    const serialized = JSON.stringify(result);
    const serializedBytes = Buffer.byteLength(serialized);
    if (serializedBytes <= WINDOWS_OS_MAX_RESULT_BYTES) {
      console.log(`WINDOWS_OS_PROOF ${serialized}`);
    } else {
      console.log(`WINDOWS_OS_PROOF_OVERSIZE bytes=${serializedBytes}`);
    }
    assertBoundedWindowsOsState(result, pid);
    assertHelperDidNotFail(result);
    assert.equal(childStdoutBytes, 0);
    assert.equal(childStderrBytes, 0);
  } catch (error) {
    proofFailed = true;
    proofError = error;
  } finally {
    if (child.connected) {
      try {
        child.send('release');
      } catch {}
    }
    if (worker !== null && worker.threadId > 0) {
      try {
        worker.postMessage('release');
      } catch {}
    }
    const childOutcome = await bounded(childExit, 35_000).then(
      (code) => ({ status: 'closed' as const, code }),
      () => ({ status: 'deadline' as const, code: null }),
    );
    if (childOutcome.status === 'deadline') {
      console.log(`WINDOWS_OS_SUBJECT_PENDING pid=${pid ?? 'none'} command=node`);
      cleanupFailure = 'subject';
    } else if (childOutcome.code !== 0) {
      console.log(
        `WINDOWS_OS_SUBJECT_EXIT pid=${pid ?? 'none'} code=${childOutcome.code ?? 'null'} command=node`,
      );
      cleanupFailure = 'subject';
    }
    if (workerExit !== null) {
      const workerCode = await bounded(workerExit, 35_000).catch(() => null);
      if (workerCode === null) {
        console.log('WINDOWS_OS_WORKER_PENDING command=node-worker');
        cleanupFailure = 'worker';
      } else if (workerCode !== 0) {
        console.log(`WINDOWS_OS_WORKER_EXIT code=${workerCode} command=node-worker`);
        cleanupFailure = 'worker';
      }
    }
  }
  if (proofFailed) throw proofError;
  if (cleanupFailure !== null) throw new Error(`owned ${cleanupFailure} did not exit cleanly`);
}
