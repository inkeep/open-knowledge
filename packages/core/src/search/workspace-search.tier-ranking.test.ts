import { describe, expect, test } from 'bun:test';
import {
  createWorkspaceSearchDocument,
  DEFAULT_FOLDER_RESULT_CAP,
  searchWorkspaceDocuments,
} from './workspace-search.ts';

describe('tier-dominant ranking — identity beats body relevance', () => {
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
    expect(partials.length).toBeGreaterThan(10);
  });

  test('an exact basename remains findable among many same-named siblings (deep pool)', () => {
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
