import { describe, expect, test } from 'bun:test';
import {
  createWorkspaceSearchDocument,
  DEFAULT_FOLDER_RESULT_CAP,
  searchWorkspaceDocuments,
} from './workspace-search.ts';

/**
 * Ranking invariants for the intent-aware, tier-dominant navigation score and
 * the exact-name surfacing guarantee. These assert PROPERTIES (an exact-name
 * match leads a body-heavier partial; an exact match is never dropped for a
 * lower-tier sibling), not frozen orderings — the parity fixture pins exact
 * scores. Expand these as the labeled query set grows.
 */

describe('tier-dominant ranking — identity beats body relevance', () => {
  // The defect this fixes: an exact-name match (bracket 700) with a weak body
  // score must outrank a substring match (bracket 600) with a much stronger
  // body score. The old additive `lexical + fullText*20` inverted this because
  // the body term (0–~6000) swamped the 450–700 bracket band.
  const exact = createWorkspaceSearchDocument({
    kind: 'page',
    path: 'cloud-collaboration/STORY',
    title: 'User Stories',
    modifiedTs: 5,
  });
  const bodyHeavyFolder = createWorkspaceSearchDocument({
    kind: 'folder',
    path: 'story/story-archive/storyboard',
    modifiedTs: 50,
  });
  const bodyHeavyPage = createWorkspaceSearchDocument({
    kind: 'page',
    path: 'storybook/storybook-notes',
    title: 'Storybook Storybook Story patterns',
    modifiedTs: 50,
  });
  const corpus = [exact, bodyHeavyFolder, bodyHeavyPage];

  test('an exact-name match leads partials that have a strictly higher body score', () => {
    const results = searchWorkspaceDocuments(corpus, 'story', { intent: 'omnibar' });
    expect(results[0]?.document.path).toBe('cloud-collaboration/STORY');

    // Non-trivial guard: the partials really do out-score the exact match on
    // body, so this only passes because the bracket dominates — not because the
    // exact match happened to win on body anyway.
    const exactHit = results.find((r) => r.document.path === 'cloud-collaboration/STORY');
    const partialHits = results.filter((r) => r.document.path !== 'cloud-collaboration/STORY');
    expect(partialHits.length).toBeGreaterThan(0);
    for (const partial of partialHits) {
      expect(partial.signals.fullText).toBeGreaterThan(exactHit?.signals.fullText ?? 0);
    }
  });

  test('every exact-name page outranks every partial-name match regardless of body', () => {
    const stories = ['cloud-collaboration', 'agent-presence', 'realtime-frontmatter'].map((slug) =>
      createWorkspaceSearchDocument({
        kind: 'page',
        path: `stories/${slug}/STORY`,
        title: `${slug} user stories`,
        modifiedTs: 1,
      }),
    );
    // Partial-name reports whose bodies hammer the `story` token.
    const partials = [1, 2, 3].map((n) =>
      createWorkspaceSearchDocument({
        kind: 'page',
        path: `reports/storybook-${n}/storybook-${n}`,
        title: `Storybook story story story ${n}`,
        modifiedTs: 90,
      }),
    );
    const results = searchWorkspaceDocuments([...partials, ...stories], 'story', {
      intent: 'omnibar',
    });
    const lastExact = Math.max(
      ...results
        .map((r, i) => ({ i, name: r.document.path.split('/').pop() }))
        .filter((r) => r.name === 'STORY')
        .map((r) => r.i),
    );
    const firstPartial = results.findIndex((r) => r.document.path.includes('storybook'));
    expect(lastExact).toBeLessThan(firstPartial);
  });

  test('a buried exact-name match surfaces into the top of its tier via recency', () => {
    // Among same-named STORY pages, the one the user is actively editing
    // (highest recency) leads its tier — the live `cloud-collaboration/STORY`
    // case (buried at ~#10 by body BM25 before tier-dominance).
    const target = createWorkspaceSearchDocument({
      kind: 'page',
      path: 'cloud-collaboration/STORY',
      title: 'Collaboration notes',
      modifiedTs: 100,
    });
    const siblings = Array.from({ length: 12 }, (_, n) =>
      createWorkspaceSearchDocument({
        kind: 'page',
        path: `stories/topic-${n}/STORY`,
        title: `Story story story ${n}`,
        modifiedTs: n,
      }),
    );
    const results = searchWorkspaceDocuments([...siblings, target], 'story', { intent: 'omnibar' });
    expect(results[0]?.document.path).toBe('cloud-collaboration/STORY');
  });
});

describe('intent-aware scoring — full_text stays body-weighted', () => {
  // The same corpus orders DIFFERENTLY by intent: navigation puts identity
  // first; content search puts the strong body match first. This is the
  // intent split — full_text keeps the body-weighted additive score.
  const exact = createWorkspaceSearchDocument({
    kind: 'page',
    path: 'a/STORY',
    title: 'Quiet notes',
    content: 'unrelated prose',
    modifiedTs: 5,
  });
  const bodyHeavy = createWorkspaceSearchDocument({
    kind: 'page',
    path: 'b/storybook-deep-dive',
    title: 'Storybook story story story',
    content: 'story story story story story story',
    modifiedTs: 5,
  });
  const corpus = [exact, bodyHeavy];

  test('omnibar puts the exact name first; full_text puts the strong body match first', () => {
    const omnibar = searchWorkspaceDocuments(corpus, 'story', { intent: 'omnibar' });
    expect(omnibar[0]?.document.path).toBe('a/STORY');

    const fullText = searchWorkspaceDocuments(corpus, 'story', { intent: 'full_text' });
    expect(fullText[0]?.document.path).toBe('b/storybook-deep-dive');
  });
});

