/**
 * Regression: the chokidar fallback (used whenever @parcel/watcher can't be
 * loaded — every packaged desktop build today) must watch SUBDIRECTORIES.
 *
 * The `ignored` predicate used to route a stats-less directory through the
 * file-only `isExcluded`, which default-excludes any non-`.md`/non-asset name,
 * so chokidar pruned every content subfolder and no external edit under one
 * ever reached the server (graph / backlinks / dead-links stayed stale until a
 * restart rebuilt from disk). inkeep/open-knowledge#760.
 */
import { lstatSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createContentFilter } from './content-filter.ts';
import {
  type DiskEvent,
  isChokidarPathIgnored,
  lastKnownHash,
  startWatcher,
  writeTracker,
} from './file-watcher.ts';

describe('isChokidarPathIgnored — stats matrix', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-chokidar-ignored-'));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(resolve(contentDir, 'sub'), { recursive: true });
    mkdirSync(resolve(contentDir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(resolve(contentDir, 'sub', 'note.md'), '# Note\n');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('the content dir root is never ignored', () => {
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    expect(isChokidarPathIgnored(contentDir, filter, contentDir, statSync(contentDir))).toBe(false);
  });

  test('a content subdirectory is NOT ignored — with stats and (the bug) without', () => {
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const subDir = resolve(contentDir, 'sub');
    // With directory stats: routed through isDirExcluded → descendable.
    expect(isChokidarPathIgnored(contentDir, filter, subDir, statSync(subDir))).toBe(false);
    // WITHOUT stats (chokidar's subwatch gate): pre-fix this fell through to
    // the file-only isExcluded and returned true, pruning the subtree.
    expect(isChokidarPathIgnored(contentDir, filter, subDir, undefined)).toBe(false);
  });

  test('a markdown file is not ignored; a stats-less non-content file routes through isExcluded', () => {
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const mdFile = resolve(contentDir, 'sub', 'note.md');
    expect(isChokidarPathIgnored(contentDir, filter, mdFile, lstatSync(mdFile))).toBe(false);
    // A real, extension-less file: `isExcluded` excludes it (not a doc/asset)
    // while `isDirExcluded` would admit it, so a `true` here proves the
    // stats-less path lstat'd to the FILE branch, not the directory branch.
    writeFileSync(resolve(contentDir, 'sub', 'Makefile'), 'x');
    const plain = resolve(contentDir, 'sub', 'Makefile');
    expect(filter.isExcluded('sub/Makefile')).toBe(true);
    expect(filter.isDirExcluded('sub/Makefile')).toBe(false);
    expect(isChokidarPathIgnored(contentDir, filter, plain, undefined)).toBe(true);
  });

  test('excluded directories stay pruned even without stats (node_modules)', () => {
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const nm = resolve(contentDir, 'node_modules');
    expect(isChokidarPathIgnored(contentDir, filter, nm, undefined)).toBe(true);
  });

  test('a nonexistent path with no stats is admitted (never prune on uncertainty)', () => {
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const gone = resolve(contentDir, 'sub', 'was-just-deleted.md');
    expect(isChokidarPathIgnored(contentDir, filter, gone, undefined)).toBe(false);
  });
});

describe('chokidar backend — live subfolder watching (forceBackend)', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-chokidar-live-'));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(resolve(contentDir, 'sub'), { recursive: true });
    writeFileSync(resolve(contentDir, 'root.md'), '# Root\n');
    writeFileSync(resolve(contentDir, 'sub', 'note.md'), '# Note\n\n[Root](./root)\n');
    lastKnownHash.clear();
    writeTracker.clear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function until(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 40));
    }
    return predicate();
  }

  test('edits to a pre-existing subfolder doc dispatch a DiskEvent', async () => {
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const events: DiskEvent[] = [];
    const handle = await startWatcher(contentDir, async (e) => void events.push(e), filter, {
      forceBackend: 'chokidar',
    });
    try {
      // Sanity: a root-level edit is detected (this worked pre-fix too).
      writeFileSync(resolve(contentDir, 'root.md'), '# Root edited\n');
      expect(
        await until(() => events.some((e) => e.kind === 'update' && e.docName === 'root')),
      ).toBe(true);

      // The regression: a subfolder edit must also dispatch.
      writeFileSync(resolve(contentDir, 'sub', 'note.md'), '# Note edited\n\n[Gone](./gone)\n');
      expect(
        await until(() => events.some((e) => e.kind === 'update' && e.docName === 'sub/note')),
      ).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('a doc created in a NEW subfolder after watch start dispatches a DiskEvent', async () => {
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const events: DiskEvent[] = [];
    const handle = await startWatcher(contentDir, async (e) => void events.push(e), filter, {
      forceBackend: 'chokidar',
    });
    try {
      mkdirSync(resolve(contentDir, 'fresh'));
      // The folder-create dispatch proves chokidar's addDir was processed, so
      // the sub-watch is armed before we write into the directory. A fixed
      // sleep would race a loaded runner and idle on a fast one.
      expect(
        await until(() =>
          events.some((e) => e.kind === 'folder-create' && e.relativePath === 'fresh'),
        ),
      ).toBe(true);
      writeFileSync(resolve(contentDir, 'fresh', 'child.md'), '# Child\n');
      expect(
        await until(() =>
          events.some(
            (e) => (e.kind === 'create' || e.kind === 'update') && e.docName === 'fresh/child',
          ),
        ),
      ).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('excluded subtrees stay pruned — node_modules edits do not dispatch', async () => {
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const events: DiskEvent[] = [];
    const handle = await startWatcher(contentDir, async (e) => void events.push(e), filter, {
      forceBackend: 'chokidar',
    });
    try {
      // Write into the excluded subtree, then edit a watched file as a
      // sentinel. Waiting for the sentinel to dispatch proves the watcher was
      // live through the window — so the absent node_modules event is a real
      // negative, not a vacuous "nothing fired yet" (node_modules is never
      // watched, so its write can't race ahead of the sentinel).
      mkdirSync(resolve(contentDir, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(resolve(contentDir, 'node_modules', 'dep', 'readme.md'), '# Dep\n');
      writeFileSync(resolve(contentDir, 'root.md'), '# Root sentinel\n');
      expect(
        await until(() => events.some((e) => e.kind === 'update' && e.docName === 'root')),
      ).toBe(true);
      expect(
        events.some((e) => 'docName' in e && String(e.docName).startsWith('node_modules')),
      ).toBe(false);
    } finally {
      await handle.unsubscribe();
    }
  });
});

/**
 * Templates-as-content on the chokidar backend. Templates enter the ordinary
 * content pipeline, so the carve-out that admits `<folder>/.ok/templates/<name>.md`
 * must hold on the chokidar path too — the packaged desktop build has no
 * @parcel/watcher and runs entirely on chokidar. These pin the two capabilities
 * the dedicated template watcher lacked (new-folder rescue, conflict-marker
 * classification) for a template path on this backend; the sync/async filter
 * carve-out itself is unit-pinned in content-filter.test.ts, and the full-server
 * parcel-backend twins live in the app integration suite.
 */
describe('chokidar backend — templates-as-content watching (forceBackend)', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-chokidar-template-'));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    lastKnownHash.clear();
    writeTracker.clear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function until(predicate: () => boolean, timeoutMs = 6000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 40));
    }
    return predicate();
  }

  test('a template created in a brand-new .ok/templates folder dispatches a DiskEvent', async () => {
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const events: DiskEvent[] = [];
    const handle = await startWatcher(contentDir, async (e) => void events.push(e), filter, {
      forceBackend: 'chokidar',
    });
    try {
      const target = resolve(contentDir, 'notes', '.ok', 'templates', 'standup.md');
      mkdirSync(resolve(target, '..'), { recursive: true });
      const src = '---\ntitle: Standup\ndescription: a standup template\n---\n\n# {{date}}\n';
      // The folder was absent at watch start; chokidar arms the subwatch on its
      // addDir handler. Re-emit until the armed subwatch catches a write — the
      // deterministic form of the brand-new-folder rescue on this backend.
      expect(
        await until(() => {
          writeFileSync(target, src);
          return events.some(
            (e) =>
              (e.kind === 'create' || e.kind === 'update') &&
              e.docName === 'notes/.ok/templates/standup',
          );
        }),
      ).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });

  test('conflict markers in a template file dispatch a conflict DiskEvent', async () => {
    // Seed the templates folder so it is watched from the initial scan — this
    // isolates conflict classification from the new-folder subwatch-arming race.
    mkdirSync(resolve(contentDir, '.ok', 'templates'), { recursive: true });
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    const events: DiskEvent[] = [];
    const handle = await startWatcher(contentDir, async (e) => void events.push(e), filter, {
      forceBackend: 'chokidar',
    });
    try {
      const target = resolve(contentDir, '.ok', 'templates', 'daily.md');
      const conflicted = '# Daily\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n';
      writeFileSync(target, conflicted);
      expect(
        await until(() =>
          events.some((e) => e.kind === 'conflict' && e.docName === '.ok/templates/daily'),
        ),
      ).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });
});
