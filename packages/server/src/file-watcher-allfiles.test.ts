import { mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createContentFilter } from './content-filter.ts';
import { type AllFileEntries, lastKnownHash, startWatcher } from './file-watcher.ts';
import {
  forgetNativeSubscriptions,
  nativeSubscriptionOn,
} from './parcel-watcher-double.test-helper.ts';

vi.mock('@parcel/watcher', async () => {
  const { parcelWatcherModule } = await import('./parcel-watcher-double.test-helper.ts');
  return parcelWatcherModule;
});

function indexedKinds(all: AllFileEntries, name: string) {
  return [...all].filter(([indexedName]) => indexedName === name).map(([, entry]) => entry.kind);
}

describe('PRD-7117 US-001 — kind discriminator + all-files admission', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = realpathSync(await mkdtemp(resolve(tmpdir(), 'ok-allfiles-')));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    lastKnownHash.clear();
    forgetNativeSubscriptions();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('seed admits markdown and non-markdown with the right kind discriminator', async () => {
    writeFileSync(resolve(contentDir, 'readme.md'), '# README\n');
    writeFileSync(resolve(contentDir, 'data.csv'), 'a,b,c\n1,2,3\n');
    writeFileSync(resolve(contentDir, 'config.json'), '{"x":1}');
    mkdirSync(resolve(contentDir, 'src'));
    writeFileSync(resolve(contentDir, 'src', 'index.ts'), 'export const x = 1;');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const all = handle.getAllFilesIndex();
      expect(indexedKinds(all, 'readme')).toEqual(['markdown']);
      expect(indexedKinds(all, 'data.csv')).toEqual(['file']);
      expect(indexedKinds(all, 'config.json')).toEqual(['file']);
      expect(indexedKinds(all, 'src/index.ts')).toEqual(['file']);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('getFileIndex() returns markdown-only view (D12 invert-default)', async () => {
    writeFileSync(resolve(contentDir, 'note.md'), '# Note\n');
    writeFileSync(resolve(contentDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(resolve(contentDir, 'script.ts'), 'export const y = 2;');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const md = handle.getFileIndex();
      expect(md.has('note')).toBe(true);
      expect(md.has('image.png')).toBe(false);
      expect(md.has('script.ts')).toBe(false);

      expect(md.size).toBe(1);

      expect([...md.keys()]).toEqual(['note']);
      expect([...md.values()].every((e) => e.kind === 'markdown')).toBe(true);
      const collected: string[] = [];
      md.forEach((_v, k) => {
        collected.push(k);
      });
      expect(collected).toEqual(['note']);

      expect([...handle.getAllFilesIndex()]).toHaveLength(3);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('AC20: seed performs NO content read / hash for kind:"file" entries', async () => {
    writeFileSync(resolve(contentDir, 'one.md'), '# One\n');
    writeFileSync(resolve(contentDir, 'two.md'), '# Two\n');
    writeFileSync(resolve(contentDir, 'logo.svg'), '<svg/>');
    writeFileSync(resolve(contentDir, 'data.csv'), 'col\nval\n');
    writeFileSync(resolve(contentDir, 'binary.bin'), Buffer.alloc(64, 0xff));
    writeFileSync(resolve(contentDir, 'shell.sh'), '#!/bin/sh\n');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      expect(lastKnownHash.has(resolve(contentDir, 'one.md'))).toBe(true);
      expect(lastKnownHash.has(resolve(contentDir, 'two.md'))).toBe(true);
      expect(lastKnownHash.has(resolve(contentDir, 'logo.svg'))).toBe(false);
      expect(lastKnownHash.has(resolve(contentDir, 'data.csv'))).toBe(false);
      expect(lastKnownHash.has(resolve(contentDir, 'binary.bin'))).toBe(false);
      expect(lastKnownHash.has(resolve(contentDir, 'shell.sh'))).toBe(false);

      expect(lastKnownHash.size).toBe(2);

      const all = handle.getAllFilesIndex();
      expect(indexedKinds(all, 'logo.svg')).toEqual(['file']);
      expect(indexedKinds(all, 'data.csv')).toEqual(['file']);
      expect(indexedKinds(all, 'binary.bin')).toEqual(['file']);
      expect(indexedKinds(all, 'shell.sh')).toEqual(['file']);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('admission keeps ContentFilter on — gitignored non-md is NOT in the index', async () => {
    writeFileSync(resolve(tmpDir, '.gitignore'), 'dist/\n');
    mkdirSync(resolve(contentDir, 'dist'), { recursive: true });
    writeFileSync(resolve(contentDir, 'dist', 'bundle.js'), 'console.log(1);');
    writeFileSync(resolve(contentDir, 'app.ts'), 'export const z = 3;');
    writeFileSync(resolve(contentDir, 'readme.md'), '# README\n');

    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      const all = handle.getAllFilesIndex();
      expect(indexedKinds(all, 'app.ts')).toEqual(['file']);
      expect(indexedKinds(all, 'readme')).toEqual(['markdown']);
      expect(indexedKinds(all, 'dist/bundle.js')).toEqual([]);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('live file-create event admits a new non-md file as kind:"file"', async () => {
    writeFileSync(resolve(contentDir, 'starter.md'), '# Start\n');
    const handle = await startWatcher(contentDir, async () => {});
    try {
      const newFile = resolve(contentDir, 'fresh.ts');
      writeFileSync(newFile, 'export const fresh = true;');
      await nativeSubscriptionOn(contentDir).deliver([{ type: 'create', path: newFile }]);

      const all = handle.getAllFilesIndex();
      expect(indexedKinds(all, 'fresh.ts')).toEqual(['file']);
      expect(lastKnownHash.has(newFile)).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('live file-delete event removes a non-md entry without touching markdown siblings', async () => {
    writeFileSync(resolve(contentDir, 'doc.md'), '# Doc\n');
    writeFileSync(resolve(contentDir, 'old.txt'), 'old');
    const handle = await startWatcher(contentDir, async () => {});
    try {
      expect(indexedKinds(handle.getAllFilesIndex(), 'old.txt')).toEqual(['file']);
      expect(indexedKinds(handle.getAllFilesIndex(), 'doc')).toEqual(['markdown']);

      unlinkSync(resolve(contentDir, 'old.txt'));
      await nativeSubscriptionOn(contentDir).deliver([
        { type: 'delete', path: resolve(contentDir, 'old.txt') },
      ]);

      expect(indexedKinds(handle.getAllFilesIndex(), 'old.txt')).toEqual([]);
      expect(indexedKinds(handle.getAllFilesIndex(), 'doc')).toEqual(['markdown']);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('mutateFileIndex purges the LIVE map (regression: snapshot-cast was a no-op)', async () => {
    writeFileSync(resolve(contentDir, 'doomed.md'), '# Doomed\n');
    writeFileSync(resolve(contentDir, 'survives.md'), '# Survives\n');
    writeFileSync(resolve(contentDir, 'doomed.txt'), 'bye\n');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      expect(handle.getFileIndex().has('doomed')).toBe(true);
      expect(indexedKinds(handle.getAllFilesIndex(), 'doomed')).toEqual(['markdown']);
      expect(indexedKinds(handle.getAllFilesIndex(), 'doomed.txt')).toEqual(['file']);

      handle.mutateFileIndex({
        kind: 'delete',
        path: resolve(contentDir, 'doomed.md'),
        docName: 'doomed',
      });
      handle.mutateFileIndex({
        kind: 'file-delete',
        path: resolve(contentDir, 'doomed.txt'),
        relativePath: 'doomed.txt',
      });

      expect(indexedKinds(handle.getAllFilesIndex(), 'doomed')).toEqual([]);
      expect(indexedKinds(handle.getAllFilesIndex(), 'doomed.txt')).toEqual([]);
      expect(handle.getFileIndex().has('doomed')).toBe(false);
      expect(handle.getFileIndex().has('survives')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('getFileIndex view is memoized across calls without mutation', async () => {
    writeFileSync(resolve(contentDir, 'a.md'), '# A\n');
    writeFileSync(resolve(contentDir, 'b.md'), '# B\n');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const first = handle.getFileIndex();
      const second = handle.getFileIndex();
      expect(second).toBe(first);

      handle.mutateFileIndex({
        kind: 'create',
        path: resolve(contentDir, 'c.md'),
        docName: 'c',
        content: '# C\n',
      });
      const third = handle.getFileIndex();
      expect(third).not.toBe(first);
      expect(third.has('c')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('symlink to non-md target produces a kind:"file" entry (one side, inode-dedup)', async () => {
    writeFileSync(resolve(contentDir, 'real.csv'), 'a\nb\n');
    symlinkSync(resolve(contentDir, 'real.csv'), resolve(contentDir, 'alias.csv'));

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const all = [...handle.getAllFilesIndex()];
      const files = all.filter(([, entry]) => entry.kind === 'file');
      expect(files).toHaveLength(1);
      expect(files[0]?.[0]).toBe('real.csv');
      expect(files[0]?.[1]).toMatchObject({
        kind: 'file',
        canonicalPath: resolve(contentDir, 'real.csv'),
        aliases: ['alias.csv'],
      });
    } finally {
      await handle.unsubscribe();
    }
  });
});
