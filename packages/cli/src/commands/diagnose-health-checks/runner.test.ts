/**
 * Runner tests — verify the timeout and crash-protection
 * contracts in isolation from any check implementation.
 */

import { describe, expect, test } from 'bun:test';
import { type CheckDefinition, DEFAULT_CHECK_TIMEOUT_MS, runCheck } from './index.ts';

const fakeCtx = { cwd: '/tmp/runner-test' };

describe('runCheck', () => {
  test('returns the result when the check resolves under the timeout', async () => {
    const def: CheckDefinition = {
      name: 'git',
      run: async () => ({ name: 'git', status: 'pass', summary: 'ok' }),
    };
    const result = await runCheck(def, fakeCtx);
    expect(result).toEqual({ name: 'git', status: 'pass', summary: 'ok' });
  });

  test('surfaces a fail when the check exceeds the timeout', async () => {
    const def: CheckDefinition = {
      name: 'git',
      run: async () =>
        new Promise(() => {
          // never resolves
        }),
    };
    const result = await runCheck(def, fakeCtx, { timeoutMs: 50 });
    expect(result.name).toBe('git');
    expect(result.status).toBe('fail');
    expect(result.summary).toMatch(/timed out/i);
  });

  test('surfaces a fail when the check throws (sync throw inside async)', async () => {
    const def: CheckDefinition = {
      name: 'bun',
      run: async () => {
        throw new Error('boom');
      },
    };
    const result = await runCheck(def, fakeCtx);
    expect(result.name).toBe('bun');
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('crashed');
    expect(result.summary).toContain('boom');
  });

  test('surfaces a fail when the check rejects with a non-Error value', async () => {
    const def: CheckDefinition = {
      name: 'bun',
      run: async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'string error';
      },
    };
    const result = await runCheck(def, fakeCtx);
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('crashed: string error');
  });

  test('default timeout is the spec-defined 5000 ms', () => {
    expect(DEFAULT_CHECK_TIMEOUT_MS).toBe(5000);
  });

  test('does not produce an unhandled rejection when a timed-out check later rejects', async () => {
    // The bug: Promise.race resolves with the timeout result, but the
    // underlying `def.run(ctx)` promise is still in flight. If it later
    // rejects, the rejection has no handler attached and Bun terminates
    // the process on unhandled rejections by default. The runner's job
    // is to keep the orphaned promise quiet.
    //
    // We capture `process` listeners around the test so any unhandled
    // rejection during this scope is caught here rather than tripping
    // Bun's default behavior.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const def: CheckDefinition = {
        name: 'slow-then-throws',
        run: () =>
          new Promise((_resolve, reject) => {
            // Rejects AFTER the timeout fires.
            setTimeout(() => reject(new Error('post-timeout failure')), 100);
          }),
      };

      const result = await runCheck(def, fakeCtx, { timeoutMs: 30 });
      expect(result.status).toBe('fail');
      expect(result.summary).toMatch(/timed out/i);

      // Give the orphaned promise time to reject + propagate. 200 ms is
      // generous — the inner promise rejects at +100 ms, microtasks drain
      // synchronously, the unhandled-rejection event would fire by now.
      await new Promise((r) => setTimeout(r, 200));

      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
