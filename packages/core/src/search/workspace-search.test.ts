import { describe, expect, test } from 'bun:test';
import { createWorkspaceSearchDocument, searchWorkspaceDocuments } from './workspace-search.ts';

const documents = [
  createWorkspaceSearchDocument({
    kind: 'page',
    path: 'docs/api',
    title: 'API Reference',
    content: 'HTTP endpoint contracts',
    modifiedTs: 10,
  }),
  createWorkspaceSearchDocument({
    kind: 'page',
    path: 'architecture/overview',
    title: 'Architecture Overview',
    content: 'Observer bridge and CRDT topology',
    modifiedTs: 30,
  }),
  createWorkspaceSearchDocument({
    kind: 'folder',
    path: 'architecture',
    modifiedTs: 0,
  }),
  createWorkspaceSearchDocument({
    kind: 'page',
    path: 'notes/graphing',
    title: 'Graphing Notes',
    content: 'Visual explorer notes',
    modifiedTs: 20,
  }),
];

describe('searchWorkspaceDocuments', () => {
  test('searches page and folder entities for omnibar intent', () => {
    const results = searchWorkspaceDocuments(documents, 'arch', { intent: 'omnibar' });

    // The `architecture` folder and the `architecture/overview` page both match
    // `arch` at the same startsWith tier (600); within that tier the more
    // recently edited page leads (normalized recency outweighs the folder's
    // higher body score). The omnibar still surfaces both the page and folder.
    expect(results.map((result) => result.document.path)).toEqual([
      'architecture/overview',
      'architecture',
    ]);
  });

  test('autocomplete intent searches pages only', () => {
    const results = searchWorkspaceDocuments(documents, 'arch', { intent: 'autocomplete' });

    expect(results.map((result) => result.document.path)).toEqual(['architecture/overview']);
  });

  test('full_text intent can return content-only matches', () => {
    const results = searchWorkspaceDocuments(documents, 'crdt', { intent: 'full_text' });

    expect(results[0]?.document.path).toBe('architecture/overview');
    expect(results[0]?.signals.fullText).toBeGreaterThan(0);
  });

  test('recency breaks otherwise comparable autocomplete matches', () => {
    const localDocuments = [
      createWorkspaceSearchDocument({
        kind: 'page',
        path: 'old/research',
        title: 'Research',
        modifiedTs: 1,
      }),
      createWorkspaceSearchDocument({
        kind: 'page',
        path: 'new/research',
        title: 'Research',
        modifiedTs: 100,
      }),
    ];

    const results = searchWorkspaceDocuments(localDocuments, 'research', {
      intent: 'autocomplete',
    });

    expect(results.map((result) => result.document.path)).toEqual(['new/research', 'old/research']);
  });
});

