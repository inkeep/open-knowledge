import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createContentFilter } from './content-filter.ts';
import type { DiskEvent } from './file-watcher';
import {
  classifyEvents,
  contentHash,
  evictStaleTrackerEntries,
  handleRawEvents,
  isSelfWrite,
  lastKnownHash,
  pathToDocName,
  reconcileFileIndexAfterFilterRebuild,
  registerWrite,
  startWatcher,
  updateLastKnownHash,
  writeTracker,
} from './file-watcher';

describe('writeTracker', () => {
  beforeEach(() => {
    writeTracker.clear();
  });

  test('skips self-writes with matching hash', () => {
    const filePath = '/content/test-fixture.md';
    const content = '# Hello\n\nWorld\n';
    const hash = contentHash(content);

    registerWrite(filePath, hash);

    // Watcher detects the change — same content → same hash → skip
    const queue = writeTracker.get(filePath);
    expect(queue).toBeTruthy();
    expect(queue?.some((e) => e.hash === hash)).toBe(true);
  });

  test('does not skip external writes with different hash', () => {
    const filePath = '/content/test-fixture.md';
    const ourContent = '# Hello\n\nWorld\n';
    const externalContent = '# Hello\n\nExternal edit\n';

    registerWrite(filePath, contentHash(ourContent));

    const externalHash = contentHash(externalContent);
    const queue = writeTracker.get(filePath);
    expect(queue?.some((e) => e.hash === externalHash)).toBe(false);
  });

  test('does not skip writes when no tracked entry exists', () => {
    const filePath = '/content/new-file.md';
    expect(writeTracker.has(filePath)).toBe(false);
  });

  test('queue handles multiple rapid writes — each event consumes only its own entry', () => {
    const filePath = '/content/test-fixture.md';
    const hash1 = contentHash('write 1');
    const hash2 = contentHash('write 2');

    registerWrite(filePath, hash1);
    registerWrite(filePath, hash2);

    const queue = writeTracker.get(filePath);
    expect(queue).toHaveLength(2);

    // First event matches hash1 — remove it, hash2 should remain
    const idx1 = queue?.findIndex((e) => e.hash === hash1) ?? -1;
    expect(idx1).toBeGreaterThanOrEqual(0);
    queue?.splice(idx1, 1);
    expect(queue).toHaveLength(1);
    expect(queue?.[0].hash).toBe(hash2);
  });
});

describe('TTL eviction', () => {
  beforeEach(() => {
    writeTracker.clear();
  });

  test('evicts entries older than TTL (10s)', () => {
    const filePath = '/content/stale.md';
    writeTracker.set(filePath, [{ hash: 'abc123', timestamp: Date.now() - 11_000 }]);

    evictStaleTrackerEntries();
    expect(writeTracker.has(filePath)).toBe(false);
  });

  test('keeps entries within TTL', () => {
    const filePath = '/content/fresh.md';
    writeTracker.set(filePath, [{ hash: 'abc123', timestamp: Date.now() - 5_000 }]);

    evictStaleTrackerEntries();
    expect(writeTracker.has(filePath)).toBe(true);
  });

  test('mixed: evicts stale, keeps fresh', () => {
    writeTracker.set('/content/stale.md', [{ hash: 'old', timestamp: Date.now() - 15_000 }]);
    writeTracker.set('/content/fresh.md', [{ hash: 'new', timestamp: Date.now() - 2_000 }]);

    evictStaleTrackerEntries();
    expect(writeTracker.has('/content/stale.md')).toBe(false);
    expect(writeTracker.has('/content/fresh.md')).toBe(true);
  });

  test('evicts stale entries within a queue while keeping fresh ones', () => {
    writeTracker.set('/content/mixed.md', [
      { hash: 'old', timestamp: Date.now() - 15_000 },
      { hash: 'new', timestamp: Date.now() - 2_000 },
    ]);

    evictStaleTrackerEntries();
    const queue = writeTracker.get('/content/mixed.md');
    expect(queue).toHaveLength(1);
    expect(queue?.[0].hash).toBe('new');
  });
});

describe('pathToDocName', () => {
  test('maps absolute path to document name', () => {
    expect(pathToDocName('/app/content/test-fixture.md', '/app/content')).toBe('test-fixture');
  });

  test('handles nested paths', () => {
    expect(pathToDocName('/app/content/docs/guide.md', '/app/content')).toBe('docs/guide');
  });

  test('strips .mdx extension', () => {
    expect(pathToDocName('/app/content/component.mdx', '/app/content')).toBe('component');
  });

  test('strips .mdx from nested paths', () => {
    expect(pathToDocName('/app/content/docs/guide.mdx', '/app/content')).toBe('docs/guide');
  });
});

