import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  processStartTokenFromOs,
  processStartTokenOffsetFromOs,
} from '../../../test-support/os-process-start.test-helper.ts';
import {
  legacyServerLock,
  lockWrittenBeforeProcessStarted,
  lockWrittenByRunningProcess,
  type OwnedProcess,
  ownedProcessHasExited,
  startOwnedProcess,
  stopOwnedProcess,
} from '../../../test-support/owned-process.test-helper.ts';
import { createTempDirFactory } from '../../../test-support/temp-dir.test-helper.ts';
import { getLogger } from './logger.ts';
import { getMachineId } from './machine-id.ts';
import {
  acquireProcessLock,
  type LockName,
  lockFilePath,
  ProcessLockCollisionError,
  type ProcessLockHandle,
  type ProcessLockMetadata,
  readProcessLock,
  readProcessLockDetailed,
} from './process-lock.ts';

const LOCK_NAME: LockName = 'server';
const tempDir = createTempDirFactory(afterEach);
const owned: OwnedProcess[] = [];

let lockDir: string;
let lockPath: string;

beforeEach(() => {
  lockDir = resolve(tempDir('ok-process-lock-holder-'), '.ok', LOCAL_DIR);
  lockPath = lockFilePath(lockDir, LOCK_NAME);
});

afterEach(async () => {
  for (const holder of owned.splice(0)) await stopOwnedProcess(holder);
});

async function startHolder(): Promise<OwnedProcess> {
  const holder = await startOwnedProcess();
  owned.push(holder);
  return holder;
}

function writeLock(lock: Record<string, unknown>): void {
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(lockPath, JSON.stringify(lock), 'utf-8');
}

function lockNaming(
  holder: OwnedProcess,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...legacyServerLock({
      pid: holder.pid,
      startedAt: lockWrittenBeforeProcessStarted(holder),
      machineId: getMachineId(),
      worktreeRoot: '/previous/boot',
    }),
    ...overrides,
  };
}

function acquireForNewServer(): ProcessLockHandle {
  return acquireProcessLock({
    lockName: LOCK_NAME,
    lockDir,
    metadata: { port: 0, worktreeRoot: '/new/boot' },
  });
}

describe.skipIf(process.platform === 'win32')(
  'a live lock whose recorded process start carries a field this release does not know',
  () => {
    test('readProcessLock still matches the holder and returns the token without that field', async () => {
      const holder = await startHolder();
      const processStart = processStartTokenFromOs(holder.pid);
      writeLock(lockNaming(holder, { processStart: { ...processStart, namespace: 'pid:[1]' } }));

      expect(readProcessLock({ lockName: LOCK_NAME, lockDir })?.processStart).toEqual(processStart);
    });

    test('readProcessLock drops a process start it cannot read', async () => {
      const holder = await startHolder();
      writeLock(
        lockNaming(holder, {
          startedAt: lockWrittenByRunningProcess(holder),
          processStart: { startedAtMs: 'soon' },
        }),
      );

      const lock = readProcessLock({ lockName: LOCK_NAME, lockDir });
      expect(lock?.pid).toBe(holder.pid);
      expect(lock).not.toHaveProperty('processStart');
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  'a lock whose recorded process start matches its holder, though its startedAt is 36 h older',
  () => {
    test('acquireProcessLock still collides', async () => {
      const holder = await startHolder();
      writeLock(lockNaming(holder, { processStart: processStartTokenFromOs(holder.pid) }));

      expect(acquireForNewServer).toThrow(ProcessLockCollisionError);
      const md: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
      expect(md.pid).toBe(holder.pid);
    });

    test('readProcessLock returns the live lock', async () => {
      const holder = await startHolder();
      writeLock(lockNaming(holder, { processStart: processStartTokenFromOs(holder.pid) }));

      expect(readProcessLock({ lockName: LOCK_NAME, lockDir })).toMatchObject({ pid: holder.pid });
    });

    test('readProcessLockDetailed reports the lock live, carrying its process start', async () => {
      const holder = await startHolder();
      const processStart = processStartTokenFromOs(holder.pid);
      writeLock(lockNaming(holder, { processStart }));

      expect(readProcessLockDetailed({ lockName: LOCK_NAME, lockDir })).toMatchObject({
        status: 'live',
        lock: { pid: holder.pid, processStart },
      });
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  'a lock whose holder started after it was written',
  () => {
    test('readProcessLock reports no live server and leaves the lock on disk', async () => {
      const holder = await startHolder();
      writeLock(lockNaming(holder));

      expect(readProcessLock({ lockName: LOCK_NAME, lockDir })).toBeNull();
      expect(existsSync(lockPath)).toBe(true);
    });

    test('readProcessLockDetailed reports the lock stale and leaves it on disk', async () => {
      const holder = await startHolder();
      writeLock(lockNaming(holder));

      expect(readProcessLockDetailed({ lockName: LOCK_NAME, lockDir })).toMatchObject({
        status: 'stale',
      });
      expect(existsSync(lockPath)).toBe(true);
    });

    test('acquireProcessLock still collides when the lock was written on another machine', async () => {
      const holder = await startHolder();
      writeLock(
        lockNaming(holder, {
          machineId: 'some-other-machine-id',
          hostname: `${hostname()}-elsewhere`,
        }),
      );
      const warn = vi.spyOn(getLogger('process-lock'), 'warn');

      try {
        expect(acquireForNewServer).toThrow(ProcessLockCollisionError);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            lockPid: holder.pid,
            holder: 'unverified',
            cause: 'foreign-host',
          }),
          expect.stringContaining(`Could not confirm that pid=${holder.pid}`),
        );
      } finally {
        warn.mockRestore();
      }
      const md: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
      expect(md.pid).toBe(holder.pid);
      expect(ownedProcessHasExited(holder)).toBe(false);
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  'a lock whose recorded process start is later than its holder started',
  () => {
    test('readProcessLock still returns the live lock', async () => {
      const holder = await startHolder();
      writeLock(lockNaming(holder, { processStart: processStartTokenOffsetFromOs(holder.pid, 5) }));

      expect(readProcessLock({ lockName: LOCK_NAME, lockDir })).toMatchObject({
        pid: holder.pid,
      });
    });

    test('readProcessLockDetailed reports the lock live', async () => {
      const holder = await startHolder();
      writeLock(lockNaming(holder, { processStart: processStartTokenOffsetFromOs(holder.pid, 5) }));

      expect(readProcessLockDetailed({ lockName: LOCK_NAME, lockDir })).toMatchObject({
        status: 'live',
        lock: { pid: holder.pid },
      });
    });
  },
);
