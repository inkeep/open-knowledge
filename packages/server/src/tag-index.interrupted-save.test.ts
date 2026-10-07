import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TagIndex } from './tag-index.ts';

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

describe('TagIndex snapshot save interrupted mid-write', () => {
  test('leaves the previous good snapshot intact and loadable', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-tag-interrupted-'));
    const contentDir = join(projectDir, 'content');
    const snapshotPath = join(projectDir, '.ok', 'local', 'cache', 'tags.json');
    mkdirSync(contentDir, { recursive: true });
    try {
      writeFileSync(join(contentDir, 'alpha.md'), 'Tag #before.\n');
      const first = new TagIndex({ projectDir, contentDir });
      await first.init();
      await first.saveToDisk();
      const good = readFileSync(snapshotPath, 'utf-8');

      writeFileSync(join(contentDir, 'beta.md'), 'Tag #after.\n');
      await first.reconcileWithDisk();
      crash.armed = true;
      await expect(first.saveToDisk()).rejects.toThrow('simulated crash mid-write');
      crash.armed = false;

      expect(readFileSync(snapshotPath, 'utf-8')).toBe(good);
      const second = new TagIndex({ projectDir, contentDir });
      expect(await second.loadFromDisk()).toBe(true);
      expect(second.getDocsForTag('before')).toEqual(['alpha']);
      expect(second.getDocsForTag('after')).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
