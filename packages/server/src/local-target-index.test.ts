import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createContentFilter } from './content-filter.ts';
import { LocalTargetIndex, type LocalTargetIndexOptions } from './local-target-index.ts';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function createIndex(): LocalTargetIndex {
  const index = new LocalTargetIndex({ contentDir: join(tmpdir(), 'ok-lti-nonexistent') });
  cleanups.push(() => index.close());
  return index;
}

function createDiskRig(
  overrides: Omit<LocalTargetIndexOptions, 'contentDir' | 'contentFilter'> = {},
  projectFiles: Record<string, string> = {},
): {
  index: LocalTargetIndex;
  contentDir: string;
  write: (rel: string, md: string) => void;
} {
  const projectDir = mkdtempSync(join(tmpdir(), 'ok-lti-'));
  const contentDir = join(projectDir, 'content');
  mkdirSync(contentDir, { recursive: true });
  for (const [rel, text] of Object.entries(projectFiles))
    writeFileSync(join(projectDir, rel), text);
  const contentFilter = createContentFilter({ projectDir, contentDir });
  const index = new LocalTargetIndex({ contentDir, contentFilter, ...overrides });
  cleanups.push(() => {
    index.close();
    rmSync(projectDir, { recursive: true, force: true });
  });
  const write = (rel: string, md: string): void => {
    const filePath = join(contentDir, rel);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, md);
  };
  return { index, contentDir, write };
}

function statusOf(index: LocalTargetIndex, docName: string): string[] {
  return index.getAssessments(docName).map((a) => a.status);
}

