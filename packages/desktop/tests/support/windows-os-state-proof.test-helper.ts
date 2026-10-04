import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  collectWindowsOsState,
  WINDOWS_OS_HELPER_EXIT,
  WINDOWS_OS_MAX_BUDGET_MS,
  WINDOWS_OS_MAX_RESULT_BYTES,
  type WindowsQueryHelper,
  windowsPowerShellPath,
} from './windows-os-state.test-helper.ts';
import { assertCapturedWindowsOsState } from './windows-os-state-contract.test-helper.ts';

const queryFile = fileURLToPath(new URL('./windows-os-query.test-helper.ps1', import.meta.url));
const cliFile = fileURLToPath(new URL('./windows-os-state-cli.test-helper.ts', import.meta.url));
const powershell = windowsPowerShellPath();

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

interface CliCaptureChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'error', listener: () => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
}

export function captureBoundedCliOutput(
  child: CliCaptureChild,
): Promise<{ code: number | null; stdout: string | null; stderrBytes: number }> {
  let stdout = '';
  let stdoutBytes = 0;
  let stdoutExceeded = child.stdout === null;
  let stderrBytes = 0;
  child.on('error', () => undefined);
  child.stdout?.on('data', (chunk: Buffer | string) => {
    if (stdoutExceeded) return;
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > WINDOWS_OS_MAX_RESULT_BYTES) {
      stdoutExceeded = true;
      stdout = '';
      return;
    }
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrBytes = Math.min(WINDOWS_OS_MAX_RESULT_BYTES + 1, stderrBytes + Buffer.byteLength(chunk));
  });
  return new Promise((resolve) => {
    child.on('close', (code) =>
      resolve({ code, stdout: stdoutExceeded ? null : stdout, stderrBytes }),
    );
  });
}

function waitWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ status: 'observed'; value: T } | { status: 'deadline' }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: 'deadline' }), ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve({ status: 'observed', value });
    });
  });
}

function spawnGuard(deadlineMs: number): WindowsQueryHelper {
  return spawn(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      queryFile,
      '-PidValues',
      String(process.pid),
      '-ParentPidValue',
      String(process.pid),
      '-DeadlineEpochMs',
      String(Date.now() + deadlineMs),
      '-DurationCapMs',
      String(deadlineMs),
    ],
    { stdio: 'pipe', windowsHide: true, shell: false },
  );
}

type GuardReason = 'deadline' | 'output-limit' | 'owner-loss';
type GuardDelivery =
  | 'not-attempted'
  | 'no-pid'
  | 'already-exited'
  | 'accepted'
  | 'rejected'
  | 'threw';
type GuardReady = 'ready' | 'invalid-frame' | 'output-limit' | 'error' | 'exited';

export interface GuardProofOutcome {
  pid: number | null;
  ready: boolean;
  reason: GuardReason | null;
  delivery: GuardDelivery;
  exitObserved: boolean;
  exitCode: number | null;
}

