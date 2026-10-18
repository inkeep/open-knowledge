import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { legacyServerLock } from '../../../test-support/owned-process.test-helper.ts';
import { createTempDirFactory } from '../../../test-support/temp-dir.test-helper.ts';
import { getMachineId } from './machine-id.ts';
import type { ProcessStart } from './process-identity.ts';
import {
  type LockName,
  lockFilePath,
  readProcessLock,
  readProcessLockDetailed,
} from './process-lock.ts';

const startReads = vi.hoisted(() => ({
  pids: [] as number[],
  nowMs: 0,
  holderStart: null as ProcessStart | null,
}));

vi.mock('./process-identity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./process-identity.ts')>();
  return {
    ...actual,
    createRecentProcessStartReader: (
      options: Parameters<typeof actual.createRecentProcessStartReader>[0],
    ) =>
      actual.createRecentProcessStartReader({
        ...options,
        now: () => startReads.nowMs,
        read: (pid) => {
          startReads.pids.push(pid);
          return startReads.holderStart;
        },
      }),
  };
});

const LOCK_NAME: LockName = 'server';
const LOCK_READ_MAX_AGE_MS = 1_000;
const tempDir = createTempDirFactory(afterEach);

let lockDir: string;

beforeEach(() => {
  startReads.pids = [];
  startReads.nowMs += 60_000;
  const startedAt = new Date();
  startReads.holderStart = { startedAtMs: startedAt.getTime(), clock: 'creation' };
  lockDir = resolve(tempDir('ok-process-lock-read-cache-'), '.ok', LOCAL_DIR);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    lockFilePath(lockDir, LOCK_NAME),
    JSON.stringify(
      legacyServerLock({
        pid: process.pid,
        startedAt: startedAt.toISOString(),
        machineId: getMachineId(),
        worktreeRoot: lockDir,
      }),
    ),
    'utf-8',
  );
});

describe('reading a live server lock repeatedly', () => {
  test('readProcessLock reads the holder start once inside the maximum age', () => {
    expect(readProcessLock({ lockName: LOCK_NAME, lockDir })?.pid).toBe(process.pid);
    startReads.nowMs += LOCK_READ_MAX_AGE_MS - 1;
    expect(readProcessLock({ lockName: LOCK_NAME, lockDir })?.pid).toBe(process.pid);
    expect(startReads.pids).toEqual([process.pid]);
  });

  test('readProcessLockDetailed reads the holder start once inside the maximum age', () => {
    expect(readProcessLockDetailed({ lockName: LOCK_NAME, lockDir }).status).toBe('live');
    startReads.nowMs += LOCK_READ_MAX_AGE_MS - 1;
    expect(readProcessLockDetailed({ lockName: LOCK_NAME, lockDir }).status).toBe('live');
    expect(startReads.pids).toEqual([process.pid]);
  });

  test('reads the holder start again once the reading reaches the maximum age', () => {
    readProcessLock({ lockName: LOCK_NAME, lockDir });
    startReads.nowMs += LOCK_READ_MAX_AGE_MS;
    readProcessLockDetailed({ lockName: LOCK_NAME, lockDir });
    expect(startReads.pids).toEqual([process.pid, process.pid]);
  });
});
