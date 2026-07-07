/**
 * Socket-free unit coverage for the `?showAll=true` entry-cap floor.
 *
 * Exercises the real walk + cap helpers directly against temp fixtures — no
 * bound HTTP server — so the boundary the integration test skips is provable:
 * the existing `document-list-showall-cap.test.ts` uses 25 files vs cap 5 (far
 * over the edge), leaving the off-by-one (exactly-cap vs cap+1) unverified.
 * Also pins the env-parser fallback for hostile `OK_SHOWALL_MAX_ENTRIES` input.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocumentListEntry } from '@inkeep/open-knowledge-core';
import {
  __getShowAllWalkStatsForTesting,
  __resetShowAllWalkStatsForTesting,
  DEFAULT_SHOWALL_MAX_ENTRIES,
  getShowAllMaxEntries,
  walkContentDirForShowAll,
} from './api-extension.ts';
import { createContentFilter } from './content-filter.ts';

// A FLAT dir of plain markdown files: entry-count == file-count (no folders,
// no assets, nothing the default ContentFilter excludes), so the cap maths is
// a clean 1:1 against the number of files written.
function makeFlatFixture(fileCount: number): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-walk-')));
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(join(dir, `file-${String(i).padStart(3, '0')}.md`), `# File ${i}\n`);
  }
  return dir;
}

async function walkFixture(dir: string, maxEntries: number) {
  const documents: DocumentListEntry[] = [];
  const { truncated } = await walkContentDirForShowAll({
    contentDir: dir,
    contentFilter: createContentFilter({ projectDir: dir, contentDir: dir }),
    dirFilter: null,
    documents,
    getDocExtension: () => '.md',
    maxEntries,
  });
  return { documents, truncated };
}

describe('getShowAllMaxEntries — env-parse fallback (QA-006)', () => {
  const KEY = 'OK_SHOWALL_MAX_ENTRIES';
  const prev = process.env[KEY];
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  });

  test('unset → default 50000', () => {
    delete process.env[KEY];
    expect(getShowAllMaxEntries()).toBe(DEFAULT_SHOWALL_MAX_ENTRIES);
    expect(DEFAULT_SHOWALL_MAX_ENTRIES).toBe(50_000);
  });

  test('non-positive / non-numeric / empty input falls back to the default without throwing', () => {
    // The exact hostile values call out: a fat-fingered ops value must
    // never disable Show All Files or invite an OOM-by-zero cap.
    for (const bad of ['0', '-5', 'abc', '', '   ']) {
      process.env[KEY] = bad;
      expect(() => getShowAllMaxEntries()).not.toThrow();
      expect(getShowAllMaxEntries()).toBe(DEFAULT_SHOWALL_MAX_ENTRIES);
    }
  });

  test('a valid positive integer (incl. very large) is honored', () => {
    process.env[KEY] = '7';
    expect(getShowAllMaxEntries()).toBe(7);
    process.env[KEY] = '999999999';
    expect(getShowAllMaxEntries()).toBe(999_999_999);
  });

  test('scientific notation lifts to its integer value (operator tuning the cap upward must not silently collapse to 1)', () => {
    // `parseInt('1e5', 10)` returns 1 (stops at the first non-digit), which
    // would have silently capped Show All Files at a single entry. `Number`
    // expands the exponent so the cap matches the operator's intent.
    process.env[KEY] = '1e5';
    expect(getShowAllMaxEntries()).toBe(100_000);
    process.env[KEY] = '1.5e3';
    expect(getShowAllMaxEntries()).toBe(1_500);
    // Fractional / negative-exponent values are still rejected — only positive
    // integers survive the `isInteger` guard.
    process.env[KEY] = '1e-5';
    expect(getShowAllMaxEntries()).toBe(DEFAULT_SHOWALL_MAX_ENTRIES);
    process.env[KEY] = '50000.5';
    expect(getShowAllMaxEntries()).toBe(DEFAULT_SHOWALL_MAX_ENTRIES);
  });
});

describe('walkContentDirForShowAll — entry-cap boundary honesty', () => {
  test('exactly-cap fixture is complete and NOT truncated (QA-003 lower edge)', async () => {
    const CAP = 4;
    const { documents, truncated } = await walkFixture(makeFlatFixture(CAP), CAP);
    expect(documents.length).toBe(CAP);
    expect(truncated).toBe(false);
  });

  test('cap+1 fixture truncates and the count never exceeds the cap (QA-003 upper edge)', async () => {
    const CAP = 4;
    const { documents, truncated } = await walkFixture(makeFlatFixture(CAP + 1), CAP);
    expect(truncated).toBe(true);
    expect(documents.length).toBe(CAP);
    expect(documents.length).toBeLessThanOrEqual(CAP);
  });

  test('well-over-cap fixture truncates with a bounded, positive count (QA-007 / AC1)', async () => {
    const CAP = 5;
    const { documents, truncated } = await walkFixture(makeFlatFixture(25), CAP);
    expect(truncated).toBe(true);
    expect(documents.length).toBe(CAP);
    expect(documents.length).toBeGreaterThan(0);
  });

  test('default cap leaves a small fixture complete and untruncated (QA-008 / AC2)', async () => {
    const { documents, truncated } = await walkFixture(
      makeFlatFixture(25),
      DEFAULT_SHOWALL_MAX_ENTRIES,
    );
    expect(truncated).toBe(false);
    expect(documents.length).toBe(25);
    const docNames = documents.filter((e) => e.kind === 'document').map((e) => e.docName);
    expect(docNames).toContain('file-000');
    expect(docNames).toContain('file-024');
  });

  test('cap consumed by a folder entry short-circuits the recursive descent', async () => {
    // Pins the cap-check-before-push ordering across the recursion boundary.
    // The folder entry is pushed BEFORE `walk()` recurses, so a cap of 1 must
    // surface the folder and stop — never enumerating its children. If a
    // future refactor reorders the cap-check past the folder push or pushes
    // folders inside the recursive call, this test fails and the heap bound
    // is no longer provable across nested structures.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showall-nested-')));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'a.md'), '# A\n');
    writeFileSync(join(dir, 'sub', 'b.md'), '# B\n');
    const { documents, truncated } = await walkFixture(dir, 1);
    expect(truncated).toBe(true);
    expect(documents.length).toBe(1);
    expect(documents[0]?.kind).toBe('folder');
  });
});

describe('walkContentDirForShowAll — abort-on-disconnect (PRD-6854)', () => {
  async function walkWithSignal(
    dir: string,
    signal: AbortSignal,
    getDocExtension: (docName: string) => string = () => '.md',
  ) {
    const documents: DocumentListEntry[] = [];
    const { truncated } = await walkContentDirForShowAll({
      contentDir: dir,
      contentFilter: createContentFilter({ projectDir: dir, contentDir: dir }),
      dirFilter: null,
      documents,
      getDocExtension,
      maxEntries: DEFAULT_SHOWALL_MAX_ENTRIES,
      signal,
    });
    return { documents, truncated };
  }

  test('an already-aborted signal pushes zero entries and records the abort', async () => {
    __resetShowAllWalkStatsForTesting();
    const controller = new AbortController();
    controller.abort();
    const { documents, truncated } = await walkWithSignal(makeFlatFixture(10), controller.signal);
    expect(documents.length).toBe(0);
    expect(truncated).toBe(false);
    const stats = __getShowAllWalkStatsForTesting();
    expect(stats.invocations).toBe(1);
    expect(stats.aborts).toBe(1);
  });

  test('aborting mid-walk halts traversal before the full tree is enumerated', async () => {
    __resetShowAllWalkStatsForTesting();
    const TOTAL = 20;
    const controller = new AbortController();
    // Fire the abort from inside the per-file getDocExtension callback after the
    // first push; the next per-entry boundary check then bails. Proves the
    // loop-boundary guard halts an in-progress walk, not only a pre-aborted one.
    const { documents } = await walkWithSignal(makeFlatFixture(TOTAL), controller.signal, () => {
      controller.abort();
      return '.md';
    });
    expect(documents.length).toBeGreaterThan(0);
    expect(documents.length).toBeLessThan(TOTAL);
    const stats = __getShowAllWalkStatsForTesting();
    expect(stats.invocations).toBe(1);
    expect(stats.aborts).toBe(1);
  });

  test('a never-aborted signal completes the full walk and records no abort', async () => {
    __resetShowAllWalkStatsForTesting();
    const controller = new AbortController();
    const { documents, truncated } = await walkWithSignal(makeFlatFixture(8), controller.signal);
    expect(documents.length).toBe(8);
    expect(truncated).toBe(false);
    const stats = __getShowAllWalkStatsForTesting();
    expect(stats.invocations).toBe(1);
    expect(stats.aborts).toBe(0);
  });
});
