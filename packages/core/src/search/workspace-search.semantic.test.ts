import { describe, expect, test } from 'vitest';
import {
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  searchWorkspaceCorpus,
  type WorkspaceSearchDocument,
} from './workspace-search.ts';

function page(
  path: string,
  title: string,
  content: string,
  modifiedTs = 1000,
): WorkspaceSearchDocument {
  return createWorkspaceSearchDocument({ kind: 'page', path, title, content, modifiedTs });
}

function ids(results: ReturnType<typeof searchWorkspaceCorpus>): string[] {
  return results.map((r) => r.document.path);
}

describe('semantic ranking — candidate source + brackets-outer/RRF-body', () => {
  test('C2a: a strong vector match never displaces an exact-title lexical match', () => {
    const docs = [
      page('auth/login', 'Login', 'the login page authenticates a user'),
      page('guides/credentials', 'Credentials Guide', 'how authorization and tokens work'),
    ];
    const corpus = createWorkspaceSearchCorpus(docs);
    const scores = new Map([
      ['page:auth/login', 0.25],
      ['page:guides/credentials', 0.97],
    ]);
    const results = searchWorkspaceCorpus(corpus, 'login', {
      intent: 'full_text',
      semantic: { scores },
    });
    expect(results[0].document.path).toBe('auth/login');
    expect(ids(results)).toContain('guides/credentials');
  });

  test('C2b: a zero-token-overlap vector-only doc is unioned as a candidate and surfaces', () => {
    const docs = [
      page(
        'guides/credential-rotation',
        'Credential Rotation',
        'the credential rotation flow re-issues secrets when they expire',
      ),
      page('recipes/sourdough', 'Sourdough', 'a recipe for sourdough bread'),
    ];
    const corpus = createWorkspaceSearchCorpus(docs);
    const noSemantic = searchWorkspaceCorpus(corpus, 'auth retries', { intent: 'full_text' });
    expect(noSemantic.length).toBe(0);

    const scores = new Map([
      ['page:guides/credential-rotation', 0.82],
      ['page:recipes/sourdough', 0.2],
    ]);
    const withSemantic = searchWorkspaceCorpus(corpus, 'auth retries', {
      intent: 'full_text',
      semantic: { scores, similarityFloor: 0.5 },
    });
    expect(ids(withSemantic)).toEqual(['guides/credential-rotation']);
    expect(withSemantic[0].signals.vector).toBeCloseTo(0.82, 5);
  });

  test('similarityFloor keeps a low-cosine vector-only doc out of the candidate pool', () => {
    const docs = [page('recipes/sourdough', 'Sourdough', 'a recipe for sourdough bread')];
    const corpus = createWorkspaceSearchCorpus(docs);
    const scores = new Map([['page:recipes/sourdough', 0.2]]);
    const results = searchWorkspaceCorpus(corpus, 'auth retries', {
      intent: 'full_text',
      semantic: { scores, similarityFloor: 0.5 },
    });
    expect(results.length).toBe(0);
  });

  test('signals.vector is present only for docs with a cosine, and only on the semantic path', () => {
    const docs = [
      page('auth/login', 'Login', 'login page'),
      page('notes/misc', 'Misc', 'login appears here too in body'),
    ];
    const corpus = createWorkspaceSearchCorpus(docs);
    for (const r of searchWorkspaceCorpus(corpus, 'login', { intent: 'full_text' })) {
      expect('vector' in r.signals).toBe(false);
    }
    const scores = new Map([['page:auth/login', 0.6]]);
    const results = searchWorkspaceCorpus(corpus, 'login', {
      intent: 'full_text',
      semantic: { scores },
    });
    const byPath = new Map(results.map((r) => [r.document.path, r]));
    expect(byPath.get('auth/login')?.signals.vector).toBeCloseTo(0.6, 5);
    const misc = byPath.get('notes/misc');
    expect(misc).toBeDefined();
    expect('vector' in (misc?.signals ?? {})).toBe(false);
  });

  test('a candidate whose cosine is below the floor does not report signals.vector', () => {
    const docs = [page('auth/login', 'Login', 'the login page authenticates a user')];
    const corpus = createWorkspaceSearchCorpus(docs);
    const scores = new Map([['page:auth/login', 0.2]]);
    const results = searchWorkspaceCorpus(corpus, 'login', {
      intent: 'full_text',
      semantic: { scores, similarityFloor: 0.5 },
    });
    expect(results.length).toBe(1);
    expect('vector' in results[0].signals).toBe(false);
  });

  test('RRF body tier: a strong vector signal promotes a doc above a stronger-BM25 rival', () => {
    const docs = [
      page('obs/observability', 'Observability', 'telemetry telemetry telemetry spans and metrics'),
      page('data/pipeline', 'Pipeline', 'telemetry pipeline ingestion'),
    ];
    const corpus = createWorkspaceSearchCorpus(docs);
    const lexicalOnly = searchWorkspaceCorpus(corpus, 'telemetry', { intent: 'full_text' });
    expect(lexicalOnly.length).toBe(2);
    const bm25Top = lexicalOnly[0].document.path;
    const bm25Second = lexicalOnly[1].document.path;

    const scores = new Map<string, number>([
      [`page:${bm25Top}`, 0.1],
      [`page:${bm25Second}`, 0.95],
    ]);
    const fused = searchWorkspaceCorpus(corpus, 'telemetry', {
      intent: 'full_text',
      semantic: { scores, similarityFloor: 0.5 },
    });
    expect(fused[0].document.path).toBe(bm25Second);
    expect(fused[1].document.path).toBe(bm25Top);
  });

  test('candidateLimit bounds how many vector-only docs are unioned', () => {
    const docs = Array.from({ length: 5 }, (_, i) =>
      page(`v/doc-${i}`, `Doc ${i}`, `body about widget number ${i}`),
    );
    const corpus = createWorkspaceSearchCorpus(docs);
    const scores = new Map(docs.map((d, i) => [d.id, 0.9 - i * 0.05] as const));
    const results = searchWorkspaceCorpus(corpus, 'unrelated concept query', {
      intent: 'full_text',
      semantic: { scores, candidateLimit: 2 },
    });
    expect(results.length).toBe(2);
    expect(ids(results).sort()).toEqual(['v/doc-0', 'v/doc-1']);
  });

  test('the default is rank-based: low cosines are admitted (no absolute cutoff), ordered by similarity', () => {
    const docs = [
      page('characters/edward', 'Edward', 'the crew hacker who breaks into networked systems'),
      page('music/soundtrack', 'Soundtrack', 'jazz and blues from the series'),
    ];
    const corpus = createWorkspaceSearchCorpus(docs);
    const noSemantic = searchWorkspaceCorpus(corpus, 'cybersecurity', { intent: 'full_text' });
    expect(noSemantic.length).toBe(0);
    const scores = new Map([
      ['page:characters/edward', 0.13],
      ['page:music/soundtrack', 0.08],
    ]);
    const results = searchWorkspaceCorpus(corpus, 'cybersecurity', {
      intent: 'full_text',
      semantic: { scores },
    });
    expect(ids(results)).toEqual(['characters/edward', 'music/soundtrack']);
    expect(results[0].signals.vector).toBeCloseTo(0.13, 5);
    expect(results[1].signals.vector).toBeCloseTo(0.08, 5);
  });
});
