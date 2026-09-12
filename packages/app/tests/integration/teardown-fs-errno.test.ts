import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  removeAllDuringTeardown,
  removeAllStrictDuringTeardown,
  runTeardownPhases,
} from '../stress/_helpers/teardown-fs.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

const mockedRm = vi.mocked(rmSync);

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`rm ${code}`), { code });
}

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
    mockedRm.mockImplementation(() => {});
    removeAllDuringTeardown('/tmp/a');
    const options = mockedRm.mock.calls[0]?.[1] as { maxRetries?: number } | undefined;
    expect(options?.maxRetries).toBeGreaterThan(0);
  });

  test.each(['EBUSY', 'ENOTEMPTY', 'EPERM'])(
    'tolerates %s rather than failing a run whose tests have all passed',
    (code) => {
      rmFailingOn('/tmp/busy', errnoError(code));
      expect(() => removeAllDuringTeardown('/tmp/busy')).not.toThrow();
    },
  );

  test.each(['EBUSY', 'ENOTEMPTY', 'EPERM'])(
    'still reclaims the remaining targets after a tolerated %s',
    (code) => {
      rmFailingOn('/tmp/busy', errnoError(code));
      removeAllDuringTeardown('/tmp/busy', '/tmp/second', '/tmp/third');
      expect(mockedRm).toHaveBeenCalledWith('/tmp/second', expect.anything());
      expect(mockedRm).toHaveBeenCalledWith('/tmp/third', expect.anything());
    },
  );

  test('warns on a tolerated failure so a genuinely leaked directory leaves a trace', () => {
    rmFailingOn('/tmp/busy', errnoError('EBUSY'));
    removeAllDuringTeardown('/tmp/busy');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('EBUSY');
    expect(String(warn.mock.calls[0]?.[0])).toContain('/tmp/busy');
  });

  test.each(['EMFILE', 'ENFILE', 'EACCES', 'ENOTDIR', 'EINVAL', undefined])(
    'rethrows %s rather than hiding it',
    (code) => {
      const err = code === undefined ? new Error('not an errno at all') : errnoError(code);
      mockedRm.mockImplementation(() => {
        throw err;
      });
      expect(() => removeAllDuringTeardown('/tmp/a')).toThrow(err);
    },
  );

  test('reclaims every remaining target before rethrowing an untolerated errno', () => {
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

describe('removeAllStrictDuringTeardown', () => {
  test('attempts every target even after one throws, and rethrows the first failure', () => {
    const first = errnoError('EBUSY');
    const second = errnoError('EPERM');
    const seen: string[] = [];
    mockedRm.mockImplementation((target) => {
      seen.push(target as string);
      if (target === '/tmp/one') throw first;
      if (target === '/tmp/two') throw second;
    });
    expect(() => removeAllStrictDuringTeardown('/tmp/one', '/tmp/two', '/tmp/three')).toThrow(
      first,
    );
    expect(seen).toEqual(['/tmp/one', '/tmp/two', '/tmp/three']);
  });

  test('tolerates nothing, unlike its sibling', () => {
    const tolerated = errnoError('ENOTEMPTY');
    mockedRm.mockImplementation(() => {
      throw tolerated;
    });
    expect(() => removeAllStrictDuringTeardown('/tmp/one')).toThrow(tolerated);
    expect(() => removeAllDuringTeardown('/tmp/one')).not.toThrow();
  });

  test('retries a removal rather than giving it one attempt', () => {
    mockedRm.mockImplementation(() => {});
    removeAllStrictDuringTeardown('/tmp/one');
    expect(mockedRm).toHaveBeenCalledWith('/tmp/one', expect.objectContaining({ maxRetries: 3 }));
  });
});

describe('runTeardownPhases', () => {
  test('runs every phase even after one throws, and rethrows the first failure', async () => {
    const first = new Error('phase one');
    const ran: string[] = [];
    await expect(
      runTeardownPhases(
        async () => {
          ran.push('one');
          throw first;
        },
        () => {
          ran.push('two');
          throw new Error('phase two');
        },
        () => {
          ran.push('three');
        },
      ),
    ).rejects.toBe(first);
    expect(ran).toEqual(['one', 'two', 'three']);
  });

  test('resolves when every phase succeeds', async () => {
    await expect(
      runTeardownPhases(
        () => {},
        async () => {},
      ),
    ).resolves.toBeUndefined();
  });
});
