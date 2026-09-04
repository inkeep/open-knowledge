import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createContentFilter } from './content-filter.ts';
import { handleRawEvents, lastKnownHash, startWatcher } from './file-watcher.ts';

describe('PRD-7117 US-001 — kind discriminator + all-files admission', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = realpathSync(await mkdtemp(resolve(tmpdir(), 'ok-allfiles-')));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    lastKnownHash.clear();
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
      expect(all.has('readme')).toBe(true);
      expect(all.has('data.csv')).toBe(true);
      expect(all.has('config.json')).toBe(true);
      expect(all.has('src/index.ts')).toBe(true);

      expect(all.get('readme')?.kind).toBe('markdown');
      expect(all.get('data.csv')?.kind).toBe('file');
      expect(all.get('config.json')?.kind).toBe('file');
      expect(all.get('src/index.ts')?.kind).toBe('file');
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

      expect(handle.getAllFilesIndex().size).toBe(3);
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
      expect(all.has('logo.svg')).toBe(true);
      expect(all.has('data.csv')).toBe(true);
      expect(all.has('binary.bin')).toBe(true);
      expect(all.has('shell.sh')).toBe(true);
      expect(all.get('logo.svg')?.kind).toBe('file');
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
      expect(all.has('app.ts')).toBe(true);
      expect(all.get('app.ts')?.kind).toBe('file');
      expect(all.has('readme')).toBe(true);
      expect(all.has('dist/bundle.js')).toBe(false);
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
      await handleRawEvents(
        [{ type: 'create', path: newFile }],
        contentDir,
        undefined,
        // biome-ignore lint/suspicious/noExplicitAny: test reaches the inner map for live admission verification
        handle.getAllFilesIndex() as any,
        // biome-ignore lint/suspicious/noExplicitAny: test reaches the inner map for live admission verification
        handle.getFolderIndex() as any,
        async () => {},
      );

      const all = handle.getAllFilesIndex();
      expect(all.has('fresh.ts')).toBe(true);
      expect(all.get('fresh.ts')?.kind).toBe('file');
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
      expect(handle.getAllFilesIndex().has('old.txt')).toBe(true);
      expect(handle.getAllFilesIndex().has('doc')).toBe(true);

      await handleRawEvents(
        [{ type: 'delete', path: resolve(contentDir, 'old.txt') }],
        contentDir,
        undefined,
        // biome-ignore lint/suspicious/noExplicitAny: see above
        handle.getAllFilesIndex() as any,
        // biome-ignore lint/suspicious/noExplicitAny: see above
        handle.getFolderIndex() as any,
        async () => {},
      );

      expect(handle.getAllFilesIndex().has('old.txt')).toBe(false);
      expect(handle.getAllFilesIndex().has('doc')).toBe(true);
      expect(handle.getAllFilesIndex().get('doc')?.kind).toBe('markdown');
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
      expect(handle.getAllFilesIndex().has('doomed')).toBe(true);
      expect(handle.getAllFilesIndex().has('doomed.txt')).toBe(true);

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

      expect(handle.getAllFilesIndex().has('doomed')).toBe(false);
      expect(handle.getAllFilesIndex().has('doomed.txt')).toBe(false);
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
      const all = handle.getAllFilesIndex();
      const hasReal = all.has('real.csv');
      const hasAlias = all.has('alias.csv');
      expect(Number(hasReal) + Number(hasAlias)).toBe(1);
      const present = hasReal ? all.get('real.csv') : all.get('alias.csv');
      expect(present?.kind).toBe('file');
    } finally {
      await handle.unsubscribe();
    }
  });
});
