import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  legacyServerLock,
  lockWrittenByRunningProcess,
  type OwnedProcess,
  startOwnedProcess,
  stopOwnedProcess,
} from '../../../test-support/owned-process.test-helper.ts';
import { createTempDirFactory } from '../../../test-support/temp-dir.test-helper.ts';
import { getMachineId } from './machine-id.ts';
import { isProcessAlive } from './process-alive.ts';
import {
  acquireProcessLock,
  type LockName,
  lockFilePath,
  ProcessLockCollisionError,
  readProcessLock,
  readProcessLockDetailed,
} from './process-lock.ts';

vi.mock('./process-alive.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./process-alive.ts')>();
  return { ...actual, isProcessAlive: vi.fn(actual.isProcessAlive) };
});

const { isProcessAlive: actualIsProcessAlive } =
  await vi.importActual<typeof import('./process-alive.ts')>('./process-alive.ts');

const LOCK_NAME: LockName = 'server';
const tempDir = createTempDirFactory(afterEach);
const owned: OwnedProcess[] = [];

let lockDir: string;
let lockPath: string;

beforeEach(() => {
  lockDir = resolve(tempDir('ok-process-lock-successor-'), '.ok', LOCAL_DIR);
  lockPath = lockFilePath(lockDir, LOCK_NAME);
  mkdirSync(lockDir, { recursive: true });
});

afterEach(async () => {
  vi.mocked(isProcessAlive).mockImplementation(actualIsProcessAlive);
  for (const holder of owned.splice(0)) await stopOwnedProcess(holder);
});

async function writeSuccessorLockText(): Promise<string> {
  const successor = await startOwnedProcess();
  owned.push(successor);
  return JSON.stringify(
    legacyServerLock({
      pid: successor.pid,
      startedAt: lockWrittenByRunningProcess(successor),
      machineId: getMachineId(),
      worktreeRoot: '/successor',
    }),
  );
}

function writePredecessorLock(pid: number): void {
  writeFileSync(
    lockPath,
    JSON.stringify(
      legacyServerLock({
        pid,
        startedAt: new Date().toISOString(),
        machineId: getMachineId(),
        worktreeRoot: '/predecessor',
      }),
    ),
  );
}

function samePidSuccessorLockText(pid: number): string {
  return JSON.stringify(
    legacyServerLock({
      pid,
      startedAt: '2026-01-01T00:00:00.000Z',
      machineId: getMachineId(),
      worktreeRoot: '/successor',
    }),
  );
}

function predecessorExitsWhileItsStartIsRead(
  pid: number,
  successorLockText: string,
  { successorRunsUnderSamePid = false } = {},
): void {
  let checks = 0;
  vi.mocked(isProcessAlive).mockImplementation((candidate) => {
    if (candidate !== pid) return actualIsProcessAlive(candidate);
    checks += 1;
    if (checks === 1) return true;
    if (checks === 2) {
      writeFileSync(lockPath, successorLockText);
      return false;
    }
    return successorRunsUnderSamePid;
  });
}

test('readProcessLock keeps a lock a successor wrote while the exited holder was assessed', async () => {
  const successorLockText = await writeSuccessorLockText();
  writePredecessorLock(99_990_101);
  predecessorExitsWhileItsStartIsRead(99_990_101, successorLockText);

  expect(readProcessLock({ lockName: LOCK_NAME, lockDir })).toBeNull();
  expect(readFileSync(lockPath, 'utf-8')).toBe(successorLockText);
});

test('readProcessLockDetailed keeps a lock a successor wrote while the exited holder was assessed', async () => {
  const successorLockText = await writeSuccessorLockText();
  writePredecessorLock(99_990_102);
  predecessorExitsWhileItsStartIsRead(99_990_102, successorLockText);

  expect(readProcessLockDetailed({ lockName: LOCK_NAME, lockDir }).status).toBe('stale');
  expect(readFileSync(lockPath, 'utf-8')).toBe(successorLockText);
});

test('acquireProcessLock collides with a successor that took the lock while the exited holder was assessed', async () => {
  const successorLockText = await writeSuccessorLockText();
  writePredecessorLock(99_990_103);
  predecessorExitsWhileItsStartIsRead(99_990_103, successorLockText);

  expect(() =>
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 0, worktreeRoot: '/new/boot' },
    }),
  ).toThrow(ProcessLockCollisionError);
  expect(readFileSync(lockPath, 'utf-8')).toBe(successorLockText);
});

test('readProcessLock keeps a lock a successor under the same pid wrote while the exited holder was assessed', () => {
  const successorLockText = samePidSuccessorLockText(99_990_104);
  writePredecessorLock(99_990_104);
  predecessorExitsWhileItsStartIsRead(99_990_104, successorLockText);

  expect(readProcessLock({ lockName: LOCK_NAME, lockDir })).toBeNull();
  expect(readFileSync(lockPath, 'utf-8')).toBe(successorLockText);
});

test('readProcessLockDetailed keeps a lock a successor under the same pid wrote while the exited holder was assessed', () => {
  const successorLockText = samePidSuccessorLockText(99_990_105);
  writePredecessorLock(99_990_105);
  predecessorExitsWhileItsStartIsRead(99_990_105, successorLockText);

  expect(readProcessLockDetailed({ lockName: LOCK_NAME, lockDir }).status).toBe('stale');
  expect(readFileSync(lockPath, 'utf-8')).toBe(successorLockText);
});

test('acquireProcessLock collides with a successor under the same pid that took the lock while the exited holder was assessed', () => {
  const successorLockText = samePidSuccessorLockText(99_990_106);
  writePredecessorLock(99_990_106);
  predecessorExitsWhileItsStartIsRead(99_990_106, successorLockText, {
    successorRunsUnderSamePid: true,
  });

  expect(() =>
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 0, worktreeRoot: '/new/boot' },
    }),
  ).toThrow(ProcessLockCollisionError);
  expect(readFileSync(lockPath, 'utf-8')).toBe(successorLockText);
});