describe('LocalTargetIndex reverse-dependent freshness', () => {
  test('creating a missing document target heals only its referencing sources', () => {
    const index = createIndex();
    index.setSource('src', 'See [x](target).\n');

    const before = index.getAssessments('src');
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      targetKind: 'document',
      resolvedTarget: 'target',
      status: 'missing',
      reason: 'no-such-doc',
    });
    expect(index.getDocumentDependents('target')).toEqual(['src']);

    index.setSource('target', '# Target\n');

    expect(index.getAssessments('src')[0]).toMatchObject({
      resolvedTarget: 'target',
      status: 'exact',
      reason: null,
    });
  });

  test('a source edit replaces its occurrences and removes ghost reverse dependents', () => {
    const index = createIndex();
    index.setSource('src', 'See [x](alpha).\n');
    expect(index.getDocumentDependents('alpha')).toEqual(['src']);

    index.setSource('src', 'See [x](beta).\n');
    expect(index.getDocumentDependents('alpha')).toEqual([]);
    expect(index.getDocumentDependents('beta')).toEqual(['src']);

    index.setSource('alpha', '# Alpha\n');
    expect(index.getAssessments('src')[0]).toMatchObject({
      resolvedTarget: 'beta',
      status: 'missing',
    });

    index.setSource('beta', '# Beta\n');
    expect(index.getAssessments('src')[0]).toMatchObject({
      resolvedTarget: 'beta',
      status: 'exact',
    });
  });

  test('ordinary-file create and delete heal and break file references without re-authoring', () => {
    const index = createIndex();
    index.setSource('src', 'Download [pdf](assets/report.pdf).\n');
    expect(index.getAssessments('src')[0]).toMatchObject({
      targetKind: 'file',
      resolvedTarget: 'assets/report.pdf',
      status: 'missing',
      reason: 'no-such-file',
    });
    expect(index.getFileDependents('assets/report.pdf')).toEqual(['src']);

    expect(index.setFileTarget('assets/report.pdf', true)).toBe(1);
    expect(index.getAssessments('src')[0]).toMatchObject({ status: 'exact', reason: null });

    expect(index.setFileTarget('assets/report.pdf', false)).toBe(1);
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'missing',
      reason: 'no-such-file',
    });
  });

  test('an extension-less target retains both dependency candidates across precedence changes', () => {
    const index = createIndex();
    index.setSource('src', 'See [license](LICENSE).\n');
    expect(index.getAssessments('src')[0]).toMatchObject({
      targetKind: 'document',
      status: 'missing',
    });
    expect(index.getDocumentDependents('LICENSE')).toEqual(['src']);
    expect(index.getFileDependents('LICENSE')).toEqual(['src']);

    index.setFileTarget('LICENSE', true);
    expect(index.getAssessments('src')[0]).toMatchObject({
      targetKind: 'file',
      status: 'exact',
    });
    index.setFileTarget('LICENSE', false);
    expect(index.getAssessments('src')[0]).toMatchObject({
      targetKind: 'document',
      status: 'missing',
    });
    index.setFileTarget('LICENSE', true);
    expect(index.getAssessments('src')[0]).toMatchObject({
      targetKind: 'file',
      status: 'exact',
    });

    index.setSource('LICENSE', '# License document\n');
    expect(index.getAssessments('src')[0]).toMatchObject({
      targetKind: 'document',
      status: 'exact',
    });
    index.removeSource('LICENSE');
    expect(index.getAssessments('src')[0]).toMatchObject({
      targetKind: 'file',
      status: 'exact',
    });
  });

  test('wiki document links are not projected here; file-shaped wiki embeds are, by their literal spelling', () => {
    const index = createIndex();
    index.setSource('src', 'See [[100%20done]] and ![[100%20done.png]].\n');
    expect(index.getAssessments('src')).toHaveLength(1);
    expect(index.getAssessments('src')[0]).toMatchObject({
      targetKind: 'file',
      status: 'missing',
      resolvedTarget: '100%20done.png',
    });
    expect(index.getFileDependents('100%20done.png')).toEqual(['src']);
    expect(index.getFileDependents('100 done')).toEqual([]);
    expect(index.getDocumentDependents('100 done')).toEqual([]);

    const markdownIndex = createIndex();
    markdownIndex.setSource('src', 'See [progress](100%20done).\n');
    expect(markdownIndex.getFileDependents('100 done')).toEqual(['src']);
    expect(markdownIndex.getFileDependents('100%20done')).toEqual([]);
  });

  test('a basename wiki embed resolves vault-wide and heals as the file comes and goes', () => {
    const index = createIndex();
    index.setSource('notes/src', 'See ![[photo.png]].\n');
    expect(index.getAssessments('notes/src')[0]).toMatchObject({
      targetKind: 'file',
      status: 'missing',
      reason: 'no-such-file',
      resolvedTarget: 'photo.png',
    });

    expect(index.setFileTarget('media/photo.png', true)).toBe(1);
    expect(index.getAssessments('notes/src')[0]).toMatchObject({
      status: 'exact',
      reason: null,
      resolvedTarget: 'media/photo.png',
      resolutionMethod: 'basename',
    });
    expect(index.getFileDependents('media/photo.png')).toEqual(['notes/src']);

    expect(index.setFileTarget('media/photo.png', false)).toBe(1);
    expect(index.getAssessments('notes/src')[0]).toMatchObject({
      status: 'missing',
      reason: 'no-such-file',
      resolvedTarget: 'photo.png',
    });
  });

  test('a path-form wiki embed resolves across folder case and heals as the file comes and goes', () => {
    const index = createIndex();
    index.setSource('src', 'See ![[pics/deep/x.png]] and [[PICS/DEEP/X.PNG]].\n');
    expect(statusOf(index, 'src')).toEqual(['missing', 'missing']);

    expect(index.setFileTarget('Pics/Deep/x.png', true)).toBe(1);
    expect(index.getAssessments('src').map((a) => [a.status, a.resolvedTarget])).toEqual([
      ['exact', 'Pics/Deep/x.png'],
      ['exact', 'Pics/Deep/x.png'],
    ]);
    expect(index.getFileDependents('Pics/Deep/x.png')).toEqual(['src']);

    expect(index.setFileTarget('pics/deep/x.png', true)).toBe(1);
    expect(index.getAssessments('src').map((a) => a.resolvedTarget)).toEqual([
      'pics/deep/x.png',
      'Pics/Deep/x.png',
    ]);

    expect(index.reconcileFileTargets([])).toBe(1);
    expect(statusOf(index, 'src')).toEqual(['missing', 'missing']);
  });

  test('a markdown asset link keeps ancestor folder case significant', () => {
    const index = createIndex();
    index.setFileTarget('Pics/Deep/x.png', true);
    index.setSource('src', '![x](pics/deep/x.png)\n');
    expect(statusOf(index, 'src')).toEqual(['missing']);
  });

  test('a watcher inventory reconcile heals a basename wiki embed across spellings', () => {
    const index = createIndex();
    index.setSource('src', 'See ![[Café.png]].\n');
    expect(statusOf(index, 'src')).toEqual(['missing']);

    expect(index.reconcileFileTargets(['media/Café.png'])).toBe(1);
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'exact',
      resolvedTarget: 'media/Café.png',
    });

    expect(index.reconcileFileTargets([])).toBe(1);
    expect(statusOf(index, 'src')).toEqual(['missing']);
  });

  test('a content-only file-update event does not flip existence or bump the generation', () => {
    const index = createIndex();
    index.setSource('src', 'Download [pdf](assets/report.pdf).\n');
    index.setFileTarget('assets/report.pdf', true);
    const generation = index.generation;

    expect(index.setFileTarget('assets/report.pdf', true)).toBe(0);
    expect(index.generation).toBe(generation);
    expect(index.getAssessments('src')[0]).toMatchObject({ status: 'exact' });
  });

  test('deleting a document target breaks its dependents', () => {
    const index = createIndex();
    index.setSource('target', '# Target\n');
    index.setSource('src', 'See [x](target).\n');
    expect(statusOf(index, 'src')).toEqual(['exact']);

    index.removeSource('target');
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'missing',
      reason: 'no-such-doc',
    });
  });

  test('renaming a document target breaks old references and heals new ones atomically', () => {
    const index = createIndex();
    index.setSource('old', '# Old\n');
    index.setSource('links-old', 'See [x](old).\n');
    index.setSource('links-new', 'See [x](new).\n');
    expect(statusOf(index, 'links-old')).toEqual(['exact']);
    expect(statusOf(index, 'links-new')).toEqual(['missing']);

    index.renameSource('old', 'new', '# New\n');

    expect(index.getAssessments('links-old')[0]).toMatchObject({
      resolvedTarget: 'old',
      status: 'missing',
    });
    expect(index.getAssessments('links-new')[0]).toMatchObject({
      resolvedTarget: 'new',
      status: 'exact',
    });
  });

  test('a target mutation reassesses exactly its reverse dependents, not the whole project', () => {
    const index = createIndex();
    const fanout = 40;
    for (let i = 0; i < fanout; i++) {
      index.setSource(`dependent-${i}`, 'Download [pdf](assets/shared.pdf).\n');
    }
    for (let i = 0; i < 15; i++) {
      index.setSource(`unrelated-${i}`, 'Download [pdf](assets/other.pdf).\n');
    }

    const affected = index.setFileTarget('assets/shared.pdf', true);
    expect(affected).toBe(fanout);
    expect(index.getFileDependents('assets/shared.pdf')).toHaveLength(fanout);

    for (let i = 0; i < fanout; i++) {
      expect(index.getAssessments(`dependent-${i}`)[0]).toMatchObject({ status: 'exact' });
    }
    for (let i = 0; i < 15; i++) {
      expect(index.getAssessments(`unrelated-${i}`)[0]).toMatchObject({ status: 'missing' });
    }
  });

  test('repeated references to one target keep every occurrence range and heal together', () => {
    const index = createIndex();
    index.setSource('src', 'A [one](assets/a.pdf) and again [two](assets/a.pdf).\n');
    const before = index.getAssessments('src');
    expect(before).toHaveLength(2);
    expect(before.every((a) => a.status === 'missing')).toBe(true);
    expect(before[0]?.occurrence.range).not.toEqual(before[1]?.occurrence.range);

    expect(index.setFileTarget('assets/a.pdf', true)).toBe(1);
    const after = index.getAssessments('src');
    expect(after.every((a) => a.status === 'exact')).toBe(true);
    expect(after[0]?.occurrence.range).toEqual(before[0]?.occurrence.range);
  });

  test('generation is monotonic across real changes and reflects healing', () => {
    const index = createIndex();
    const g0 = index.generation;
    index.setSource('src', 'See [x](target).\n');
    const g1 = index.generation;
    expect(g1).toBeGreaterThan(g0);
    index.setSource('target', '# Target\n');
    expect(index.generation).toBeGreaterThan(g1);
  });

  test('an unrelated body edit with unchanged local-target evidence does not move generation', () => {
    const index = createIndex();
    index.setSource('src', '# Before\n\nSee [x](target).\n');
    const generation = index.generation;

    expect(index.setSource('src', '# After!\n\nSee [x](target).\n')).toBe(false);
    expect(index.generation).toBe(generation);
  });

  test('records tolerant slug fallback provenance and follows create-delete healing', () => {
    const index = createIndex();
    index.setSource('src', 'See [x](guide).\n');
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'missing',
      resolvedTarget: 'guide',
      fallbackTarget: null,
    });

    index.setSource('Guide', '# Guide\n');
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'fallback',
      reason: 'no-such-doc',
      resolutionMethod: 'tolerant',
      resolvedTarget: 'guide',
      fallbackTarget: 'Guide',
    });
    expect(index.getDocumentDependents('Guide')).toEqual(['src']);

    index.removeSource('Guide');
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'missing',
      fallbackTarget: null,
    });
  });

  test('a folder target is exact; a bare basename still records its fallback', () => {
    const index = createIndex();
    index.setSource('guides/index', '# Guides\n');
    index.setSource('nested/analysis', '# Analysis\n');
    index.setSource('src', 'See [folder](guides) and [bare](analysis).\n');

    expect(
      index.getAssessments('src').map(({ status, resolvedTarget, fallbackTarget }) => ({
        status,
        resolvedTarget,
        fallbackTarget,
      })),
    ).toEqual([
      { status: 'exact', resolvedTarget: 'guides', fallbackTarget: null },
      { status: 'fallback', resolvedTarget: 'analysis', fallbackTarget: 'nested/analysis' },
    ]);
  });

  test('reconcileFolderTargets flips folder links as watcher folders come and go', () => {
    const index = createIndex();
    index.setSource('src', 'See [dir](assets).\n');
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'missing',
      resolvedTarget: 'assets',
    });

    expect(index.reconcileFolderTargets(['assets'])).toBe(1);
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'exact',
      resolvedTarget: 'assets',
    });

    expect(index.reconcileFolderTargets([])).toBe(1);
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'missing',
      resolvedTarget: 'assets',
    });
  });

  test('a staged rebuild carries the folder oracle into live reassessment (PRD-7956)', async () => {
    const index = createIndex();
    await index.rebuildFromDisk({
      documentTargets: ['guides/guide-one'],
      fileTargets: [],
    });

    index.setSource('src', 'See [folder](guides).\n');
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'exact',
      resolvedTarget: 'guides',
    });
  });

  test('folder existence tracks the docs beneath it in both directions (PRD-7956)', () => {
    const index = createIndex();
    index.setSource('src', 'See [folder](guides).\n');
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'missing',
      resolvedTarget: 'guides',
    });

    index.setSource('guides/first', '# First\n');
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'exact',
      resolvedTarget: 'guides',
      fallbackTarget: null,
    });

    index.removeSource('guides/first');
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'missing',
      resolvedTarget: 'guides',
    });
  });

  test('system and config source names are never indexed and create no reverse edges', () => {
    const index = createIndex();
    index.setSource('__system__', 'See [x](target).\n');
    index.setSource('__config__/project', 'See [y](other).\n');
    expect(index.getAssessments('__system__')).toEqual([]);
    expect(index.getDocumentDependents('target')).toEqual([]);
    expect(index.getDocumentDependents('other')).toEqual([]);
  });

  test('external, anchor, and traversal-escaping targets create no false document or file dependents', () => {
    const index = createIndex();
    index.setSource(
      'src',
      'Ext [a](https://example.com) anchor [b](#section) escape [c](../../secret.pdf) beyond [d](../../nope).\n',
    );
    for (const assessment of index.getAssessments('src')) {
      expect(assessment.status).toBe('unresolvable');
      expect(assessment.resolvedTarget).toBeNull();
    }
    expect(index.getFileDependents('../../secret.pdf')).toEqual([]);
    expect(index.getStats().documentTargets).toBe(0);
    expect(index.getStats().fileTargets).toBe(0);
  });
});