describe('ranking decoupled from intent — the omnibar config', () => {
  // The omnibar searches content (a full_text candidate set, with fuzzy
  // tolerance) but must rank name-first and bound folders/files. It does that by
  // pairing intent `full_text` with ranking `navigation`. The MCP `search` tool
  // uses the same intent with the default (relevance) ranking and stays
  // body-weighted + uncapped. This pins that decoupling — the wiring that makes
  // the ranking fix reach the user-facing omnibar.
  const exact = createWorkspaceSearchDocument({
    kind: 'page',
    path: 'cloud-collaboration/STORY',
    title: 'Quiet notes',
    content: 'unrelated prose',
    modifiedTs: 5,
  });
  const bodyHeavy = createWorkspaceSearchDocument({
    kind: 'page',
    path: 'storybook/deep-dive',
    title: 'Storybook story story story',
    content: 'story story story story story story',
    modifiedTs: 5,
  });

  test('navigation ranking over a full_text candidate set puts the exact name first', () => {
    const nav = searchWorkspaceDocuments([exact, bodyHeavy], 'story', {
      intent: 'full_text',
      ranking: 'navigation',
    });
    expect(nav[0]?.document.path).toBe('cloud-collaboration/STORY');

    // Same intent, default (relevance) ranking → the strong body match leads.
    const relevance = searchWorkspaceDocuments([exact, bodyHeavy], 'story', {
      intent: 'full_text',
    });
    expect(relevance[0]?.document.path).toBe('storybook/deep-dive');
  });

  test('navigation ranking applies the per-kind cap; relevance does not', () => {
    const folders = ['a', 'b', 'c', 'd', 'e'].map((p) =>
      createWorkspaceSearchDocument({ kind: 'folder', path: `${p}/reports`, modifiedTs: 0 }),
    );
    const scopes = ['page', 'folder', 'file'] as const;

    const capped = searchWorkspaceDocuments(folders, 'reports', {
      intent: 'full_text',
      ranking: 'navigation',
      scopes,
    });
    expect(capped.filter((r) => r.document.kind === 'folder').length).toBe(
      DEFAULT_FOLDER_RESULT_CAP,
    );

    const uncapped = searchWorkspaceDocuments(folders, 'reports', {
      intent: 'full_text',
      ranking: 'relevance',
      scopes,
    });
    expect(uncapped.filter((r) => r.document.kind === 'folder').length).toBe(folders.length);
  });
});

describe('exact-name surfacing — deep candidate pool', () => {
  test('an exact basename is never dropped for lower-tier siblings that crowd the limit', () => {
    // One exact-name target (weak body) plus many partial-name pages with strong
    // body. Under the old body-driven score the partials would fill the limited
    // result set and bury the target; tier-dominance keeps the exact match on top.
    const target = createWorkspaceSearchDocument({
      kind: 'page',
      path: 'cloud-collaboration/STORY',
      title: 'Quiet collaboration notes',
      modifiedTs: 1,
    });
    const partials = Array.from({ length: 40 }, (_, n) =>
      createWorkspaceSearchDocument({
        kind: 'page',
        path: `reports/storybook-${n}/storybook-${n}`,
        title: `Storybook story story story ${n}`,
        modifiedTs: 50 + n,
      }),
    );
    const results = searchWorkspaceDocuments([...partials, target], 'story', {
      intent: 'omnibar',
      limit: 10,
    });
    expect(results[0]?.document.path).toBe('cloud-collaboration/STORY');
    // The partials really did exceed the result limit — so the guarantee is
    // doing work, not riding a small corpus.
    expect(partials.length).toBeGreaterThan(10);
  });

  test('an exact basename remains findable among many same-named siblings (deep pool)', () => {
    // The candidate pool admits every lexical match from the whole corpus, so a
    // pile of same-named siblings far larger than the fetch window cannot push
    // the actively-edited target out of the candidate set.
    const target = createWorkspaceSearchDocument({
      kind: 'file',
      path: 'team/quarterly/data.csv',
      modifiedTs: 100,
    });
    const siblings = Array.from({ length: 80 }, (_, n) =>
      createWorkspaceSearchDocument({
        kind: 'file',
        path: `archive/run-${n}/data.csv`,
        modifiedTs: n,
      }),
    );
    const results = searchWorkspaceDocuments([...siblings, target], 'data.csv', {
      intent: 'full_text',
      limit: 50,
    });
    expect(results.some((r) => r.document.path === 'team/quarterly/data.csv')).toBe(true);
  });

  test('a uniquely-named file ranks first and a matching folder still surfaces (regression)', () => {
    const docs = [
      createWorkspaceSearchDocument({
        kind: 'page',
        path: 'guides/onboarding',
        title: 'Onboarding',
        modifiedTs: 5,
      }),
      createWorkspaceSearchDocument({ kind: 'folder', path: 'guides', modifiedTs: 0 }),
      createWorkspaceSearchDocument({ kind: 'file', path: 'assets/diagram.png', modifiedTs: 9 }),
    ];
    const unique = searchWorkspaceDocuments(docs, 'diagram.png', { intent: 'omnibar' });
    expect(unique[0]?.document.path).toBe('assets/diagram.png');

    const folderQuery = searchWorkspaceDocuments(docs, 'guides', { intent: 'omnibar' });
    expect(folderQuery.some((r) => r.document.kind === 'folder')).toBe(true);
  });
});
