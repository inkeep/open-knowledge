import { describe, expect, test } from 'bun:test';
import {
  createWorkspaceSearchDocument,
  DEFAULT_BODY_RESULT_CAP,
  DEFAULT_PATH_ONLY_RESULT_CAP,
  searchWorkspaceDocuments,
  type WorkspaceSearchOptions,
} from './workspace-search.ts';

/**
 * Category-cap phase (navigation ranking): a query buckets results by match
 * provenance — `lexical` (a real title/name/path-segment match), `body`
 * (content-only), `pathOnly` (incidental path substring) — and caps the two
 * weak buckets so no single match-class floods the list. Asserts the SPREAD
 * (exact name + folder + a bounded body/path tail), not frozen orderings; the
 * parity fixture pins exact scores for the lexical path.
 *
 * Configured like the SERVER omnibar request (`/api/search`): `full_text`
 * intent (so content is actually searched) with `navigation` ranking (so the
 * category caps apply). The per-keystroke client path uses `omnibar` intent,
 * which does not search content, so body-only hits only ever arise here.
 */
const OMNIBAR: WorkspaceSearchOptions = {
  intent: 'full_text',
  ranking: 'navigation',
  scopes: ['page', 'folder', 'content', 'file'],
  limit: 50,
};

describe('category caps — content-first spread for a name-shaped query', () => {
  // The `spec` case: one exact-name page + one exact-name folder, plus a wall of
  // pages that mention "spec" only in their BODY (no name/path match), plus a few
  // whose PATH incidentally contains "spec". Without the category caps the body
  // wall would crowd out the path hits; with them the list keeps a useful spread.
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
  // Body-only matches: name/path do NOT contain "spec", but content does, so
  // they enter via the BM25 content candidate union as `body`.
  const bodyOnly = Array.from({ length: 12 }, (_, i) =>
    createWorkspaceSearchDocument({
      kind: 'page',
      path: `notes/note-${i}`,
      title: `Note ${i}`,
      content: 'this page discusses the spec at length and references spec details',
      modifiedTs: i,
    }),
  );
  // Path-substring-only matches: "spec" appears as a path substring ("in-spec-t"),
  // not a whole segment, not the name, and the body does NOT mention it → `pathOnly`.
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
    // Both 700-bracket exact-name hits are at the front — tier-dominant sort puts
    // them first, and the category merge emits the lexical bucket before body/path.
    expect(leading).toContain('specs/spec');
    expect(leading).toContain('spec');
  });

  test('body-only matches are bounded, not a flood', () => {
    const results = searchWorkspaceDocuments(corpus, 'spec', OMNIBAR);
    // Body-only candidates: the 12 `notes/note-*` pages (name/path miss, body hit).
    const bodyHits = results.filter((r) => r.document.path.startsWith('notes/note-'));
    expect(bodyHits.length).toBeLessThanOrEqual(DEFAULT_BODY_RESULT_CAP);
    // Non-trivial: more body candidates existed than the cap admits.
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
    // The exact name + folder AND the path-substring tail are all present — the
    // path hits are not crowded out by the 12-page body wall.
    expect(exact.length).toBe(2);
    expect(path.length).toBeGreaterThan(0);
  });
});

describe('category caps respect the relevance (MCP search) path', () => {
  // `full_text` with default (relevance) ranking must NOT apply the navigation
  // category caps — content search legitimately wants every body match.
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
    // Every body match survives — relevance bypasses the navigation caps.
    expect(bodyHits.length).toBe(12);
  });
});