describe('LocalTargetIndex disk lifecycle', () => {
  test('uses injected document identities for aliases and managed targets absent from the source walk', async () => {
    const rig = createDiskRig();
    rig.write('source.md', 'See [alias](aliased/guide).\n');

    await rig.index.rebuildFromDisk({
      documentTargets: ['source', 'aliased/guide'],
      fileTargets: [],
    });

    expect(rig.index.getAssessments('source')[0]).toMatchObject({
      targetKind: 'document',
      resolvedTarget: 'aliased/guide',
      status: 'exact',
    });
  });

  test('is not ready until rebuilt, then exposes seeded assessments', async () => {
    const rig = createDiskRig();
    expect(rig.index.isReady()).toBe(false);

    rig.write('a.md', 'See [x](b) and [pdf](assets/f.pdf).\n');
    rig.write('b.md', '# B\n');

    await rig.index.rebuildFromDisk({
      documentTargets: ['a', 'b'],
      fileTargets: ['assets/f.pdf'],
    });

    expect(rig.index.isReady()).toBe(true);
    const assessments = rig.index.getAssessments('a');
    expect(assessments).toHaveLength(2);
    expect(assessments.every((assessment) => assessment.status === 'exact')).toBe(true);
  });

  test('rebuild seeds reverse dependencies so a later target create heals scoped sources', async () => {
    const rig = createDiskRig();
    rig.write('a.md', 'See [missing](gone).\n');
    rig.write('c.md', 'Image ![alt](assets/pic.png).\n');

    await rig.index.rebuildFromDisk({ documentTargets: ['a', 'c'], fileTargets: [] });
    expect(rig.index.getAssessments('a')[0]).toMatchObject({ status: 'missing' });
    expect(rig.index.getAssessments('c')[0]).toMatchObject({
      status: 'missing',
      targetKind: 'file',
    });

    expect(rig.index.setFileTarget('assets/pic.png', true)).toBe(1);
    expect(rig.index.getAssessments('c')[0]).toMatchObject({ status: 'exact' });
    expect(rig.index.getAssessments('a')[0]).toMatchObject({ status: 'missing' });
  });

  test('a dependency-only disk sweep repairs watcher events dropped in either direction', async () => {
    const rig = createDiskRig();
    rig.write('source.md', 'Download [pdf](assets/report.pdf).\n');
    rig.write('assets/report.pdf', '%PDF-1.4\n');
    await rig.index.rebuildFromDisk({
      documentTargets: ['source'],
      fileTargets: ['assets/report.pdf'],
    });
    expect(rig.index.getAssessments('source')[0]).toMatchObject({ status: 'exact' });

    unlinkSync(join(rig.contentDir, 'assets/report.pdf'));
    expect(await rig.index.reconcileDependentFileTargetsFromDisk()).toBe(1);
    expect(rig.index.getAssessments('source')[0]).toMatchObject({
      status: 'missing',
      reason: 'no-such-file',
    });

    rig.write('assets/report.pdf', '%PDF-1.4\n');
    expect(await rig.index.reconcileDependentFileTargetsFromDisk()).toBe(1);
    expect(rig.index.getAssessments('source')[0]).toMatchObject({ status: 'exact' });
  });

  test('rebuild against a missing content dir settles ready and empty', async () => {
    const index = new LocalTargetIndex({ contentDir: join(tmpdir(), 'ok-lti-does-not-exist-xyz') });
    cleanups.push(() => index.close());
    const result = await index.rebuildFromDisk({ documentTargets: [], fileTargets: [] });
    expect(result).toEqual({ sources: 0, occurrences: 0 });
    expect(index.isReady()).toBe(true);
  });

  test('a document read failure keeps the rebuilt index not ready', async () => {
    const rig = createDiskRig({
      readDocument: async () => {
        throw new Error('forced document read failure');
      },
    });
    rig.write('source.md', 'See [x](target).\n');

    await expect(
      rig.index.rebuildFromDisk({ documentTargets: ['source'], fileTargets: [] }),
    ).rejects.toThrow('forced document read failure');
    expect(rig.index.isReady()).toBe(false);
    expect(rig.index.getAssessments('source')).toEqual([]);
  });

  test('a directory read failure keeps the rebuilt index not ready', async () => {
    const rig = createDiskRig({
      readDirectory: async () => {
        throw new Error('forced directory read failure');
      },
    });

    await expect(
      rig.index.rebuildFromDisk({ documentTargets: [], fileTargets: [] }),
    ).rejects.toThrow('forced directory read failure');
    expect(rig.index.isReady()).toBe(false);
  });

  test('a failed rebuild retains the prior complete snapshot and a later rebuild recovers', async () => {
    let failReads = false;
    const rig = createDiskRig({
      readDocument: async (filePath) => {
        if (failReads) throw new Error('transient read failure');
        return readFileSync(filePath, 'utf-8');
      },
    });
    rig.write('source.md', 'See [x](first).\n');
    await rig.index.rebuildFromDisk({
      documentTargets: ['source', 'first'],
      fileTargets: [],
    });
    expect(rig.index.getAssessments('source')[0]).toMatchObject({
      resolvedTarget: 'first',
      status: 'exact',
    });

    rig.write('source.md', 'See [x](second).\n');
    failReads = true;
    await expect(
      rig.index.rebuildFromDisk({
        documentTargets: ['source', 'second'],
        fileTargets: [],
      }),
    ).rejects.toThrow('transient read failure');
    expect(rig.index.isReady()).toBe(false);
    expect(rig.index.getAssessments('source')[0]).toMatchObject({ resolvedTarget: 'first' });

    failReads = false;
    await rig.index.rebuildFromDisk({
      documentTargets: ['source', 'second'],
      fileTargets: [],
    });
    expect(rig.index.isReady()).toBe(true);
    expect(rig.index.getAssessments('source')[0]).toMatchObject({
      resolvedTarget: 'second',
      status: 'exact',
    });
  });
});