export async function runWindowsGuardSlice(
  kind: 'owner-loss' | 'deadline',
  spawnHelper: (deadlineMs: number) => WindowsQueryHelper = spawnGuard,
): Promise<GuardProofOutcome> {
  let child: WindowsQueryHelper;
  try {
    child = spawnHelper(WINDOWS_OS_MAX_BUDGET_MS);
  } catch {
    return {
      pid: null,
      ready: false,
      reason: 'owner-loss',
      delivery: 'no-pid',
      exitObserved: false,
      exitCode: null,
    };
  }
  const rawPid = child.pid;
  const pid: number | null =
    typeof rawPid === 'number' && Number.isSafeInteger(rawPid) && rawPid > 0 ? rawPid : null;
  let exitObserved = false;
  let exitCode: number | null = null;
  let readySettled = false;
  let resolveReady: (result: GuardReady) => void = () => undefined;
  const readyResult = new Promise<GuardReady>((resolve) => {
    resolveReady = (result) => {
      if (readySettled) return;
      readySettled = true;
      resolve(result);
    };
  });
  let resolveClosed: () => void = () => undefined;
  const closedResult = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  child.on('error', () => resolveReady('error'));
  child.on('exit', (code) => {
    exitObserved = true;
    exitCode = Number.isSafeInteger(code) && code !== null && code >= 0 ? code : null;
    resolveReady('exited');
  });
  child.on('close', (code) => {
    exitObserved = true;
    exitCode = Number.isSafeInteger(code) && code !== null && code >= 0 ? code : exitCode;
    resolveReady('exited');
    resolveClosed();
  });
  let frame = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout?.on('error', () => resolveReady('error'));
  child.stderr?.on('error', () => resolveReady('error'));
  child.stdin?.on?.('error', () => resolveReady('error'));
  child.stdout?.on('data', (chunk) => {
    if (readySettled) return;
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > 64) {
      resolveReady('output-limit');
      return;
    }
    frame += chunk.toString();
    if (/^READY\r?\n$/u.test(frame)) resolveReady('ready');
    else if (frame.includes('\n')) resolveReady('invalid-frame');
  });
  child.stderr?.on('data', (chunk) => {
    if (readySettled) return;
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > 64) resolveReady('output-limit');
  });
  if (child.stdout === null) resolveReady('invalid-frame');

  let reason: GuardReason | null = null;
  let delivery: GuardDelivery = 'not-attempted';
  const requestTermination = (why: GuardReason): void => {
    if (reason !== null) return;
    reason = why;
    if (pid === null) {
      delivery = 'no-pid';
      return;
    }
    if (exitObserved) {
      delivery = 'already-exited';
      return;
    }
    try {
      delivery = child.kill() ? 'accepted' : 'rejected';
    } catch {
      delivery = 'threw';
    }
  };
  const releasePipes = (): void => {
    try {
      child.stdin?.end();
    } catch {}
    try {
      child.stdout?.destroy?.();
    } catch {}
    try {
      child.stderr?.destroy?.();
    } catch {}
    try {
      child.unref?.();
    } catch {}
  };
  const readyWait: { status: 'observed'; value: GuardReady } | { status: 'deadline' } =
    pid === null ? { status: 'observed', value: 'error' } : await waitWithin(readyResult, 8_000);
  const ready = readyWait.status === 'observed' && readyWait.value === 'ready';
  if (!ready) {
    requestTermination(
      readyWait.status === 'deadline'
        ? 'deadline'
        : readyWait.value === 'output-limit'
          ? 'output-limit'
          : 'owner-loss',
    );
    releasePipes();
    await waitWithin(closedResult, 8_000);
    return { pid, ready: false, reason, delivery, exitObserved, exitCode };
  }

  if (kind === 'owner-loss') {
    try {
      child.stdin?.end();
    } catch {
      requestTermination('owner-loss');
    }
  }
  const exitWait = await waitWithin(closedResult, 8_000);
  if (exitWait.status === 'deadline') {
    requestTermination('deadline');
    releasePipes();
    await waitWithin(closedResult, 8_000);
  } else {
    try {
      child.stdin?.end();
    } catch {}
  }
  return { pid, ready: true, reason, delivery, exitObserved, exitCode };
}

async function proveGuard(): Promise<void> {
  const eof = await runWindowsGuardSlice('owner-loss');
  if (
    !eof.ready ||
    !eof.exitObserved ||
    eof.exitCode !== WINDOWS_OS_HELPER_EXIT.ownerLoss ||
    eof.reason !== null
  ) {
    console.log(`WINDOWS_OS_GUARD_FAILURE ${JSON.stringify(eof)} command=powershell.exe`);
  }
  assert.equal(eof.ready, true);
  assert.equal(eof.reason, null);
  assert.equal(eof.exitObserved, true);
  assert.equal(eof.exitCode, WINDOWS_OS_HELPER_EXIT.ownerLoss);

  const deadline = await runWindowsGuardSlice('deadline');
  if (
    !deadline.ready ||
    !deadline.exitObserved ||
    deadline.exitCode !== WINDOWS_OS_HELPER_EXIT.deadline ||
    deadline.reason !== null
  ) {
    console.log(`WINDOWS_OS_GUARD_FAILURE ${JSON.stringify(deadline)} command=powershell.exe`);
  }
  assert.equal(deadline.ready, true);
  assert.equal(deadline.reason, null);
  assert.equal(deadline.exitObserved, true);
  assert.equal(deadline.exitCode, WINDOWS_OS_HELPER_EXIT.deadline);
  console.log(
    `WINDOWS_OS_GUARD_PROOF eof=${WINDOWS_OS_HELPER_EXIT.ownerLoss} deadline=${WINDOWS_OS_HELPER_EXIT.deadline}`,
  );
}

async function proveCli(pid: number): Promise<void> {
  const cli = spawn(
    process.execPath,
    [cliFile, '--pid', String(pid), '--parent-pid', String(process.pid), '--budget-ms', '5000'],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false },
  );
  const cliOutput = captureBoundedCliOutput(cli);
  assert.ok(cli.pid && cli.pid > 0);
  let captured: Awaited<typeof cliOutput>;
  try {
    captured = await bounded(cliOutput, 15_000);
  } catch {
    console.log(`WINDOWS_OS_CLI_PENDING pid=${cli.pid ?? 'none'} command=node`);
    throw new Error('owned CLI did not settle');
  }
  if (captured.stdout === null) throw new Error('owned CLI output-limit');
  assert.equal(captured.code, 0);
  assert.equal(captured.stderrBytes, 0);
  const lines = captured.stdout.trimEnd().split(/\r?\n/u);
  assert.equal(lines.length, 1);
  const result = JSON.parse(lines[0] ?? '') as unknown;
  assertCapturedWindowsOsState(result, pid, false);
  console.log(`WINDOWS_OS_CLI_PROOF ${JSON.stringify(result)}`);
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
    assertCapturedWindowsOsState(result, pid, true);
    console.log(`WINDOWS_OS_PROOF ${JSON.stringify(result)}`);
    await proveCli(pid);
    await proveGuard();
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
