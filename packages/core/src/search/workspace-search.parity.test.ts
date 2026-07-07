import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  createWorkspaceSearchCorpus,
  searchWorkspaceCorpus,
  type WorkspaceSearchDocument,
  type WorkspaceSearchOptions,
} from './workspace-search.ts';

/**
 * Flag-OFF byte-identity guard.
 *
 * The fixture is the frozen output of `searchWorkspaceCorpus` captured from the
 * pre-embeddings ranking baseline. With no
 * `semantic` option (the flag-OFF path), the post-embeddings code MUST reproduce
 * it exactly, including the `signals` shape (no `vector` key). A diff here means
 * the no-surprise contract is broken.
 *
 * Regenerate the fixture ONLY when intentionally changing the flag-OFF ranking.
 */
interface FixtureCase {
  query: string;
  options: WorkspaceSearchOptions;
  expected: Array<{ id: string; score: number; signals: Record<string, number> }>;
}
interface Fixture {
  documents: WorkspaceSearchDocument[];
  cases: FixtureCase[];
}

const fixture = JSON.parse(
  readFileSync(new URL('./workspace-search.baseline.fixture.json', import.meta.url), 'utf-8'),
) as Fixture;

describe('flag-OFF parity with the pre-embeddings baseline', () => {
  const corpus = createWorkspaceSearchCorpus(fixture.documents);

  test('fixture is non-trivial', () => {
    expect(fixture.cases.length).toBeGreaterThan(5);
    expect(fixture.documents.length).toBeGreaterThan(5);
  });

  for (const [i, c] of fixture.cases.entries()) {
    test(`case ${i}: "${c.query}" ${JSON.stringify(c.options)} is byte-identical`, () => {
      const actual = searchWorkspaceCorpus(corpus, c.query, c.options).map((r) => ({
        id: r.document.id,
        score: r.score,
        signals: r.signals,
      }));
      expect(actual).toEqual(c.expected);
      // Belt-and-suspenders: no result may carry a `vector` signal on this path.
      for (const r of actual) {
        expect('vector' in r.signals).toBe(false);
      }
    });
  }
});
