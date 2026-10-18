import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, type MockInstance, test, vi } from 'vitest';
import { createTempDirFactory } from '../../../test-support/temp-dir.test-helper.ts';
import { getLogger } from './logger.ts';
import type { ProcessStart } from './process-identity.ts';
import { acquireProcessLock, type ProcessLockMetadata } from './process-lock.ts';
import { acquireLock, type LockMetadata, releaseLock } from './shadow-lock.ts';

const ownStart = vi.hoisted(() => ({ value: null as ProcessStart | null }));

vi.mock('./process-identity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./process-identity.ts')>();
  return {
    ...actual,
    readProcessStart: (pid: number, options?: Parameters<typeof actual.readProcessStart>[1]) =>
      pid === process.pid ? ownStart.value : actual.readProcessStart(pid, options),
  };
});

const UNRECORDED_START_EVENT = 'process-start-unrecorded';
const tempDir = createTempDirFactory(afterEach);

const unrecordedStarts: ReadonlyArray<{ reason: string; start: ProcessStart | null }> = [
  { reason: 'start-unreadable', start: null },
  {
    reason: 'boot-id-unreadable',
    start: { startedAtMs: 1_700_000_000_000, clock: 'boot-derived', startTicks: 4_200 },
  },
];

const READABLE_START: ProcessStart = { startedAtMs: 1_700_000_000_000, clock: 'creation' };

afterEach(() => {
  ownStart.value = null;
  vi.restoreAllMocks();
});

function unrecordedStartWarnings(warn: MockInstance<(data: unknown, message: string) => void>) {
  return warn.mock.calls.filter(
    ([fields]) => (fields as { event?: unknown } | undefined)?.event === UNRECORDED_START_EVENT,
  );
}

function acquireServerLock(): ProcessLockMetadata {
  const lockDir = resolve(tempDir('ok-unrecorded-start-'), '.ok', LOCAL_DIR);
  const handle = acquireProcessLock({
    lockName: 'server',
    lockDir,
    metadata: { port: 0, worktreeRoot: lockDir },
  });
  try {
    return JSON.parse(readFileSync(handle.lockPath, 'utf-8')) as ProcessLockMetadata;
  } finally {
    handle.release();
  }
}

function acquireShadowLock(): LockMetadata {
  const shadowDir = resolve(tempDir('ok-unrecorded-start-shadow-'), 'shadow');
  mkdirSync(shadowDir, { recursive: true });
  const lockPath = acquireLock(shadowDir, shadowDir);
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8')) as LockMetadata;
  } finally {
    releaseLock(shadowDir);
  }
}

const lockWriters: ReadonlyArray<{
  lock: string;
  logger: string;
  acquire: () => { pid: number; processStart?: unknown };
}> = [
  { lock: 'server', logger: 'process-lock', acquire: acquireServerLock },
  { lock: 'shadow', logger: 'shadow-lock', acquire: acquireShadowLock },
];

describe.each(lockWriters)(
  'a $lock lock written by a process that cannot record its own start',
  ({ logger, acquire }) => {
    test.each(unrecordedStarts)(
      'logs one warning naming the cause ($reason)',
      ({ reason, start }) => {
        ownStart.value = start;
        const warn = vi.spyOn(getLogger(logger), 'warn');

        const lock = acquire();

        expect(lock.pid).toBe(process.pid);
        expect(lock).not.toHaveProperty('processStart');
        const warnings = unrecordedStartWarnings(warn);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.[0]).toEqual({
          event: UNRECORDED_START_EVENT,
          platform: process.platform,
          reason,
        });
        expect(warnings[0]?.[1]).toContain('startedAt');
      },
    );

    test('records the start and logs no such warning when the start is readable', () => {
      ownStart.value = READABLE_START;
      const warn = vi.spyOn(getLogger(logger), 'warn');

      const lock = acquire();

      expect(lock.processStart).toEqual({ startedAtMs: READABLE_START.startedAtMs });
      expect(unrecordedStartWarnings(warn)).toEqual([]);
    });
  },
);
