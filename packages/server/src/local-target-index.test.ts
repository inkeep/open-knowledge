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

/** In-memory index (no disk) — the pure incremental machinery. */
function createIndex(): LocalTargetIndex {
  const index = new LocalTargetIndex({ contentDir: join(tmpdir(), 'ok-lti-nonexistent') });
  cleanups.push(() => index.close());
  return index;
}

/** Disk-backed index over a fresh temp content dir. */
function createDiskRig(
  overrides: Omit<LocalTargetIndexOptions, 'contentDir' | 'contentFilter'> = {},
): {
  index: LocalTargetIndex;
  contentDir: string;
  write: (rel: string, md: string) => void;
} {
  const projectDir = mkdtempSync(join(tmpdir(), 'ok-lti-'));
  const contentDir = join(projectDir, 'content');
  mkdirSync(contentDir, { recursive: true });
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

    // The target document appears; the referencing source is NOT re-authored.
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

    // Re-author the source to point elsewhere.
    index.setSource('src', 'See [x](beta).\n');
    expect(index.getDocumentDependents('alpha')).toEqual([]);
    expect(index.getDocumentDependents('beta')).toEqual(['src']);

    // The abandoned target appearing must not touch the source anymore.
    index.setSource('alpha', '# Alpha\n');
    expect(index.getAssessments('src')[0]).toMatchObject({
      resolvedTarget: 'beta',
      status: 'missing',
    });

    // The current target appearing heals it.
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

  test('a content-only file-update event does not flip existence or bump the generation', () => {
    const index = createIndex();
    index.setSource('src', 'Download [pdf](assets/report.pdf).\n');
    index.setFileTarget('assets/report.pdf', true);
    const generation = index.generation;

    // The watcher reports the same file again (content changed, still present).
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
    // Unrelated sources pointing at a different, still-missing file.
    for (let i = 0; i < 15; i++) {
      index.setSource(`unrelated-${i}`, 'Download [pdf](assets/other.pdf).\n');
    }

    const affected = index.setFileTarget('assets/shared.pdf', true);
    expect(affected).toBe(fanout);
    expect(index.getFileDependents('assets/shared.pdf')).toHaveLength(fanout);

    // Every dependent healed; every unrelated source is untouched.
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
    // Distinct ranges preserved per occurrence.
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

  test('records canonical folder-index and bare-basename fallbacks', () => {
    const index = createIndex();
    index.setSource('guides/index', '# Guides\n');
    index.setSource('nested/analysis', '# Analysis\n');
    index.setSource('src', 'See [folder](guides) and [bare](analysis).\n');

    expect(index.getAssessments('src').map((assessment) => assessment.fallbackTarget)).toEqual([
      'guides/index',
      'nested/analysis',
    ]);
    expect(
      index.getAssessments('src').every((assessment) => assessment.status === 'fallback'),
    ).toBe(true);
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
    // External + anchor are dropped at extraction; the two escaping forms assess
    // as unresolvable with no resolvable identity, so nothing depends on them.
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
    // `b` exists as a walked document; `assets/f.pdf` exists via the seeded file inventory.
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
    // `a`'s missing doc reference is untouched by the file create.
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
