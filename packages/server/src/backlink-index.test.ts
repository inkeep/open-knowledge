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
    const markdown = 'Not a link: \\[[page]] but [[real]] is.\n';

    expect(extractWikiLinksFromMarkdown(markdown)).toEqual([
      { target: 'real', anchor: null, snippet: 'Not a link: [[page]] but real is.' },
    ]);
  });

  test('inline code with multi-backtick delimiter: shorter run does not close span', () => {
    const markdown = 'See `foo``bar` and [[target]].\n';

    expect(extractWikiLinksFromMarkdown(markdown)).toEqual([
      { target: 'target', anchor: null, snippet: 'See foo``bar and target.' },
    ]);
  });

  test('long unclosed backtick run does not trigger quadratic scan', () => {
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
      index.updateDocumentFromMarkdown(
        'work-log',
        'Touched [the skill](.ok/skills/my-skill/SKILL.md) and [the tpl](notes/.ok/templates/daily.md).\n',
      );
      expect(index.getBacklinks('.ok/skills/my-skill/SKILL')).toEqual([
        expect.objectContaining({ source: 'work-log' }),
      ]);
      expect(index.getBacklinks('__template__/notes/daily')).toEqual([
        expect.objectContaining({ source: 'work-log' }),
      ]);
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

  test('rebuildFromDisk first-wins dedup when both .md and .mdx exist for the same docName', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-dedup-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    try {
      writeFileSync(join(contentDir, 'alpha.md'), '# Alpha\n\nSee [[beta]].\n', 'utf-8');
      writeFileSync(join(contentDir, 'alpha.mdx'), '# Alpha\n\nSee [[gamma]].\n', 'utf-8');
      writeFileSync(join(contentDir, 'beta.md'), '# Beta\n', 'utf-8');
      writeFileSync(join(contentDir, 'gamma.md'), '# Gamma\n', 'utf-8');

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();

      const fwd = index.getForwardLinks('alpha');
      expect(fwd).toHaveLength(1);
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


describe('BacklinkIndex structural skill-bundle edges', () => {
  const SKILL = '.ok/skills/demo/SKILL';
  const REF = '.ok/skills/demo/references/notes';

  test('connects a SKILL doc and its reference with NO authored link between them', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-skill-struct-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocumentFromMarkdown(SKILL, 'See `references/notes.md` for detail.\n');
      index.updateDocumentFromMarkdown(REF, '# Notes\n\nStandalone body, no links.\n');

      expect(index.getBacklinks(REF)).toEqual([{ source: SKILL, anchor: null, snippet: null }]);
      expect(index.getBacklinks(SKILL)).toEqual([{ source: REF, anchor: null, snippet: null }]);
      expect(index.getForwardLinks(SKILL)).toEqual([REF]);
      expect(index.getForwardLinks(REF)).toEqual([SKILL]);
      expect(index.getBacklinkCount(REF)).toBe(1);

      const neighborhood = index.getLinkGraphNeighborhood(SKILL, 1);
      expect(new Set(neighborhood.nodes.map((n) => n.id))).toEqual(new Set([REF, SKILL]));
      expect(neighborhood.links).toContainEqual({ source: SKILL, target: REF });
      expect(neighborhood.links).toHaveLength(1);

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
      index.updateDocumentFromMarkdown(SKILL, 'See [[references/notes]].\n');
      index.updateDocumentFromMarkdown(REF, '# Notes\n');

      expect(index.getForwardLinks(SKILL)).toEqual([REF]);
      const backlinks = index.getBacklinks(REF);
      expect(backlinks).toHaveLength(1);
      expect(backlinks[0]?.source).toBe(SKILL);
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
      index.updateDocumentFromMarkdown('notes/alpha', '# Alpha\n');
      index.updateDocumentFromMarkdown('notes/beta', '# Beta\n');
      index.updateDocumentFromMarkdown('notes/references/x', '# X\n');

      expect(index.getBacklinks('notes/beta')).toEqual([]);
      expect(index.getForwardLinks('notes/alpha')).toEqual([]);
      expect(index.getBacklinks('notes/references/x')).toEqual([]);
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
      index.updateDocumentFromMarkdown('.ok/skills/demo/scripts/run', '# run\n');
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


describe('BacklinkIndex GLOBAL structural skill-bundle edges', () => {
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
      index.updateDocumentFromMarkdown('architecture', '# Architecture\n');
      index.registerGlobalSkillBundleNode(G_SKILL);
      index.updateDocumentFromMarkdown(G_REF, 'See [[architecture]] and [[notes2]].\n');

      expect(index.getBacklinks('architecture')).toEqual([]);
      expect(index.getForwardLinks(G_REF)).toEqual([G_SKILL]);
      expect(index.getBacklinks('notes2')).toEqual([]);
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

      expect(index.getForwardLinks('.ok/skills/demo/SKILL')).toEqual([
        '.ok/skills/demo/references/notes',
      ]);
      expect(index.getForwardLinks(G_SKILL)).toEqual([G_REF]);
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
    mkdirSync(join(demoDir, 'scripts'), { recursive: true });
    writeFileSync(join(demoDir, 'scripts', 'run.sh'), '#!/bin/sh\n');
    try {
      await index.ingestGlobalSkillBundles([homeSkills]);

      const G_REF_DEEP = '__skill__/global/demo/references/sub/deep';
      expect(new Set(index.getForwardLinks(G_SKILL))).toEqual(new Set([G_REF, G_REF_DEEP]));
      expect(index.getBacklinks(G_REF)).toEqual([{ source: G_SKILL, anchor: null, snippet: null }]);
      expect(index.getBacklinks('__skill__/global/demo/scripts/run')).toEqual([]);

      await index.ingestGlobalSkillBundles([homeSkills]);
      expect(new Set(index.getForwardLinks(G_SKILL))).toEqual(new Set([G_REF, G_REF_DEEP]));

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

      await index.rebuildFromDisk();
      expect(index.getForwardLinks(G_SKILL)).toEqual([]);
      await index.ingestGlobalSkillBundles([homeSkills]);
      expect(index.getForwardLinks(G_SKILL)).toEqual([G_REF]);

      await index.reconcileWithDisk();
      expect(index.getForwardLinks(G_SKILL)).toEqual([G_REF]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});


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
    const md = '[[wiki]] links to [markdown](./other.md).';
    const mdLinks = extractMarkdownLinksFromMarkdown(md, 'notes');
    expect(mdLinks.map((l) => l.target)).toEqual(['other']);
  });

  test('returns empty array when no internal links present', () => {
    expect(extractMarkdownLinksFromMarkdown('Just text.', 'notes')).toEqual([]);
    expect(extractMarkdownLinksFromMarkdown('[ext](https://example.com)', 'notes')).toEqual([]);
  });
});


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
      const md = '[[target]] and [text](./target.md).';
      index.updateDocumentFromMarkdown('source', md);
      const backlinks = index.getBacklinks('target');
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

      const reloaded = new BacklinkIndex({ projectDir, contentDir });
      expect(await reloaded.loadFromDisk()).toBe(true);
      const diff = await reloaded.reconcileWithDisk();
      expect(diff).toEqual({ added: 0, updated: 0, deleted: 0 });

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

      writeFileSync(join(contentDir, 'gamma.md'), 'Links to [[alpha]].');
      rmSync(join(contentDir, 'beta.md'));

      const reloaded = new BacklinkIndex({ projectDir, contentDir });
      expect(await reloaded.loadFromDisk()).toBe(true);
      const diff = await reloaded.reconcileWithDisk();
      expect(diff.added).toBe(1);
      expect(diff.deleted).toBe(1);

      expect(reloaded.getBacklinks('alpha')).toEqual([
        { source: 'gamma', anchor: null, snippet: 'Links to alpha.' },
      ]);
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


describe('computeBrokenOutboundLinks', () => {
  test('returns [] when every outbound link resolves (AC2.1)', () => {
    const md = 'See [sibling](./real.md) and [root](/docs/guide.md) and [[Existing]].';
    const admitted = new Set(['notes/real', 'docs/guide', 'Existing']);
    expect(computeBrokenOutboundLinks(md, 'notes/a', admitted)).toEqual([]);
  });

  test('flags the `./`-onto-content-root doubling footgun as no-such-doc (AC2.2)', () => {
    const md = 'See [tasks](./wiki/modules/tasks).';
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
    expect(computeBrokenOutboundLinks(md, 'notes/a', new Set(['notes/a']))).toEqual([]);
  });


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
