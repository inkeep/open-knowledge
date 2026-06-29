import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSET_EXTENSIONS, type DocumentListEntry } from '@inkeep/open-knowledge-core';
import {
  __getShowAllWalkStatsForTesting,
  __resetShowAllWalkStatsForTesting,
  type StreamShowAllOpts,
  streamShowAllEntries,
  walkContentDirForShowAll,
} from './api-extension.ts';
import { createContentFilter } from './content-filter.ts';

function makeFlatFixture(fileCount: number): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-stream-')));
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(join(dir, `file-${String(i).padStart(3, '0')}.md`), `# File ${i}\n`);
  }
  return dir;
}

function makeNestedFixture(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-stream-nested-')));
  writeFileSync(join(dir, 'root.md'), '# root\n');
  writeFileSync(join(dir, 'note.txt'), 'plain\n');
  for (const sub of ['alpha', 'beta']) {
    mkdirSync(join(dir, sub));
    writeFileSync(join(dir, sub, 'child.md'), `# ${sub}\n`);
  }
  return dir;
}

function streamOptsFor(dir: string, maxEntries: number): StreamShowAllOpts {
  return {
    contentDir: dir,
    contentFilter: createContentFilter({ projectDir: dir, contentDir: dir }),
    dirFilter: null,
    getDocExtension: () => '.md',
    maxEntries,
  };
}

async function drain(
  gen: AsyncGenerator<DocumentListEntry, { truncated: boolean }, void>,
): Promise<{ entries: DocumentListEntry[]; truncated: boolean }> {
  const entries: DocumentListEntry[] = [];
  let next = await gen.next();
  while (!next.done) {
    entries.push(next.value);
    next = await gen.next();
  }
  return { entries, truncated: next.value.truncated };
}

describe('streamShowAllEntries — buffered-walk equivalence (PRD-6856)', () => {
  afterEach(() => __resetShowAllWalkStatsForTesting());

  test('generator yields exactly the entries the buffered walk accumulates', async () => {
    const dir = makeNestedFixture();
    const CAP = 50_000;

    const buffered: DocumentListEntry[] = [];
    await walkContentDirForShowAll({ ...streamOptsFor(dir, CAP), documents: buffered });

    const streamed = await drain(streamShowAllEntries(streamOptsFor(dir, CAP)));

    expect(streamed.entries).toEqual(buffered);
    expect(streamed.truncated).toBe(false);
    expect(streamed.entries.length).toBeGreaterThan(0);
  });

  test('one generator instantiation counts as exactly one walk invocation', async () => {
    const dir = makeFlatFixture(10);
    __resetShowAllWalkStatsForTesting();
    await drain(streamShowAllEntries(streamOptsFor(dir, 50_000)));
    expect(__getShowAllWalkStatsForTesting().invocations).toBe(1);
    expect(__getShowAllWalkStatsForTesting().aborts).toBe(0);
  });
});

describe('streamShowAllEntries — entry cap', () => {
  test('exactly-cap fixture streams complete and untruncated', async () => {
    const CAP = 5;
    const { entries, truncated } = await drain(
      streamShowAllEntries(streamOptsFor(makeFlatFixture(CAP), CAP)),
    );
    expect(entries.length).toBe(CAP);
    expect(truncated).toBe(false);
  });

  test('cap+1 fixture stops at the cap and returns truncated', async () => {
    const CAP = 5;
    const { entries, truncated } = await drain(
      streamShowAllEntries(streamOptsFor(makeFlatFixture(CAP + 1), CAP)),
    );
    expect(entries.length).toBe(CAP);
    expect(truncated).toBe(true);
  });
});

