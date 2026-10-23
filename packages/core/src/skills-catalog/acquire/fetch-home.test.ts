import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { afterAll, afterEach, describe, expect, onTestFinished, test, vi } from 'vitest';

const fakeHome = vi.hoisted(() => ({ dir: '' }));
const pathResolution = vi.hoisted(() => ({ win32: false }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome.dir };
});

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return {
    ...actual,
    resolve: (...paths: string[]) =>
      pathResolution.win32
        ? actual.win32
            .resolve('C:\\', ...paths)
            .slice(2)
            .replaceAll('\\', '/')
        : actual.resolve(...paths),
  };
});

const { tmpdir } = await vi.importActual<typeof import('node:os')>('node:os');
const { fetchSource } = await import('./fetch.ts');

fakeHome.dir = mkdtempSync(join(tmpdir(), 'ok-fake-home-'));
mkdirSync(join(fakeHome.dir, 'skills'));

afterAll(() => rmSync(fakeHome.dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

describe('fetchSource home expansion', () => {
  test('expands ~ through os.homedir(), not HOME', async () => {
    vi.stubEnv('HOME', join(fakeHome.dir, 'not-home'));
    const fetched = await fetchSource({ kind: 'local', path: '~/skills' });
    expect(fetched.dir).toBe(join(fakeHome.dir, 'skills'));
  });

  test.runIf(sep === '/')(
    'rejects ~ followed by a backslash as a missing path under POSIX resolution',
    async () => {
      await expect(fetchSource({ kind: 'local', path: '~\\skills' })).rejects.toThrow(
        `Local path not found: ${fakeHome.dir}\\skills`,
      );
    },
  );

  test.runIf(sep === '\\')(
    'expands ~ followed by a backslash to the home directory on Windows',
    async () => {
      const fetched = await fetchSource({ kind: 'local', path: '~\\skills' });
      expect(fetched.dir).toBe(join(fakeHome.dir, 'skills'));
    },
  );

  test.runIf(sep === '/')(
    'expands ~ followed by a backslash to the home directory under win32 resolution',
    async () => {
      onTestFinished(() => {
        pathResolution.win32 = false;
      });
      pathResolution.win32 = true;
      const fetched = await fetchSource({ kind: 'local', path: '~\\skills' });
      expect(fetched.dir).toBe(join(fakeHome.dir, 'skills'));
    },
  );
});