describe('LocalTargetIndex across canonically equivalent spellings', () => {
  const NFC = 'people/Ren\u00e9';
  const NFD = 'people/Rene\u0301';

  test.each([
    ['NFC', 'NFD', NFC, NFD],
    ['NFD', 'NFC', NFD, NFC],
  ])('an %s link heals and breaks with its %s document', (_l, _d, linked, stored) => {
    const index = createIndex();
    index.setSource('src', `See [x](/${linked}).\n`);
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'missing',
      resolvedTarget: linked,
    });

    index.setSource(stored, '# Target\n');
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'exact',
      resolvedTarget: stored,
      reason: null,
    });
    expect(index.getDocumentDependents(linked)).toEqual(['src']);
    expect(index.getDocumentDependents(stored)).toEqual(['src']);

    index.removeSource(stored);
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'missing',
      resolvedTarget: linked,
      reason: 'no-such-doc',
    });
  });

  test('a file target reported in NFD heals an NFC link and is found by either spelling', () => {
    const index = createIndex();
    index.setSource('src', 'See [pdf](assets/Ren\u00e9.pdf).\n');

    expect(index.setFileTarget('assets/Rene\u0301.pdf', true)).toBe(1);
    expect(index.getAssessments('src')[0]).toMatchObject({
      targetKind: 'file',
      status: 'exact',
      resolvedTarget: 'assets/Rene\u0301.pdf',
    });
    expect(index.getFileDependents('assets/Ren\u00e9.pdf')).toEqual(['src']);
    expect(index.getFileDependents('assets/Rene\u0301.pdf')).toEqual(['src']);

    expect(index.setFileTarget('assets/Rene\u0301.pdf', false)).toBe(1);
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'missing',
      reason: 'no-such-file',
      resolvedTarget: 'assets/Ren\u00e9.pdf',
    });
  });

  test('folder targets resolve across spellings from the watcher and from the docs beneath', () => {
    const index = createIndex();
    index.setSource('src', 'See [folder](Ren\u00e9).\n');

    expect(index.reconcileFolderTargets(['Rene\u0301'])).toBe(1);
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'exact',
      resolvedTarget: 'Rene\u0301',
    });
    expect(index.reconcileFolderTargets([])).toBe(1);
    expect(index.getAssessments('src')[0]).toMatchObject({ status: 'missing' });

    index.setSource('Rene\u0301/notes', '# Notes\n');
    expect(index.getAssessments('src')[0]).toMatchObject({
      status: 'exact',
      resolvedTarget: 'Rene\u0301',
    });
    index.removeSource('Rene\u0301/notes');
    expect(index.getAssessments('src')[0]).toMatchObject({ status: 'missing' });
  });

  test('a rebuild resolves NFC links against NFD inventory and a disk sweep stats the raw paths', async () => {
    const rig = createDiskRig();
    rig.write(
      'source.md',
      'See [doc](people/Ren\u00e9), [pdf](assets/Ren\u00e9.pdf) and [big](assets/Report.PDF).\n',
    );
    rig.write('people/Rene\u0301.md', '# Ren\u00e9\n');
    rig.write('assets/Rene\u0301.pdf', '%PDF-1.4\n');
    rig.write('assets/Report.PDF', '%PDF-1.4\n');
    await rig.index.rebuildFromDisk({
      documentTargets: ['source', 'people/Rene\u0301'],
      fileTargets: ['assets/Rene\u0301.pdf', 'assets/Report.PDF'],
    });
    expect(
      rig.index
        .getAssessments('source')
        .map(({ status, resolvedTarget }) => [status, resolvedTarget]),
    ).toEqual([
      ['exact', 'people/Rene\u0301'],
      ['exact', 'assets/Rene\u0301.pdf'],
      ['exact', 'assets/Report.PDF'],
    ]);

    expect(await rig.index.reconcileDependentFileTargetsFromDisk()).toBe(0);
    expect(statusOf(rig.index, 'source')).toEqual(['exact', 'exact', 'exact']);

    unlinkSync(join(rig.contentDir, 'assets/Rene\u0301.pdf'));
    expect(await rig.index.reconcileDependentFileTargetsFromDisk()).toBe(1);
    expect(rig.index.getAssessments('source')[1]).toMatchObject({
      status: 'missing',
      reason: 'no-such-file',
    });
  });
});