describe('streamShowAllEntries — abort + laziness', () => {
  afterEach(() => __resetShowAllWalkStatsForTesting());

  test('a pre-aborted signal yields nothing and counts one abort', async () => {
    const dir = makeFlatFixture(20);
    __resetShowAllWalkStatsForTesting();
    const controller = new AbortController();
    controller.abort();
    const { entries, truncated } = await drain(
      streamShowAllEntries({ ...streamOptsFor(dir, 50_000), signal: controller.signal }),
    );
    expect(entries.length).toBe(0);
    expect(truncated).toBe(false);
    expect(__getShowAllWalkStatsForTesting().aborts).toBe(1);
  });

  test('pulling a single entry does not drain the whole tree', async () => {
    const dir = makeFlatFixture(500);
    const gen = streamShowAllEntries(streamOptsFor(dir, 50_000));
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toBeDefined();
    const ret = await gen.return({ truncated: false });
    expect(ret.done).toBe(true);
  });

  test('abort between queued directories is honored when the remaining dirs are empty', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-stream-abort-')));
    for (const sub of ['a', 'b', 'c']) {
      mkdirSync(join(dir, sub));
    }
    __resetShowAllWalkStatsForTesting();
    const controller = new AbortController();
    const gen = streamShowAllEntries({
      ...streamOptsFor(dir, 50_000),
      signal: controller.signal,
    });
    await gen.next();
    await gen.next();
    const third = await gen.next();
    expect(third.done).toBe(false);
    controller.abort();
    const final = await gen.next();
    expect(final.done).toBe(true);
    expect(__getShowAllWalkStatsForTesting().aborts).toBe(1);
  });
});

function entryPath(e: DocumentListEntry): string {
  return e.kind === 'document' ? e.docName : e.path;
}

describe('streamShowAllEntries — level-order emission (PRD-6858)', () => {
  function makeStarvationFixture(): { dir: string; rootFolders: string[]; rootDocs: string[] } {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-bfs-')));
    const rootFolders: string[] = [];
    const rootDocs: string[] = [];
    for (let d = 0; d < 5; d++) {
      const sub = `dir-${d}`;
      mkdirSync(join(dir, sub));
      rootFolders.push(sub);
      for (let f = 0; f < 20; f++) {
        writeFileSync(join(dir, sub, `leaf-${String(f).padStart(2, '0')}.md`), `# leaf ${f}\n`);
      }
    }
    for (let f = 0; f < 5; f++) {
      const name = `root-file-${f}`;
      writeFileSync(join(dir, `${name}.md`), `# ${name}\n`);
      rootDocs.push(name);
    }
    return { dir, rootFolders, rootDocs };
  }

  test('cap hit inside a deep subtree never starves root-level entries', async () => {
    const { dir, rootFolders, rootDocs } = makeStarvationFixture();
    const CAP = 15;
    const { entries, truncated } = await drain(streamShowAllEntries(streamOptsFor(dir, CAP)));

    expect(truncated).toBe(true);
    expect(entries.length).toBe(CAP);

    const paths = entries.map(entryPath);
    for (const folder of rootFolders) expect(paths).toContain(folder);
    for (const doc of rootDocs) expect(paths).toContain(doc);
  });

  test('every depth-N entry emits before the first depth-N+1 entry, parents before children', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-levelorder-')));
    writeFileSync(join(dir, 'root.md'), '# root\n');
    mkdirSync(join(dir, 'a', 'sub'), { recursive: true });
    mkdirSync(join(dir, 'b'));
    writeFileSync(join(dir, 'a', 'one.md'), '# one\n');
    writeFileSync(join(dir, 'a', 'note.txt'), 'asset\n');
    writeFileSync(join(dir, 'b', 'two.md'), '# two\n');
    writeFileSync(join(dir, 'a', 'sub', 'deep.md'), '# deep\n');

    const { entries, truncated } = await drain(streamShowAllEntries(streamOptsFor(dir, 50_000)));
    expect(truncated).toBe(false);

    const depths = entries.map((e) => entryPath(e).split('/').length);
    expect(depths).toEqual([1, 1, 1, 2, 2, 2, 2, 3]);

    const paths = entries.map(entryPath);
    for (const path of paths) {
      const segments = path.split('/');
      if (segments.length < 2) continue;
      const parent = segments.slice(0, -1).join('/');
      const parentIdx = entries.findIndex((e) => e.kind === 'folder' && e.path === parent);
      expect(parentIdx).toBeGreaterThanOrEqual(0);
      expect(parentIdx).toBeLessThan(paths.indexOf(path));
    }
  });

  test('maxDepth=1 yields a single level with hasChildren stamped, never recursing', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-depth1-')));
    writeFileSync(join(dir, 'top.md'), '# top\n');
    mkdirSync(join(dir, 'full', 'grandchild'), { recursive: true });
    writeFileSync(join(dir, 'full', 'child.md'), '# child\n');
    mkdirSync(join(dir, 'hollow'));

    const { entries, truncated } = await drain(
      streamShowAllEntries({ ...streamOptsFor(dir, 50_000), maxDepth: 1 }),
    );
    expect(truncated).toBe(false);

    const paths = entries.map(entryPath);
    expect(paths.toSorted()).toEqual(['full', 'hollow', 'top']);

    const full = entries.find((e) => e.kind === 'folder' && e.path === 'full');
    const hollow = entries.find((e) => e.kind === 'folder' && e.path === 'hollow');
    expect(full?.kind === 'folder' && full.hasChildren).toBe(true);
    expect(hollow?.kind === 'folder' && hollow.hasChildren).toBe(false);
  });
});

