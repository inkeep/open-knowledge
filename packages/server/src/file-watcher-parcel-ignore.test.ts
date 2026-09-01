import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createContentFilter } from './content-filter.ts';
import { startWatcher } from './file-watcher.ts';

const subscribeCalls: Array<{ dir: string; ignore: string[] | undefined }> = [];

vi.mock('@parcel/watcher', () => {
  const subscribe = async (
    dir: string,
    _onEvent: unknown,
    opts?: { ignore?: string[] },
  ): Promise<{ unsubscribe: () => Promise<void> }> => {
    subscribeCalls.push({ dir, ignore: opts?.ignore });
    return { unsubscribe: async () => {} };
  };
  return { default: { subscribe }, subscribe };
});

describe('what startWatcher hands @parcel/watcher as `ignore`', () => {
  let contentDir: string;

  beforeEach(async () => {
    subscribeCalls.length = 0;
    contentDir = await mkdtemp(resolve(tmpdir(), 'ok-parcel-wiring-'));
  });

  afterEach(async () => {
    await rm(contentDir, { recursive: true, force: true });
  });

  test('prefix paths only, roots plus discovered nested dirs, no pattern', async () => {
    writeFileSync(
      resolve(contentDir, '.gitignore'),
      ['dist/', '*.log', 'build/**', '**/*.tmp', 'a[0-9]/'].join('\n'),
    );
    mkdirSync(resolve(contentDir, 'packages/app/node_modules'), { recursive: true });
    mkdirSync(resolve(contentDir, 'notes'), { recursive: true });
    writeFileSync(resolve(contentDir, 'notes/keep.md'), '# keep\n');

    const filter = createContentFilter({ projectDir: contentDir, contentDir });
    const watcher = await startWatcher(contentDir, async () => {}, filter, {
      forceBackend: 'parcel',
    });

    try {
      expect(subscribeCalls).toHaveLength(1);
      const ignore = subscribeCalls[0].ignore ?? [];

      expect(ignore.length).toBeGreaterThan(0);
      for (const entry of ignore) {
        expect(entry).not.toMatch(/[*?[\]{}()!+@|\\]/);
      }

      expect(ignore).toEqual(
        expect.arrayContaining([
          '.git',
          'node_modules',
          '.ok/local',
          '.ok/worktrees',
          'packages/app/node_modules',
        ]),
      );

      expect(ignore).not.toContain('dist/');
      expect(ignore).not.toContain('*.log');
      expect(ignore).not.toContain('build/**');
    } finally {
      await watcher.unsubscribe();
    }
  });
});
