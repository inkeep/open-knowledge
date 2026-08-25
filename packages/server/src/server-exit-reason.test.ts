import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { bootCompositionRig } from './composition-rig.test-helper.ts';
import type { PinoLogger } from './logger.ts';

/**
 * Shutdown records WHY the server exited. Without it an external stop, an idle
 * self-reap, and the host going away leave byte-identical logs, so the whole
 * class is invisible after the fact.
 */
interface Entry {
  level: string;
  msg: string;
  payload: Record<string, unknown>;
}

function captureLog(): { log: PinoLogger; entries: Entry[] } {
  const entries: Entry[] = [];
  const record =
    (level: string) =>
    (data: unknown, message?: string): void => {
      entries.push({
        level,
        msg: message ?? '',
        payload: (data as Record<string, unknown>) ?? {},
      });
    };
  const log = {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    trace: record('trace'),
    fatal: record('fatal'),
  } as unknown as PinoLogger;
  return { log, entries };
}

describe('server exit reason', () => {
  test('an external signal teardown records the reason', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'ok-exit-reason-'));
    const { log, entries } = captureLog();
    const booted = await bootCompositionRig(dir, { log });
    await booted.ready;
    try {
      await booted.destroy('external-signal');
      const record = entries.find((e) => e.msg.includes('shutdown initiated'));
      expect(record).toBeDefined();
      expect(record?.payload.reason).toBe('external-signal');
      expect(record?.payload.pid).toBe(process.pid);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('an idle self-reap records a different reason than an external stop', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'ok-exit-reason-idle-'));
    const { log, entries } = captureLog();
    let fireIdle: (() => Promise<void>) | undefined;
    const booted = await bootCompositionRig(dir, {
      log,
      // Boot wires the handler around its own destroy; capture it instead of
      // waiting out a real idle window.
      idleShutdownMs: 60_000,
      idleShutdownHandler: (destroyServer) => {
        fireIdle = destroyServer;
        return async () => {
          await destroyServer();
        };
      },
    });
    await booted.ready;
    try {
      expect(fireIdle).toBeDefined();
      await fireIdle?.();
      const record = entries.find((e) => e.msg.includes('shutdown initiated'));
      expect(record?.payload.reason).toBe('idle-shutdown');
    } finally {
      await booted.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('an unattributed teardown is recorded as unspecified, not as a stop', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'ok-exit-reason-plain-'));
    const { log, entries } = captureLog();
    const booted = await bootCompositionRig(dir, { log });
    await booted.ready;
    try {
      await booted.destroy();
      const record = entries.find((e) => e.msg.includes('shutdown initiated'));
      expect(record?.payload.reason).toBe('unspecified');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