describe('contentHash', () => {
  test('produces consistent SHA-256 hex digest', () => {
    const hash1 = contentHash('hello');
    const hash2 = contentHash('hello');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  test('different content produces different hashes', () => {
    expect(contentHash('hello')).not.toBe(contentHash('world'));
  });
});

describe('isSelfWrite', () => {
  beforeEach(() => {
    writeTracker.clear();
  });

  test('returns true and consumes entry for matching hash', () => {
    const path = '/content/test.md';
    const hash = contentHash('hello');
    registerWrite(path, hash);

    expect(isSelfWrite(path, hash)).toBe(true);
    expect(writeTracker.has(path)).toBe(false);
  });

  test('returns false for non-matching hash', () => {
    const path = '/content/test.md';
    registerWrite(path, contentHash('hello'));

    expect(isSelfWrite(path, contentHash('world'))).toBe(false);
    expect(writeTracker.has(path)).toBe(true);
  });
});

// ─── classifyEvents ──────────────────────────────────────────────────────────

describe('classifyEvents', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-watcher-test-'));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    lastKnownHash.clear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('emits update event for modified file', async () => {
    const filePath = resolve(contentDir, 'doc.md');
    writeFileSync(filePath, '# Updated\n');

    const events = await classifyEvents([{ type: 'update', path: filePath }], contentDir);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('update');
    if (events[0].kind === 'update') {
      expect(events[0].docName).toBe('doc');
      expect(events[0].content).toBe('# Updated\n');
    }
  });

  test('emits create event for new file', async () => {
    const filePath = resolve(contentDir, 'new.md');
    writeFileSync(filePath, '# New\n');

    const events = await classifyEvents([{ type: 'create', path: filePath }], contentDir);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('create');
  });

  test('emits create event for new empty file', async () => {
    const filePath = resolve(contentDir, 'empty.md');
    writeFileSync(filePath, '');

    const events = await classifyEvents([{ type: 'create', path: filePath }], contentDir);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('create');
    if (events[0].kind === 'create') {
      expect(events[0].docName).toBe('empty');
      expect(events[0].content).toBe('');
    }
  });

  test('emits update event when existing file becomes empty', async () => {
    const filePath = resolve(contentDir, 'cleared.md');
    writeFileSync(filePath, '');

    const events = await classifyEvents([{ type: 'update', path: filePath }], contentDir);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('update');
    if (events[0].kind === 'update') {
      expect(events[0].docName).toBe('cleared');
      expect(events[0].content).toBe('');
    }
  });

  test('emits delete event for removed file', async () => {
    const filePath = resolve(contentDir, 'gone.md');

    const events = await classifyEvents([{ type: 'delete', path: filePath }], contentDir);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('delete');
    if (events[0].kind === 'delete') {
      expect(events[0].docName).toBe('gone');
    }
  });

  test('emits rename for delete+create with matching content hash', async () => {
    const oldPath = resolve(contentDir, 'old-name.md');
    const newPath = resolve(contentDir, 'new-name.md');
    const content = '# Same Content\n';

    // Pre-seed the last known hash for the old path
    updateLastKnownHash(oldPath, contentHash(content));

    // Write the new file
    writeFileSync(newPath, content);

    const events = await classifyEvents(
      [
        { type: 'delete', path: oldPath },
        { type: 'create', path: newPath },
      ],
      contentDir,
    );

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('rename');
    if (events[0].kind === 'rename') {
      expect(events[0].oldDocName).toBe('old-name');
      expect(events[0].newDocName).toBe('new-name');
      expect(events[0].content).toBe(content);
    }
  });

  test('emits separate delete+create when content hashes differ', async () => {
    const oldPath = resolve(contentDir, 'old.md');
    const newPath = resolve(contentDir, 'new.md');

    // Pre-seed with different content
    updateLastKnownHash(oldPath, contentHash('old content'));
    writeFileSync(newPath, 'different content');

    const events = await classifyEvents(
      [
        { type: 'delete', path: oldPath },
        { type: 'create', path: newPath },
      ],
      contentDir,
    );

    expect(events).toHaveLength(2);
    expect(events.some((e) => e.kind === 'delete')).toBe(true);
    expect(events.some((e) => e.kind === 'create')).toBe(true);
  });

  test('emits conflict event when file contains conflict markers', async () => {
    const filePath = resolve(contentDir, 'conflicted.md');
    writeFileSync(filePath, '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n');

    const events = await classifyEvents([{ type: 'update', path: filePath }], contentDir);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('conflict');
  });

  test('emits conflict event for create with conflict markers', async () => {
    const filePath = resolve(contentDir, 'new-conflicted.md');
    writeFileSync(filePath, '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n');

    const events = await classifyEvents([{ type: 'create', path: filePath }], contentDir);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('conflict');
  });

  test('ignores non-.md files', async () => {
    const filePath = resolve(contentDir, 'readme.txt');
    writeFileSync(filePath, 'hello');

    const events = await classifyEvents([{ type: 'update', path: filePath }], contentDir);

    expect(events).toHaveLength(0);
  });

  test('filters events through ContentFilter when provided', async () => {
    // Create a filter that excludes dist/
    writeFileSync(resolve(tmpDir, '.gitignore'), 'dist/\n');
    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    // Create files in both included and excluded dirs
    mkdirSync(resolve(contentDir, 'dist'), { recursive: true });
    mkdirSync(resolve(contentDir, 'docs'), { recursive: true });
    writeFileSync(resolve(contentDir, 'dist', 'output.md'), '# Build Output\n');
    writeFileSync(resolve(contentDir, 'docs', 'guide.md'), '# Guide\n');

    const events = await classifyEvents(
      [
        { type: 'create', path: resolve(contentDir, 'dist', 'output.md') },
        { type: 'create', path: resolve(contentDir, 'docs', 'guide.md') },
      ],
      contentDir,
      filter,
    );

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('create');
    if (events[0].kind === 'create') {
      expect(events[0].docName).toBe('docs/guide');
    }
  });
});

// ─── startWatcher file index ────────────────────────────────────────────────