describe('dotted wiki names that a document can claim (PRD-8896)', () => {
  const SOURCE_MD = 'See [[acp.daemon]], ![[ACP.Daemon]] and [[vault/acp.daemon]].\n';
  const MISSING_ROWS = [
    ['notes/source', 'acp.daemon', 'file', 'missing', 'no-such-file'],
    ['notes/source', 'ACP.Daemon', 'file', 'missing', 'no-such-file'],
    ['notes/source', 'vault/acp.daemon', 'file', 'missing', 'no-such-file'],
  ];

  function rowsOf(index: LocalTargetIndex): Array<Array<string | null>> {
    return index
      .getAssessmentsForSources()
      .flatMap(({ source, assessments }) =>
        assessments.map((a) => [source, a.occurrence.href, a.targetKind, a.status, a.reason]),
      );
  }

  const documentMutations: Array<
    [string, (index: LocalTargetIndex, docNames: string[], created: boolean) => void]
  > = [
    [
      'a source event',
      (index, _docNames, created) =>
        created
          ? index.setSource('vault/acp.daemon', '# ACP\n')
          : index.removeSource('vault/acp.daemon'),
    ],
    ['a document reconcile', (index, docNames) => index.reconcileDocumentTargets(docNames)],
  ];

  for (const [label, mutate] of documentMutations) {
    test(`creating the document after the link matches a rebuild: ${label}`, async () => {
      const rig = createDiskRig();
      rig.write('notes/source.md', SOURCE_MD);
      await rig.index.rebuildFromDisk({ documentTargets: ['notes/source'], fileTargets: [] });
      expect(rowsOf(rig.index)).toEqual(MISSING_ROWS);

      rig.write('vault/acp.daemon.md', '# ACP\n');
      const docNames = ['notes/source', 'vault/acp.daemon'];
      mutate(rig.index, docNames, true);
      const incremental = rowsOf(rig.index);
      await rig.index.rebuildFromDisk({ documentTargets: docNames, fileTargets: [] });
      expect(incremental).toEqual(rowsOf(rig.index));
      expect(incremental).toEqual([]);
    });

    test(`deleting the document after the link matches a rebuild: ${label}`, async () => {
      const rig = createDiskRig();
      rig.write('notes/source.md', SOURCE_MD);
      rig.write('vault/acp.daemon.md', '# ACP\n');
      await rig.index.rebuildFromDisk({
        documentTargets: ['notes/source', 'vault/acp.daemon'],
        fileTargets: [],
      });
      expect(rowsOf(rig.index)).toEqual([]);

      unlinkSync(join(rig.contentDir, 'vault/acp.daemon.md'));
      const docNames = ['notes/source'];
      mutate(rig.index, docNames, false);
      const incremental = rowsOf(rig.index);
      await rig.index.rebuildFromDisk({ documentTargets: docNames, fileTargets: [] });
      expect(incremental).toEqual(rowsOf(rig.index));
      expect(incremental).toEqual(MISSING_ROWS);
    });
  }
});

