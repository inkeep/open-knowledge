/**
 * all-files file-index admission.
 *
 * Covers (entry-kind discriminator + admit any
 * ContentFilter-passing extension) and (the seed walk performs no
 * content read for `kind:'file'` entries).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createContentFilter } from './content-filter.ts';
import { handleRawEvents, lastKnownHash, startWatcher } from './file-watcher.ts';

describe('PRD-7117 US-001 — kind discriminator + all-files admission', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    // realpath here so absolute-path assertions against `lastKnownHash`
    // (keyed by the seed walk's `fullPath`, which goes through
    // `realpathSync(contentDir)` inside `startWatcher`) align with what we
    // observe on macOS (`/var/folders/...` is a symlink to `/private/var/...`).
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
      // All four files admitted to the underlying file index.
      expect(all.has('readme')).toBe(true);
      expect(all.has('data.csv')).toBe(true);
      expect(all.has('config.json')).toBe(true);
      expect(all.has('src/index.ts')).toBe(true);

      // Discriminator: .md → markdown; everything else → file.
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
      // Only the .md file is observable through the default accessor.
      expect(md.has('note')).toBe(true);
      expect(md.has('image.png')).toBe(false);
      expect(md.has('script.ts')).toBe(false);

      // size counts only markdown entries.
      expect(md.size).toBe(1);

      // entries() / values() / keys() / forEach iterators all filter.
      expect([...md.keys()]).toEqual(['note']);
      expect([...md.values()].every((e) => e.kind === 'markdown')).toBe(true);
      const collected: string[] = [];
      md.forEach((_v, k) => {
        collected.push(k);
      });
      expect(collected).toEqual(['note']);

      // The full view shows everything.
      expect(handle.getAllFilesIndex().size).toBe(3);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('AC20: seed performs NO content read / hash for kind:"file" entries', async () => {
    // Two markdown files (will be read) + several non-markdown files (must NOT
    // be read). The lastKnownHash map is set ONLY inside the readFile branch
    // of the seed — its membership is the directly observable witness.
    writeFileSync(resolve(contentDir, 'one.md'), '# One\n');
    writeFileSync(resolve(contentDir, 'two.md'), '# Two\n');
    writeFileSync(resolve(contentDir, 'logo.svg'), '<svg/>');
    writeFileSync(resolve(contentDir, 'data.csv'), 'col\nval\n');
    writeFileSync(resolve(contentDir, 'binary.bin'), Buffer.alloc(64, 0xff));
    writeFileSync(resolve(contentDir, 'shell.sh'), '#!/bin/sh\n');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      // Both markdown files are hashed (their canonical paths appear).
      expect(lastKnownHash.has(resolve(contentDir, 'one.md'))).toBe(true);
      expect(lastKnownHash.has(resolve(contentDir, 'two.md'))).toBe(true);
      // Non-markdown files MUST NOT appear in lastKnownHash — no readFile ran.
      expect(lastKnownHash.has(resolve(contentDir, 'logo.svg'))).toBe(false);
      expect(lastKnownHash.has(resolve(contentDir, 'data.csv'))).toBe(false);
      expect(lastKnownHash.has(resolve(contentDir, 'binary.bin'))).toBe(false);
      expect(lastKnownHash.has(resolve(contentDir, 'shell.sh'))).toBe(false);

      // The lastKnownHash set must contain exactly the 2 markdown entries —
      // pin the count so a future regression that quietly hashes one
      // non-markdown file (e.g. via an asset-hash sibling for rename detection)
      // would break this test loudly.
      expect(lastKnownHash.size).toBe(2);

      // Confirm the non-markdown files DID land in the index (they're just
      // there metadata-only, with no body read).
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
    // node_modules-style forest under the worktree must stay out of the
    // file index even though it contains real files.
    writeFileSync(resolve(tmpDir, '.gitignore'), 'dist/\n');
    mkdirSync(resolve(contentDir, 'dist'), { recursive: true });
    writeFileSync(resolve(contentDir, 'dist', 'bundle.js'), 'console.log(1);');
    writeFileSync(resolve(contentDir, 'app.ts'), 'export const z = 3;');
    writeFileSync(resolve(contentDir, 'readme.md'), '# README\n');

    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      const all = handle.getAllFilesIndex();
      // Non-md tracked file is in.
      expect(all.has('app.ts')).toBe(true);
      expect(all.get('app.ts')?.kind).toBe('file');
      // The markdown still indexes.
      expect(all.has('readme')).toBe(true);
      // Gitignored non-md is OUT — admission line held.
      expect(all.has('dist/bundle.js')).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('live file-create event admits a new non-md file as kind:"file"', async () => {
    writeFileSync(resolve(contentDir, 'starter.md'), '# Start\n');
    const handle = await startWatcher(contentDir, async () => {});
    try {
      // Write a new non-md file AFTER the watcher starts, then drive
      // handleRawEvents directly with a synthesized 'create' to bypass the
      // backend-specific debounce that depends on inotify / FSEvents timing.
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
      // No content was read for the file event — lastKnownHash unchanged
      // for `kind:'file'`.
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
      // Bootstrap state — both present.
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
      // Markdown sibling untouched.
      expect(handle.getAllFilesIndex().has('doc')).toBe(true);
      expect(handle.getAllFilesIndex().get('doc')?.kind).toBe('markdown');
    } finally {
      await handle.unsubscribe();
    }
  });

  test('mutateFileIndex purges the LIVE map (regression: snapshot-cast was a no-op)', async () => {
    // `handleDeletePath` / `handleTrashCleanup` purged via
    // `getFileIndex() + as Map cast + updateFileIndex(...)`. When
    // `getFileIndex()` switched to returning a `markdownIndexView`
    // snapshot, the cast targeted a throwaway copy and the live
    // `fileIndex` retained the deleted entry until the next async
    // file-watcher event landed. This test pins that the typed
    // `mutateFileIndex` accessor goes against the live map: after a
    // synchronous `delete` event, the entry is gone from BOTH the
    // markdown view (`getFileIndex`) and the all-files map
    // (`getAllFilesIndex`).
    writeFileSync(resolve(contentDir, 'doomed.md'), '# Doomed\n');
    writeFileSync(resolve(contentDir, 'survives.md'), '# Survives\n');
    writeFileSync(resolve(contentDir, 'doomed.txt'), 'bye\n');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      expect(handle.getFileIndex().has('doomed')).toBe(true);
      expect(handle.getAllFilesIndex().has('doomed')).toBe(true);
      expect(handle.getAllFilesIndex().has('doomed.txt')).toBe(true);

      // Synchronous markdown purge — the shape of the
      // delete/trash handlers.
      handle.mutateFileIndex({
        kind: 'delete',
        path: resolve(contentDir, 'doomed.md'),
        docName: 'doomed',
      });
      // Synchronous non-markdown purge — same accessor handles both.
      handle.mutateFileIndex({
        kind: 'file-delete',
        path: resolve(contentDir, 'doomed.txt'),
        relativePath: 'doomed.txt',
      });

      // Live map: both entries gone.
      expect(handle.getAllFilesIndex().has('doomed')).toBe(false);
      expect(handle.getAllFilesIndex().has('doomed.txt')).toBe(false);
      // Markdown view: the markdown entry is also gone (generation bumped
      // -> the memoized snapshot is rebuilt on next read).
      expect(handle.getFileIndex().has('doomed')).toBe(false);
      // Siblings untouched.
      expect(handle.getFileIndex().has('survives')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('getFileIndex view is memoized across calls without mutation', async () => {
    // the snapshot rebuild happens once per mutation batch,
    // not once per call. Identity (===) is the simplest witness — two
    // back-to-back calls return the SAME object reference, so a
    // hypothetical regression that rebuilds on every call
    // would break this test.
    writeFileSync(resolve(contentDir, 'a.md'), '# A\n');
    writeFileSync(resolve(contentDir, 'b.md'), '# B\n');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const first = handle.getFileIndex();
      const second = handle.getFileIndex();
      expect(second).toBe(first);

      // A mutation invalidates the cache; the next call returns a fresh
      // snapshot (distinct identity).
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
    // Only admission is pinned here. Proper canonical resolution +
    // alias-paths are separate work that closes the inode-dedup-but-search-
    // both-paths gap. For now we just check that the symlinked file lands in
    // the index exactly once (no double entry) and as `kind:'file'`.
    writeFileSync(resolve(contentDir, 'real.csv'), 'a\nb\n');
    symlinkSync(resolve(contentDir, 'real.csv'), resolve(contentDir, 'alias.csv'));

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const all = handle.getAllFilesIndex();
      const hasReal = all.has('real.csv');
      const hasAlias = all.has('alias.csv');
      // Exactly one of the two reaches the index — inode-dedup keeps the
      // symlink twin out.
      expect(Number(hasReal) + Number(hasAlias)).toBe(1);
      const present = hasReal ? all.get('real.csv') : all.get('alias.csv');
      expect(present?.kind).toBe('file');
    } finally {
      await handle.unsubscribe();
    }
  });
});
