/**
 * Errno policy for the e2e teardown filesystem-removal path.
 *
 * The sibling `kill-gracefully-errno.test.ts` pins which SIGNAL errnos
 * teardown absorbs. This file pins the same question one layer over, for the
 * removals that reclaim a just-killed dev server's contentDir, Vite cacheDir
 * and log file: which removal errnos teardown absorbs, which it still lets
 * out, and that one failing target cannot stop the others being reclaimed.
 *
 * The motivating failure is the shape the signal policy was written for, one
 * layer over — a Playwright run where every test passed and the run still
 * reported failure, because a teardown throw escaped after the last test had
 * finished. Playwright counts that as "N errors were not a part of any test":
 * a red run with a completely green report, and in the merge queue an ejection
 * that rebuilds everything behind it.
 *
 * `rmSync`'s `force` option only suppresses ENOENT; EBUSY, ENOTEMPTY and EPERM
 * still throw, and its `maxRetries` defaults to 0. Those three are what a Vite
 * optimizer or file-watcher still holding a handle produces while teardown
 * deletes the directory under it — so they are injected here at the `rmSync`
 * boundary rather than raced for against a real watcher.
 *
 * The mock factory spreads the real `node:fs`, so every other call in this file
 * (`mkdtempSync`, `existsSync`) is the genuine syscall and `rmSync` itself
 * falls back to the real one whenever a test does not override it.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { removeAllDuringTeardown } from '../stress/_helpers/teardown-fs.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

const mockedRm = vi.mocked(rmSync);

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`rm ${code}`), { code });
}

/** Fail only on `failing`; every other target removes cleanly. */
function rmFailingOn(failing: string, err: NodeJS.ErrnoException) {
  mockedRm.mockImplementation((target) => {
    if (target === failing) throw err;
  });
  return mockedRm;
}

let warn: ReturnType<typeof vi.spyOn<Console, 'warn'>>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  // `mockReset` restores the implementation `vi.fn(actual.rmSync)` was built
  // with, so the next test starts from the real syscall again.
  mockedRm.mockReset();
  vi.restoreAllMocks();
});

describe('removeAllDuringTeardown removal policy', () => {
  test('removes every target, recursively and forcefully', () => {
    mockedRm.mockImplementation(() => {});
    removeAllDuringTeardown('/tmp/a', '/tmp/b', '/tmp/c');
    expect(mockedRm).toHaveBeenCalledTimes(3);
    for (const target of ['/tmp/a', '/tmp/b', '/tmp/c']) {
      expect(mockedRm).toHaveBeenCalledWith(
        target,
        expect.objectContaining({ recursive: true, force: true }),
      );
    }
  });

  test('retries transient removals instead of giving up on the first refusal', () => {
    // `maxRetries` engages Node's own linear backoff over the errnos it treats
    // as transient, so a watcher that closes its handle a moment later is
    // actually reclaimed rather than tolerated and leaked.
    mockedRm.mockImplementation(() => {});
    removeAllDuringTeardown('/tmp/a');
    const options = mockedRm.mock.calls[0]?.[1] as { maxRetries?: number } | undefined;
    expect(options?.maxRetries).toBeGreaterThan(0);
  });

  test.each([
    'EBUSY',
    'ENOTEMPTY',
    'EPERM',
  ])('tolerates %s rather than failing a run whose tests have all passed', (code) => {
    rmFailingOn('/tmp/busy', errnoError(code));
    expect(() => removeAllDuringTeardown('/tmp/busy')).not.toThrow();
  });

  test.each([
    'EBUSY',
    'ENOTEMPTY',
    'EPERM',
  ])('still reclaims the remaining targets after a tolerated %s', (code) => {
    rmFailingOn('/tmp/busy', errnoError(code));
    removeAllDuringTeardown('/tmp/busy', '/tmp/second', '/tmp/third');
    // The bug: a throw on the first target skipped the two that followed it,
    // leaking a contentDir and a Vite cacheDir per teardown.
    expect(mockedRm).toHaveBeenCalledWith('/tmp/second', expect.anything());
    expect(mockedRm).toHaveBeenCalledWith('/tmp/third', expect.anything());
  });

  test('warns on a tolerated failure so a genuinely leaked directory leaves a trace', () => {
    rmFailingOn('/tmp/busy', errnoError('EBUSY'));
    removeAllDuringTeardown('/tmp/busy');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('EBUSY');
    expect(String(warn.mock.calls[0]?.[0])).toContain('/tmp/busy');
  });

  test.each([
    'EMFILE',
    'ENFILE',
    'EACCES',
    'ENOTDIR',
    'EINVAL',
    undefined,
  ])('rethrows %s rather than hiding it', (code) => {
    const err = code === undefined ? new Error('not an errno at all') : errnoError(code);
    mockedRm.mockImplementation(() => {
      throw err;
    });
    expect(() => removeAllDuringTeardown('/tmp/a')).toThrow(err);
  });

  test('reclaims every remaining target before rethrowing an untolerated errno', () => {
    // Losing the diagnosis is bad; leaking the other directories too is worse.
    const err = errnoError('EMFILE');
    rmFailingOn('/tmp/broken', err);
    expect(() => removeAllDuringTeardown('/tmp/broken', '/tmp/second', '/tmp/third')).toThrow(err);
    expect(mockedRm).toHaveBeenCalledWith('/tmp/second', expect.anything());
    expect(mockedRm).toHaveBeenCalledWith('/tmp/third', expect.anything());
  });

  test('rethrows the FIRST untolerated errno when several targets fail', () => {
    const first = errnoError('EMFILE');
    const second = errnoError('EACCES');
    mockedRm.mockImplementation((target) => {
      if (target === '/tmp/one') throw first;
      if (target === '/tmp/two') throw second;
    });
    expect(() => removeAllDuringTeardown('/tmp/one', '/tmp/two')).toThrow(first);
  });

  test('is silent on an absent path, which `force` already suppresses', () => {
    // Real syscalls, no injection: ENOENT must not reach the tolerate path and
    // must not warn, or every ordinary teardown would log.
    const dir = mkdtempSync(join(tmpdir(), 'ok-teardown-fs-'));
    expect(() => removeAllDuringTeardown(join(dir, 'never-existed'), dir)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(false);
  });

  test('accepts an empty target list without touching the filesystem', () => {
    mockedRm.mockImplementation(() => {});
    expect(() => removeAllDuringTeardown()).not.toThrow();
    expect(mockedRm).not.toHaveBeenCalled();
  });
});
