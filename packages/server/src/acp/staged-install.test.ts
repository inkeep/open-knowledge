/**
 * Shared staged-install primitives: the bounded rename retry (Windows
 * share-violation resilience) and the stale-artifact sweep both install
 * paths rely on. The end-to-end commit flow is covered through its callers
 * in `launch.test.ts` and `managed-runtime.test.ts`.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { getLogger } from '../logger.ts';
import { cleanupStaleInstallArtifacts, renameWithRetries } from './staged-install.ts';

const log = getLogger('staged-install-test');

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'staged-install-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe('renameWithRetries', () => {
  test('retries transient share-violation codes until the handle is released', async () => {
    let calls = 0;
    await renameWithRetries('from', 'to', {
      baseDelayMs: 1,
      renameImpl: async () => {
        calls += 1;
        if (calls < 3) throw errnoError('EPERM');
      },
    });
    expect(calls).toBe(3);
  });

  test('rethrows non-transient codes without retrying', async () => {
    let calls = 0;
    await expect(
      renameWithRetries('from', 'to', {
        baseDelayMs: 1,
        renameImpl: async () => {
          calls += 1;
          throw errnoError('ENOENT');
        },
      }),
    ).rejects.toThrow('ENOENT');
    expect(calls).toBe(1);
  });

  test('gives up once the retry budget is spent', async () => {
    let calls = 0;
    await expect(
      renameWithRetries('from', 'to', {
        attempts: 3,
        baseDelayMs: 1,
        renameImpl: async () => {
          calls += 1;
          throw errnoError('EBUSY');
        },
      }),
    ).rejects.toThrow('EBUSY');
    expect(calls).toBe(3);
  });
});

describe('cleanupStaleInstallArtifacts', () => {
  test('sweeps stale staging dirs, lockfiles, and failure markers; keeps everything else', async () => {
    const dir = tmp();
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    const age = (path: string) => utimesSync(path, staleTime, staleTime);

    const staleStaging = join(dir, '.install-1.0.0-dead');
    mkdirSync(staleStaging);
    age(staleStaging);
    const staleLock = join(dir, '1.0.0.install.lock');
    writeFileSync(staleLock, 'held');
    age(staleLock);
    const staleMarker = join(dir, '.install-failed-1.0.0');
    writeFileSync(staleMarker, '{}');
    age(staleMarker);

    const freshLock = join(dir, '2.0.0.install.lock');
    writeFileSync(freshLock, 'held');
    const versionDir = join(dir, '1.0.0');
    mkdirSync(versionDir);
    const unrelated = join(dir, 'unrelated.txt');
    writeFileSync(unrelated, 'keep');
    age(unrelated);

    await cleanupStaleInstallArtifacts(dir, log, '[test]');

    expect(existsSync(staleStaging)).toBe(false);
    expect(existsSync(staleLock)).toBe(false);
    expect(existsSync(staleMarker)).toBe(false);
    expect(existsSync(freshLock)).toBe(true);
    expect(existsSync(versionDir)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  test('a missing parent dir is a no-op', async () => {
    await expect(
      cleanupStaleInstallArtifacts(join(tmp(), 'never-created'), log, '[test]'),
    ).resolves.toBeUndefined();
  });
});
