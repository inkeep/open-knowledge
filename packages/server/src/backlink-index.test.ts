import { beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import {
  BacklinkIndex,
  type BrokenOutboundLink,
  computeBrokenOutboundLinks,
  type ExtractedWikiLink,
  extractMarkdownLinksFromMarkdown,
  extractWikiLinksFromMarkdown,
  resolveMarkdownHref,
} from './backlink-index.ts';
import { _resetDocExtensionsForTests } from './doc-extensions.ts';

// `docExtensionByName` is process-global module state in `doc-extensions.ts`,
// populated by the file watcher's initial scan. Boot order calls
// `BacklinkIndex.rebuildFromDisk()` BEFORE `startWatcher()`, so the registry
// is empty at the moment we want to pin. Earlier tests in this file (380+ lines) may have registered
// extensions for docNames the rebuild test re-uses — without an explicit
// reset, the OLD buggy `rebuildFromDisk` (which used `getDocExtension`)
// would have happily resolved via the leaked registry, and the RED test
// would pass without the fix. Reset between every test for RED-by-
// construction guarantees.
beforeEach(() => {
  _resetDocExtensionsForTests();
});

describe('extractWikiLinksFromMarkdown', () => {
  test('extracts wiki-link targets with context snippets', () => {
    expect(extractWikiLinksFromMarkdown('Alpha links to [[beta]] for deployment notes.\n')).toEqual<
      ExtractedWikiLink[]
    >([
      {
        target: 'beta',
        anchor: null,
        snippet: 'Alpha links to beta for deployment notes.',
      },
    ]);
  });

  test('ignores wiki-links inside fenced code blocks and inline code', () => {
    const markdown = [
      'See [[alpha]].',
      '',
      '```ts',
      'const example = "[[beta]]";',
      '```',
      '',
      'Inline `[[gamma]]` should not count.',
    ].join('\n');

    expect(extractWikiLinksFromMarkdown(markdown)).toEqual([
      {
        target: 'alpha',
        anchor: null,
        snippet: 'See alpha.',
      },
    ]);
  });

  test('tolerates colon ranges that remark-directive would claim', () => {
    const markdown = '**Current (slash-command.ts:108-115):**\n\nSee [[beta]].\n';

    expect(extractWikiLinksFromMarkdown(markdown)).toEqual([
      {
        target: 'beta',
        anchor: null,
        snippet: 'See beta.',
      },
    ]);
  });

  test('ignores wiki-links inside tilde fenced code blocks', () => {
    const markdown = [
      'See [[alpha]].',
      '',
      '~~~js',
      'const x = "[[beta]]";',
      '~~~',
      '',
      'And [[gamma]].',
    ].join('\n');

    expect(extractWikiLinksFromMarkdown(markdown)).toEqual([
      { target: 'alpha', anchor: null, snippet: 'See alpha.' },
      { target: 'gamma', anchor: null, snippet: 'And gamma.' },
    ]);
  });

  test('fence-length matching: longer closing fence ends a shorter opening fence', () => {
    // CommonMark: a closing fence must be at least as long as the opening fence.
    // A longer closing fence is valid. A shorter closing fence does NOT close the block.
    const markdown = [
      'Before [[alpha]].',
      '````ts',
      '[[inside]]',
      '```',
      '[[also-inside]]',
      '````',
      'After [[beta]].',
    ].join('\n');

    expect(extractWikiLinksFromMarkdown(markdown)).toEqual([
      { target: 'alpha', anchor: null, snippet: 'Before alpha.' },
      { target: 'beta', anchor: null, snippet: 'After beta.' },
    ]);
  });

  test('extracts multiple wiki-links from the same line', () => {
    const markdown = 'See [[alpha]] and [[beta]] for more.\n';

    expect(extractWikiLinksFromMarkdown(markdown)).toEqual([
      { target: 'alpha', anchor: null, snippet: 'See alpha and beta for more.' },
      { target: 'beta', anchor: null, snippet: 'See alpha and beta for more.' },
    ]);
  });

  test('handles anchor syntax [[page#heading]]', () => {
    const markdown = 'See [[guide#installation]] for setup.\n';

    expect(extractWikiLinksFromMarkdown(markdown)).toEqual([
      { target: 'guide', anchor: 'installation', snippet: 'See guide#installation for setup.' },
    ]);
  });

  test('handles alias syntax [[page|display text]]', () => {
    const markdown = 'See [[guide|the guide]] for setup.\n';

    expect(extractWikiLinksFromMarkdown(markdown)).toEqual([
      { target: 'guide', anchor: null, snippet: 'See the guide for setup.' },
    ]);
  });

  test('handles combined anchor and alias syntax [[page#section|display]]', () => {
    const markdown = 'See [[API#auth|Auth Docs]] for setup.\n';

    expect(extractWikiLinksFromMarkdown(markdown)).toEqual([
      { target: 'API', anchor: 'auth', snippet: 'See Auth Docs for setup.' },
    ]);
  });

  test('backslash-escaped opening bracket suppresses wiki-link', () => {
    // \[ escapes the first bracket; the second [ is a standalone char, so [[page]]
    // appears as literal text in the snippet and is not extracted as a link.
    const markdown = 'Not a link: \\[[page]] but [[real]] is.\n';

    expect(extractWikiLinksFromMarkdown(markdown)).toEqual([
      { target: 'real', anchor: null, snippet: 'Not a link: [[page]] but real is.' },
    ]);
  });

  test('inline code with multi-backtick delimiter: shorter run does not close span', () => {
    // CommonMark §6.1: closing backtick string must be exactly the same length.
    // `` `foo``bar` `` — the '``' inside does NOT close the single-backtick span.
    const markdown = 'See `foo``bar` and [[target]].\n';

    expect(extractWikiLinksFromMarkdown(markdown)).toEqual([
      { target: 'target', anchor: null, snippet: 'See foo``bar and target.' },
    ]);
  });

  test('long unclosed backtick run does not trigger quadratic scan', () => {
    // Pre-fix: each opening-position retry re-scanned the rest of the line,
    // giving O(N²) work on long unclosed runs. A 100k-char prefix in front
    // of the backticks ensures the line is not detected as a fenced-code
    // opener. Wall-time bound generously sized so CI variance can't flake;
    // the unfixed implementation took >5 s for 50k backticks on the dev box.
    const prefix = 'prefix ';
    const backticks = '`'.repeat(50_000);
    const markdown = `${prefix}${backticks}\n\nSee [[target]].\n`;

    const start = performance.now();
    const links = extractWikiLinksFromMarkdown(markdown);
    const elapsed = performance.now() - start;

    expect(links).toEqual([{ target: 'target', anchor: null, snippet: 'See target.' }]);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('BacklinkIndex', () => {
  test('deleteDocument removes outbound links and incoming backlinks', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-del-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocumentFromMarkdown('alpha', 'See [[beta]].\n');
      expect(index.getBacklinks('beta')).toEqual([
        { source: 'alpha', anchor: null, snippet: 'See beta.' },
      ]);
      index.deleteDocument('alpha');
      expect(index.getBacklinks('beta')).toEqual([]);
      expect(index.getForwardLinks('alpha')).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('normalizes skill file links to the content doc and template links to the artifact', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-artifact-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      // A doc links to a skill + a template by their on-disk file paths.
      index.updateDocumentFromMarkdown(
        'work-log',
        'Touched [the skill](.ok/skills/my-skill/SKILL.md) and [the tpl](notes/.ok/templates/daily.md).\n',
      );
      // Project skills are content docs: a link to `.ok/skills/<name>/SKILL.md`
      // resolves to the content doc, NOT the dead `__skill__/project/<name>`.
      // Templates are still managed artifacts.
      expect(index.getBacklinks('.ok/skills/my-skill/SKILL')).toEqual([
        expect.objectContaining({ source: 'work-log' }),
      ]);
      expect(index.getBacklinks('__template__/notes/daily')).toEqual([
        expect.objectContaining({ source: 'work-log' }),
      ]);
      // The phantom managed-artifact path is NOT a target for a project skill.
      expect(index.getBacklinks('__skill__/project/my-skill')).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('indexes a managed-artifact doc (skill) own outgoing links', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-skill-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      // A skill referencing a doc — previously skipped by the reserved-tree
      // guard; now indexed so the skill participates in the link graph.
      index.updateDocumentFromMarkdown('__skill__/project/my-skill', 'See [[architecture]].\n');
      expect(index.getForwardLinks('__skill__/project/my-skill')).toEqual(['architecture']);
      expect(index.getBacklinks('architecture')).toEqual([
        expect.objectContaining({ source: '__skill__/project/my-skill' }),
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('renameDocument moves edges from old doc name to new', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-rename-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocumentFromMarkdown('alpha', 'See [[beta]].\n');
      expect(index.getBacklinks('beta')).toEqual([
        { source: 'alpha', anchor: null, snippet: 'See beta.' },
      ]);
      index.renameDocument('alpha', 'gamma', '# Gamma\n\nSee [[beta]].\n');
      expect(index.getBacklinks('beta')).toEqual([
        { source: 'gamma', anchor: null, snippet: 'See beta.' },
      ]);
      expect(index.getForwardLinks('alpha')).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('switchBranch isolates graph state per branch', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-branch-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocumentFromMarkdown('alpha', '[[beta]]\n', 'main');
      expect(index.getBacklinks('beta', 'main')).toEqual([
        { source: 'alpha', anchor: null, snippet: 'beta' },
      ]);

      index.switchBranch('feature');
      expect(index.getBacklinks('beta')).toEqual([]);

      index.updateDocumentFromMarkdown('gamma', '[[beta]]\n', 'feature');
      expect(index.getBacklinks('beta', 'feature')).toEqual([
        { source: 'gamma', anchor: null, snippet: 'beta' },
      ]);

      index.switchBranch('main');
      expect(index.getBacklinks('beta')).toEqual([
        { source: 'alpha', anchor: null, snippet: 'beta' },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('updateDocument replaces forward links when content changes', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-update-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      const links1: ExtractedWikiLink[] = [{ target: 'beta', anchor: null, snippet: 'one' }];
      index.updateDocument('alpha', links1);
      expect(index.getBacklinks('beta')).toEqual([
        { source: 'alpha', anchor: null, snippet: 'one' },
      ]);

      const links2: ExtractedWikiLink[] = [{ target: 'gamma', anchor: null, snippet: 'two' }];
      index.updateDocument('alpha', links2);
      expect(index.getBacklinks('beta')).toEqual([]);
      expect(index.getBacklinks('gamma')).toEqual([
        { source: 'alpha', anchor: null, snippet: 'two' },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('getDeadLinks returns missing targets ordered by source count then target', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-dead-links-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      writeFileSync(
        join(contentDir, 'alpha.md'),
        '# Alpha\n\nSee [[missing-target]] and [missing markdown](./missing-markdown.md) plus [[existing]].\n',
        'utf-8',
      );
      writeFileSync(join(contentDir, 'beta.md'), '# Beta\n\nSee [[missing-target]].\n', 'utf-8');
      writeFileSync(join(contentDir, 'gamma.md'), '# Gamma\n\nSee [[other-missing]].\n', 'utf-8');
      writeFileSync(join(contentDir, 'existing.md'), '# Existing\n\nBody.\n', 'utf-8');

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();

      const deadLinks = index.getDeadLinks(['alpha', 'beta', 'gamma', 'existing']);
      expect(deadLinks.map((entry) => entry.target)).toEqual([
        'missing-target',
        'missing-markdown',
        'other-missing',
      ]);
      expect(deadLinks[0]?.sources.map((entry) => entry.source)).toEqual(['alpha', 'beta']);
      expect(deadLinks[1]?.sources.map((entry) => entry.source)).toEqual(['alpha']);
      expect(deadLinks[2]?.sources.map((entry) => entry.source)).toEqual(['gamma']);
      expect(
        deadLinks.every((entry) => entry.sources.every((source) => source.snippet !== null)),
      ).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('getDeadLinks returns an empty array when every target exists', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-dead-links-empty-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      writeFileSync(join(contentDir, 'alpha.md'), '# Alpha\n\nSee [[beta]].\n', 'utf-8');
      writeFileSync(join(contentDir, 'beta.md'), '# Beta\n\nReady.\n', 'utf-8');

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();

      expect(index.getDeadLinks(['alpha', 'beta'])).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('getDeadLinks does not flag a freshly-indexed target missing from the admitted set', () => {
    // An in-session write registers the new doc as a live
    // forward node (and its backlink edge) synchronously, but the file-watcher
    // hasn't yet added it to the admitted set. The graph must not call a node it
    // already holds a backlink for a dead link.
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-dead-links-fresh-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      // Source links to the new target.
      index.updateDocument('report', [
        { target: 'evidence/new-target', anchor: null, snippet: 'see new target' },
      ]);
      // The new target itself is indexed (its body parsed → a forward node),
      // exactly as `onStoreDocument` does on the in-session write.
      index.updateDocument('evidence/new-target', []);

      // Backlink edge is registered…
      expect(index.getBacklinkCount('evidence/new-target')).toBe(1);
      // …and the admitted set (file-watcher view) lags behind, listing only the
      // source. The new target must still NOT be reported dead.
      expect(index.getDeadLinks(['report'])).toEqual([]);

      // A genuinely-missing target (referenced, never indexed) is still dead.
      index.updateDocument('report', [
        { target: 'evidence/new-target', anchor: null, snippet: 'see new target' },
        { target: 'evidence/ghost', anchor: null, snippet: 'see ghost' },
      ]);
      expect(index.getDeadLinks(['report']).map((entry) => entry.target)).toEqual([
        'evidence/ghost',
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('getIndexedDocNames returns one entry per indexed doc and never a referenced-but-missing target', () => {
    // The additive existence oracle unions into `collectAdmittedDocNames`.
    // A doc whose body was indexed is a forward node (even with zero links); a
    // target only referenced (never indexed) lives in `state.backward` alone and
    // must NOT appear here — otherwise the union would report a ghost as existing.
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-indexed-names-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocument('report', [
        { target: 'evidence/new-target', anchor: null, snippet: 'see new target' },
        { target: 'evidence/ghost', anchor: null, snippet: 'see ghost' },
      ]);
      // `report` (has links) and `evidence/new-target` (zero links) are indexed;
      // `evidence/ghost` is only referenced.
      index.updateDocument('evidence/new-target', []);

      expect(new Set(index.getIndexedDocNames())).toEqual(
        new Set(['report', 'evidence/new-target']),
      );
      expect(index.getIndexedDocNames()).not.toContain('evidence/ghost');

      // After delete the forward node is gone, so the name drops out.
      index.deleteDocument('evidence/new-target');
      expect(index.getIndexedDocNames()).toEqual(['report']);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('getDeadLinks reports a target as dead again after deleteDocument removes its forward node', () => {
    // The inverse of the freshness guard: once `deleteDocument` drops the doc
    // from `state.forward`, the forward-check must stop suppressing the dead-link
    // report (otherwise a deleted doc would silently swallow a real dead link —
    // the very inversion of the bug being fixed).
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-dead-after-delete-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocument('report', [
        { target: 'evidence/new-target', anchor: null, snippet: 'see new target' },
      ]);
      index.updateDocument('evidence/new-target', []);
      expect(index.getDeadLinks(['report'])).toEqual([]);

      index.deleteDocument('evidence/new-target');
      expect(index.getDeadLinks(['report']).map((entry) => entry.target)).toEqual([
        'evidence/new-target',
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('rebuilds from disk and persists cache per branch', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-project-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    try {
      writeFileSync(join(contentDir, 'alpha.md'), '# Alpha\n\nSee [[beta]].\n', 'utf-8');
      writeFileSync(
        join(contentDir, 'beta.md'),
        '# Beta\n\nReferenced by [[alpha]] and [[alpha#details|Alpha details]].\n',
        'utf-8',
      );

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();

      expect(index.getBacklinks('beta')).toEqual([
        {
          source: 'alpha',
          anchor: null,
          snippet: 'See beta.',
        },
      ]);
      expect(index.getForwardLinks('beta')).toEqual(['alpha']);
      expect(index.getHubs()).toEqual([
        { docName: 'alpha', count: 1 },
        { docName: 'beta', count: 1 },
      ]);
      expect(index.getOrphans(['alpha', 'beta', 'gamma'])).toEqual(['gamma']);

      await index.saveToDisk();
      const cacheRaw = readFileSync(
        join(projectDir, '.ok', LOCAL_DIR, 'cache', 'main', 'backlinks.json'),
        'utf-8',
      );
      expect(cacheRaw).toContain('"beta"');

      const reloaded = new BacklinkIndex({ projectDir, contentDir });
      expect(await reloaded.loadFromDisk()).toBe(true);
      expect(reloaded.getBacklinks('beta')).toEqual([
        {
          source: 'alpha',
          anchor: null,
          snippet: 'See beta.',
        },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('rebuildFromDisk uses raw markdown scanning instead of the full parser', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-rebuild-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    try {
      writeFileSync(
        join(contentDir, 'alpha.md'),
        '**Current (slash-command.ts:108-115):**\n\nSee [[beta]].\n',
        'utf-8',
      );
      writeFileSync(join(contentDir, 'beta.md'), '# Beta\n', 'utf-8');

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();

      expect(index.getBacklinks('beta')).toEqual([
        {
          source: 'alpha',
          anchor: null,
          snippet: 'See beta.',
        },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  // Boot order: server-factory.ts calls `backlinkIndex.rebuildFromDisk()` BEFORE
  // `startWatcher()`, so the file-watcher's `docExtensionByName` registry is empty.
  // `getDocExtension` defaults to `.md` for unregistered docNames, which would
  // ENOENT every `.mdx` file. This test pins the cold-start behavior: rebuild
  // must walk paths directly and use the observed extension, not the registry.
  test('rebuildFromDisk indexes .mdx files at cold-start (empty extension registry)', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-rebuild-mdx-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    try {
      writeFileSync(join(contentDir, 'alpha.mdx'), '# Alpha\n\nSee [[beta]].\n', 'utf-8');
      writeFileSync(join(contentDir, 'beta.mdx'), '# Beta\n', 'utf-8');
      writeFileSync(join(contentDir, 'gamma.md'), '# Gamma\n\nSee [[beta]].\n', 'utf-8');

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();

      expect(index.getBacklinks('beta')).toEqual([
        { source: 'alpha', anchor: null, snippet: 'See beta.' },
        { source: 'gamma', anchor: null, snippet: 'See beta.' },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  // Pins the dedup filter in `rebuildFromDisk` (the `seen` Set that filters
  // `rawDocs`). When both `foo.md` and `foo.mdx` exist on disk,
  // `stripDocExtension` maps both to docName `"foo"`. Without dedup,
  // `rebuildFromDisk` would index the same docName twice, with the second
  // pass overwriting the first's links. The sibling `reconcileWithDisk` path
  // does the same first-wins dedup — this test pins the
  // matching contract for `rebuildFromDisk`.
  test('rebuildFromDisk first-wins dedup when both .md and .mdx exist for the same docName', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-dedup-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    try {
      // Two files map to docName "alpha" with different link targets.
      writeFileSync(join(contentDir, 'alpha.md'), '# Alpha\n\nSee [[beta]].\n', 'utf-8');
      writeFileSync(join(contentDir, 'alpha.mdx'), '# Alpha\n\nSee [[gamma]].\n', 'utf-8');
      writeFileSync(join(contentDir, 'beta.md'), '# Beta\n', 'utf-8');
      writeFileSync(join(contentDir, 'gamma.md'), '# Gamma\n', 'utf-8');

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();

      // Exactly one of the two `alpha` files is indexed (first walked wins).
      // Forward-link target set has length 1 — without the dedup filter, both
      // would be processed and the count would be 2 (or contain duplicates).
      const fwd = index.getForwardLinks('alpha');
      expect(fwd).toHaveLength(1);
      // The winning file links to either `beta` or `gamma` — both are valid
      // outcomes (walk order is filesystem-dependent), but exactly one wins.
      expect(['beta', 'gamma']).toContain(fwd[0]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('getOrphans supports incoming, outgoing, and both modes', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-orphan-modes-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocumentFromMarkdown('alpha', '[[beta]]');
      index.updateDocumentFromMarkdown('beta', '# Beta');
      index.updateDocumentFromMarkdown('gamma', '# Gamma');

      const allDocs = ['alpha', 'beta', 'gamma'];

      expect(index.getOrphans(allDocs, 'incoming')).toEqual(['alpha', 'gamma']);
      expect(index.getOrphans(allDocs, 'outgoing')).toEqual(['beta', 'gamma']);
      expect(index.getOrphans(allDocs, 'both')).toEqual(['gamma']);
      expect(index.getOrphans(allDocs)).toEqual(['gamma']);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('getLinkGraph returns sorted nodes and directed edges', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-linkgraph-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocumentFromMarkdown('alpha', '[[beta]] and [[gamma]]');
      index.updateDocumentFromMarkdown('beta', '[[gamma]]');

      const { nodes, links } = index.getLinkGraph();

      expect(nodes).toEqual([
        { kind: 'doc', id: 'alpha', docName: 'alpha', anchor: null },
        { kind: 'doc', id: 'beta', docName: 'beta', anchor: null },
        { kind: 'doc', id: 'gamma', docName: 'gamma', anchor: null },
      ]);
      expect(links).toContainEqual({ source: 'alpha', target: 'beta' });
      expect(links).toContainEqual({ source: 'alpha', target: 'gamma' });
      expect(links).toContainEqual({ source: 'beta', target: 'gamma' });
      expect(links).toHaveLength(3);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('getLinkGraphNeighborhood returns an undirected degree-limited neighborhood', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-linkgraph-neighborhood-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocumentFromMarkdown('alpha', '[[beta]]');
      index.updateDocumentFromMarkdown('beta', '[[gamma]] [[delta]]');
      index.updateDocumentFromMarkdown('gamma', '[[epsilon]]');
      index.updateDocumentFromMarkdown('delta', '');
      index.updateDocumentFromMarkdown('epsilon', '');

      const oneHop = index.getLinkGraphNeighborhood('beta', 1);
      expect(oneHop.nodes).toEqual([
        { kind: 'doc', id: 'alpha', docName: 'alpha', anchor: null },
        { kind: 'doc', id: 'beta', docName: 'beta', anchor: null },
        { kind: 'doc', id: 'delta', docName: 'delta', anchor: null },
        { kind: 'doc', id: 'gamma', docName: 'gamma', anchor: null },
      ]);
      expect(oneHop.links).toContainEqual({ source: 'alpha', target: 'beta' });
      expect(oneHop.links).toContainEqual({ source: 'beta', target: 'gamma' });
      expect(oneHop.links).toContainEqual({ source: 'beta', target: 'delta' });
      expect(oneHop.links).toHaveLength(3);

      const twoHop = index.getLinkGraphNeighborhood('beta', 2);
      expect(twoHop.nodes).toEqual([
        { kind: 'doc', id: 'alpha', docName: 'alpha', anchor: null },
        { kind: 'doc', id: 'beta', docName: 'beta', anchor: null },
        { kind: 'doc', id: 'delta', docName: 'delta', anchor: null },
        { kind: 'doc', id: 'epsilon', docName: 'epsilon', anchor: null },
        { kind: 'doc', id: 'gamma', docName: 'gamma', anchor: null },
      ]);
      expect(twoHop.links).toContainEqual({ source: 'gamma', target: 'epsilon' });
      expect(twoHop.links).toHaveLength(4);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('getLinkGraphNeighborhood includes external neighbors with labels', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-linkgraph-neighborhood-external-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocumentFromMarkdown('alpha', 'See [Docs](https://example.com/docs).');
      index.updateDocumentFromMarkdown('beta', '[[alpha]]');

      const neighborhood = index.getLinkGraphNeighborhood('alpha', 1);
      expect(neighborhood.nodes).toEqual([
        { kind: 'doc', id: 'alpha', docName: 'alpha', anchor: null },
        { kind: 'doc', id: 'beta', docName: 'beta', anchor: null },
        {
          kind: 'external',
          id: 'external:https://example.com/docs',
          url: 'https://example.com/docs',
          label: 'Docs',
        },
      ]);
      expect(neighborhood.links).toContainEqual({
        source: 'alpha',
        target: 'external:https://example.com/docs',
      });
      expect(neighborhood.links).toContainEqual({ source: 'beta', target: 'alpha' });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

// ── structural skill-bundle edges ──────────────────────────────────────────────

describe('BacklinkIndex structural skill-bundle edges', () => {
  const SKILL = '.ok/skills/demo/SKILL';
  const REF = '.ok/skills/demo/references/notes';

  test('connects a SKILL doc and its reference with NO authored link between them', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-skill-struct-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      // SKILL body mentions the reference only as a backticked path (not a link);
      // the reference body has no link back. Authored edges would be zero.
      index.updateDocumentFromMarkdown(SKILL, 'See `references/notes.md` for detail.\n');
      index.updateDocumentFromMarkdown(REF, '# Notes\n\nStandalone body, no links.\n');

      // Backlinks both directions via the structural edge.
      expect(index.getBacklinks(REF)).toEqual([{ source: SKILL, anchor: null, snippet: null }]);
      expect(index.getBacklinks(SKILL)).toEqual([{ source: REF, anchor: null, snippet: null }]);
      // Forward links surface the undirected partner both ways.
      expect(index.getForwardLinks(SKILL)).toEqual([REF]);
      expect(index.getForwardLinks(REF)).toEqual([SKILL]);
      expect(index.getBacklinkCount(REF)).toBe(1);

      // Graph neighborhood connects them.
      const neighborhood = index.getLinkGraphNeighborhood(SKILL, 1);
      expect(new Set(neighborhood.nodes.map((n) => n.id))).toEqual(new Set([REF, SKILL]));
      expect(neighborhood.links).toContainEqual({ source: SKILL, target: REF });
      expect(neighborhood.links).toHaveLength(1);

      // Reference is NOT orphaned despite having no authored links.
      expect(index.getOrphans([SKILL, REF])).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('a wiki-link reference still works (no regression, no duplicate edge)', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-skill-wiki-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      // Bundle-relative wiki-link resolves to the ref doc (authored edge) AND
      // the structural edge points at the same ref — must not double-count.
      index.updateDocumentFromMarkdown(SKILL, 'See [[references/notes]].\n');
      index.updateDocumentFromMarkdown(REF, '# Notes\n');

      expect(index.getForwardLinks(SKILL)).toEqual([REF]);
      const backlinks = index.getBacklinks(REF);
      expect(backlinks).toHaveLength(1);
      expect(backlinks[0]?.source).toBe(SKILL);
      // The authored wiki-link's snippet wins over the structural null.
      expect(backlinks[0]?.snippet).toBe('See references/notes.');

      const neighborhood = index.getLinkGraphNeighborhood(SKILL, 1);
      expect(neighborhood.links).toEqual([{ source: SKILL, target: REF }]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('NON-skill docs sharing a normal folder are NOT auto-connected (scope control)', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-nonskill-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      // Two ordinary docs in the same folder, plus a doc that imitates the
      // references shape but is NOT under `.ok/skills/<name>/`.
      index.updateDocumentFromMarkdown('notes/alpha', '# Alpha\n');
      index.updateDocumentFromMarkdown('notes/beta', '# Beta\n');
      index.updateDocumentFromMarkdown('notes/references/x', '# X\n');

      expect(index.getBacklinks('notes/beta')).toEqual([]);
      expect(index.getForwardLinks('notes/alpha')).toEqual([]);
      expect(index.getBacklinks('notes/references/x')).toEqual([]);
      // All three are orphans — co-membership in a normal folder draws no edge.
      expect(index.getOrphans(['notes/alpha', 'notes/beta', 'notes/references/x'])).toEqual([
        'notes/alpha',
        'notes/beta',
        'notes/references/x',
      ]);
      const neighborhood = index.getLinkGraphNeighborhood('notes/alpha', 2);
      expect(neighborhood.links).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('scripts/** and cross-skill refs do not draw structural edges', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-skill-scope2-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocumentFromMarkdown(SKILL, '# Demo\n');
      // A script bundle file is not a content graph node — no structural edge.
      index.updateDocumentFromMarkdown('.ok/skills/demo/scripts/run', '# run\n');
      // A reference under a DIFFERENT skill must not connect to demo's SKILL.
      index.updateDocumentFromMarkdown('.ok/skills/other/references/notes', '# other\n');

      expect(index.getForwardLinks(SKILL)).toEqual([]);
      expect(index.getBacklinks(SKILL)).toEqual([]);
      expect(index.getBacklinks('.ok/skills/other/references/notes')).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('deleting a reference removes the structural edge', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-skill-del-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocumentFromMarkdown(SKILL, '# Demo\n');
      index.updateDocumentFromMarkdown(REF, '# Notes\n');
      expect(index.getForwardLinks(SKILL)).toEqual([REF]);

      index.deleteDocument(REF);
      // The reference is no longer an indexed node, so the SKILL has no partner.
      expect(index.getForwardLinks(SKILL)).toEqual([]);
      expect(index.getBacklinks(SKILL)).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('renaming a reference moves the structural edge to the new name', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-skill-ren-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const REF2 = '.ok/skills/demo/references/renamed';
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocumentFromMarkdown(SKILL, '# Demo\n');
      index.updateDocumentFromMarkdown(REF, '# Notes\n');
      expect(index.getForwardLinks(SKILL)).toEqual([REF]);

      index.renameDocument(REF, REF2, '# Notes\n');
      expect(index.getForwardLinks(SKILL)).toEqual([REF2]);
      expect(index.getBacklinks(REF2)).toEqual([{ source: SKILL, anchor: null, snippet: null }]);
      expect(index.getBacklinks(REF)).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

// ── GLOBAL structural skill-bundle edges ────────────────────────────────────────

describe('BacklinkIndex GLOBAL structural skill-bundle edges', () => {
  // Global skills live at `<home>/.ok/skills/<name>/`, OUTSIDE contentDir; their
  // bundle docs keep the managed-artifact namespace.
  const G_SKILL = '__skill__/global/demo';
  const G_REF = '__skill__/global/demo/references/notes';

  function makeIndex(): { index: BacklinkIndex; projectDir: string } {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-gskill-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    return { index: new BacklinkIndex({ projectDir, contentDir }), projectDir };
  }

  test('connects a global SKILL doc and its reference via the structural edge', () => {
    const { index, projectDir } = makeIndex();
    try {
      index.registerGlobalSkillBundleNode(G_SKILL);
      index.registerGlobalSkillBundleNode(G_REF);

      expect(index.getBacklinks(G_REF)).toEqual([{ source: G_SKILL, anchor: null, snippet: null }]);
      expect(index.getBacklinks(G_SKILL)).toEqual([{ source: G_REF, anchor: null, snippet: null }]);
      expect(index.getForwardLinks(G_SKILL)).toEqual([G_REF]);
      expect(index.getForwardLinks(G_REF)).toEqual([G_SKILL]);
      expect(index.getBacklinkCount(G_REF)).toBe(1);

      const { nodes, links } = index.getLinkGraph();
      expect(new Set(nodes.map((n) => n.id))).toEqual(new Set([G_SKILL, G_REF]));
      expect(links).toContainEqual({ source: G_SKILL, target: G_REF });
      expect(links).toHaveLength(1);

      const neighborhood = index.getLinkGraphNeighborhood(G_SKILL, 1);
      expect(neighborhood.links).toContainEqual({ source: G_SKILL, target: G_REF });
      expect(index.getOrphans([G_SKILL, G_REF])).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('NEGATIVE CONTROL: a global reference body NEVER links into the project KB', () => {
    const { index, projectDir } = makeIndex();
    try {
      // A real project doc the global reference body "links" to.
      index.updateDocumentFromMarkdown('architecture', '# Architecture\n');
      index.registerGlobalSkillBundleNode(G_SKILL);
      // The reference flows through the body-parsing entry point — the within-
      // bundle guard must drop its authored `[[architecture]]` edge entirely.
      index.updateDocumentFromMarkdown(G_REF, 'See [[architecture]] and [[notes2]].\n');

      // No cross-boundary edge: the project doc gains no backlink from the global
      // reference, and the global reference forwards ONLY to its own SKILL.
      expect(index.getBacklinks('architecture')).toEqual([]);
      expect(index.getForwardLinks(G_REF)).toEqual([G_SKILL]);
      // The phantom KB-wide `notes2` target was never created.
      expect(index.getBacklinks('notes2')).toEqual([]);
      // And the SKILL likewise stays within its own bundle.
      index.updateDocumentFromMarkdown(G_SKILL, 'Body links [[architecture]].\n');
      expect(index.getForwardLinks(G_SKILL)).toEqual([G_REF]);
      expect(index.getBacklinks('architecture')).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('deleting / renaming a global reference moves the structural edge', () => {
    const { index, projectDir } = makeIndex();
    const G_REF2 = '__skill__/global/demo/references/renamed';
    try {
      index.registerGlobalSkillBundleNode(G_SKILL);
      index.registerGlobalSkillBundleNode(G_REF);
      expect(index.getForwardLinks(G_SKILL)).toEqual([G_REF]);

      index.renameDocument(G_REF, G_REF2, '# Notes\n');
      // renameDocument body-parses the new name, but the within-bundle guard keeps
      // it node-only, so only the structural edge moves.
      expect(index.getForwardLinks(G_SKILL)).toEqual([G_REF2]);
      expect(index.getBacklinks(G_REF)).toEqual([]);

      index.deleteDocument(G_REF2);
      expect(index.getForwardLinks(G_SKILL)).toEqual([]);
      expect(index.getBacklinks(G_SKILL)).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('global and project bundles of the same name never cross-connect', () => {
    const { index, projectDir } = makeIndex();
    try {
      index.updateDocumentFromMarkdown('.ok/skills/demo/SKILL', '# Project demo\n');
      index.updateDocumentFromMarkdown('.ok/skills/demo/references/notes', '# Project notes\n');
      index.registerGlobalSkillBundleNode(G_SKILL);
      index.registerGlobalSkillBundleNode(G_REF);

      // Each SKILL connects ONLY to its own-scope reference.
      expect(index.getForwardLinks('.ok/skills/demo/SKILL')).toEqual([
        '.ok/skills/demo/references/notes',
      ]);
      expect(index.getForwardLinks(G_SKILL)).toEqual([G_REF]);
      // The global reference never reports the project SKILL as a partner.
      expect(index.getBacklinks(G_REF)).toEqual([{ source: G_SKILL, anchor: null, snippet: null }]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('ingestGlobalSkillBundles registers SKILL + references from disk (idempotent)', async () => {
    const { index, projectDir } = makeIndex();
    const homeSkills = join(projectDir, 'home', '.ok', 'skills');
    const demoDir = join(homeSkills, 'demo');
    mkdirSync(join(demoDir, 'references', 'sub'), { recursive: true });
    writeFileSync(join(demoDir, 'SKILL.md'), '---\nname: demo\n---\n# Demo\n');
    writeFileSync(join(demoDir, 'references', 'notes.md'), '# Notes\n');
    writeFileSync(join(demoDir, 'references', 'sub', 'deep.md'), '# Deep\n');
    // scripts/** are never graph nodes.
    mkdirSync(join(demoDir, 'scripts'), { recursive: true });
    writeFileSync(join(demoDir, 'scripts', 'run.sh'), '#!/bin/sh\n');
    try {
      await index.ingestGlobalSkillBundles([homeSkills]);

      const G_REF_DEEP = '__skill__/global/demo/references/sub/deep';
      expect(new Set(index.getForwardLinks(G_SKILL))).toEqual(new Set([G_REF, G_REF_DEEP]));
      expect(index.getBacklinks(G_REF)).toEqual([{ source: G_SKILL, anchor: null, snippet: null }]);
      // The script produced no node.
      expect(index.getBacklinks('__skill__/global/demo/scripts/run')).toEqual([]);

      // Idempotent: re-running yields the same graph.
      await index.ingestGlobalSkillBundles([homeSkills]);
      expect(new Set(index.getForwardLinks(G_SKILL))).toEqual(new Set([G_REF, G_REF_DEEP]));

      // Pruning: a deleted reference disappears on the next ingest.
      rmSync(join(demoDir, 'references', 'notes.md'));
      await index.ingestGlobalSkillBundles([homeSkills]);
      expect(index.getForwardLinks(G_SKILL)).toEqual([G_REF_DEEP]);
      expect(index.getBacklinks(G_REF)).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('global nodes survive a content rebuild/reconcile (re-ingest restores them)', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-gskill-rebuild-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const homeSkills = join(projectDir, 'home', '.ok', 'skills');
    const demoDir = join(homeSkills, 'demo');
    mkdirSync(join(demoDir, 'references'), { recursive: true });
    writeFileSync(join(demoDir, 'SKILL.md'), '# Demo\n');
    writeFileSync(join(demoDir, 'references', 'notes.md'), '# Notes\n');
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.registerGlobalSkillBundleNode(G_SKILL);
      index.registerGlobalSkillBundleNode(G_REF);
      expect(index.getForwardLinks(G_SKILL)).toEqual([G_REF]);

      // A full content rebuild replaces state and drops the out-of-contentDir
      // global nodes — they are restored by the paired re-ingest.
      await index.rebuildFromDisk();
      expect(index.getForwardLinks(G_SKILL)).toEqual([]);
      await index.ingestGlobalSkillBundles([homeSkills]);
      expect(index.getForwardLinks(G_SKILL)).toEqual([G_REF]);

      // reconcileWithDisk must NOT delete global nodes as "missing from content".
      await index.reconcileWithDisk();
      expect(index.getForwardLinks(G_SKILL)).toEqual([G_REF]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

// ── resolveMarkdownHref ────────────────────────────────────────────────────────

describe('resolveMarkdownHref', () => {
  test('resolves same-directory relative link', () => {
    expect(resolveMarkdownHref('./other', 'notes')).toBe('other');
    expect(resolveMarkdownHref('./other.md', 'notes')).toBe('other');
  });

  test('resolves same-directory link without leading dot', () => {
    expect(resolveMarkdownHref('sibling.md', 'notes')).toBe('sibling');
  });

  test('resolves into a subdirectory', () => {
    expect(resolveMarkdownHref('./sub/page.md', 'notes')).toBe('sub/page');
    expect(resolveMarkdownHref('sub/page', 'notes')).toBe('sub/page');
  });

  test('resolves parent-relative links', () => {
    expect(resolveMarkdownHref('../overview.md', 'folder/page')).toBe('overview');
    expect(resolveMarkdownHref('../sibling/other.md', 'folder/page')).toBe('sibling/other');
  });

  test('strips fragment and query before resolving', () => {
    expect(resolveMarkdownHref('./page.md#section', 'notes')).toBe('page');
    expect(resolveMarkdownHref('./page.md?q=1#frag', 'notes')).toBe('page');
  });

  test('returns null for external http/https links', () => {
    expect(resolveMarkdownHref('https://example.com', 'notes')).toBeNull();
    expect(resolveMarkdownHref('http://example.com/page', 'notes')).toBeNull();
  });

  test('returns null for mailto and other URI schemes', () => {
    expect(resolveMarkdownHref('mailto:foo@bar.com', 'notes')).toBeNull();
  });

  test('returns null for protocol-relative URLs', () => {
    expect(resolveMarkdownHref('//example.com/page', 'notes')).toBeNull();
  });

  test('resolves root-absolute paths from the content root', () => {
    expect(resolveMarkdownHref('/absolute/path.md', 'notes')).toBe('absolute/path');
  });

  test('returns null for anchor-only links', () => {
    expect(resolveMarkdownHref('#section', 'notes')).toBeNull();
  });

  test('returns null when escaping content root', () => {
    expect(resolveMarkdownHref('../../escape.md', 'folder/page')).toBeNull();
    expect(resolveMarkdownHref('../../../way-out.md', 'deep/a/b')).toBeNull();
  });
});

// ── extractMarkdownLinksFromMarkdown ──────────────────────────────────────────

describe('extractMarkdownLinksFromMarkdown', () => {
  test('extracts relative inline markdown links', () => {
    const md = 'See [related](./other.md) for details.';
    expect(extractMarkdownLinksFromMarkdown(md, 'notes')).toEqual<ExtractedWikiLink[]>([
      { target: 'other', anchor: null, snippet: 'See related for details.' },
    ]);
  });

  test('extracts root-absolute markdown links from the content root', () => {
    const md = 'See [the guide](/docs/guide.md) for details.';
    expect(extractMarkdownLinksFromMarkdown(md, 'notes')).toEqual<ExtractedWikiLink[]>([
      { target: 'docs/guide', anchor: null, snippet: 'See the guide for details.' },
    ]);
  });

  test('extracts multiple markdown links from the same line', () => {
    const md = 'See [page A](./a.md) and [page B](./b.md) for more.';
    expect(extractMarkdownLinksFromMarkdown(md, 'notes')).toEqual<ExtractedWikiLink[]>([
      { target: 'a', anchor: null, snippet: 'See page A and page B for more.' },
      { target: 'b', anchor: null, snippet: 'See page A and page B for more.' },
    ]);
  });

  test('resolves links relative to the source doc directory', () => {
    const md = 'See [overview](../overview.md).';
    expect(extractMarkdownLinksFromMarkdown(md, 'folder/page')).toEqual([
      { target: 'overview', anchor: null, snippet: 'See overview.' },
    ]);
  });

  test('extracts internal links with optional titles', () => {
    const md = 'See [overview](./overview.md "Project overview") for details.';
    expect(extractMarkdownLinksFromMarkdown(md, 'notes')).toEqual([
      { target: 'overview', anchor: null, snippet: 'See overview for details.' },
    ]);
  });

  test('extracts markdown link anchors', () => {
    const md = 'See [install](./guide.md#install) for details.';
    expect(extractMarkdownLinksFromMarkdown(md, 'notes')).toEqual([
      { target: 'guide', anchor: 'install', snippet: 'See install for details.' },
    ]);
  });

  test('ignores external links', () => {
    const md = 'Visit [example](https://example.com) and [local](./local.md).';
    expect(extractMarkdownLinksFromMarkdown(md, 'notes')).toEqual([
      { target: 'local', anchor: null, snippet: 'Visit example and local.' },
    ]);
  });

  test('ignores image syntax while still extracting sibling links', () => {
    const md = 'See ![diagram](./assets/diagram.png) and [docs](./docs.md).';
    expect(extractMarkdownLinksFromMarkdown(md, 'notes')).toEqual([
      { target: 'docs', anchor: null, snippet: expect.any(String) as string },
    ]);
  });

  test('ignores links inside fenced code blocks', () => {
    const md = ['See [page](./page.md).', '', '```', '[ignore](./ignore.md)', '```'].join('\n');
    expect(extractMarkdownLinksFromMarkdown(md, 'notes')).toEqual([
      { target: 'page', anchor: null, snippet: 'See page.' },
    ]);
  });

  test('ignores links inside inline code spans', () => {
    const md = 'Use `[skip](./skip.md)` then [real](./real.md).';
    expect(extractMarkdownLinksFromMarkdown(md, 'notes')).toEqual([
      { target: 'real', anchor: null, snippet: expect.any(String) as string },
    ]);
  });

  test('does not double-count wiki-links that precede markdown links', () => {
    // [[wiki]] and [md](./other.md) in same line — wiki link is processed first
    const md = '[[wiki]] links to [markdown](./other.md).';
    const mdLinks = extractMarkdownLinksFromMarkdown(md, 'notes');
    expect(mdLinks.map((l) => l.target)).toEqual(['other']);
  });

  test('returns empty array when no internal links present', () => {
    expect(extractMarkdownLinksFromMarkdown('Just text.', 'notes')).toEqual([]);
    expect(extractMarkdownLinksFromMarkdown('[ext](https://example.com)', 'notes')).toEqual([]);
  });
});

// ── BacklinkIndex: markdown link integration ───────────────────────────────────

describe('BacklinkIndex with markdown links', () => {
  test('updateDocumentFromMarkdown indexes markdown links alongside wiki links', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'backlinks-md-'));
    try {
      const index = new BacklinkIndex({ projectDir: tmpDir, contentDir: tmpDir });
      const md = 'See [[wikiTarget]] and [mdTarget](./md-target.md).';
      index.updateDocumentFromMarkdown('source', md);
      expect(index.getForwardLinks('source')).toContain('wikiTarget');
      expect(index.getForwardLinks('source')).toContain('md-target');
      expect(index.getBacklinks('wikiTarget').map((b) => b.source)).toContain('source');
      expect(index.getBacklinks('md-target').map((b) => b.source)).toContain('source');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('rebuildFromDisk indexes markdown links', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'backlinks-rebuild-'));
    try {
      mkdirSync(join(tmpDir, 'docs'), { recursive: true });
      writeFileSync(
        join(tmpDir, 'source.md'),
        'Links to [target](./target.md) and [guide](/docs/guide.md).\n',
        'utf-8',
      );
      writeFileSync(join(tmpDir, 'target.md'), '# Target\n', 'utf-8');
      writeFileSync(join(tmpDir, 'docs', 'guide.md'), '# Guide\n', 'utf-8');
      const index = new BacklinkIndex({ projectDir: tmpDir, contentDir: tmpDir });
      await index.rebuildFromDisk();
      expect(index.getBacklinks('target').map((b) => b.source)).toContain('source');
      expect(index.getBacklinks('docs/guide').map((b) => b.source)).toContain('source');
      expect(index.getForwardLinks('source')).toContain('target');
      expect(index.getForwardLinks('source')).toContain('docs/guide');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('wiki link wins for same target when both syntaxes link to the same page', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'backlinks-dedup-'));
    try {
      const index = new BacklinkIndex({ projectDir: tmpDir, contentDir: tmpDir });
      // Both [[target]] and [text](./target.md) point to "target"
      const md = '[[target]] and [text](./target.md).';
      index.updateDocumentFromMarkdown('source', md);
      const backlinks = index.getBacklinks('target');
      // Only one backlink entry for "source" (no duplicate)
      expect(backlinks.filter((b) => b.source === 'source')).toHaveLength(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('indexes external markdown and wiki links for forward links and graph', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'backlinks-external-'));
    try {
      const index = new BacklinkIndex({ projectDir: tmpDir, contentDir: tmpDir });
      index.updateDocumentFromMarkdown(
        'source',
        'See [Docs](https://example.com/docs) and [[https://inkeep.com|Inkeep]].',
      );

      expect(index.getForwardLinkEntries('source')).toEqual([
        {
          kind: 'external',
          url: 'https://example.com/docs',
          label: 'Docs',
          snippet: 'See Docs and Inkeep.',
        },
        {
          kind: 'external',
          url: 'https://inkeep.com',
          label: 'Inkeep',
          snippet: '…com/docs) and Inkeep.',
        },
      ]);

      const graph = index.getLinkGraph();
      expect(graph.nodes).toContainEqual({
        kind: 'doc',
        id: 'source',
        docName: 'source',
        anchor: null,
      });
      expect(graph.nodes).toContainEqual({
        kind: 'external',
        id: 'external:https://example.com/docs',
        url: 'https://example.com/docs',
        label: 'Docs',
      });
      expect(graph.links).toContainEqual({
        source: 'source',
        target: 'external:https://example.com/docs',
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('reconcileWithDisk', () => {
  test('unchanged files are not re-parsed; mtime snapshot is preserved', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-reconcile-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      writeFileSync(join(contentDir, 'alpha.md'), 'Links to [[beta]].');
      writeFileSync(join(contentDir, 'beta.md'), 'No links here.');

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();
      await index.saveToDisk();

      // Load the cache into a fresh index and reconcile — no files changed.
      const reloaded = new BacklinkIndex({ projectDir, contentDir });
      expect(await reloaded.loadFromDisk()).toBe(true);
      const diff = await reloaded.reconcileWithDisk();
      expect(diff).toEqual({ added: 0, updated: 0, deleted: 0 });

      // Backlinks should still be intact after a no-op reconcile.
      expect(reloaded.getBacklinks('beta')).toEqual([
        { source: 'alpha', anchor: null, snippet: 'Links to beta.' },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('changed file is re-parsed on reconcile', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-reconcile-changed-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      writeFileSync(join(contentDir, 'alpha.md'), 'Links to [[beta]].');
      writeFileSync(join(contentDir, 'beta.md'), 'No links here.');

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();
      await index.saveToDisk();

      // Simulate an offline edit. reconcileWithDisk detects changes by exact
      // mtime comparison, so the rewrite must land at a distinct mtime. A fixed
      // sleep is racy: when filesystem mtime resolution is coarser than the
      // interval, cached and on-disk mtimes stay equal and reconcile skips the
      // file. Force a deterministically-later mtime instead.
      const alphaPath = join(contentDir, 'alpha.md');
      writeFileSync(alphaPath, 'Links to [[gamma]].');
      const bumped = new Date(statSync(alphaPath).mtimeMs + 2000);
      utimesSync(alphaPath, bumped, bumped);

      const reloaded = new BacklinkIndex({ projectDir, contentDir });
      expect(await reloaded.loadFromDisk()).toBe(true);
      const diff = await reloaded.reconcileWithDisk();
      expect(diff.updated).toBe(1);
      expect(diff.added).toBe(0);

      expect(reloaded.getBacklinks('gamma')).toEqual([
        { source: 'alpha', anchor: null, snippet: 'Links to gamma.' },
      ]);
      // Old link should be gone
      expect(reloaded.getBacklinks('beta')).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('new file is added and deleted file is removed on reconcile', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-reconcile-newdel-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      writeFileSync(join(contentDir, 'alpha.md'), 'Links to [[beta]].');
      writeFileSync(join(contentDir, 'beta.md'), 'No links here.');

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();
      await index.saveToDisk();

      // Offline: add a new file and delete beta
      writeFileSync(join(contentDir, 'gamma.md'), 'Links to [[alpha]].');
      rmSync(join(contentDir, 'beta.md'));

      const reloaded = new BacklinkIndex({ projectDir, contentDir });
      expect(await reloaded.loadFromDisk()).toBe(true);
      const diff = await reloaded.reconcileWithDisk();
      expect(diff.added).toBe(1);
      expect(diff.deleted).toBe(1);

      // gamma was indexed and links to alpha
      expect(reloaded.getBacklinks('alpha')).toEqual([
        { source: 'gamma', anchor: null, snippet: 'Links to alpha.' },
      ]);
      // beta's own forward-link entry was removed
      expect(reloaded.getForwardLinks('beta')).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('cold start (no cache) falls back to full rebuild', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-coldstart-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      writeFileSync(join(contentDir, 'alpha.md'), 'Links to [[beta]].');

      const index = new BacklinkIndex({ projectDir, contentDir });
      const cacheLoaded = await index.loadFromDisk();
      expect(cacheLoaded).toBe(false);
      await index.rebuildFromDisk();
      expect(index.getBacklinks('beta')).toEqual([
        { source: 'alpha', anchor: null, snippet: 'Links to beta.' },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

// ── computeBrokenOutboundLinks (write-time link validation) ───────────────

describe('computeBrokenOutboundLinks', () => {
  test('returns [] when every outbound link resolves (AC2.1)', () => {
    const md = 'See [sibling](./real.md) and [root](/docs/guide.md) and [[Existing]].';
    const admitted = new Set(['notes/real', 'docs/guide', 'Existing']);
    expect(computeBrokenOutboundLinks(md, 'notes/a', admitted)).toEqual([]);
  });

  test('flags the `./`-onto-content-root doubling footgun as no-such-doc (AC2.2)', () => {
    const md = 'See [tasks](./wiki/modules/tasks).';
    // Authored from inside `wiki/`, so `./wiki/...` doubles to `wiki/wiki/...`.
    expect(computeBrokenOutboundLinks(md, 'wiki/OVERVIEW', new Set())).toEqual<
      BrokenOutboundLink[]
    >([
      {
        href: './wiki/modules/tasks',
        resolvedTo: 'wiki/wiki/modules/tasks',
        reason: 'no-such-doc',
      },
    ]);
  });

  test('flags a root-escaping relative link as unresolvable (AC2.3)', () => {
    const md = 'Bad [escape](../escape.md).';
    expect(computeBrokenOutboundLinks(md, 'readme', new Set())).toEqual<BrokenOutboundLink[]>([
      { href: '../escape.md', resolvedTo: null, reason: 'unresolvable' },
    ]);
  });

  test('flags a relative path that pops past the content root as unresolvable', () => {
    const md = 'Deep [out](../../way-out.md).';
    expect(computeBrokenOutboundLinks(md, 'a/b', new Set())).toEqual<BrokenOutboundLink[]>([
      { href: '../../way-out.md', resolvedTo: null, reason: 'unresolvable' },
    ]);
  });

  test('an empty-href markdown construct `[x]()` is not a link (mirrors the indexer)', () => {
    // `MD_LINK_RE` requires a non-empty href, so `[x]()` is literal text, not a
    // link — and the dead-link graph never tracks it. brokenLinks stays
    // consistent with that model rather than inventing a link the rest of the
    // system doesn't see.
    expect(computeBrokenOutboundLinks('See [x]() here.', 'notes/a', new Set())).toEqual([]);
  });

  test('flags a broken wiki-link with the reconstructed [[…]] href (AC2.4)', () => {
    const md = 'Missing [[Ghost Page]] reference, and an [[Existing]] one.';
    const admitted = new Set(['Existing']);
    expect(computeBrokenOutboundLinks(md, 'notes/a', admitted)).toEqual<BrokenOutboundLink[]>([
      { href: '[[Ghost Page]]', resolvedTo: 'Ghost Page', reason: 'no-such-doc' },
    ]);
  });

  test('flags a broken `![[doc]]` embed (validated like the index does)', () => {
    const md = 'Embed: ![[missing-doc]] here.';
    expect(computeBrokenOutboundLinks(md, 'notes/a', new Set())).toEqual<BrokenOutboundLink[]>([
      { href: '[[missing-doc]]', resolvedTo: 'missing-doc', reason: 'no-such-doc' },
    ]);
  });

  test('resolves a path-qualified wiki-link (`[[folder/slug|Alias]]`) vault-root, not source-dir-relative', () => {
    // The entity-vault / GBrain dossier form. The `|Alias` and any `#anchor`
    // are stripped to the target `folder/slug`, which resolves against the
    // content root (NOT the source doc's dir) — so a dossier link from a
    // subfolder note resolves correctly. A markdown `[x](folder/slug.md)` from
    // the same note would resolve source-dir-relative instead.
    const md = 'Met [[people/alice-chen|Alice Chen]]; stub [[people/bob-jones|Bob]].';
    const admitted = new Set(['people/alice-chen']);
    expect(computeBrokenOutboundLinks(md, 'meetings/2026-01-01', admitted)).toEqual<
      BrokenOutboundLink[]
    >([{ href: '[[people/bob-jones]]', resolvedTo: 'people/bob-jones', reason: 'no-such-doc' }]);
  });

  test('skips external URLs, image embeds, and anchors; file links skipped when no oracle is passed', () => {
    const md = [
      'Web [site](https://example.com/missing).',
      'Mail [me](mailto:a@b.com).',
      'Asset [pdf](./missing.pdf) and ![alt](./missing.png).',
      'Image embed ![[missing.png]].',
      'Anchor [top](#section).',
    ].join('\n');
    // No `fileExists` oracle → the `[pdf](./missing.pdf)` file link is not
    // validated (callers without a filesystem stay pure). External URLs,
    // markdown images (`![…]`), wiki image embeds, and anchors are always
    // skipped regardless of the oracle.
    expect(computeBrokenOutboundLinks(md, 'notes/a', new Set())).toEqual([]);
  });

  test('does not scan links inside fenced or inline code', () => {
    const md = [
      'Inline `[x](./missing.md)` stays code.',
      '```',
      '[fenced](./also-missing.md)',
      '[[FencedWiki]]',
      '```',
    ].join('\n');
    expect(computeBrokenOutboundLinks(md, 'notes/a', new Set())).toEqual([]);
  });

  test('does not scan the frontmatter region', () => {
    const md = ['---', 'title: Has a [fake](./missing.md) in YAML', '---', 'Body only.'].join('\n');
    expect(computeBrokenOutboundLinks(md, 'notes/a', new Set())).toEqual([]);
  });

  test('dedupes repeated identical broken hrefs', () => {
    const md = 'First [a](./missing.md), again [b](./missing.md).';
    expect(computeBrokenOutboundLinks(md, 'notes/a', new Set())).toEqual<BrokenOutboundLink[]>([
      { href: './missing.md', resolvedTo: 'notes/missing', reason: 'no-such-doc' },
    ]);
  });

  test('treats a self-link to the admitted source doc as valid', () => {
    const md = 'See [self](./a.md).';
    // The write handler adds the just-written doc to the admitted set so a
    // valid self-link is never falsely flagged.
    expect(computeBrokenOutboundLinks(md, 'notes/a', new Set(['notes/a']))).toEqual([]);
  });

  // ── file links (assets + source files) validated against the fileExists oracle ──
  // These mirror the real-world codebase-wiki break: a `[code](../../../src/x.py)`
  // with one extra `../` overshoots the content root and 404s silently, invisible
  // to both the editor red-underline and the `.md`-only link graph.

  const fileOracle = (existing: string[]) => {
    const set = new Set(existing);
    return (p: string) => set.has(p);
  };

  test('a correct-depth source-file link that exists on disk is clean', () => {
    const md = 'Probe in [jacobian.py](../../microreservoir/entk/jacobian.py).';
    expect(
      computeBrokenOutboundLinks(
        md,
        'wiki/modules/entk',
        new Set(),
        fileOracle(['microreservoir/entk/jacobian.py']),
      ),
    ).toEqual([]);
  });

  test('an over-deep source-file link (one extra `../`) is unresolvable — the wiki bug', () => {
    const md = 'Probe in [jacobian.py](../../../microreservoir/entk/jacobian.py).';
    expect(
      computeBrokenOutboundLinks(
        md,
        'wiki/modules/entk',
        new Set(),
        // Even if the file exists at the CORRECT path, the over-deep href
        // escapes the content root, so it can never reach it.
        fileOracle(['microreservoir/entk/jacobian.py']),
      ),
    ).toEqual<BrokenOutboundLink[]>([
      {
        href: '../../../microreservoir/entk/jacobian.py',
        resolvedTo: null,
        reason: 'unresolvable',
      },
    ]);
  });

  test('an in-root file link to a missing file is no-such-file (resolvedTo = the path)', () => {
    const md = 'See [data](../data/missing.json).';
    expect(
      computeBrokenOutboundLinks(md, 'wiki/OVERVIEW', new Set(), fileOracle([]))[0],
    ).toEqual<BrokenOutboundLink>({
      href: '../data/missing.json',
      resolvedTo: 'data/missing.json',
      reason: 'no-such-file',
    });
  });

  test('a content-root-absolute file link resolves from the root', () => {
    const md = 'Config at [pkg](/package.json) and [gone](/nope.json).';
    expect(
      computeBrokenOutboundLinks(md, 'wiki/modules/cli', new Set(), fileOracle(['package.json'])),
    ).toEqual<BrokenOutboundLink[]>([
      { href: '/nope.json', resolvedTo: 'nope.json', reason: 'no-such-file' },
    ]);
  });

  test('external URLs and wiki image embeds are not file-validated even with an oracle', () => {
    const md = [
      'Web [pdf](https://example.com/x.pdf).',
      'Embed ![[diagram.png]].',
      'Image ![alt](./local.png).',
    ].join('\n');
    expect(computeBrokenOutboundLinks(md, 'notes/a', new Set(), fileOracle([]))).toEqual([]);
  });
});