describe('rows the index keeps only to track dependencies (PRD-8896)', () => {
  const HIDDEN_ONLY = 'See [[acp.daemon]].\n';

  test('a change to hidden rows alone does not move the generation', () => {
    const index = createIndex();
    index.setSource('vault/acp.daemon', '# ACP\n');
    index.setSource('notes/source', HIDDEN_ONLY);
    expect(index.getAssessmentsForSources()).toEqual([]);
    const generation = index.generation;

    expect(index.setSource('acp.daemon', '# Root\n')).toBe(false);
    expect(index.setSource('notes/source', 'See [[acp.daemon]] and [[acp.daemon]].\n')).toBe(false);
    expect(index.removeSource('notes/source')).toBe(false);
    expect(index.generation).toBe(generation);
  });

  test('a rebuild over hidden rows alone reports nothing and does not move the generation', async () => {
    const rig = createDiskRig();
    rig.write('vault/acp.daemon.md', '# ACP\n');
    rig.write('notes/source.md', HIDDEN_ONLY);
    const inventory = { documentTargets: [], fileTargets: [] };

    expect(await rig.index.rebuildFromDisk(inventory)).toEqual({ sources: 0, occurrences: 0 });
    expect(rig.index.getDocumentDependents('vault/acp.daemon')).toEqual(['notes/source']);
    const generation = rig.index.generation;

    expect(await rig.index.rebuildFromDisk(inventory)).toEqual({ sources: 0, occurrences: 0 });
    expect(rig.index.generation).toBe(generation);
  });

  test('stats count only the rows the index returns', () => {
    const withHidden = createIndex();
    const withoutHidden = createIndex();
    for (const index of [withHidden, withoutHidden]) index.setSource('vault/acp.daemon', '# ACP\n');
    withHidden.setSource('notes/source', 'See [[acp.daemon]] and [x](target).\n');
    withHidden.setSource('notes/other', HIDDEN_ONLY);
    withoutHidden.setSource('notes/source', 'See [x](target).\n');

    const returned = withHidden.getAssessmentsForSources();
    expect(withHidden.getStats()).toEqual(withoutHidden.getStats());
    expect(withHidden.getStats()).toMatchObject({
      sources: returned.length,
      occurrences: returned.flatMap(({ assessments }) => assessments).length,
    });
  });
});