describe('streamShowAllEntries — cap accounting boundary quirks', () => {
  test('an excludable entry past the cap still reports truncated (cap checked before exclusion)', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-quirk-')));
    const CAP = 4;
    mkdirSync(join(dir, 'sub'));
    for (let i = 0; i < CAP - 1; i++) {
      writeFileSync(join(dir, `f-${i}.md`), `# f ${i}\n`);
    }
    mkdirSync(join(dir, 'sub', 'node_modules'));

    const { entries, truncated } = await drain(streamShowAllEntries(streamOptsFor(dir, CAP)));
    expect(entries.length).toBe(CAP);
    expect(entries.map(entryPath).toSorted()).toEqual(['f-0', 'f-1', 'f-2', 'sub']);
    expect(truncated).toBe(true);
  });

  test('the same tree under a roomier cap drains untruncated — the exclusion gate still prunes', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-quirk-roomy-')));
    mkdirSync(join(dir, 'sub'));
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(dir, `f-${i}.md`), `# f ${i}\n`);
    }
    mkdirSync(join(dir, 'sub', 'node_modules'));

    const { entries, truncated } = await drain(streamShowAllEntries(streamOptsFor(dir, 5)));
    expect(entries.length).toBe(4);
    expect(entries.map(entryPath)).not.toContain('sub/node_modules');
    expect(truncated).toBe(false);
  });
});

describe('streamShowAllEntries — unreadable directory mid-queue', () => {
  const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  test.skipIf(runningAsRoot)(
    'a permission-denied directory skips with a warn while every other entry still emits',
    async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-eacces-')));
      writeFileSync(join(dir, 'root.md'), '# root\n');
      mkdirSync(join(dir, 'locked'));
      writeFileSync(join(dir, 'locked', 'hidden.md'), '# hidden\n');
      mkdirSync(join(dir, 'open'));
      writeFileSync(join(dir, 'open', 'visible.md'), '# visible\n');
      chmodSync(join(dir, 'locked'), 0o000);

      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { entries, truncated } = await drain(
          streamShowAllEntries(streamOptsFor(dir, 50_000)),
        );

        const paths = entries.map(entryPath);
        expect(paths).not.toContain('locked/hidden');
        expect(paths).toContain('root');
        expect(paths).toContain('open');
        expect(paths).toContain('open/visible');
        expect(truncated).toBe(false);

        const lockedWarn = warnSpy.mock.calls.find(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('failed for') &&
            call[0].includes('locked'),
        );
        expect(lockedWarn).toBeDefined();
      } finally {
        warnSpy.mockRestore();
        chmodSync(join(dir, 'locked'), 0o755);
      }
    },
  );
});

