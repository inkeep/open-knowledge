import type { Dirent } from 'node:fs';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { previewContent } from '@inkeep/open-knowledge';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type TraversalEntry, walkExceedsCap } from './fs-walk-budget.ts';

let tmpRoot: string;
let fixtureRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), 'ok-walk-budget-descent-'));
  fixtureRoot = realpathSync(tmpRoot);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function seedBulkBehindDirectorySymlink(fileCount: number, extension: string): string {
  const bulk = resolve(fixtureRoot, 'bulk');
  const root = resolve(fixtureRoot, 'root');
  mkdirSync(bulk, { recursive: true });
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(join(bulk, `f${i}${extension}`), '');
  }
  writeFileSync(join(root, 'a.md'), '# a');
  symlinkSync(bulk, join(root, 'linked'), process.platform === 'win32' ? 'junction' : undefined);
  return root;
}

describe('walkExceedsCap — async chunked yields', () => {
  test('yields the event loop between chunks of entries', async () => {
    const fakeEntries: TraversalEntry[] = Array.from({ length: 5000 }, (_, i) => ({
      name: `f${i}.md`,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    }));
    const fakeReaddir = (path: string): Promise<readonly TraversalEntry[]> =>
      Promise.resolve(path === '/fake/root' ? fakeEntries : []);

    let yieldsDuringWalk = 0;
    let walkCompleted = false;
    const tickCounter = (): void => {
      if (walkCompleted) return;
      yieldsDuringWalk += 1;
      setImmediate(tickCounter);
    };
    setImmediate(tickCounter);

    const truncated = await walkExceedsCap('/fake/root', 50_000, {
      descendSymlinks: false,
      readdirImpl: fakeReaddir,
      chunkYieldEvery: 500,
    });
    walkCompleted = true;

    expect(yieldsDuringWalk).toBeGreaterThanOrEqual(5);
    expect(truncated).toBe(false);
  });

  test('returns truncated=true when entry count exceeds cap', async () => {
    const fakeEntries: TraversalEntry[] = Array.from({ length: 100 }, (_, i) => ({
      name: `f${i}.md`,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    }));
    const fakeReaddir = (path: string): Promise<readonly TraversalEntry[]> =>
      Promise.resolve(path === '/fake/root' ? fakeEntries : []);

    const truncated = await walkExceedsCap('/fake/root', 10, {
      descendSymlinks: false,
      readdirImpl: fakeReaddir,
      chunkYieldEvery: 1000,
    });
    expect(truncated).toBe(true);
  });
});

describe('walkExceedsCap — descent parity with the traversal it guards', () => {
  test('reports over-cap when the bulk is reachable only through a directory symlink', async () => {
    const root = seedBulkBehindDirectorySymlink(60, '.md');

    const admittedByConsumer = previewContent({ projectDir: root, contentDir: root }).totalCount;
    expect(admittedByConsumer).toBe(61);

    expect(await walkExceedsCap(root, admittedByConsumer - 1, { descendSymlinks: true })).toBe(
      true,
    );
  });

  test('stays under cap when the symlinked bulk fits inside it', async () => {
    const root = seedBulkBehindDirectorySymlink(60, '.md');

    expect(await walkExceedsCap(root, 500, { descendSymlinks: true })).toBe(false);
  });

  test('terminates after a bounded number of directory reads on self-referencing symlinks', async () => {
    const root = resolve(fixtureRoot, 'cyclic');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.md'), '# a');
    const linkType = process.platform === 'win32' ? 'junction' : undefined;
    symlinkSync(root, join(root, 'self1'), linkType);
    symlinkSync(root, join(root, 'self2'), linkType);

    let directoriesRead = 0;
    const countingReaddir = async (path: string): Promise<readonly Dirent[]> => {
      directoriesRead += 1;
      return readdir(path, { withFileTypes: true });
    };

    const cap = 500;
    const entriesPerDirectory = 3;
    const symlinksPerDirectory = 2;
    const successfulReadsToExceedCap = Math.ceil((cap + 1) / entriesPerDirectory);
    const maxDirectoryReads = 1 + symlinksPerDirectory * successfulReadsToExceedCap;

    const verdict = await walkExceedsCap(root, cap, {
      descendSymlinks: true,
      readdirImpl: countingReaddir,
    });

    expect(verdict).toBe(true);
    expect(directoriesRead).toBeLessThanOrEqual(maxDirectoryReads);
  });

  test('a cyclic symlink does not by itself push a small tree over the cap', async () => {
    const root = resolve(fixtureRoot, 'cyclic-small');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.md'), '# a');
    symlinkSync(root, join(root, 'self'), process.platform === 'win32' ? 'junction' : undefined);

    expect(await walkExceedsCap(root, 500, { descendSymlinks: true })).toBe(false);
  });
});

function seedBulk(name: string, fileCount: number): string {
  const bulk = resolve(fixtureRoot, name);
  mkdirSync(bulk, { recursive: true });
  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(join(bulk, `f${i}.md`), '');
  }
  return bulk;
}

function seedRootWithSymlinks(
  name: string,
  symlinks: readonly (readonly [string, string])[],
): string {
  const root = resolve(fixtureRoot, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'a.md'), '# a');
  for (const [linkName, target] of symlinks) {
    const absoluteTarget = resolve(root, target);
    const targetIsDirectory =
      statSync(absoluteTarget, { throwIfNoEntry: false })?.isDirectory() ?? false;
    symlinkSync(
      absoluteTarget,
      join(root, linkName),
      process.platform === 'win32' ? (targetIsDirectory ? 'junction' : 'file') : undefined,
    );
  }
  return root;
}

describe('walkExceedsCap — symlinked entries the traversal does not count through', () => {
  test.each(['node_modules', '.git'])(
    'does not count through a directory symlink named %s',
    async (excludedName) => {
      seedBulk('excluded-name-bulk', 60);
      const root = seedRootWithSymlinks('excluded-name-root', [
        [excludedName, '../excluded-name-bulk'],
      ]);

      expect(previewContent({ projectDir: root, contentDir: root }).totalCount).toBe(1);

      expect(await walkExceedsCap(root, readdirSync(root).length, { descendSymlinks: true })).toBe(
        false,
      );
    },
  );

  test('a symlink pointing at a file leaves the verdict unchanged', async () => {
    const bulkFileCount = 60;
    seedBulk('shared-bulk', bulkFileCount);
    const baseline = seedRootWithSymlinks('baseline-root', [['linked', '../shared-bulk']]);
    const withFileSymlink = seedRootWithSymlinks('file-symlink-root', [
      ['linked', '../shared-bulk'],
      ['alias.md', 'a.md'],
    ]);

    const cap = bulkFileCount + readdirSync(withFileSymlink).length;
    expect(
      previewContent({ projectDir: withFileSymlink, contentDir: withFileSymlink }).totalCount,
    ).toBeLessThanOrEqual(cap);

    const baselineVerdict = await walkExceedsCap(baseline, cap, { descendSymlinks: true });

    expect(baselineVerdict).toBe(false);
    expect(await walkExceedsCap(withFileSymlink, cap, { descendSymlinks: true })).toBe(
      baselineVerdict,
    );
  });
});