describe('file-kind documents', () => {
  const mixed = [
    createWorkspaceSearchDocument({
      kind: 'page',
      path: 'notes/data',
      title: 'Data Notes',
      content: 'analysis prose about spreadsheets',
      modifiedTs: 10,
    }),
    createWorkspaceSearchDocument({ kind: 'file', path: 'data.csv', modifiedTs: 20 }),
    createWorkspaceSearchDocument({
      kind: 'file',
      path: 'packages/server/src/file-watcher.ts',
      modifiedTs: 30,
    }),
  ];

  test('a file entry is findable by basename under the default omnibar scope', () => {
    const results = searchWorkspaceDocuments(mixed, 'data.csv', { intent: 'omnibar' });
    const hit = results.find((result) => result.document.path === 'data.csv');
    expect(hit).toBeDefined();
    expect(hit?.document.kind).toBe('file');
  });

  test('a file entry is findable by a partial path segment under the default omnibar scope', () => {
    const results = searchWorkspaceDocuments(mixed, 'file-watcher', { intent: 'omnibar' });
    expect(results.map((result) => result.document.path)).toContain(
      'packages/server/src/file-watcher.ts',
    );
  });

  test('the explicit file scope returns only file entries', () => {
    const results = searchWorkspaceDocuments(mixed, 'data', {
      intent: 'omnibar',
      scopes: ['file'],
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.document.kind === 'file')).toBe(true);
    expect(results.map((result) => result.document.path)).toContain('data.csv');
  });

  test('file entries carry no content and never match on body text', () => {
    const fileDoc = mixed.find((document) => document.kind === 'file');
    expect(fileDoc?.content).toBe('');

    // The query term lives only in the markdown page body — a name-only file
    // entry must not match it.
    const results = searchWorkspaceDocuments(mixed, 'analysis', { intent: 'full_text' });
    expect(results.map((result) => result.document.path)).toContain('notes/data');
    expect(results.map((result) => result.document.path)).not.toContain('data.csv');
  });

  // invariant: `autocomplete` backs the `[[wikilink]]` target picker,
  // whose resolution model is markdown-scoped. Even when the corpus mixes
  // markdown pages with name-only `kind:'file'` documents, the autocomplete
  // intent must NEVER return a file entry — a regression that leaked files into
  // the wikilink picker would silently break link resolution.
  test('autocomplete excludes kind:file rows even when the corpus contains them', () => {
    const corpus = [
      createWorkspaceSearchDocument({
        kind: 'page',
        path: 'notes/data',
        title: 'Data Notes',
        modifiedTs: 10,
      }),
      createWorkspaceSearchDocument({ kind: 'file', path: 'data.csv', modifiedTs: 20 }),
      createWorkspaceSearchDocument({
        kind: 'file',
        path: 'data.json',
        modifiedTs: 30,
      }),
    ];
    const results = searchWorkspaceDocuments(corpus, 'data', { intent: 'autocomplete' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.document.kind === 'page')).toBe(true);
    expect(results.map((result) => result.document.path)).not.toContain('data.csv');
    expect(results.map((result) => result.document.path)).not.toContain('data.json');
  });
});

describe('hidden / dot-path ranking — searchable but rank-deprioritized', () => {
  // Same stem, same title, same recency — the ONLY difference is that one path is
  // hidden (a leading-dot segment). Ranking must treat them identically except
  // for the hidden-path penalty, so this isolates the penalty's effect.
  const visible = createWorkspaceSearchDocument({
    kind: 'page',
    path: 'notes/release',
    title: 'Release',
    modifiedTs: 50,
  });
  const hidden = createWorkspaceSearchDocument({
    kind: 'page',
    path: '.changeset/release',
    title: 'Release',
    modifiedTs: 50,
  });

  test('a hidden dot-path document is still returned by search', () => {
    const results = searchWorkspaceDocuments([hidden], 'release', { intent: 'omnibar' });
    expect(results.map((result) => result.document.path)).toContain('.changeset/release');
  });

  test('a hidden dot-path hit carries half the lexical bracket of an equivalent visible hit', () => {
    const results = searchWorkspaceDocuments([visible, hidden], 'release', { intent: 'omnibar' });
    const v = results.find((result) => result.document.path === 'notes/release');
    const h = results.find((result) => result.document.path === '.changeset/release');
    expect(v?.signals.lexical).toBeGreaterThan(0);
    // Exact-stem collision: both earn the same raw bracket (title === query); the
    // hidden doc's is halved, so its lexical signal is exactly 0.5x the visible's.
    expect(h?.signals.lexical).toBe((v?.signals.lexical ?? 0) * 0.5);
  });

  test('the visible twin outranks the hidden one on an exact-stem collision', () => {
    const results = searchWorkspaceDocuments([visible, hidden], 'release', { intent: 'omnibar' });
    const visibleRank = results.findIndex((result) => result.document.path === 'notes/release');
    const hiddenRank = results.findIndex((result) => result.document.path === '.changeset/release');
    expect(visibleRank).toBeGreaterThanOrEqual(0);
    expect(hiddenRank).toBeGreaterThanOrEqual(0);
    expect(visibleRank).toBeLessThan(hiddenRank);
  });

  // Non-dotted agent config (`HIDDEN_CONFIG_BASENAMES`, e.g. `opencode.json`)
  // takes the same hidden penalty as a dot-path. Covers the basename branch of
  // `isHiddenDocName`, which the dot-path twin above does not exercise — a
  // refactor dropping that branch would leave the dot-path tests green while
  // `opencode.json` surfaced at full rank.
  const visibleConfigTwin = createWorkspaceSearchDocument({
    kind: 'page',
    path: 'notes/opencode',
    title: 'opencode',
    modifiedTs: 50,
  });
  const hiddenConfig = createWorkspaceSearchDocument({
    kind: 'page',
    path: 'opencode.json',
    title: 'opencode',
    modifiedTs: 50,
  });

  test('a non-dotted HIDDEN_CONFIG_BASENAMES path carries half the lexical bracket of its visible twin', () => {
    const results = searchWorkspaceDocuments([visibleConfigTwin, hiddenConfig], 'opencode', {
      intent: 'omnibar',
    });
    const v = results.find((result) => result.document.path === 'notes/opencode');
    const h = results.find((result) => result.document.path === 'opencode.json');
    expect(v?.signals.lexical).toBeGreaterThan(0);
    // Same matchable content (title `opencode` + one `opencode` path segment on
    // each side), so the raw brackets are equal; the hidden basename halves it.
    expect(h?.signals.lexical).toBe((v?.signals.lexical ?? 0) * 0.5);
  });
});