describe('file targets that exist but are excluded by ignore rules (PRD-8896)', () => {
  const IGNORED_SOURCE = [
    '[d](ignored/ig.png)',
    '![e](ignored/ig.png)',
    '[m](ignored/missing.png)',
    '[m2](media/missing.png)',
  ].join('\n');

  function reasonsOf(index: LocalTargetIndex): Array<[string | null, string, string | null]> {
    return index.getAssessments('src').map((a) => [a.resolvedTarget, a.status, a.reason]);
  }

  test('a file on disk under a .gitignore rule reports excluded; missing files stay no-such-file', () => {
    const rig = createDiskRig({}, { '.gitignore': 'ignored/\n' });
    rig.write('ignored/ig.png', 'png');
    rig.index.setSource('src', IGNORED_SOURCE);
    expect(reasonsOf(rig.index)).toEqual([
      ['ignored/ig.png', 'missing', 'excluded'],
      ['ignored/ig.png', 'missing', 'excluded'],
      ['ignored/missing.png', 'missing', 'no-such-file'],
      ['media/missing.png', 'missing', 'no-such-file'],
    ]);
  });

  test('a file on disk under a .okignore rule reports excluded', () => {
    const rig = createDiskRig({}, { '.okignore': 'ignored/\n' });
    rig.write('ignored/ig.png', 'png');
    rig.index.setSource('src', '[d](ignored/ig.png)\n');
    expect(reasonsOf(rig.index)).toEqual([['ignored/ig.png', 'missing', 'excluded']]);
  });

  test('without a content filter the probe is inert and the file stays no-such-file', () => {
    const index = createIndex();
    index.setSource('src', '[d](ignored/ig.png)\n');
    expect(reasonsOf(index)).toEqual([['ignored/ig.png', 'missing', 'no-such-file']]);
  });

  test('a built-in exclusion a "!" rule cannot lift stays no-such-file (control)', () => {
    const rig = createDiskRig();
    rig.write('node_modules/pkg/logo.png', 'png');
    rig.write('.env', 'SECRET=1');
    rig.index.setSource('src', '[n](node_modules/pkg/logo.png)\n[s](.env)\n');
    expect(reasonsOf(rig.index)).toEqual([
      ['node_modules/pkg/logo.png', 'missing', 'no-such-file'],
      ['.env', 'missing', 'no-such-file'],
    ]);
  });

  test('a file under a built-in skip folder stays no-such-file even when an ignore file also matches it', () => {
    const rig = createDiskRig({}, { '.okignore': 'build/\noutput/\n' });
    rig.write('build/diagram.png', 'png');
    rig.write('output/chart.png', 'png');
    rig.index.setSource('src', '[b](build/diagram.png)\n[o](output/chart.png)\n');
    expect(reasonsOf(rig.index)).toEqual([
      ['build/diagram.png', 'missing', 'no-such-file'],
      ['output/chart.png', 'missing', 'no-such-file'],
    ]);
  });
});
