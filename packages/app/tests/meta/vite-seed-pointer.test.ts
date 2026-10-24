import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { APP_PACKAGE_ROOT } from '../stress/_helpers/server-process.ts';
import { withTempDir } from '../temp-dir.test-helper.ts';

const TEMP_DIR_PREFIX = 'ok-vite-seed-pointer-';

async function serverProcessFor(seedDir: string) {
  vi.stubEnv('OK_TEST_VITE_SEED_DIR', seedDir);
  vi.resetModules();
  try {
    return await import('../stress/_helpers/server-process.ts');
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
}

async function seedResolverFor(seedDir: string) {
  return (await serverProcessFor(seedDir)).resolveViteSeedDir;
}

describe('vite seed pointer resolution', () => {
  test('a published pointer names the generation workers copy', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (dir) => {
      const seedDir = join(dir, 'seed');
      const published = join(dir, 'published-generation');
      mkdirSync(published);
      writeFileSync(`${seedDir}.current`, `${published}\n`);
      const resolveSeed = await seedResolverFor(seedDir);
      expect(resolveSeed()).toBe(published);
    });
  });

  test('without a pointer, the legacy seed directory is used when it exists and nothing otherwise', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (dir) => {
      const seedDir = join(dir, 'seed');
      const resolveSeed = await seedResolverFor(seedDir);
      expect(resolveSeed()).toBeUndefined();
      mkdirSync(seedDir);
      expect(resolveSeed()).toBe(seedDir);
    });
  });

  test('a pointer that exists but cannot be read is reported with its path and errno', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (dir) => {
      const seedDir = join(dir, 'seed');
      const pointer = `${seedDir}.current`;
      mkdirSync(pointer);
      const resolveSeed = await seedResolverFor(seedDir);
      expect(() => resolveSeed()).toThrow(pointer);
      expect(() => resolveSeed()).toThrow('EISDIR');
    });
  });

  test('a pointer that cannot be read fails cache preparation and leaves no cache directory behind', async ({
    onTestFinished,
  }) => {
    await withTempDir(TEMP_DIR_PREFIX, async (dir) => {
      const seedDir = join(dir, 'seed');
      const pointer = `${seedDir}.current`;
      const { prepareViteCacheDir } = await serverProcessFor(seedDir);
      const cacheParent = join(APP_PACKAGE_ROOT, 'node_modules');
      const prefix = `unreadable-pointer-${randomUUID()}`;
      const prepared = () =>
        readdirSync(cacheParent).filter((name) => name.startsWith(`.vite-${prefix}-`));
      onTestFinished(() => {
        for (const name of prepared()) {
          rmSync(join(cacheParent, name), { recursive: true, force: true });
        }
      });
      const control = basename(prepareViteCacheDir(prefix));
      expect(prepared()).toEqual([control]);

      mkdirSync(pointer);
      expect(() => prepareViteCacheDir(prefix)).toThrow(pointer);
      expect(prepared()).toEqual([control]);
    });
  });
});
