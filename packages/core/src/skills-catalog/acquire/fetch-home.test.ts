import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

const fakeHome = vi.hoisted(() => ({ dir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome.dir };
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

  test('expands ~ followed by a backslash', async () => {
    await expect(fetchSource({ kind: 'local', path: '~\\skills' })).rejects.toThrow(
      `Local path not found: ${fakeHome.dir}\\skills`,
    );
  });
});
