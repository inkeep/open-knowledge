import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { BacklinkIndex } from './backlink-index.ts';

const crash = vi.hoisted(() => ({ armed: false }));

vi.mock('./fs-traced.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fs-traced.ts')>();
  return {
    ...actual,
    tracedAtomicFs: {
      writeFile: async (path: string, content: string, opts: { encoding: 'utf-8' }) => {
        if (!crash.armed) return actual.tracedAtomicFs.writeFile(path, content, opts);
        await writeFile(path, content.slice(0, Math.floor(content.length / 2)), opts);
        throw new Error('simulated crash mid-write');
      },
      rename: (from: string, to: string) => actual.tracedAtomicFs.rename(from, to),
    },
  };
});

afterEach(() => {
  crash.armed = false;
});

describe('BacklinkIndex cache save interrupted mid-write', () => {
  test('leaves the previous good snapshot intact and loadable', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-interrupted-'));
    const contentDir = join(projectDir, 'content');
    const cachePath = join(projectDir, '.ok', LOCAL_DIR, 'cache', 'main', 'backlinks.json');
    mkdirSync(contentDir, { recursive: true });
    try {
      writeFileSync(join(contentDir, 'alpha.md'), 'See [[beta]].\n');
      writeFileSync(join(contentDir, 'beta.md'), '# Beta\n');
      const first = new BacklinkIndex({ projectDir, contentDir });
      await first.rebuildFromDisk();
      await first.saveToDisk();
      const good = readFileSync(cachePath, 'utf-8');

      writeFileSync(join(contentDir, 'gamma.md'), 'See [[beta]] too.\n');
      await first.rebuildFromDisk();
      crash.armed = true;
      await expect(first.saveToDisk()).rejects.toThrow('simulated crash mid-write');
      crash.armed = false;

      expect(readFileSync(cachePath, 'utf-8')).toBe(good);
      const second = new BacklinkIndex({ projectDir, contentDir });
      expect(await second.loadFromDisk()).toBe(true);
      expect(second.getBacklinks('beta').map((link) => link.source)).toEqual(['alpha']);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
