import { describe, expect, test } from 'vitest';
import {
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  searchWorkspaceCorpus,
  updateWorkspaceSearchCorpus,
  type WorkspaceSearchDocument,
  type WorkspaceSearchOptions,
} from './workspace-search.ts';

function page(
  path: string,
  content: string,
  modifiedTs = 10,
  title?: string,
): WorkspaceSearchDocument {
  return createWorkspaceSearchDocument({ kind: 'page', path, title, content, modifiedTs });
}

function folder(path: string, modifiedTs = 0): WorkspaceSearchDocument {
  return createWorkspaceSearchDocument({ kind: 'folder', path, modifiedTs });
}

function file(path: string, modifiedTs = 5): WorkspaceSearchDocument {
  return createWorkspaceSearchDocument({ kind: 'file', path, modifiedTs });
}

const baseDocuments: WorkspaceSearchDocument[] = [
  page('docs/api', 'HTTP endpoint contracts', 10, 'API Reference'),
  page('architecture/overview', 'Observer bridge and CRDT topology', 30, 'Architecture Overview'),
  page('notes/graphing', 'Visual explorer notes', 20, 'Graphing Notes'),
  folder('docs'),
  folder('architecture'),
  folder('notes'),
  file('assets/diagram.png'),
];

/**
 * The correctness bar for the incremental path: for any query/options pair, an
 * incrementally-maintained corpus must be indistinguishable from a corpus
 * built from scratch over the same documents — paths, scores, and signals.
 */
function expectSearchEquivalence(
  incremental: ReturnType<typeof createWorkspaceSearchCorpus>,
  documents: readonly WorkspaceSearchDocument[],
  queries: readonly string[],
  options: WorkspaceSearchOptions = { intent: 'full_text' },
) {
  const fresh = createWorkspaceSearchCorpus(documents);
  for (const query of queries) {
    const incrementalResults = searchWorkspaceCorpus(incremental, query, options);
    const freshResults = searchWorkspaceCorpus(fresh, query, options);
    expect(
      incrementalResults.map((r) => ({
        path: r.document.path,
        kind: r.document.kind,
        score: r.score,
        signals: r.signals,
      })),
    ).toEqual(
      freshResults.map((r) => ({
        path: r.document.path,
        kind: r.document.kind,
        score: r.score,
        signals: r.signals,
      })),
    );
  }
}