describe('streamShowAllEntries — .base/.canvas mediaKind', () => {
  test('.base and .canvas entries report mediaKind text in showAll output', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-mediakind-')));
    writeFileSync(join(dir, 'note.md'), '# Note\n');
    writeFileSync(join(dir, 'Characters.base'), 'fields:\n  - name\n');
    writeFileSync(join(dir, 'Board.canvas'), '{"nodes":[],"edges":[]}\n');

    const { entries } = await drain(streamShowAllEntries(streamOptsFor(dir, 50_000)));

    const baseEntry = entries.find((e) => e.kind === 'asset' && e.docName === 'Characters.base');
    const canvasEntry = entries.find((e) => e.kind === 'asset' && e.docName === 'Board.canvas');

    expect(baseEntry).toBeDefined();
    expect(baseEntry?.kind === 'asset' && baseEntry.mediaKind).toBe('text');
    expect(canvasEntry).toBeDefined();
    expect(canvasEntry?.kind === 'asset' && canvasEntry.mediaKind).toBe('text');
  });

  test('.base and .canvas are absent from ASSET_EXTENSIONS (serve allowlist unchanged)', () => {
    expect(ASSET_EXTENSIONS.has('base')).toBe(false);
    expect(ASSET_EXTENSIONS.has('canvas')).toBe(false);
  });
});

describe('streamShowAllEntries — symlinked directories', () => {
  function makeSymlinkDirFixture(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-symdir-')));
    const canonical = join(dir, 'canonical-folder');
    mkdirSync(canonical);
    writeFileSync(join(canonical, 'note-one.md'), '# one\n');
    mkdirSync(join(canonical, 'nested'));
    writeFileSync(join(canonical, 'nested', 'deep.md'), '# deep\n');
    symlinkSync(canonical, join(dir, 'alias-A'));
    symlinkSync(canonical, join(dir, 'alias-B'));
    return dir;
  }

  function pathsOf(entries: DocumentListEntry[]): string[] {
    return entries.map((e) => (e.kind === 'folder' ? (e.path ?? '') : (e.docName ?? e.path ?? '')));
  }

  test('emits each symlinked directory as a folder without recursing into it', async () => {
    const dir = makeSymlinkDirFixture();
    const { entries } = await drain(streamShowAllEntries(streamOptsFor(dir, 50_000)));
    const folders = new Map(entries.filter((e) => e.kind === 'folder').map((e) => [e.path, e]));
    for (const alias of ['alias-A', 'alias-B']) {
      const f = folders.get(alias);
      expect(f).toBeDefined();
      expect(f?.isSymlink).toBe(true);
      expect(f?.targetPath).toBe('canonical-folder');
      expect(f?.hasChildren).toBe(true);
    }
    const paths = pathsOf(entries);
    expect(paths).toContain('canonical-folder/note-one');
    expect(paths).toContain('canonical-folder/nested/deep');
    expect(paths.some((p) => p.startsWith('alias-A/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('alias-B/'))).toBe(false);
  });

  test('expanding a symlinked directory lists the canonical children under the alias prefix', async () => {
    const dir = makeSymlinkDirFixture();
    const { entries } = await drain(
      streamShowAllEntries({ ...streamOptsFor(dir, 50_000), dirFilter: 'alias-A' }),
    );
    const paths = pathsOf(entries);
    expect(paths).toContain('alias-A/note-one');
    expect(paths).toContain('alias-A/nested');
  });

  test('refuses a symlinked directory whose target escapes contentDir', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-symesc-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-outside-')));
    writeFileSync(join(outside, 'secret.md'), '# secret\n');
    symlinkSync(outside, join(dir, 'escape'));
    const { entries } = await drain(streamShowAllEntries(streamOptsFor(dir, 50_000)));
    const paths = pathsOf(entries);
    expect(paths).not.toContain('escape');
    expect(paths.some((p) => p.includes('secret'))).toBe(false);
  });

  test('does not infinitely recurse on cyclic symlinked directories', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-symcycle-')));
    mkdirSync(join(dir, 'A'));
    mkdirSync(join(dir, 'B'));
    writeFileSync(join(dir, 'A', 'a.md'), '# a\n');
    writeFileSync(join(dir, 'B', 'b.md'), '# b\n');
    symlinkSync(join(dir, 'B'), join(dir, 'A', 'to-b'));
    symlinkSync(join(dir, 'A'), join(dir, 'B', 'to-a'));
    const { entries, truncated } = await drain(streamShowAllEntries(streamOptsFor(dir, 50_000)));
    const toB = entries.find((e) => e.kind === 'folder' && e.path === 'A/to-b');
    expect(toB?.isSymlink).toBe(true);
    expect(truncated).toBe(false);
  });
});
