import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createRestartableServer } from '../packages/app/tests/integration/restartable-server.test-helper.ts';
import { createTestServer } from '../packages/app/tests/integration/test-harness.ts';
import { bootCompositionRig } from '../packages/server/src/composition-rig.test-helper.ts';
import { withTempDir } from './temp-dir.test-helper.ts';

async function withIsolatedTemp(fn: (root: string) => Promise<void>): Promise<void> {
  await withTempDir('ok-acquisition-cleanup-', async (root) => {
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(key, root);
    try {
      await fn(root);
    } finally {
      vi.unstubAllEnvs();
    }
  });
}

function callerHome(root: string, provided: boolean): string | undefined {
  const home = join(root, 'caller-home');
  mkdirSync(home);
  writeFileSync(join(home, 'keep.txt'), 'caller-owned');
  return provided ? home : undefined;
}

test.each([false, true])(
  'composition rig releases a rejected acquisition without deleting caller paths (provided home: %s)',
  async (provided) => {
    await withIsolatedTemp(async (root) => {
      const content = join(root, 'content');
      mkdirSync(content);
      writeFileSync(join(content, 'one.md'), '# One\n');
      mkdirSync(join(root, 'preview', '.ok'), { recursive: true });
      writeFileSync(join(root, 'preview', '.ok', 'config.yml'), '');
      const configHomedirOverride = callerHome(root, provided);
      const owner = await bootCompositionRig(content, {
        projectDir: join(root, 'preview'),
        ephemeral: true,
        singleDocRelPath: 'one.md',
      });
      try {
        await owner.ready;
        const before = readdirSync(root).sort();
        expect(before.some((name) => name.startsWith('ok-rig-home-'))).toBe(true);
        const failure: unknown = await bootCompositionRig(content, {
          configHomedirOverride,
        }).then(
          async (unexpected) => {
            await unexpected.destroy();
            return undefined;
          },
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toMatch(/content ownership is already held/i);
        expect.soft(readdirSync(root).sort()).toEqual(before);
        expect(readFileSync(join(content, 'one.md'), 'utf8')).toBe('# One\n');
        expect(readFileSync(join(root, 'caller-home', 'keep.txt'), 'utf8')).toBe('caller-owned');
      } finally {
        await owner.destroy();
      }
    });
  },
);

test.each([false, true])(
  'integration server releases a rejected acquisition without deleting caller paths (provided home: %s)',
  async (provided) => {
    await withIsolatedTemp(async (root) => {
      const configHomedirOverride = callerHome(root, provided);
      const owner = await createTestServer();
      try {
        const before = readdirSync(root).sort();
        expect(before.some((name) => name.startsWith('ok-test-home-'))).toBe(true);
        const failure: unknown = await createTestServer({
          contentDir: owner.contentDir,
          keepContentDir: true,
          configHomedirOverride,
        }).then(
          async (unexpected) => {
            await unexpected.cleanup();
            return undefined;
          },
          (error: unknown) => error,
        );
        expect(failure).toMatchObject({ name: 'ServerLockCollisionError' });
        expect.soft(readdirSync(root).sort()).toEqual(before);
        expect(existsSync(join(owner.contentDir, 'test-doc.md'))).toBe(true);
        expect(readFileSync(join(root, 'caller-home', 'keep.txt'), 'utf8')).toBe('caller-owned');
      } finally {
        await owner.cleanup();
      }
    });
  },
);

test.each([false, true])(
  'integration server releases owned paths when setup fails before the server exists (provided home: %s)',
  async (provided) => {
    await withIsolatedTemp(async (root) => {
      const configHomedirOverride = callerHome(root, provided);
      const missingProjectDir = join(root, 'missing-project');
      const before = readdirSync(root).sort();
      const failure: unknown = await createTestServer({
        configHomedirOverride,
        projectDir: missingProjectDir,
      }).then(
        async (unexpected) => {
          await unexpected.cleanup();
          return undefined;
        },
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        code: 'ENOENT',
        path: expect.stringMatching(/missing-project$/),
      });
      expect.soft(readdirSync(root).sort()).toEqual(before);
      expect(readFileSync(join(root, 'caller-home', 'keep.txt'), 'utf8')).toBe('caller-owned');
    });
  },
);

test.each([false, true])(
  'restartable server releases a rejected acquisition without deleting caller paths (provided home: %s)',
  async (provided) => {
    await withIsolatedTemp(async (root) => {
      const content = join(root, 'content');
      mkdirSync(content);
      writeFileSync(join(content, '.ok'), 'caller-owned file');
      const configHomedirOverride = callerHome(root, provided);
      const before = readdirSync(root).sort();
      const failure: unknown = await createRestartableServer({
        contentDir: content,
        configHomedirOverride,
      }).then(
        async (unexpected) => {
          await unexpected.shutdown();
          return undefined;
        },
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: 'EEXIST' });
      expect.soft(readdirSync(root).sort()).toEqual(before);
      expect(readFileSync(join(content, '.ok'), 'utf8')).toBe('caller-owned file');
      expect(readFileSync(join(root, 'caller-home', 'keep.txt'), 'utf8')).toBe('caller-owned');
    });
  },
);