describe('startWatcher file index', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-watcher-index-'));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    lastKnownHash.clear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('initial scan populates file index with .md files', async () => {
    writeFileSync(resolve(contentDir, 'readme.md'), '# README\n');
    mkdirSync(resolve(contentDir, 'docs'));
    writeFileSync(resolve(contentDir, 'docs', 'guide.md'), '# Guide\n');
    writeFileSync(resolve(contentDir, 'script.js'), 'console.log("hi")');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const index = handle.getFileIndex();
      expect(index.size).toBe(2);
      expect(index.has('readme')).toBe(true);
      expect(index.has('docs/guide')).toBe(true);
      // Non-.md files are not in the index
      expect(index.has('script')).toBe(false);

      // Entries have size and modified
      const entry = index.get('readme');
      expect(entry).toBeTruthy();
      expect(entry?.size).toBeGreaterThan(0);
      expect(entry?.modified).toBeTruthy();
    } finally {
      await handle.unsubscribe();
    }
  });

  test('initial scan caches page title + icon on each markdown entry', async () => {
    // The seed walk already reads each markdown file for its content hash, so
    // title/icon are derived from that in-hand content (zero extra reads) and
    // cached on the entry — letting GET /api/pages serve them from memory.
    writeFileSync(
      resolve(contentDir, 'with-meta.md'),
      '---\ntitle: Meta Title\nicon: 📝\n---\n\n# Heading Ignored\n',
    );
    writeFileSync(resolve(contentDir, 'heading-only.md'), '# Heading Title\n');
    writeFileSync(resolve(contentDir, 'plain.md'), 'just body text, no heading\n');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const index = handle.getFileIndex();
      expect(index.get('with-meta')?.title).toBe('Meta Title');
      expect(index.get('with-meta')?.icon).toBe('📝');
      expect(index.get('heading-only')?.title).toBe('Heading Title');
      expect(index.get('heading-only')?.icon).toBeUndefined();
      // No frontmatter title and no H1 → fall back to the docName.
      expect(index.get('plain')?.title).toBe('plain');
    } finally {
      await handle.unsubscribe();
    }
  });

  test('initial scan preserves uppercase .MD/.MDX extension casing', async () => {
    // Regression for the duplicate-file class: when a user has `Foo.MD` on
    // disk, the file watcher records `.md` (lowercase) and persistence later
    // writes `Foo.md`, leaving two files for the same docName on case-
    // sensitive filesystems. Casing must round-trip through doc-extensions so
    // safeContentPath() returns the original on-disk filename.
    writeFileSync(resolve(contentDir, 'Upper.MD'), '# Upper\n');
    writeFileSync(resolve(contentDir, 'Mixed.MdX'), '# Mixed\n');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const { getDocExtension } = await import('./doc-extensions.ts');
      const { safeContentPath } = await import('./persistence.ts');

      expect(getDocExtension('Upper')).toBe('.MD');
      expect(getDocExtension('Mixed')).toBe('.MdX');

      const upperPath = safeContentPath('Upper', contentDir);
      expect(upperPath.endsWith('/Upper.MD')).toBe(true);

      const mixedPath = safeContentPath('Mixed', contentDir);
      expect(mixedPath.endsWith('/Mixed.MdX')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('file index excludes files filtered by ContentFilter', async () => {
    writeFileSync(resolve(tmpDir, '.gitignore'), 'dist/\n');
    mkdirSync(resolve(contentDir, 'dist'), { recursive: true });
    mkdirSync(resolve(contentDir, 'docs'), { recursive: true });
    writeFileSync(resolve(contentDir, 'dist', 'output.md'), '# Build\n');
    writeFileSync(resolve(contentDir, 'docs', 'guide.md'), '# Guide\n');

    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      const index = handle.getFileIndex();
      expect(index.size).toBe(1);
      expect(index.has('docs/guide')).toBe(true);
      expect(index.has('dist/output')).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('file index excludes files matching .okignore patterns', async () => {
    mkdirSync(resolve(contentDir, 'archive'), { recursive: true });
    writeFileSync(resolve(contentDir, 'readme.md'), '# README\n');
    writeFileSync(resolve(contentDir, 'archive', 'old.md'), '# Old\n');
    writeFileSync(resolve(tmpDir, '.okignore'), 'content/archive/\n');

    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      const index = handle.getFileIndex();
      expect(index.size).toBe(1);
      expect(index.has('readme')).toBe(true);
      expect(index.has('archive/old')).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('file index updates on create event', () => {
    const { updateFileIndex } = require('./file-watcher.ts');
    const index = new Map();
    const event = {
      kind: 'create' as const,
      path: resolve(contentDir, 'new-file.md'),
      docName: 'new-file',
      content: '# New File\n',
    };
    updateFileIndex(event, index);
    expect(index.has('new-file')).toBe(true);
    expect(index.get('new-file')?.size).toBe(Buffer.byteLength('# New File\n', 'utf-8'));
    expect(index.get('new-file')?.modified).toBeTruthy();
  });

  test('file index removes entry on delete event', () => {
    const { updateFileIndex } = require('./file-watcher.ts');
    const index = new Map([['existing', { size: 10, modified: new Date().toISOString() }]]);
    const event = {
      kind: 'delete' as const,
      path: resolve(contentDir, 'existing.md'),
      docName: 'existing',
    };
    updateFileIndex(event, index);
    expect(index.has('existing')).toBe(false);
  });

  test('file index updates size/modified on update event', () => {
    const { updateFileIndex } = require('./file-watcher.ts');
    const oldModified = '2020-01-01T00:00:00.000Z';
    const index = new Map([['doc', { size: 5, modified: oldModified }]]);
    const event = {
      kind: 'update' as const,
      path: resolve(contentDir, 'doc.md'),
      docName: 'doc',
      content: '# Updated content with more text\n',
    };
    updateFileIndex(event, index);
    expect(index.get('doc')?.size).toBe(
      Buffer.byteLength('# Updated content with more text\n', 'utf-8'),
    );
    expect(index.get('doc')?.modified).not.toBe(oldModified);
  });

  test('file index handles rename event', () => {
    const { updateFileIndex } = require('./file-watcher.ts');
    const index = new Map([['old-name', { size: 10, modified: new Date().toISOString() }]]);
    const event = {
      kind: 'rename' as const,
      oldPath: resolve(contentDir, 'old-name.md'),
      newPath: resolve(contentDir, 'new-name.md'),
      oldDocName: 'old-name',
      newDocName: 'new-name',
      content: '# Renamed\n',
    };
    updateFileIndex(event, index);
    expect(index.has('old-name')).toBe(false);
    expect(index.has('new-name')).toBe(true);
    expect(index.get('new-name')?.size).toBe(Buffer.byteLength('# Renamed\n', 'utf-8'));
  });

  test('file index caches title + icon on create/update/rename/conflict events', () => {
    const { updateFileIndex } = require('./file-watcher.ts');
    const index = new Map();

    updateFileIndex(
      {
        kind: 'create' as const,
        path: resolve(contentDir, 'doc.md'),
        docName: 'doc',
        content: '---\ntitle: Created\nicon: 🚀\n---\n\nBody\n',
      },
      index,
    );
    expect(index.get('doc')?.title).toBe('Created');
    expect(index.get('doc')?.icon).toBe('🚀');

    // An edit refreshes the cached title (and clears the now-absent icon).
    updateFileIndex(
      {
        kind: 'update' as const,
        path: resolve(contentDir, 'doc.md'),
        docName: 'doc',
        content: '# Edited Title\n',
      },
      index,
    );
    expect(index.get('doc')?.title).toBe('Edited Title');
    expect(index.get('doc')?.icon).toBeUndefined();

    // A rename carries the new content's title onto the new docName.
    updateFileIndex(
      {
        kind: 'rename' as const,
        oldPath: resolve(contentDir, 'doc.md'),
        newPath: resolve(contentDir, 'renamed.md'),
        oldDocName: 'doc',
        newDocName: 'renamed',
        content: '---\ntitle: Renamed Title\nicon: 🔖\n---\n\nBody\n',
      },
      index,
    );
    expect(index.get('renamed')?.title).toBe('Renamed Title');
    // The rename arm is a structurally distinct path (delete old + set new), so
    // assert it re-derives the icon from the new content rather than carrying a
    // stale value forward.
    expect(index.get('renamed')?.icon).toBe('🔖');

    // The conflict arm shares the create/update case in updateFileIndex; pin
    // that it enriches too, so a future split of that arm can't silently serve
    // a stale/docName title for conflicted files.
    updateFileIndex(
      {
        kind: 'conflict' as const,
        path: resolve(contentDir, 'renamed.md'),
        docName: 'renamed',
        content: '---\ntitle: Conflicted\nicon: ⚠️\n---\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n',
      },
      index,
    );
    expect(index.get('renamed')?.title).toBe('Conflicted');
    expect(index.get('renamed')?.icon).toBe('⚠️');
  });

  test('getFileIndex returns empty map when no .md files exist', async () => {
    const handle = await startWatcher(contentDir, async () => {});
    try {
      expect(handle.getFileIndex().size).toBe(0);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('pruneFileIndexNowExcluded removes entries that became excluded after rebuild', async () => {
    // Bootstrap: two .md files visible; .okignore is empty so both index.
    writeFileSync(resolve(contentDir, 'keep.md'), '# Keep\n');
    writeFileSync(resolve(contentDir, 'hide-me.md'), '# Hide me\n');
    writeFileSync(resolve(tmpDir, '.okignore'), '');

    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      // Both files were indexed at boot.
      expect(handle.getFileIndex().has('keep')).toBe(true);
      expect(handle.getFileIndex().has('hide-me')).toBe(true);

      // Edit .okignore on disk to exclude hide-me.md, then rebuild
      // ContentFilter (the rebuild path the multi-path watcher would
      // trigger). The seeded fileIndex still has both entries — that's
      // the bug pruneFileIndexNowExcluded fixes.
      writeFileSync(resolve(tmpDir, '.okignore'), 'hide-me.md\n');
      await filter.rebuildIgnorePatterns();

      const pruned = handle.pruneFileIndexNowExcluded();
      expect(pruned).toBe(1);
      expect(handle.getFileIndex().has('keep')).toBe(true);
      expect(handle.getFileIndex().has('hide-me')).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('pruneFolderIndexNowExcluded removes folders that became excluded after rebuild', async () => {
    // Bootstrap: parent and nested folders exist in the index while .okignore is empty.
    mkdirSync(resolve(contentDir, 'archive', 'sub'), { recursive: true });
    writeFileSync(resolve(contentDir, 'archive', 'sub', 'old.md'), '# Old\n');
    writeFileSync(resolve(tmpDir, '.okignore'), '');

    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      expect(handle.getFolderIndex().has('archive')).toBe(true);
      expect(handle.getFolderIndex().has('archive/sub')).toBe(true);

      writeFileSync(resolve(tmpDir, '.okignore'), 'content/archive/\n');
      await filter.rebuildIgnorePatterns();

      const pruned = handle.pruneFolderIndexNowExcluded();
      expect(pruned).toBe(2);
      expect(handle.getFolderIndex().has('archive')).toBe(false);
      expect(handle.getFolderIndex().has('archive/sub')).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('pruneFileIndexNowExcluded is a no-op when nothing is now-excluded', async () => {
    writeFileSync(resolve(contentDir, 'keep.md'), '# Keep\n');
    writeFileSync(resolve(tmpDir, '.okignore'), '');

    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      expect(handle.getFileIndex().has('keep')).toBe(true);

      // Add a pattern that does NOT match keep.md.
      writeFileSync(resolve(tmpDir, '.okignore'), 'something-else.md\n');
      await filter.rebuildIgnorePatterns();

      expect(handle.pruneFileIndexNowExcluded()).toBe(0);
      expect(handle.getFileIndex().has('keep')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('pruneFolderIndexNowExcluded is a no-op when nothing is now-excluded', async () => {
    mkdirSync(resolve(contentDir, 'keep'), { recursive: true });
    writeFileSync(resolve(tmpDir, '.okignore'), '');

    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      expect(handle.getFolderIndex().has('keep')).toBe(true);

      writeFileSync(resolve(tmpDir, '.okignore'), 'content/something-else/\n');
      await filter.rebuildIgnorePatterns();

      expect(handle.pruneFolderIndexNowExcluded()).toBe(0);
      expect(handle.getFolderIndex().has('keep')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('pruneFileIndexNowExcluded returns 0 when no ContentFilter is set', async () => {
    writeFileSync(resolve(contentDir, 'keep.md'), '# Keep\n');

    // No filter passed.
    const handle = await startWatcher(contentDir, async () => {});
    try {
      expect(handle.pruneFileIndexNowExcluded()).toBe(0);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('pruneFolderIndexNowExcluded returns 0 when no ContentFilter is set', async () => {
    mkdirSync(resolve(contentDir, 'archive'), { recursive: true });

    const handle = await startWatcher(contentDir, async () => {});
    try {
      expect(handle.getFolderIndex().has('archive')).toBe(true);
      expect(handle.pruneFolderIndexNowExcluded()).toBe(0);
      expect(handle.getFolderIndex().has('archive')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('initial scan populates folderIndex with empty subdirectories', async () => {
    mkdirSync(resolve(contentDir, 'empty-folder'));
    mkdirSync(resolve(contentDir, 'nested', 'empty-child'), { recursive: true });

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const folderIndex = handle.getFolderIndex();
      expect(folderIndex.has('empty-folder')).toBe(true);
      expect(folderIndex.has('nested')).toBe(true);
      expect(folderIndex.has('nested/empty-child')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('folderIndex detects externally-created empty directory via live watcher', async () => {
    const events: DiskEvent[] = [];
    const handle = await startWatcher(contentDir, async (e) => {
      events.push(e);
    });
    try {
      mkdirSync(resolve(contentDir, 'live-empty'));
      // Allow the watcher up to 1 s to detect and emit the event.
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        if (handle.getFolderIndex().has('live-empty')) break;
        await new Promise((r) => setTimeout(r, 30));
      }
      expect(handle.getFolderIndex().has('live-empty')).toBe(true);
      expect(
        events.some((e) => e.kind === 'folder-create' && e.relativePath === 'live-empty'),
      ).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });
});

// ─── reconcileFileIndexAfterFilterRebuild — symmetric post-rebuild reconcile ─

describe('reconcileFileIndexAfterFilterRebuild', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-reconcile-'));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    lastKnownHash.clear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('re-includes files previously excluded after pattern removal (start-with-pattern → remove)', async () => {
    // Bug coverage gap: prior `.okignore` ADD-then-test passes (pruneFileIndexNowExcluded
    // covers it), but ADD-AT-BOOT, then REMOVE-AT-RUNTIME never had a test asserting
    // that the index re-includes. Without the symmetric rescan, the file stays hidden
    // from `/api/documents` until next server restart.
    writeFileSync(resolve(contentDir, 'keep.md'), '# Keep\n');
    writeFileSync(resolve(contentDir, 'hide-me.md'), '# Hide me\n');
    writeFileSync(resolve(tmpDir, '.okignore'), 'hide-me.md\n');

    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      // Boot: pattern excludes hide-me.
      expect(handle.getFileIndex().has('keep')).toBe(true);
      expect(handle.getFileIndex().has('hide-me')).toBe(false);

      // User removes the pattern; ContentFilter rebuild fires.
      writeFileSync(resolve(tmpDir, '.okignore'), '');
      const result = await filter.rebuildIgnorePatterns();
      expect(result.ok).toBe(true);

      const { prunedFiles, prunedFolders } = await reconcileFileIndexAfterFilterRebuild(handle);
      // Symmetric semantics: nothing pruned (no new exclusion); rescan adds hide-me.
      expect(prunedFiles).toBe(0);
      expect(prunedFolders).toBe(0);
      expect(handle.getFileIndex().has('hide-me')).toBe(true);
      expect(handle.getFileIndex().has('keep')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('still prunes now-excluded files after pattern addition (other direction)', async () => {
    // Regression guard: the symmetric add must not regress the prune semantics
    // covered by pruneFileIndexNowExcluded tests.
    writeFileSync(resolve(contentDir, 'keep.md'), '# Keep\n');
    writeFileSync(resolve(contentDir, 'will-hide.md'), '# Will hide\n');
    writeFileSync(resolve(tmpDir, '.okignore'), '');

    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      expect(handle.getFileIndex().has('keep')).toBe(true);
      expect(handle.getFileIndex().has('will-hide')).toBe(true);

      writeFileSync(resolve(tmpDir, '.okignore'), 'will-hide.md\n');
      const result = await filter.rebuildIgnorePatterns();
      expect(result.ok).toBe(true);

      const { prunedFiles, prunedFolders } = await reconcileFileIndexAfterFilterRebuild(handle);
      expect(prunedFiles).toBe(1);
      expect(prunedFolders).toBe(0);
      expect(handle.getFileIndex().has('will-hide')).toBe(false);
      expect(handle.getFileIndex().has('keep')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('re-includes a previously-excluded folder + its files after pattern removal', async () => {
    mkdirSync(resolve(contentDir, 'archive', 'sub'), { recursive: true });
    writeFileSync(resolve(contentDir, 'archive', 'sub', 'old.md'), '# Old\n');
    writeFileSync(resolve(contentDir, 'keep.md'), '# Keep\n');
    writeFileSync(resolve(tmpDir, '.okignore'), 'archive/\n');

    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      expect(handle.getFolderIndex().has('archive')).toBe(false);
      expect(handle.getFolderIndex().has('archive/sub')).toBe(false);
      expect(handle.getFileIndex().has('archive/sub/old')).toBe(false);
      expect(handle.getFileIndex().has('keep')).toBe(true);

      writeFileSync(resolve(tmpDir, '.okignore'), '');
      const result = await filter.rebuildIgnorePatterns();
      expect(result.ok).toBe(true);

      await reconcileFileIndexAfterFilterRebuild(handle);
      expect(handle.getFolderIndex().has('archive')).toBe(true);
      expect(handle.getFolderIndex().has('archive/sub')).toBe(true);
      expect(handle.getFileIndex().has('archive/sub/old')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('returns zero counts when no pattern matches existing entries', async () => {
    writeFileSync(resolve(contentDir, 'keep.md'), '# Keep\n');
    writeFileSync(resolve(tmpDir, '.okignore'), '');

    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      writeFileSync(resolve(tmpDir, '.okignore'), 'unrelated.md\n');
      await filter.rebuildIgnorePatterns();
      const { prunedFiles, prunedFolders } = await reconcileFileIndexAfterFilterRebuild(handle);
      expect(prunedFiles).toBe(0);
      expect(prunedFolders).toBe(0);
      expect(handle.getFileIndex().has('keep')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('prunes one file while re-including another in the same reconcile (pattern swap)', async () => {
    // The real production scenario: a user edits .okignore to swap one
    // pattern for another (or removes one pattern and adds a different one
    // in the same edit). Both halves of the symmetric pair must fire in
    // a single reconcile — prune for the newly-excluded entry, rescan
    // for the newly-included one — to produce the correct final index.
    writeFileSync(resolve(contentDir, 'will-hide.md'), '# Will hide\n');
    writeFileSync(resolve(contentDir, 'was-hidden.md'), '# Was hidden\n');
    writeFileSync(resolve(tmpDir, '.okignore'), 'was-hidden.md\n');

    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      expect(handle.getFileIndex().has('will-hide')).toBe(true);
      expect(handle.getFileIndex().has('was-hidden')).toBe(false);

      // Swap: hide `will-hide`, re-include `was-hidden`, in one edit.
      writeFileSync(resolve(tmpDir, '.okignore'), 'will-hide.md\n');
      const result = await filter.rebuildIgnorePatterns();
      expect(result.ok).toBe(true);

      const { prunedFiles } = await reconcileFileIndexAfterFilterRebuild(handle);
      expect(prunedFiles).toBe(1);
      expect(handle.getFileIndex().has('will-hide')).toBe(false);
      expect(handle.getFileIndex().has('was-hidden')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('returns zero counts when watcher is undefined (defensive guard)', async () => {
    const { prunedFiles, prunedFolders } = await reconcileFileIndexAfterFilterRebuild(undefined);
    expect(prunedFiles).toBe(0);
    expect(prunedFolders).toBe(0);
  });
});

// ─── ContentFilter refcount integration ────────────────────────────────────

describe('file-watcher ContentFilter refcount hooks', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-watcher-refcount-'));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    lastKnownHash.clear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('.md rename across directories triggers decrement on old dir and increment on new dir', async () => {
    mkdirSync(resolve(contentDir, 'old-dir'));
    mkdirSync(resolve(contentDir, 'new-dir'));
    writeFileSync(resolve(contentDir, 'old-dir', 'doc.md'), '# Doc\n');

    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    // Before rename: old-dir has an .md, so assets there should be included
    expect(filter.isExcluded('old-dir/img.png')).toBe(false);
    expect(filter.isExcluded('new-dir/img.png')).toBe(true);

    // Simulate rename as classifyEvents would produce it
    const oldPath = resolve(contentDir, 'old-dir', 'doc.md');
    const newPath = resolve(contentDir, 'new-dir', 'doc.md');
    updateLastKnownHash(oldPath, contentHash('# Doc\n'));
    writeFileSync(newPath, '# Doc\n');

    const events = await classifyEvents(
      [
        { type: 'delete', path: oldPath },
        { type: 'create', path: newPath },
      ],
      contentDir,
      filter,
    );

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('rename');

    // Apply filter hooks as handleRawEvents would
    if (events[0].kind === 'rename') {
      const { dirname } = await import('node:path');
      filter.decrementMdDir(dirname(events[0].oldDocName));
      filter.incrementMdDir(dirname(events[0].newDocName));
    }

    // After rename: old-dir loses its .md, new-dir gains one
    expect(filter.isExcluded('old-dir/img.png')).toBe(true);
    expect(filter.isExcluded('new-dir/img.png')).toBe(false);
  });

  test('same-batch md+asset create in a brand-new directory: asset is dispatched (md-first ordering)', async () => {
    // Reproduces the file-watcher race the bot flagged. Sequence:
    //   `mkdir foo && cp note.md foo/ && cp pic.png foo/`
    // arrives in a single watcher batch — @parcel/watcher's FSEvents
    // backend coalesces with `latency=0.001` (1ms; FSEventsBackend.cc),
    // and the chokidar fallback batches in `BATCH_WINDOW_MS=50`. Both
    // windows easily span a quick mkdir+cp+cp burst.
    //
    // With assets-first ordering (the pre-fix shape) the asset hits
    // `isExcluded()` while the new dir's `dirCount` is still 0; the
    // sibling-asset rule (extension in LINKABLE_ASSET_EXTENSIONS + dirCount > 0)
    // fails closed and the asset never makes it to `onDiskEvent` — i.e.
    // never lands in basenameIndex until the next server restart.
    //
    // This test runs `handleRawEvents` directly with a one-batch pair.
    // Md-first ordering must dispatch BOTH events. Mutation: revert the
    // ordering swap → only the md create event reaches the collector.
    // Create filter FIRST while disk is empty — `createContentFilter`
    // scans the tree at construction and would see the .md if it
    // already existed, prefilling dirCount and masking the bug.
    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
      // No explicit asset include — admission depends entirely on the
      // sibling-asset fallback rule, which is the path the bug lives on.
    });

    // Pre-condition: dirCount for `fresh/` is 0 → asset is excluded.
    expect(filter.isExcluded('fresh/pic.png')).toBe(true);

    // Now create the files — simulating the same-batch fs activity
    // the watcher about to surface.
    const newDir = resolve(contentDir, 'fresh');
    mkdirSync(newDir);
    const mdPath = resolve(newDir, 'note.md');
    const assetPath = resolve(newDir, 'pic.png');
    writeFileSync(mdPath, '# Note\n');
    writeFileSync(assetPath, 'fake-png-bytes');

    const collected: DiskEvent[] = [];
    await handleRawEvents(
      [
        { type: 'create', path: mdPath },
        { type: 'create', path: assetPath },
      ],
      contentDir,
      filter,
      new Map(),
      new Map(),
      async (e) => {
        collected.push(e);
      },
    );

    const kinds = collected.map((e) => e.kind).sort();
    // a non-md create now also fires `file-create` for the
    // all-files file-index admission (alongside the asset-create that
    // maintains the render-side basenameIndex). The two paths are independent
    // by design — different state, different consumers.
    expect(kinds).toEqual(['asset-create', 'create', 'file-create']);
    const asset = collected.find((e) => e.kind === 'asset-create');
    expect(asset?.kind).toBe('asset-create');
    if (asset?.kind === 'asset-create') {
      expect(asset.relativePath).toBe('fresh/pic.png');
    }
    // dirCount is now 1 — assets in `fresh/` admit on subsequent checks too.
    expect(filter.isExcluded('fresh/pic.png')).toBe(false);
  });

  test('LINKABLE_ASSET_EXTENSIONS: .base file alongside .md dispatches asset-create event', async () => {
    // .base and .canvas are in LINKABLE_ASSET_EXTENSIONS but NOT in ASSET_EXTENSIONS.
    // Reverting the handleRawEvents swap back to ASSET_EXTENSIONS would cause
    // isSupportedAssetFile to reject .base and drop the asset-create event here.
    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    const newDir = resolve(contentDir, 'canvas-test');
    mkdirSync(newDir);
    const mdPath = resolve(newDir, 'note.md');
    const assetPath = resolve(newDir, 'board.base');
    writeFileSync(mdPath, '# Note\n');
    writeFileSync(assetPath, '{}');

    const collected: DiskEvent[] = [];
    await handleRawEvents(
      [
        { type: 'create', path: mdPath },
        { type: 'create', path: assetPath },
      ],
      contentDir,
      filter,
      new Map(),
      new Map(),
      async (e) => {
        collected.push(e);
      },
    );

    const kinds = collected.map((e) => e.kind).sort();
    // `.base` is also non-md so a
    // `file-create` fires alongside the `asset-create`.
    expect(kinds).toEqual(['asset-create', 'create', 'file-create']);
    const asset = collected.find((e) => e.kind === 'asset-create');
    if (asset?.kind === 'asset-create') {
      expect(asset.relativePath).toBe('canvas-test/board.base');
    }
  });

  test('folder create/delete events update the folder index', async () => {
    const folderIndex = new Map();
    const collected: DiskEvent[] = [];
    const notesDir = resolve(contentDir, 'notes');
    const nestedDir = resolve(notesDir, 'nested');
    mkdirSync(nestedDir, { recursive: true });

    await handleRawEvents(
      [
        { type: 'create', path: notesDir },
        { type: 'create', path: nestedDir },
      ],
      contentDir,
      undefined,
      new Map(),
      folderIndex,
      async (e) => {
        collected.push(e);
      },
    );

    expect(folderIndex.has('notes')).toBe(true);
    expect(folderIndex.has('notes/nested')).toBe(true);
    expect(collected).toContainEqual(
      expect.objectContaining({ kind: 'folder-create', relativePath: 'notes' }),
    );
    expect(collected).toContainEqual(
      expect.objectContaining({ kind: 'folder-create', relativePath: 'notes/nested' }),
    );

    await rm(notesDir, { recursive: true, force: true });
    await handleRawEvents(
      [{ type: 'delete', path: notesDir }],
      contentDir,
      undefined,
      new Map(),
      folderIndex,
      async (e) => {
        collected.push(e);
      },
    );

    expect(folderIndex.has('notes')).toBe(false);
    expect(folderIndex.has('notes/nested')).toBe(false);
    expect(collected).toContainEqual(
      expect.objectContaining({ kind: 'folder-delete', relativePath: 'notes' }),
    );
  });

  test('mkdir -p race: single create event for parent surfaces folder-create for all pre-existing subdirs', async () => {
    // On Linux, `mkdir -p deep/nested/empty` creates all three levels faster
    // than parcel-watcher can call inotify_add_watch on each new directory,
    // so the kernel only delivers an event for `deep` (the level that was
    // already being watched). Without the recursive rescan, `deep/nested`
    // and `deep/nested/empty` would be missing from the folder index.
    //
    // This test simulates the race by invoking `handleRawEvents` with ONLY
    // the top-level `deep` create event, even though all three levels exist
    // on disk.
    const folderIndex = new Map();
    const collected: DiskEvent[] = [];
    const deepDir = resolve(contentDir, 'deep');
    const nestedDir = resolve(deepDir, 'nested');
    const emptyDir = resolve(nestedDir, 'empty');
    mkdirSync(emptyDir, { recursive: true });

    await handleRawEvents(
      [{ type: 'create', path: deepDir }],
      contentDir,
      undefined,
      new Map(),
      folderIndex,
      async (e) => {
        collected.push(e);
      },
    );

    expect(folderIndex.has('deep')).toBe(true);
    expect(folderIndex.has('deep/nested')).toBe(true);
    expect(folderIndex.has('deep/nested/empty')).toBe(true);
    expect(collected).toContainEqual(
      expect.objectContaining({ kind: 'folder-create', relativePath: 'deep' }),
    );
    expect(collected).toContainEqual(
      expect.objectContaining({ kind: 'folder-create', relativePath: 'deep/nested' }),
    );
    expect(collected).toContainEqual(
      expect.objectContaining({ kind: 'folder-create', relativePath: 'deep/nested/empty' }),
    );

    // Parent-before-child ordering matches the natural creation order.
    const folderEvents = collected
      .filter((e) => e.kind === 'folder-create')
      .map((e) => e.relativePath);
    expect(folderEvents.indexOf('deep')).toBeLessThan(folderEvents.indexOf('deep/nested'));
    expect(folderEvents.indexOf('deep/nested')).toBeLessThan(
      folderEvents.indexOf('deep/nested/empty'),
    );
  });

  test('rescan does not double-emit when an inner folder already arrived as its own raw event', async () => {
    // Same race, but parcel-watcher manages to deliver events for
    // both the parent and one of the children. The rescan triggered by the
    // parent must not emit a second `folder-create` for the already-indexed
    // child.
    const folderIndex = new Map();
    const collected: DiskEvent[] = [];
    const deepDir = resolve(contentDir, 'deep');
    const nestedDir = resolve(deepDir, 'nested');
    mkdirSync(nestedDir, { recursive: true });

    await handleRawEvents(
      [
        { type: 'create', path: deepDir },
        { type: 'create', path: nestedDir },
      ],
      contentDir,
      undefined,
      new Map(),
      folderIndex,
      async (e) => {
        collected.push(e);
      },
    );

    const nestedCreates = collected.filter(
      (e) => e.kind === 'folder-create' && e.relativePath === 'deep/nested',
    );
    expect(nestedCreates).toHaveLength(1);
  });

  test('dropped file-create rescue: folder event alone surfaces a markdown file already inside', async () => {
    // Same inotify registration race as the mkdir -p test, file flavor:
    // `mkdir d && cp note.md d/` writes the file before the recursive
    // subwatch registers, so the kernel only delivers the directory event.
    // The rescan must re-inject the file as a synthetic create — otherwise
    // /api/pages and the CRDT layer miss it until a manual rescan.
    const fileIndex = new Map();
    const folderIndex = new Map();
    const collected: DiskEvent[] = [];
    const scratchDir = resolve(contentDir, '.scratch-notes');
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(resolve(scratchDir, 'hidden-note.md'), '# Hidden note\n', 'utf-8');

    await handleRawEvents(
      [{ type: 'create', path: scratchDir }],
      contentDir,
      undefined,
      fileIndex,
      folderIndex,
      async (e) => {
        collected.push(e);
      },
    );

    expect(folderIndex.has('.scratch-notes')).toBe(true);
    expect(fileIndex.has('.scratch-notes/hidden-note')).toBe(true);
    expect(collected).toContainEqual(
      expect.objectContaining({
        kind: 'create',
        docName: '.scratch-notes/hidden-note',
        content: '# Hidden note\n',
      }),
    );
  });

  test('dropped file-create rescue reaches files in rescued subfolders and non-markdown files', async () => {
    const fileIndex = new Map();
    const folderIndex = new Map();
    const collected: DiskEvent[] = [];
    const outerDir = resolve(contentDir, 'outer');
    const innerDir = resolve(outerDir, 'inner');
    mkdirSync(innerDir, { recursive: true });
    writeFileSync(resolve(innerDir, 'deep-note.md'), '# Deep\n', 'utf-8');
    writeFileSync(resolve(outerDir, 'data.json'), '{}', 'utf-8');

    await handleRawEvents(
      [{ type: 'create', path: outerDir }],
      contentDir,
      undefined,
      fileIndex,
      folderIndex,
      async (e) => {
        collected.push(e);
      },
    );

    expect(fileIndex.has('outer/inner/deep-note')).toBe(true);
    expect(collected).toContainEqual(
      expect.objectContaining({ kind: 'create', docName: 'outer/inner/deep-note' }),
    );
    expect(fileIndex.get('outer/data.json')?.kind).toBe('file');
    expect(collected).toContainEqual(
      expect.objectContaining({ kind: 'file-create', relativePath: 'outer/data.json' }),
    );
  });

  test('file rescue does not double-emit when the file event arrived in the same batch', async () => {
    // macOS FSEvents coalesces mkdir+write into one batch, so both raw events
    // are usually present — the rescue must dedupe against the batch.
    const fileIndex = new Map();
    const folderIndex = new Map();
    const collected: DiskEvent[] = [];
    const notesDir = resolve(contentDir, 'batch-notes');
    const notePath = resolve(notesDir, 'note.md');
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(notePath, '# Note\n', 'utf-8');

    await handleRawEvents(
      [
        { type: 'create', path: notesDir },
        { type: 'create', path: notePath },
      ],
      contentDir,
      undefined,
      fileIndex,
      folderIndex,
      async (e) => {
        collected.push(e);
      },
    );

    const creates = collected.filter(
      (e) => e.kind === 'create' && e.docName === 'batch-notes/note',
    );
    expect(creates).toHaveLength(1);
  });

  test('file rescue respects self-write tracking: rescued own write is indexed but not dispatched', async () => {
    const fileIndex = new Map();
    const folderIndex = new Map();
    const collected: DiskEvent[] = [];
    const selfDir = resolve(contentDir, 'self-notes');
    const selfPath = resolve(selfDir, 'own-write.md');
    const content = '# Ours\n';
    mkdirSync(selfDir, { recursive: true });
    writeFileSync(selfPath, content, 'utf-8');
    registerWrite(realpathSync(selfPath), contentHash(content));

    await handleRawEvents(
      [{ type: 'create', path: selfDir }],
      contentDir,
      undefined,
      fileIndex,
      folderIndex,
      async (e) => {
        collected.push(e);
      },
    );

    expect(fileIndex.has('self-notes/own-write')).toBe(true);
    expect(collected.filter((e) => e.kind === 'create')).toHaveLength(0);
  });

  test('file rescue suppresses files under a ContentFilter-excluded subfolder', async () => {
    writeFileSync(resolve(tmpDir, '.gitignore'), 'vendor/\n');
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const fileIndex = new Map();
    const folderIndex = new Map();
    const collected: DiskEvent[] = [];
    const packDir = resolve(contentDir, 'pack');
    const vendorDir = resolve(packDir, 'vendor');
    mkdirSync(vendorDir, { recursive: true });
    writeFileSync(resolve(packDir, 'note.md'), '# Note\n', 'utf-8');
    writeFileSync(resolve(vendorDir, 'data.json'), '{}', 'utf-8');
    writeFileSync(resolve(vendorDir, 'hidden.md'), '# Hidden\n', 'utf-8');

    await handleRawEvents(
      [{ type: 'create', path: packDir }],
      contentDir,
      filter,
      fileIndex,
      folderIndex,
      async (e) => {
        collected.push(e);
      },
    );

    expect(fileIndex.has('pack/note')).toBe(true);
    expect(fileIndex.has('pack/vendor/data.json')).toBe(false);
    expect(fileIndex.has('pack/vendor/hidden')).toBe(false);
    expect(collected.some((e) => e.kind === 'file-create')).toBe(false);
    expect(collected.filter((e) => e.kind === 'create').map((e) => e.docName)).toEqual([
      'pack/note',
    ]);
  });

  test('file rescue skips symlinked files in a freshly created directory', async () => {
    const fileIndex = new Map();
    const folderIndex = new Map();
    const collected: DiskEvent[] = [];
    const targetPath = resolve(contentDir, 'link-target.md');
    writeFileSync(targetPath, '# Target\n', 'utf-8');
    const linkedDir = resolve(contentDir, 'linked');
    mkdirSync(linkedDir, { recursive: true });
    writeFileSync(resolve(linkedDir, 'real.md'), '# Real\n', 'utf-8');
    symlinkSync(targetPath, resolve(linkedDir, 'alias.md'));

    await handleRawEvents(
      [{ type: 'create', path: linkedDir }],
      contentDir,
      undefined,
      fileIndex,
      folderIndex,
      async (e) => {
        collected.push(e);
      },
    );

    // Only the regular file is rescued; the symlink waits for its own raw
    // event, which carries the escape check + alias resolution.
    expect(fileIndex.has('linked/real')).toBe(true);
    expect(fileIndex.has('linked/alias')).toBe(false);
    expect(collected.filter((e) => e.kind === 'create').map((e) => e.docName)).toEqual([
      'linked/real',
    ]);
  });
});

// ─── Symlink-aware watcher ──────────────────────────────────────────────────

describe('startWatcher symlink handling', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = realpathSync(await mkdtemp(resolve(tmpdir(), 'ok-watcher-symlink-')));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    lastKnownHash.clear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('indexes symlinked file with canonical docName and registers alias', async () => {
    const targetPath = resolve(contentDir, 'target.md');
    const linkPath = resolve(contentDir, 'link.md');
    writeFileSync(targetPath, '# Target\n');
    symlinkSync(targetPath, linkPath);

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const index = handle.getFileIndex();
      const aliasMap = handle.getAliasMap();

      expect(index.has('target')).toBe(true);
      expect(aliasMap.get('link')).toBe('target');

      const entry = index.get('target');
      expect(entry).toBeTruthy();
      expect(entry?.canonicalPath).toBe(targetPath);
      expect(entry?.inode).toBeGreaterThan(0);
      expect(entry?.aliases).toContain('link');
    } finally {
      await handle.unsubscribe();
    }
  });

  test('records a folder-alias edge for a symlinked directory without materializing its subtree', async () => {
    const canonicalDir = resolve(contentDir, 'canonical');
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(resolve(canonicalDir, 'note.md'), '# Note\n');
    mkdirSync(resolve(canonicalDir, 'sub'), { recursive: true });
    writeFileSync(resolve(canonicalDir, 'sub', 'deep.md'), '# Deep\n');
    // Two symlinks to the same in-scope directory.
    symlinkSync(canonicalDir, resolve(contentDir, 'aliasA'));
    symlinkSync(canonicalDir, resolve(contentDir, 'aliasB'));

    const handle = await startWatcher(contentDir, async () => {});
    try {
      // Each directory symlink is recorded as a single edge → canonical docName.
      const folderAliasIndex = handle.getFolderAliasIndex();
      expect(folderAliasIndex.get('aliasA')).toBe('canonical');
      expect(folderAliasIndex.get('aliasB')).toBe('canonical');

      // Canonical subtree indexed exactly once under canonical docNames; the
      // alias prefixes are NOT materialized into the file/folder indexes.
      const index = handle.getFileIndex();
      expect(index.has('canonical/note')).toBe(true);
      expect(index.has('canonical/sub/deep')).toBe(true);
      expect(index.has('aliasA/note')).toBe(false);
      expect(index.has('aliasB/sub/deep')).toBe(false);

      const folderIndex = handle.getFolderIndex();
      expect(folderIndex.has('canonical')).toBe(true);
      expect(folderIndex.has('canonical/sub')).toBe(true);
      expect(folderIndex.has('aliasA')).toBe(false);
      expect(folderIndex.has('aliasB')).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('skips broken symlinks during startup walk', async () => {
    const linkPath = resolve(contentDir, 'broken.md');
    symlinkSync(resolve(contentDir, 'nonexistent.md'), linkPath);
    writeFileSync(resolve(contentDir, 'good.md'), '# Good\n');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const index = handle.getFileIndex();
      expect(index.has('good')).toBe(true);
      expect(index.has('broken')).toBe(false);
      expect(index.has('nonexistent')).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('skips symlinks escaping contentDir during startup walk', async () => {
    const outsideDir = resolve(tmpDir, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    const outsideFile = resolve(outsideDir, 'secret.md');
    writeFileSync(outsideFile, '# Secret\n');

    const escapePath = resolve(contentDir, 'escape.md');
    symlinkSync(outsideFile, escapePath);
    writeFileSync(resolve(contentDir, 'safe.md'), '# Safe\n');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const index = handle.getFileIndex();
      expect(index.has('safe')).toBe(true);
      expect(index.has('escape')).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('drops runtime events for symlinks whose target escapes contentDir', async () => {
    // Defense-in-depth against hostile-symlink content leaks. A symlink
    // landing in contentDir AFTER startup (so it bypasses the seed-walk
    // escape check) must not surface external content to onDiskEvent.
    // Without this guard, classifyEvents would readFile() through the
    // symlink and emit /etc/passwd-shaped content as a contentDir-scoped
    // create event.
    const outsideDir = resolve(tmpDir, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    const outsideFile = resolve(outsideDir, 'secret.md');
    writeFileSync(outsideFile, '# external secrets\n');

    const escapePath = resolve(contentDir, 'escape.md');
    symlinkSync(outsideFile, escapePath);

    const collected: DiskEvent[] = [];
    await handleRawEvents(
      [{ type: 'create', path: escapePath }],
      contentDir,
      undefined,
      new Map(),
      new Map(),
      async (e) => {
        collected.push(e);
      },
    );

    expect(collected).toHaveLength(0);
  });

  test('drops runtime events for asset symlinks whose target escapes contentDir', async () => {
    // Same threat as the markdown variant, but asset events bypass
    // classifyEvents entirely and go straight to onDiskEvent — they
    // need their own coverage of the escape filter.
    const outsideDir = resolve(tmpDir, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    const outsideAsset = resolve(outsideDir, 'leak.png');
    writeFileSync(outsideAsset, 'fake-png');

    const escapePath = resolve(contentDir, 'leak.png');
    symlinkSync(outsideAsset, escapePath);

    const collected: DiskEvent[] = [];
    await handleRawEvents(
      [{ type: 'create', path: escapePath }],
      contentDir,
      undefined,
      new Map(),
      new Map(),
      async (e) => {
        collected.push(e);
      },
    );

    expect(collected).toHaveLength(0);
  });

  test('preserves runtime events for symlinks pointing inside contentDir', async () => {
    // Negative control: the escape filter must not break the supported
    // intra-contentDir alias case. resolveDocName + aliasMap handle the
    // canonical-docName mapping; here we just assert the event survives.
    const targetPath = resolve(contentDir, 'real-target.md');
    const aliasPath = resolve(contentDir, 'alias.md');
    writeFileSync(targetPath, '# real\n');
    symlinkSync(targetPath, aliasPath);

    const aliasMap = new Map<string, string>();
    const collected: DiskEvent[] = [];
    await handleRawEvents(
      [{ type: 'create', path: aliasPath }],
      contentDir,
      undefined,
      new Map(),
      new Map(),
      async (e) => {
        collected.push(e);
      },
      aliasMap,
    );

    expect(collected).toHaveLength(1);
    expect(collected[0].kind).toBe('create');
    if (collected[0].kind === 'create') {
      expect(collected[0].docName).toBe('real-target');
    }
    expect(aliasMap.get('alias')).toBe('real-target');
  });

  test('skips symlink-to-excluded-dir (node_modules inside contentDir) during startup walk', async () => {
    // node_modules lives inside contentDir — NOT a symlink-escape, so the escape
    // check does not fire. Only isDirExcluded() stops traversal.
    const realNm = resolve(contentDir, 'node_modules');
    mkdirSync(realNm, { recursive: true });
    // Broken symlink inside — traversal would throw if isDirExcluded check is missing
    symlinkSync(resolve(realNm, 'nonexistent'), resolve(realNm, 'broken-pkg'));
    writeFileSync(resolve(realNm, 'README.md'), '# Pkg\n');

    // Sub-package symlinking back to root node_modules (pnpm-style hoisting).
    // Exercises the symlink → directory path.
    const subPkg = resolve(contentDir, 'packages', 'foo');
    mkdirSync(subPkg, { recursive: true });
    symlinkSync(realNm, resolve(subPkg, 'node_modules'));

    writeFileSync(resolve(contentDir, 'docs.md'), '# Docs\n');

    const filter = createContentFilter({
      projectDir: tmpDir,
      contentDir,
    });

    const handle = await startWatcher(contentDir, async () => {}, filter);
    try {
      const index = handle.getFileIndex();
      // docs.md indexed; node_modules contents are not
      expect(index.has('docs')).toBe(true);
      expect(index.has('node_modules/README')).toBe(false);
      expect(index.has('packages/foo/node_modules/README')).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('handles cyclic symlink directories without infinite loop', async () => {
    const dirA = resolve(contentDir, 'dir-a');
    const dirB = resolve(contentDir, 'dir-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(resolve(dirA, 'file.md'), '# File A\n');

    symlinkSync(dirB, resolve(dirA, 'link-to-b'));
    symlinkSync(dirA, resolve(dirB, 'link-to-a'));

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const index = handle.getFileIndex();
      expect(index.has('dir-a/file')).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('FileIndexEntry has canonicalPath, inode, and aliases fields', async () => {
    writeFileSync(resolve(contentDir, 'regular.md'), '# Regular\n');

    const handle = await startWatcher(contentDir, async () => {});
    try {
      const entry = handle.getFileIndex().get('regular');
      expect(entry).toBeTruthy();
      expect(entry?.canonicalPath).toBe(resolve(contentDir, 'regular.md'));
      expect(entry?.inode).toBeGreaterThan(0);
      expect(entry?.aliases).toEqual([]);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('classifyEvents resolves alias docName to canonical', async () => {
    const targetPath = resolve(contentDir, 'target.md');
    const linkPath = resolve(contentDir, 'link.md');
    writeFileSync(targetPath, '# Target\n');
    symlinkSync(targetPath, linkPath);

    const aliasMap = new Map([['link', 'target']]);
    updateLastKnownHash(linkPath, contentHash('# Target\n'));

    writeFileSync(targetPath, '# Updated\n');

    const events = await classifyEvents(
      [{ type: 'update', path: linkPath }],
      contentDir,
      undefined,
      aliasMap,
    );

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('update');
    if (events[0].kind === 'update') {
      expect(events[0].docName).toBe('target');
    }
  });

  test('self-write detection works with canonical path after symlink resolution', async () => {
    const targetPath = resolve(contentDir, 'target.md');
    const linkPath = resolve(contentDir, 'link.md');
    writeFileSync(targetPath, '# Original\n');
    symlinkSync(targetPath, linkPath);

    const markdown = '# Updated via symlink\n';
    const hash = contentHash(markdown);

    registerWrite(targetPath, hash);

    expect(isSelfWrite(targetPath, hash)).toBe(true);
  });

  test('classifyEvents live-resolves symlink created post-startup and updates aliasMap', async () => {
    // Simulate a symlink that appears AFTER the watcher's startup walk — i.e.
    // the aliasMap is empty but the path on disk is a live symlink. The watcher
    // should lstat, realpath, populate the aliasMap, and emit the canonical
    // docName on the resulting DiskEvent.
    const targetPath = resolve(contentDir, 'new-target.md');
    const linkPath = resolve(contentDir, 'new-link.md');
    writeFileSync(targetPath, '# Target\n');
    symlinkSync(targetPath, linkPath);

    const aliasMap = new Map<string, string>();

    const events = await classifyEvents(
      [{ type: 'create', path: linkPath }],
      contentDir,
      undefined,
      aliasMap,
    );

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('create');
    if (events[0].kind === 'create') {
      expect(events[0].docName).toBe('new-target');
    }
    expect(aliasMap.get('new-link')).toBe('new-target');
  });

  test('classifyEvents re-resolves a repointed symlink and updates aliasMap', async () => {
    // Symlink was originally pointing to old-target.md; now it's been repointed
    // to fresh-target.md. The watcher should detect the change on the next
    // event and update its aliasMap entry.
    const oldTargetPath = resolve(contentDir, 'old-target.md');
    const newTargetPath = resolve(contentDir, 'fresh-target.md');
    const aliasPath = resolve(contentDir, 'alias.md');
    writeFileSync(oldTargetPath, '# Old\n');
    writeFileSync(newTargetPath, '# Fresh\n');
    symlinkSync(newTargetPath, aliasPath);

    // aliasMap is stale — still points to the old canonical
    const aliasMap = new Map<string, string>([['alias', 'old-target']]);

    const events = await classifyEvents(
      [{ type: 'update', path: aliasPath }],
      contentDir,
      undefined,
      aliasMap,
    );

    expect(events).toHaveLength(1);
    if (events[0].kind === 'update') {
      expect(events[0].docName).toBe('fresh-target');
    }
    expect(aliasMap.get('alias')).toBe('fresh-target');
  });
});
