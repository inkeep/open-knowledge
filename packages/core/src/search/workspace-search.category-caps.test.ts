import { describe, expect, test } from 'vitest';
import {
  createWorkspaceSearchDocument,
  DEFAULT_BODY_RESULT_CAP,
  DEFAULT_PATH_ONLY_RESULT_CAP,
  searchWorkspaceDocuments,
  type WorkspaceSearchOptions,
} from './workspace-search.ts';

const OMNIBAR: WorkspaceSearchOptions = {
  intent: 'full_text',
  ranking: 'navigation',
  scopes: ['page', 'folder', 'content', 'file'],
  limit: 50,
};

describe('category caps — content-first spread for a name-shaped query', () => {
  const exactPage = createWorkspaceSearchDocument({
    kind: 'page',
    path: 'specs/spec',
    title: 'spec',
    content: 'the canonical spec document',
    modifiedTs: 100,
  });
  const exactFolder = createWorkspaceSearchDocument({
    kind: 'folder',
    path: 'spec',
    modifiedTs: 90,
  });
  const bodyOnly = Array.from({ length: 12 }, (_, i) =>
    createWorkspaceSearchDocument({
      kind: 'page',
      path: `notes/note-${i}`,
      title: `Note ${i}`,
      content: 'this page discusses the spec at length and references spec details',
      modifiedTs: i,
    }),
  );
  const pathOnly = Array.from({ length: 8 }, (_, i) =>
    createWorkspaceSearchDocument({
      kind: 'page',
      path: `inspect-${i}/details`,
      title: `Details ${i}`,
      content: 'unrelated body content with no query term',
      modifiedTs: i,
    }),
  );
  const corpus = [exactPage, exactFolder, ...bodyOnly, ...pathOnly];

  test('exact-name page and exact-name folder both lead (lexical bucket first)', () => {
    const results = searchWorkspaceDocuments(corpus, 'spec', OMNIBAR);
    const leading = results.slice(0, 2).map((r) => r.document.path);
    expect(leading).toContain('specs/spec');
    expect(leading).toContain('spec');
  });

  test('body-only matches are bounded, not a flood', () => {
    const results = searchWorkspaceDocuments(corpus, 'spec', OMNIBAR);
    const bodyHits = results.filter((r) => r.document.path.startsWith('notes/note-'));
    expect(bodyHits.length).toBeLessThanOrEqual(DEFAULT_BODY_RESULT_CAP);
    expect(bodyHits.length).toBeLessThan(12);
  });

  test('path-substring-only matches are bounded tightest', () => {
    const results = searchWorkspaceDocuments(corpus, 'spec', OMNIBAR);
    const pathHits = results.filter((r) => r.document.path.startsWith('inspect-'));
    expect(pathHits.length).toBe(DEFAULT_PATH_ONLY_RESULT_CAP);
    expect(pathHits.length).toBeLessThan(8);
  });

  test('the list is a spread of categories, not a single-class flood', () => {
    const results = searchWorkspaceDocuments(corpus, 'spec', OMNIBAR);
    const exact = results.filter(
      (r) => r.document.path === 'specs/spec' || r.document.path === 'spec',
    );
    const path = results.filter((r) => r.document.path.startsWith('inspect-'));
    expect(exact.length).toBe(2);
    expect(path.length).toBeGreaterThan(0);
  });
});

describe('category caps respect the relevance (MCP search) path', () => {
  const bodyOnly = Array.from({ length: 12 }, (_, i) =>
    createWorkspaceSearchDocument({
      kind: 'page',
      path: `notes/note-${i}`,
      title: `Note ${i}`,
      content: 'this page discusses the spec at length and references spec details',
      modifiedTs: i,
    }),
  );

  test('full_text (relevance) is NOT category-capped', () => {
    const results = searchWorkspaceDocuments(bodyOnly, 'spec', {
      intent: 'full_text',
      scopes: ['page', 'content'],
      limit: 50,
    });
    const bodyHits = results.filter((r) => r.document.path.startsWith('notes/note-'));
    expect(bodyHits.length).toBe(12);
  });
});