describe('canonical-kind ranking — markdown outranks a same-stem file (D5)', () => {
  test('a markdown page ranks above a same-stem non-markdown file', () => {
    // The realistic collision: foo.md is indexed extension-less (docName `foo`,
    // kind page), foo.ts keeps its extension (kind file). On the stem query the
    // page earns the exact-name bracket and the file the weaker startsWith
    // bracket, so the page leads.
    const docs = [
      createWorkspaceSearchDocument({ kind: 'page', path: 'foo', title: 'foo', modifiedTs: 10 }),
      createWorkspaceSearchDocument({ kind: 'file', path: 'foo.ts', modifiedTs: 10 }),
    ];
    const ranked = searchWorkspaceDocuments(docs, 'foo', { intent: 'omnibar' });
    expect(ranked[0]?.document.path).toBe('foo');
  });

  test('a markdown page outranks a same-stem file at equal recency (kind is the within-tier tiebreaker)', () => {
    // Both earn the SAME exact-name bracket (700) on `config` and share recency,
    // so the canonical-kind term decides and the markdown page leads its
    // non-markdown sibling. The kind term is now a within-tier tiebreaker, not a
    // recency override — a much-newer file can legitimately rise above the page
    // within the tier; that softening from the old additive demotion is intended.
    const page = createWorkspaceSearchDocument({
      kind: 'page',
      path: 'config',
      title: 'config',
      modifiedTs: 10,
    });
    const file = createWorkspaceSearchDocument({
      kind: 'file',
      path: 'sub/config',
      modifiedTs: 10,
    });
    const ranked = searchWorkspaceDocuments([page, file], 'config', { intent: 'omnibar' });
    const pageRank = ranked.findIndex((r) => r.document.path === 'config');
    const fileRank = ranked.findIndex((r) => r.document.path === 'sub/config');
    expect(pageRank).toBeGreaterThanOrEqual(0);
    expect(fileRank).toBeGreaterThanOrEqual(0);
    expect(pageRank).toBeLessThan(fileRank);
  });
});

describe('alias / symlink handling — inode-dedup + alias paths searchable (D16)', () => {
  test('a file is findable by EITHER its canonical or an alias path segment, once', () => {
    // One corpus entry (the index is keyed by canonical docName → one per inode).
    const doc = createWorkspaceSearchDocument({
      kind: 'file',
      path: 'canonical/report.csv',
      aliases: ['linked/report.csv'],
      modifiedTs: 10,
    });
    const byCanonical = searchWorkspaceDocuments([doc], 'canonical', { intent: 'omnibar' });
    expect(byCanonical.map((r) => r.document.path)).toEqual(['canonical/report.csv']);
    const byAlias = searchWorkspaceDocuments([doc], 'linked', { intent: 'omnibar' });
    // Found via the folded alias segment, displayed as the canonical path, once.
    expect(byAlias.map((r) => r.document.path)).toEqual(['canonical/report.csv']);
  });

  test('no aliases → pathSegments is byte-identical to the canonical-only form', () => {
    expect(createWorkspaceSearchDocument({ kind: 'file', path: 'a/b/c.ts' }).pathSegments).toBe(
      'a b c.ts',
    );
    // Repeated segments in the canonical path are preserved verbatim (not deduped).
    expect(createWorkspaceSearchDocument({ kind: 'page', path: 'a/x/a' }).pathSegments).toBe(
      'a x a',
    );
  });
});