describe('updateWorkspaceSearchCorpus', () => {
  test('inserting a document makes it searchable without a rebuild', () => {
    const corpus = createWorkspaceSearchCorpus(baseDocuments);
    const next = [...baseDocuments, page('guides/tutorial', 'Zebra migration walkthrough', 40)];

    const update = updateWorkspaceSearchCorpus(corpus, next);

    expect(update.rebuilt).toBe(false);
    expect(update.inserted).toBe(1);
    expect(update.updated).toBe(0);
    expect(update.removed).toBe(0);
    const results = searchWorkspaceCorpus(update.corpus, 'zebra', { intent: 'full_text' });
    expect(results.map((r) => r.document.path)).toContain('guides/tutorial');
    expectSearchEquivalence(update.corpus, next, ['zebra', 'tutorial', 'topology', 'arch']);
  });

  test('updating a document swaps its indexed content', () => {
    const corpus = createWorkspaceSearchCorpus(baseDocuments);
    const next = baseDocuments.map((doc) =>
      doc.path === 'notes/graphing'
        ? page('notes/graphing', 'Quokka habitat research', 21, 'Graphing Notes')
        : doc,
    );

    const update = updateWorkspaceSearchCorpus(corpus, next);

    expect(update.rebuilt).toBe(false);
    expect(update.inserted).toBe(0);
    expect(update.updated).toBe(1);
    expect(update.removed).toBe(0);
    const newHits = searchWorkspaceCorpus(update.corpus, 'quokka', { intent: 'full_text' });
    expect(newHits.map((r) => r.document.path)).toContain('notes/graphing');
    const oldHits = searchWorkspaceCorpus(update.corpus, 'explorer', { intent: 'full_text' });
    expect(oldHits.map((r) => r.document.path)).not.toContain('notes/graphing');
    expectSearchEquivalence(update.corpus, next, ['quokka', 'explorer', 'notes']);
  });

  test('removing a document drops it from every search tier', () => {
    const corpus = createWorkspaceSearchCorpus(baseDocuments);
    const next = baseDocuments.filter((doc) => doc.path !== 'docs/api');

    const update = updateWorkspaceSearchCorpus(corpus, next);

    expect(update.rebuilt).toBe(false);
    expect(update.inserted).toBe(0);
    expect(update.updated).toBe(0);
    expect(update.removed).toBe(1);
    for (const query of ['endpoint', 'api']) {
      const hits = searchWorkspaceCorpus(update.corpus, query, { intent: 'full_text' });
      expect(hits.map((r) => r.document.path)).not.toContain('docs/api');
    }
    expectSearchEquivalence(update.corpus, next, ['endpoint', 'api', 'contracts']);
  });

  test('unchanged document set patches nothing and stays searchable', () => {
    const corpus = createWorkspaceSearchCorpus(baseDocuments);
    // New array, mixed identity: some reused objects, some re-created equal ones
    // (the server reuses page objects via its cache but re-creates metadata-only
    // folder/file documents every build).
    const next = baseDocuments.map((doc) =>
      doc.kind === 'page' ? doc : createWorkspaceSearchDocument({ ...doc }),
    );

    const update = updateWorkspaceSearchCorpus(corpus, next);

    expect(update.rebuilt).toBe(false);
    expect(update.inserted).toBe(0);
    expect(update.updated).toBe(0);
    expect(update.removed).toBe(0);
    expectSearchEquivalence(update.corpus, next, ['topology', 'arch', 'diagram']);
  });

  test('a removed id can be re-added across successive updates', () => {
    const corpus = createWorkspaceSearchCorpus(baseDocuments);
    const without = baseDocuments.filter((doc) => doc.path !== 'docs/api');
    const first = updateWorkspaceSearchCorpus(corpus, without);
    expect(first.rebuilt).toBe(false);

    const readded = [...without, page('docs/api', 'Fresh endpoint catalog', 50, 'API Reference')];
    const second = updateWorkspaceSearchCorpus(first.corpus, readded);

    expect(second.rebuilt).toBe(false);
    const hits = searchWorkspaceCorpus(second.corpus, 'catalog', { intent: 'full_text' });
    expect(hits.map((r) => r.document.path)).toContain('docs/api');
    expectSearchEquivalence(second.corpus, readded, ['catalog', 'endpoint']);
  });

  test('emptying the corpus rebuilds electively and leaves a searchable empty index', () => {
    const corpus = createWorkspaceSearchCorpus(baseDocuments);
    const update = updateWorkspaceSearchCorpus(corpus, []);
    // Removing everything mutates more entries than an (empty) rebuild inserts,
    // so the bulk-change gate takes the cheap from-scratch path.
    expect(update.rebuilt).toBe(true);
    expect(update.rebuildReason).toBe('bulk-change');
    expect(searchWorkspaceCorpus(update.corpus, 'topology', { intent: 'full_text' })).toEqual([]);
  });

  test('duplicate ids fail loudly, matching the from-scratch build', () => {
    const corpus = createWorkspaceSearchCorpus(baseDocuments);
    const duplicated = [...baseDocuments, page('docs/api', 'Shadow copy', 60)];
    expect(() => createWorkspaceSearchCorpus(duplicated)).toThrow();
    expect(() => updateWorkspaceSearchCorpus(corpus, duplicated)).toThrow();
  });

  test('reusing a consumed base falls back to a from-scratch rebuild', () => {
    const corpus = createWorkspaceSearchCorpus(baseDocuments);
    const first = updateWorkspaceSearchCorpus(corpus, [
      ...baseDocuments,
      page('guides/alpha', 'Alpha content', 40),
    ]);
    expect(first.rebuilt).toBe(false);

    // Diffing against `corpus` again would patch an index that has already
    // moved past it; the consumed-base gate must force a rebuild instead.
    const next = [...baseDocuments, page('guides/beta', 'Beta content', 41)];
    const second = updateWorkspaceSearchCorpus(corpus, next);

    expect(second.rebuilt).toBe(true);
    expect(second.rebuildReason).toBe('stale-base');
    expectSearchEquivalence(second.corpus, next, ['beta', 'alpha', 'topology']);
  });

  test('a diff touching more documents than a rebuild would insert rebuilds electively', () => {
    const corpus = createWorkspaceSearchCorpus(baseDocuments);
    // Replace everything: every old id removed, every new id inserted.
    const next = [page('brand/new', 'Entirely new workspace', 70)];

    const update = updateWorkspaceSearchCorpus(corpus, next);

    expect(update.rebuilt).toBe(true);
    expect(update.rebuildReason).toBe('bulk-change');
    expectSearchEquivalence(update.corpus, next, ['workspace', 'topology']);
  });

  test('mixed burst of inserts, updates, and removes matches a from-scratch build', () => {
    // Deterministic pseudo-random burst: enough documents and churn to exercise
    // the diff paths together, seeded so a failure replays exactly.
    let seed = 0xc0ffee;
    const rand = () => {
      // LCG (Numerical Recipes constants) — deterministic across runs/platforms.
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const words = ['alpha', 'bravo', 'crdt', 'delta', 'editor', 'fjord', 'graph', 'hocus'];
    const makeContent = () =>
      Array.from({ length: 5 }, () => words[Math.trunc(rand() * words.length)]).join(' ');

    let documents: WorkspaceSearchDocument[] = Array.from({ length: 40 }, (_, i) =>
      page(`corpus/doc-${i}`, makeContent(), i),
    );
    let corpus = createWorkspaceSearchCorpus(documents);

    for (let step = 0; step < 8; step++) {
      const next = [...documents];
      // Remove one, update two, insert one per step — small deltas, like a
      // write burst with interleaved searches.
      next.splice(Math.trunc(rand() * next.length), 1);
      for (let u = 0; u < 2; u++) {
        const i = Math.trunc(rand() * next.length);
        const target = next[i];
        if (target) next[i] = page(target.path, makeContent(), target.modifiedTs + 100);
      }
      next.push(page(`corpus/new-${step}`, makeContent(), 1000 + step));

      const update = updateWorkspaceSearchCorpus(corpus, next);
      expect(update.rebuilt).toBe(false);
      corpus = update.corpus;
      documents = next;

      expectSearchEquivalence(corpus, documents, words, { intent: 'full_text' });
      expectSearchEquivalence(corpus, documents, ['corpus', 'doc-3', 'new-'], {
        intent: 'omnibar',
      });
    }
  });
});
