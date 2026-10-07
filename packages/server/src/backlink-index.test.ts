import {
  existsSync,
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
import {
  createTargetNamespace,
  encodeHrefPath,
  LOCAL_DIR,
  skillLiveDocName,
} from '@inkeep/open-knowledge-core';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  BacklinkIndex,
  type BrokenOutboundLink,
  computeBrokenOutboundLinks,
  type ExtractedWikiLink,
  extractJsxSrcRefsFromMarkdown,
  extractMarkdownLinksFromMarkdown,
  extractWikiLinksFromMarkdown,
  resolveMarkdownHref,
} from './backlink-index.ts';
import { _resetDocExtensionsForTests } from './doc-extensions.ts';
import { getLogger } from './logger.ts';

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
        line: 0,
        column: 15,
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
        line: 0,
        column: 4,
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
        line: 2,
        column: 4,
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
      { target: 'alpha', anchor: null, snippet: 'See alpha.', line: 0, column: 4 },
      { target: 'gamma', anchor: null, snippet: 'And gamma.', line: 6, column: 4 },
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
      { target: 'alpha', anchor: null, snippet: 'Before alpha.', line: 0, column: 7 },
      { target: 'beta', anchor: null, snippet: 'After beta.', line: 6, column: 6 },
    ]);
  });

  test('extracts multiple wiki-links from the same line', () => {
    const markdown = 'See [[alpha]] and [[beta]] for more.\n';

    expect(extractWikiLinksFromMarkdown(markdown)).toEqual([
      {
        target: 'alpha',
        anchor: null,
        snippet: 'See alpha and beta for more.',
        line: 0,
        column: 4,
      },
      {
        target: 'beta',
        anchor: null,
        snippet: 'See alpha and beta for more.',
        line: 0,
        column: 14,
      },
    ]);
  });

  test('handles anchor syntax [[page#heading]]', () => {
    const markdown = 'See [[guide#installation]] for setup.\n';

    expect(extractWikiLinksFromMarkdown(markdown)).toEqual([
      {
        target: 'guide',
        anchor: 'installation',
        snippet: 'See guide#installation for setup.',
        line: 0,
        column: 4,
      },
    ]);
  });

  test('handles alias syntax [[page|display text]]', () => {
    const markdown = 'See [[guide|the guide]] for setup.\n';

    expect(extractWikiLinksFromMarkdown(markdown)).toEqual([
      { target: 'guide', anchor: null, snippet: 'See the guide for setup.', line: 0, column: 4 },
    ]);
  });

  test('handles combined anchor and alias syntax [[page#section|display]]', () => {
    const markdown = 'See [[API#auth|Auth Docs]] for setup.\n';

    expect(extractWikiLinksFromMarkdown(markdown)).toEqual([
      { target: 'API', anchor: 'auth', snippet: 'See Auth Docs for setup.', line: 0, column: 4 },
    ]);
  });

  test('backslash-escaped opening bracket suppresses wiki-link', () => {
    const markdown = 'Not a link: \\[[page]] but [[real]] is.\n';

    expect(extractWikiLinksFromMarkdown(markdown)).toEqual([
      {
        target: 'real',
        anchor: null,
        snippet: 'Not a link: [[page]] but real is.',
        line: 0,
        column: 25,
      },
    ]);
  });

  test('inline code with multi-backtick delimiter: shorter run does not close span', () => {
    const markdown = 'See `foo``bar` and [[target]].\n';

    expect(extractWikiLinksFromMarkdown(markdown)).toEqual([
      {
        target: 'target',
        anchor: null,
        snippet: 'See foo``bar and target.',
        line: 0,
        column: 17,
      },
    ]);
  });

  test('long unclosed backtick run does not trigger quadratic scan', () => {
    const prefix = 'prefix ';
    const backticks = '`'.repeat(50_000);
    const markdown = `${prefix}${backticks}\n\nSee [[target]].\n`;

    const start = performance.now();
    const links = extractWikiLinksFromMarkdown(markdown);
    const elapsed = performance.now() - start;

    expect(links).toEqual([
      { target: 'target', anchor: null, snippet: 'See target.', line: 2, column: 4 },
    ]);
    expect(elapsed).toBeLessThan(1000);
  });

  test('offsets link lines by the caller-supplied lineOffset', () => {
    expect(extractWikiLinksFromMarkdown('See [[alpha]].', '', 3)).toEqual([
      { target: 'alpha', anchor: null, snippet: 'See alpha.', line: 3, column: 4 },
    ]);
  });
});

describe('BacklinkIndex', () => {
  test('indexes full, collapsed, and shortcut reference links across graph queries', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-reference-links-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocumentFromMarkdown(
        'source',
        [
          'See [full label][full-ref], [collapsed-ref][], and [shortcut-ref].',
          '',
          '[full-ref]: ./full-target.md',
          '[collapsed-ref]: ./collapsed-target.md',
          '[shortcut-ref]: ./shortcut-target.md',
        ].join('\n'),
      );

      const targets = ['collapsed-target', 'full-target', 'shortcut-target'];
      expect(index.getForwardLinks('source')).toEqual(targets);
      for (const target of targets) {
        expect(index.getBacklinks(target)).toEqual([expect.objectContaining({ source: 'source' })]);
      }
      expect(index.getDeadLinks(['source']).map((entry) => entry.target)).toEqual(targets);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

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

  test('skill and template file links resolve to their content docs, not synthetic names', () => {
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
      expect(index.getBacklinks('notes/.ok/templates/daily')).toEqual([
        expect.objectContaining({ source: 'work-log' }),
      ]);
      expect(index.getBacklinks('__skill__/project/my-skill')).toEqual([]);
      expect(index.getBacklinks('__template__/notes/daily')).toEqual([]);
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

  test('getDeadLinks never reports a link to an existing folder (PRD-7956)', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-dead-links-folder-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(join(contentDir, 'guides', 'deep'), { recursive: true });
    try {
      writeFileSync(
        join(contentDir, 'alpha.md'),
        '# Alpha\n\nSee [[guides]] and [markdown-form](./guides/deep) plus [[missing-folder]].\n',
        'utf-8',
      );
      writeFileSync(
        join(contentDir, 'guides', 'deep', 'guide-one.md'),
        '# Guide one\n\nBody.\n',
        'utf-8',
      );

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();

      const deadLinks = index.getDeadLinks(['alpha', 'guides/deep/guide-one']);
      expect(deadLinks.map((entry) => entry.target)).toEqual(['missing-folder']);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('getDeadLinks accepts a watcher folder inventory for folders with no doc descendants', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-dead-links-watcher-folder-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      writeFileSync(join(contentDir, 'alpha.md'), '# Alpha\n\nSee [[assets]].\n', 'utf-8');

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();

      expect(index.getDeadLinks(['alpha']).map((entry) => entry.target)).toEqual(['assets']);
      expect(index.getDeadLinks(['alpha'], undefined, undefined, ['assets'])).toEqual([]);
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
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-dead-links-fresh-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocument('report', [
        { target: 'evidence/new-target', anchor: null, snippet: 'see new target' },
      ]);
      index.updateDocument('evidence/new-target', []);

      expect(index.getBacklinkCount('evidence/new-target')).toBe(1);
      expect(index.getDeadLinks(['report'])).toEqual([]);

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

  test('a wikilink to a dotted-filename document is recorded and is not reported dead', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-dotted-doc-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(join(contentDir, 'notes'), { recursive: true });
    try {
      writeFileSync(join(contentDir, 'index.md'), '# Index\n\nSee [[acp.daemon]].\n', 'utf-8');
      writeFileSync(join(contentDir, 'notes', 'acp.daemon.md'), '# Daemon\n\nBody.\n', 'utf-8');

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();

      expect(index.getForwardLinks('index')).toContain('notes/acp.daemon');
      expect(index.getDeadLinks(['index', 'notes/acp.daemon'])).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('an undecided raw target stays undecided across a cache save/load', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-raw-roundtrip-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(join(contentDir, 'notes'), { recursive: true });
    try {
      writeFileSync(
        join(contentDir, 'index.md'),
        '# Index\n\nSee [[acp.daemon]] and ![[diagram.png]].\n',
        'utf-8',
      );
      writeFileSync(join(contentDir, 'notes', 'acp.daemon.md'), '# Daemon\n\nBody.\n', 'utf-8');

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();
      await index.saveToDisk();

      const reloaded = new BacklinkIndex({ projectDir, contentDir });
      expect(await reloaded.loadFromDisk()).toBe(true);
      expect(reloaded.getDeadLinks(['index', 'notes/acp.daemon'])).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('a bare wikilink the editor reaches by basename is not reported dead', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-bare-basename-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(join(contentDir, 'research'), { recursive: true });
    try {
      writeFileSync(join(contentDir, 'index.md'), '# Index\n\nSee [[analysis]].\n', 'utf-8');
      writeFileSync(join(contentDir, 'research', 'analysis.md'), '# A\n\nBody.\n', 'utf-8');

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();

      expect(index.getDeadLinks(['index', 'research/analysis'])).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('a bare wikilink naming no document is still reported dead', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-bare-missing-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(join(contentDir, 'research'), { recursive: true });
    try {
      writeFileSync(join(contentDir, 'index.md'), '# Index\n\nSee [[nowhere]].\n', 'utf-8');
      writeFileSync(join(contentDir, 'research', 'analysis.md'), '# A\n\nBody.\n', 'utf-8');

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();

      expect(index.getDeadLinks(['index', 'research/analysis']).map((e) => e.target)).toEqual([
        'nowhere',
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('the neighborhood view admits the same documents as the whole graph', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-neighborhood-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(join(contentDir, 'notes'), { recursive: true });
    try {
      writeFileSync(
        join(contentDir, 'index.md'),
        '# Index\n\n![[diagram.png]] and [[acp.daemon]].\n',
        'utf-8',
      );
      writeFileSync(join(contentDir, 'notes', 'acp.daemon.md'), '# Daemon\n\nBody.\n', 'utf-8');

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();

      const neighborhood = index.getLinkGraphNeighborhood('index', 2).nodes.map((n) => n.id);
      const whole = index.getLinkGraph().nodes.map((n) => n.id);

      expect(neighborhood).not.toContain('diagram.png');
      expect(whole).not.toContain('diagram.png');
      expect(neighborhood).toContain('notes/acp.daemon');
      expect(whole).toContain('notes/acp.daemon');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('a markdown href is not basename-resolved by the dead-link audit', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-md-exact-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(join(contentDir, 'research'), { recursive: true });
    try {
      writeFileSync(join(contentDir, 'index.md'), '# Index\n\n[A](./analysis.md)\n', 'utf-8');
      writeFileSync(join(contentDir, 'research', 'analysis.md'), '# A\n\nBody.\n', 'utf-8');

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();

      expect(index.getDeadLinks(['index', 'research/analysis']).map((e) => e.target)).toEqual([
        'analysis',
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('a wiki asset embed is neither reported dead nor minted as a graph node', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-asset-embed-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      writeFileSync(
        join(contentDir, 'notes.md'),
        '# Notes\n\n![[diagram.png]]\n\nSee [[report.pdf]].\n',
        'utf-8',
      );

      const index = new BacklinkIndex({ projectDir, contentDir });
      await index.rebuildFromDisk();

      expect(index.getDeadLinks(['notes'])).toEqual([]);

      const graph = index.getLinkGraph();
      expect(graph.nodes.map((node) => node.id)).toEqual(['notes']);
      expect(graph.links).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('a dotted target becomes a graph node once its document is indexed', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-dotted-late-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocument('index', [
        { target: 'acp.daemon', anchor: null, snippet: null, rawWikiTarget: true },
      ]);

      expect(index.getLinkGraph().nodes.map((node) => node.id)).toEqual(['index']);

      index.updateDocument('notes/acp.daemon', []);

      expect(index.getLinkGraph().nodes.map((node) => node.id)).toContain('notes/acp.daemon');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('getIndexedDocNames returns one entry per indexed doc and never a referenced-but-missing target', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-indexed-names-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocument('report', [
        { target: 'evidence/new-target', anchor: null, snippet: 'see new target' },
        { target: 'evidence/ghost', anchor: null, snippet: 'see ghost' },
      ]);
      index.updateDocument('evidence/new-target', []);

      expect(new Set(index.getIndexedDocNames())).toEqual(
        new Set(['report', 'evidence/new-target']),
      );
      expect(index.getIndexedDocNames()).not.toContain('evidence/ghost');

      index.deleteDocument('evidence/new-target');
      expect(index.getIndexedDocNames()).toEqual(['report']);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('getDeadLinks reports a target as dead again after deleteDocument removes its forward node', () => {
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

  test('getDeadLinks positions each broken link at its 0-based full-doc source line', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-dead-link-lines-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      const markdown = [
        '---',
        'title: Alpha',
        '---',
        '# Alpha',
        '',
        '```ts',
        'const decoy = "[[ghost-wiki]] and [gone](./ghost-md.md)";',
        '```',
        '',
        'See [[ghost-wiki]].',
        'And [also gone](./ghost-md.md).',
        '',
      ].join('\n');
      index.updateDocumentFromMarkdown('alpha', markdown);

      const deadLinks = index.getDeadLinks(['alpha']);
      expect(deadLinks.map((entry) => entry.target)).toEqual(['ghost-md', 'ghost-wiki']);

      const mdSource = deadLinks[0]?.sources[0];
      const wikiSource = deadLinks[1]?.sources[0];
      expect(wikiSource).toEqual(expect.objectContaining({ source: 'alpha', line: 9 }));
      expect(mdSource).toEqual(expect.objectContaining({ source: 'alpha', line: 10 }));
      expect(typeof wikiSource?.column).toBe('number');
      expect(typeof mdSource?.column).toBe('number');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('a target broken from multiple source docs carries a per-source position', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-dead-link-multi-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocumentFromMarkdown('alpha', 'See [[ghost]].\n');
      index.updateDocumentFromMarkdown('beta', '# Beta\n\nAlso [[ghost]].\n');

      const deadLinks = index.getDeadLinks(['alpha', 'beta']);
      expect(deadLinks.map((entry) => entry.target)).toEqual(['ghost']);
      expect(deadLinks[0]?.sources).toEqual([
        expect.objectContaining({ source: 'alpha', line: 0 }),
        expect.objectContaining({ source: 'beta', line: 2 }),
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('dead-link positions survive a cache save/load round-trip', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-dead-link-cache-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocumentFromMarkdown('alpha', '# Alpha\n\nSee [[ghost]].\n');
      await index.saveToDisk();

      const reloaded = new BacklinkIndex({ projectDir, contentDir });
      expect(await reloaded.loadFromDisk()).toBe(true);
      expect(reloaded.getDeadLinks(['alpha'])[0]?.sources[0]).toEqual(
        expect.objectContaining({ source: 'alpha', line: 2 }),
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('a current-version cache with corrupt positions degrades them to "position unknown"', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-dead-link-legacy-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const cacheDir = join(projectDir, '.ok', LOCAL_DIR, 'cache', 'main');
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, 'backlinks.json'),
        JSON.stringify({
          version: 4,
          backward: {
            ghost: [{ source: 'alpha', anchor: null, snippet: 'See ghost.' }],
            wraith: [
              { source: 'alpha', anchor: null, snippet: 'See wraith.', line: '7', column: -2 },
            ],
            shade: [{ source: 'alpha', anchor: null, snippet: 'See shade.', line: 1.5 }],
          },
          forward: { alpha: ['ghost', 'wraith', 'shade'] },
          externalForward: {},
          sourceLinks: {
            alpha: [
              { target: 'ghost', anchor: null, snippet: 'See ghost.', sourceForm: 'wiki' },
              {
                target: 'wraith',
                anchor: null,
                snippet: 'See wraith.',
                sourceForm: 'wiki',
                line: '7',
                column: -2,
              },
              {
                target: 'shade',
                anchor: null,
                snippet: 'See shade.',
                sourceForm: 'wiki',
                line: 1.5,
              },
            ],
          },
        }),
        'utf-8',
      );

      const index = new BacklinkIndex({ projectDir, contentDir });
      expect(await index.loadFromDisk()).toBe(true);
      expect(index.getBacklinks('ghost')).toEqual([
        { source: 'alpha', anchor: null, snippet: 'See ghost.' },
      ]);
      const legacySource = index.getDeadLinks(['alpha']).find((e) => e.target === 'ghost')
        ?.sources[0];
      expect(legacySource).toEqual(
        expect.objectContaining({ source: 'alpha', snippet: 'See ghost.' }),
      );
      expect(legacySource?.line).toBeUndefined();
      expect(legacySource?.column).toBeUndefined();
      const corruptSource = index.getDeadLinks(['alpha']).find((e) => e.target === 'wraith')
        ?.sources[0];
      expect(corruptSource?.line).toBeUndefined();
      expect(corruptSource?.column).toBeUndefined();
      const fractionalSource = index.getDeadLinks(['alpha']).find((e) => e.target === 'shade')
        ?.sources[0];
      expect(fractionalSource?.line).toBeUndefined();

      index.updateDocumentFromMarkdown('alpha', 'See [[ghost]].\n');
      expect(index.getDeadLinks(['alpha'])[0]?.sources[0]).toEqual(
        expect.objectContaining({ source: 'alpha', line: 0 }),
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('a v1 cache is rejected so skill refs are recorded instead of silently missing', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-skillrefs-guard-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const analyze = '.agents/skills/analyze/SKILL';
      const research = '.agents/skills/research/SKILL';
      mkdirSync(join(contentDir, '.agents', 'skills', 'analyze'), { recursive: true });
      mkdirSync(join(contentDir, '.agents', 'skills', 'research'), { recursive: true });
      writeFileSync(
        join(contentDir, '.agents', 'skills', 'analyze', 'SKILL.md'),
        '# Analyze\n\nFor reports use /research.\n',
      );
      writeFileSync(join(contentDir, '.agents', 'skills', 'research', 'SKILL.md'), '# Research\n');

      const cacheDir = join(projectDir, '.ok', LOCAL_DIR, 'cache', 'main');
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, 'backlinks.json'),
        JSON.stringify({
          version: 1,
          backward: {},
          forward: { [analyze]: [], [research]: [] },
          externalForward: {},
          mtimes: {},
        }),
        'utf-8',
      );

      const index = new BacklinkIndex({ projectDir, contentDir });
      expect(await index.loadFromDisk()).toBe(false);

      await index.rebuildFromDisk();
      expect(index.getForwardLinks(analyze)).toEqual([research]);
      expect(index.getBacklinks(research)).toEqual([
        { source: analyze, anchor: null, snippet: null },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test.each([
    { version: 3, sourceLinks: undefined, expectedWarnings: [], kept: true },
    {
      version: 4,
      sourceLinks: {},
      expectedWarnings: [
        [{ branch: 'main' }, 'Incomplete backlink cache snapshot for main; rebuilding from disk'],
      ],
      kept: false,
    },
    {
      version: 4,
      sourceLinks: { alpha: [], beta: [] },
      expectedWarnings: [
        [{ branch: 'main' }, 'Incomplete backlink cache snapshot for main; rebuilding from disk'],
      ],
      kept: false,
    },
  ])('rejects incomplete source-link snapshots and rebuilds from disk: $version', async (cache) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-source-links-guard-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      writeFileSync(join(contentDir, 'alpha.md'), '[[beta]]');
      writeFileSync(join(contentDir, 'beta.md'), '# Beta');
      const cacheDir = join(projectDir, '.ok', LOCAL_DIR, 'cache', 'main');
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, 'backlinks.json'),
        JSON.stringify({
          ...cache,
          backward: { beta: [{ source: 'alpha', anchor: null, snippet: 'beta' }] },
          forward: { alpha: ['beta'], beta: [] },
          externalForward: {},
        }),
      );

      const index = new BacklinkIndex({ projectDir, contentDir });
      const warn = vi.spyOn(getLogger('backlinks'), 'warn');
      try {
        expect(await index.loadFromDisk()).toBe(false);
        expect(warn.mock.calls).toEqual(cache.expectedWarnings);
        expect(existsSync(join(cacheDir, 'backlinks.json'))).toBe(cache.kept);
      } finally {
        warn.mockRestore();
      }
      await index.rebuildFromDisk();
      expect(index.getForwardLinks('alpha')).toEqual(['beta']);
      expect(index.getRenameSourceInventory().find((entry) => entry.docName === 'alpha')).toEqual(
        expect.objectContaining({ wikiTargets: ['beta'] }),
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test.each([
    {
      label: 'truncated JSON',
      corrupt: (good: string) => good.slice(0, Math.floor(good.length / 2)),
    },
    { label: 'NUL-padded file', corrupt: (good: string) => '\0'.repeat(good.length) },
  ])(
    'a torn cache snapshot ($label) is discarded once and replaced on the next save',
    async ({ corrupt }) => {
      const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-torn-cache-'));
      const contentDir = join(projectDir, 'content');
      const cachePath = join(projectDir, '.ok', LOCAL_DIR, 'cache', 'main', 'backlinks.json');
      mkdirSync(contentDir, { recursive: true });
      try {
        writeFileSync(join(contentDir, 'alpha.md'), 'See [[beta]].\n');
        writeFileSync(join(contentDir, 'beta.md'), '# Beta\n');
        const first = new BacklinkIndex({ projectDir, contentDir });
        await first.rebuildFromDisk();
        await first.saveToDisk();
        writeFileSync(cachePath, corrupt(readFileSync(cachePath, 'utf-8')));

        const second = new BacklinkIndex({ projectDir, contentDir });
        expect(await second.loadFromDisk()).toBe(false);
        expect(existsSync(cachePath)).toBe(false);
        await second.rebuildFromDisk();
        expect(second.getBacklinks('beta').map((link) => link.source)).toEqual(['alpha']);
        await second.saveToDisk();

        const third = new BacklinkIndex({ projectDir, contentDir });
        expect(await third.loadFromDisk()).toBe(true);
        expect(third.getBacklinks('beta').map((link) => link.source)).toEqual(['alpha']);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    },
  );

  test('a versionless pre-upgrade cache is rejected so boot cold-rebuilds instead of serving stale keys', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-version-guard-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const templateDoc = 'notes/.ok/templates/daily';
      mkdirSync(join(contentDir, 'notes', '.ok', 'templates'), { recursive: true });
      writeFileSync(
        join(contentDir, 'alpha.md'),
        '# Alpha\n\nSee [[notes/.ok/templates/daily]].\n',
      );
      writeFileSync(join(contentDir, 'notes', '.ok', 'templates', 'daily.md'), '# Daily\n');

      const cacheDir = join(projectDir, '.ok', LOCAL_DIR, 'cache', 'main');
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, 'backlinks.json'),
        JSON.stringify({
          backward: {
            '__template__/notes/daily': [{ source: 'alpha', anchor: null, snippet: 'See daily.' }],
          },
          forward: { alpha: ['__template__/notes/daily'] },
          externalForward: {},
          mtimes: {},
        }),
        'utf-8',
      );

      const index = new BacklinkIndex({ projectDir, contentDir });
      expect(await index.loadFromDisk()).toBe(false);

      await index.rebuildFromDisk();
      expect(index.getBacklinks(templateDoc)).toEqual([
        expect.objectContaining({ source: 'alpha' }),
      ]);
      expect(index.getDeadLinks(['alpha', templateDoc])).toEqual([]);
      expect(index.getOrphans(['alpha', templateDoc])).not.toContain(templateDoc);
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

  test('IN-PLACE bundles (editor-dir shapes) draw the same structural edges', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-skill-inplace-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      const skill = '.agents/skills/demo/SKILL';
      const ref = '.agents/skills/demo/references/notes';
      index.updateDocumentFromMarkdown(skill, 'See `references/notes.md`.\n');
      index.updateDocumentFromMarkdown(ref, '# Notes\n\nNo links.\n');
      expect(index.getForwardLinks(skill)).toEqual([ref]);
      expect(index.getBacklinks(ref)).toEqual([{ source: skill, anchor: null, snippet: null }]);
      const otherRef = '.claude/skills/demo/references/other';
      index.updateDocumentFromMarkdown(otherRef, 'Standalone.\n');
      expect(index.getForwardLinks(skill)).toEqual([ref]);
      expect(index.getForwardLinks(otherRef)).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('/skill-name refs draw same-scope edges to the referenced SKILL doc, both directions', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-backlinks-skill-refs-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      const analyze = '.agents/skills/analyze/SKILL';
      const research = '.agents/skills/research/SKILL';
      index.updateDocumentFromMarkdown(analyze, 'For reports use `/research` or /research.\n');
      expect(index.getForwardLinks(analyze)).toEqual([]);
      index.updateDocumentFromMarkdown(research, '# Research skill\n');
      expect(index.getForwardLinks(analyze)).toEqual([research]);
      expect(index.getBacklinks(research)).toEqual([
        { source: analyze, anchor: null, snippet: null },
      ]);
      index.updateDocumentFromMarkdown(analyze, 'Files under /tmp and half/way.\n');
      expect(index.getForwardLinks(analyze)).toEqual([]);
      index.registerGlobalSkillBundleNode('__skill__/global/deploy/SKILL');
      index.updateDocumentFromMarkdown(analyze, 'Use /deploy.\n');
      expect(index.getForwardLinks(analyze)).toEqual([]);
      index.updateDocumentFromMarkdown(analyze, 'Use /research.\n');
      expect(index.getForwardLinks(analyze)).toEqual([research]);
      index.deleteDocument(research);
      expect(index.getForwardLinks(analyze)).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

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
      { target: 'other', anchor: null, snippet: 'See related for details.', line: 0, column: 4 },
    ]);
  });

  test('extracts root-absolute markdown links from the content root', () => {
    const md = 'See [the guide](/docs/guide.md) for details.';
    expect(extractMarkdownLinksFromMarkdown(md, 'notes')).toEqual<ExtractedWikiLink[]>([
      {
        target: 'docs/guide',
        anchor: null,
        snippet: 'See the guide for details.',
        line: 0,
        column: 4,
      },
    ]);
  });

  test('extracts multiple markdown links from the same line', () => {
    const md = 'See [page A](./a.md) and [page B](./b.md) for more.';
    expect(extractMarkdownLinksFromMarkdown(md, 'notes')).toEqual<ExtractedWikiLink[]>([
      { target: 'a', anchor: null, snippet: 'See page A and page B for more.', line: 0, column: 4 },
      {
        target: 'b',
        anchor: null,
        snippet: 'See page A and page B for more.',
        line: 0,
        column: 15,
      },
    ]);
  });

  test('resolves links relative to the source doc directory', () => {
    const md = 'See [overview](../overview.md).';
    expect(extractMarkdownLinksFromMarkdown(md, 'folder/page')).toEqual([
      { target: 'overview', anchor: null, snippet: 'See overview.', line: 0, column: 4 },
    ]);
  });

  test('extracts internal links with optional titles', () => {
    const md = 'See [overview](./overview.md "Project overview") for details.';
    expect(extractMarkdownLinksFromMarkdown(md, 'notes')).toEqual([
      {
        target: 'overview',
        anchor: null,
        snippet: 'See overview for details.',
        line: 0,
        column: 4,
      },
    ]);
  });

  test('extracts markdown link anchors', () => {
    const md = 'See [install](./guide.md#install) for details.';
    expect(extractMarkdownLinksFromMarkdown(md, 'notes')).toEqual([
      {
        target: 'guide',
        anchor: 'install',
        snippet: 'See install for details.',
        line: 0,
        column: 4,
      },
    ]);
  });

  test('ignores external links', () => {
    const md = 'Visit [example](https://example.com) and [local](./local.md).';
    expect(extractMarkdownLinksFromMarkdown(md, 'notes')).toEqual([
      { target: 'local', anchor: null, snippet: 'Visit example and local.', line: 0, column: 18 },
    ]);
  });

  test('ignores image syntax while still extracting sibling links', () => {
    const md = 'See ![diagram](./assets/diagram.png) and [docs](./docs.md).';
    expect(extractMarkdownLinksFromMarkdown(md, 'notes')).toEqual([
      {
        target: 'docs',
        anchor: null,
        snippet: expect.any(String) as string,
        line: 0,
        column: 41,
      },
    ]);
  });

  test('ignores links inside fenced code blocks', () => {
    const md = ['See [page](./page.md).', '', '```', '[ignore](./ignore.md)', '```'].join('\n');
    expect(extractMarkdownLinksFromMarkdown(md, 'notes')).toEqual([
      { target: 'page', anchor: null, snippet: 'See page.', line: 0, column: 4 },
    ]);
  });

  test('ignores links inside inline code spans', () => {
    const md = 'Use `[skip](./skip.md)` then [real](./real.md).';
    expect(extractMarkdownLinksFromMarkdown(md, 'notes')).toEqual([
      {
        target: 'real',
        anchor: null,
        snippet: expect.any(String) as string,
        line: 0,
        column: 27,
      },
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

  test('offsets link lines by the caller-supplied lineOffset', () => {
    expect(extractMarkdownLinksFromMarkdown('Read [the guide](./guide.md).', 'notes', 4)).toEqual([
      { target: 'guide', anchor: null, snippet: 'Read the guide.', line: 4, column: 5 },
    ]);
  });

  test('a .md link with a fragment or query keeps its document edge when a file oracle answers its path', () => {
    const files = new Set(['notes/Guide.md', 'notes/Help.mdx']);
    const md =
      'See [g](./Guide.md#intro) and [h](./Help.mdx?v=1).\n\n[r][ref]\n\n[ref]: ./Guide.md#ref';
    const edges = extractMarkdownLinksFromMarkdown(md, 'notes/a', 0, {
      hasFile: (path) => files.has(path),
    });
    expect(edges.map((edge) => edge.target)).toEqual(['notes/Guide', 'notes/Help', 'notes/Guide']);
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

  test('rebuildFromDisk indexes full, collapsed, and shortcut reference links', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'backlinks-reference-rebuild-'));
    try {
      writeFileSync(
        join(tmpDir, 'source.md'),
        [
          'See [full label][full-ref], [collapsed-ref][], and [shortcut-ref].',
          '',
          '[full-ref]: ./full-target.md',
          '[collapsed-ref]: ./collapsed-target.md',
          '[shortcut-ref]: ./shortcut-target.md',
          '',
        ].join('\n'),
        'utf-8',
      );
      for (const target of ['full-target', 'collapsed-target', 'shortcut-target']) {
        writeFileSync(join(tmpDir, `${target}.md`), `# ${target}\n`, 'utf-8');
      }

      const index = new BacklinkIndex({ projectDir: tmpDir, contentDir: tmpDir });
      await index.rebuildFromDisk();

      const targets = ['collapsed-target', 'full-target', 'shortcut-target'];
      expect(index.getForwardLinks('source')).toEqual(targets);
      for (const target of targets) {
        expect(index.getBacklinks(target)).toEqual([expect.objectContaining({ source: 'source' })]);
      }
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
  test('unchanged snapshot files reuse persisted source links without rereading', async () => {
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
      expect(diff).toEqual({
        added: 0,
        updated: 0,
        deleted: 0,
        deletedDocNames: [],
        changedDocs: [],
      });

      expect(reloaded.getBacklinks('beta')).toEqual([
        { source: 'alpha', anchor: null, snippet: 'Links to beta.' },
      ]);
      expect(
        reloaded.getRenameSourceInventory().find((entry) => entry.docName === 'alpha'),
      ).toEqual(expect.objectContaining({ wikiTargets: ['beta'] }));
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
      expect(diff.deletedDocNames).toEqual(['beta']);

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

  test('a folder oracle exempts wiki and markdown links to existing folders', () => {
    const md = 'See [[assets]] and [dir](./assets) and [[missing-folder]].';
    const folderExists = (folderPath: string) => folderPath === 'assets';
    expect(computeBrokenOutboundLinks(md, 'notes', new Set(), undefined, folderExists)).toEqual<
      BrokenOutboundLink[]
    >([{ href: '[[missing-folder]]', resolvedTo: 'missing-folder', reason: 'no-such-doc' }]);
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

  test('a bare-name wiki-link resolving to a subfolder doc is not broken; an unresolvable one is', () => {
    const md = 'See [[analysis]] and [[nowhere]].';
    const admitted = new Set(['research/analysis', 'notes/a']);
    expect(computeBrokenOutboundLinks(md, 'notes/a', admitted)).toEqual<BrokenOutboundLink[]>([
      { href: '[[nowhere]]', resolvedTo: 'nowhere', reason: 'no-such-doc' },
    ]);
  });

  test.each(['guide', 'Guide', 'runbook'])(
    'does not resolve fuzzy [[%s]] against global skill documents',
    (target) => {
      const global = skillLiveDocName('global', 'guide');
      const admitted = new Set([global, `${global}/references/runbook`]);
      expect(computeBrokenOutboundLinks(`[[${target}]]`, 'notes/a', admitted)).toEqual([
        { href: `[[${target}]]`, resolvedTo: target, reason: 'no-such-doc' },
      ]);
    },
  );

  test('keeps explicit global and fuzzy project skill references admitted', () => {
    const global = skillLiveDocName('global', 'guide');
    const globalReference = `${global}/references/runbook`;
    const projectReference = '.agents/skills/project/references/project-guide';
    const markdown = `[[${global}]] [[${globalReference}]] [[Project Guide]]`;
    expect(
      computeBrokenOutboundLinks(markdown, 'notes/a', [global, globalReference, projectReference]),
    ).toEqual([]);
  });

  test('markdown document links stay literal when the wiki target resolves fuzzily', () => {
    expect(
      computeBrokenOutboundLinks('[[guide]] [guide](./guide.md)', 'notes/a', ['archive/guide']),
    ).toEqual([{ href: './guide.md', resolvedTo: 'notes/guide', reason: 'no-such-doc' }]);
  });

  test('a dotted-filename document target is not reported broken', () => {
    const md = 'See [[acp.daemon]] here.';
    const admitted = new Set(['notes/acp.daemon', 'notes/a']);
    expect(computeBrokenOutboundLinks(md, 'notes/a', admitted)).toEqual([]);
  });

  test('wiki asset embeds and dotted non-doc targets produce no broken links', () => {
    const md = [
      'Embed ![[diagram.png]] and ![[chart.v2.png]].',
      'Link [[meeting.pdf]] and [[report.v3.xlsx]].',
    ].join('\n');
    const admitted = new Set(['meeting.pdf', 'notes/a']);
    expect(computeBrokenOutboundLinks(md, 'notes/a', admitted)).toEqual([]);
  });

  test('resolving many wiki links scans the corpus a bounded number of times', () => {
    class ScanCountingSet extends Set<string> {
      scans = 0;
      [Symbol.iterator](): SetIterator<string> {
        this.scans += 1;
        return super[Symbol.iterator]();
      }
    }
    const admitted = new ScanCountingSet(['research/analysis', 'archive/summary', 'notes/a']);
    const md = Array.from({ length: 12 }, (_, i) => `[[analysis]] [[summary]] [[gone-${i}]]`).join(
      '\n',
    );

    const broken = computeBrokenOutboundLinks(md, 'notes/a', admitted);

    expect(broken).toHaveLength(12);
    expect(admitted.scans).toBeLessThanOrEqual(2);
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

  test('the markdown and JSX planes of one href each keep their own resolution', () => {
    const md = ['See [x](api-spec).', '<Mirror src="api-spec" anchor="dep" />', ''].join('\n');
    expect(computeBrokenOutboundLinks(md, 'notes/a', new Set())).toEqual<BrokenOutboundLink[]>([
      { href: 'api-spec', resolvedTo: 'notes/api-spec', reason: 'no-such-doc' },
      { href: 'api-spec', resolvedTo: 'api-spec', reason: 'no-such-doc', sourceForm: 'jsx' },
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

  test('a Markdown link naming no document but an existing or ignored file is judged as that file', () => {
    const md = 'See [make](../Makefile), [notice](../ignored/NOTICE) and [gone](../Nope).';
    const excluded = new Set(['ignored/NOTICE']);
    expect(
      computeBrokenOutboundLinks(
        md,
        'notes/a',
        new Set(),
        fileOracle(['Makefile']),
        () => false,
        (path) => excluded.has(path),
      ),
    ).toEqual<BrokenOutboundLink[]>([
      { href: '../ignored/NOTICE', resolvedTo: 'ignored/NOTICE', reason: 'excluded' },
      { href: '../Nope', resolvedTo: 'Nope', reason: 'no-such-doc' },
    ]);
  });

  test('a Markdown link to a missing document is never satisfied by a file check on its .md path', () => {
    const md = 'See [g](./Guide.md) and [h](./Help.mdx).';
    expect(
      computeBrokenOutboundLinks(
        md,
        'notes/a',
        new Set(['notes/guide', 'notes/help']),
        fileOracle(['notes/Guide.md', 'notes/Help.mdx']),
        () => false,
        () => false,
      ),
    ).toEqual<BrokenOutboundLink[]>([
      { href: './Guide.md', resolvedTo: 'notes/Guide', reason: 'no-such-doc' },
      { href: './Help.mdx', resolvedTo: 'notes/Help', reason: 'no-such-doc' },
    ]);
  });

  test('a Markdown link to an existing but ignored .md file reports excluded', () => {
    const md = 'See [d](./drafts/plan.md) and [g](./Guide.md).';
    const excluded = new Set(['notes/drafts/plan.md']);
    expect(
      computeBrokenOutboundLinks(
        md,
        'notes/a',
        new Set(['notes/guide']),
        fileOracle(['notes/Guide.md']),
        () => false,
        (path) => excluded.has(path),
      ),
    ).toEqual<BrokenOutboundLink[]>([
      { href: './drafts/plan.md', resolvedTo: 'notes/drafts/plan.md', reason: 'excluded' },
      { href: './Guide.md', resolvedTo: 'notes/Guide', reason: 'no-such-doc' },
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

describe('extractJsxSrcRefsFromMarkdown', () => {
  test('extracts Mirror and Excalidraw src refs as document targets', () => {
    const md = [
      '# Doc',
      '',
      '<Mirror src="api-spec" anchor="dep" />',
      '<Excalidraw src="/diagrams/board.excalidraw" />',
      '',
    ].join('\n');
    const refs = extractJsxSrcRefsFromMarkdown(md, 'notes/index');
    expect(refs.map((r) => r.target)).toEqual(['api-spec', 'diagrams/board.excalidraw']);
    expect(refs[0]).toEqual(
      expect.objectContaining({
        anchor: null,
        line: 2,
        snippet: '<Mirror src="api-spec" anchor="dep" />',
      }),
    );
  });

  test('resolves a doc-relative Excalidraw src against the source doc dir', () => {
    const refs = extractJsxSrcRefsFromMarkdown(
      '<Excalidraw src="board.excalidraw" />\n',
      'notes/index',
    );
    expect(refs.map((r) => r.target)).toEqual(['notes/board.excalidraw']);
  });

  test('skips refs inside fenced code and inline code', () => {
    const md = [
      '```mdx',
      '<Excalidraw src="/fenced/board.excalidraw" />',
      '```',
      'Write `<Mirror src="api-spec" anchor="x" />` to mirror.',
      '<Mirror src="live-doc" anchor="x" />',
      '',
    ].join('\n');
    expect(extractJsxSrcRefsFromMarkdown(md, 'index').map((r) => r.target)).toEqual(['live-doc']);
  });

  test('skips empty, external-scheme, and contentDir-escaping values', () => {
    const md = [
      '<Excalidraw src="" />',
      '<Excalidraw src="https://example.com/board.excalidraw" />',
      '<Mirror src="https://example.com/x" anchor="a" />',
      '<Mirror src="mailto:someone@example.com" anchor="b" />',
      '<Excalidraw src="../../outside.excalidraw" />',
      '',
    ].join('\n');
    expect(extractJsxSrcRefsFromMarkdown(md, 'notes/index')).toEqual([]);
  });

  test('does not read data-src as src', () => {
    expect(
      extractJsxSrcRefsFromMarkdown('<Mirror data-src="decoy" anchor="x" src="real" />\n', 'index'),
    ).toEqual([expect.objectContaining({ target: 'real' })]);
  });

  test('applies the frontmatter line offset', () => {
    const refs = extractJsxSrcRefsFromMarkdown(
      '<Mirror src="api-spec" anchor="x" />\n',
      'index',
      4,
    );
    expect(refs[0]).toEqual(expect.objectContaining({ line: 4 }));
  });

  test('a >-free line of repeated tag prefixes completes within the complexity budget', () => {
    const line = '<Mirror '.repeat(6400);
    const startedAt = performance.now();
    expect(extractJsxSrcRefsFromMarkdown(line, 'notes/index')).toEqual([]);
    expect(computeBrokenOutboundLinks(line, 'notes/index', new Set())).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(2000);
  });

  test('a line whose only > is distant and unmatched completes within the complexity budget', () => {
    const line = `${'<Mirror '.repeat(6400)}>`;
    const startedAt = performance.now();
    expect(extractJsxSrcRefsFromMarkdown(line, 'notes/index')).toEqual([]);
    expect(computeBrokenOutboundLinks(line, 'notes/index', new Set())).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(2000);
  });
});

describe('BacklinkIndex with JSX src refs', () => {
  test('a JSX-src-only document becomes a backlink source for the board', () => {
    const index = new BacklinkIndex({ projectDir: '/tmp/x', contentDir: '/tmp/x' });
    index.updateDocumentFromMarkdown(
      'notes/embeds-only',
      '# Embeds\n\n<Excalidraw src="board.excalidraw" />\n',
    );
    expect(index.getBacklinks('notes/board.excalidraw')).toEqual([
      expect.objectContaining({ source: 'notes/embeds-only' }),
    ]);
    expect(index.getForwardLinks('notes/embeds-only')).toEqual(['notes/board.excalidraw']);
  });

  test('a Mirror-only document becomes a backlink source for the mirrored doc', () => {
    const index = new BacklinkIndex({ projectDir: '/tmp/x', contentDir: '/tmp/x' });
    index.updateDocumentFromMarkdown('mirror-only', '<Mirror src="api-spec" anchor="dep" />\n');
    expect(index.getBacklinks('api-spec')).toEqual([
      expect.objectContaining({ source: 'mirror-only' }),
    ]);
  });

  test('dead-links: an existing board is exempt, a missing board reports, no oracle stays silent', () => {
    const files = new Set<string>();
    const makeIndex = (withOracle: boolean) => {
      const index = new BacklinkIndex({
        projectDir: '/tmp/x',
        contentDir: '/tmp/x',
        ...(withOracle ? { getFileOracle: () => ({ hasFile: (p: string) => files.has(p) }) } : {}),
      });
      index.updateDocumentFromMarkdown(
        'notes/embeds-only',
        '<Excalidraw src="board.excalidraw" />\n',
      );
      return index;
    };

    files.add('notes/board.excalidraw');
    expect(makeIndex(true).getDeadLinks(['notes/embeds-only'])).toEqual([]);

    files.clear();
    expect(makeIndex(true).getDeadLinks(['notes/embeds-only'])).toEqual([
      expect.objectContaining({ target: 'notes/board.excalidraw' }),
    ]);

    expect(makeIndex(false).getDeadLinks(['notes/embeds-only'])).toEqual([]);
  });

  test('dead-links: a Mirror src naming a missing doc still reports', () => {
    const index = new BacklinkIndex({ projectDir: '/tmp/x', contentDir: '/tmp/x' });
    index.updateDocumentFromMarkdown('mirror-only', '<Mirror src="ghost-doc" anchor="x" />\n');
    expect(index.getDeadLinks(['mirror-only'])).toEqual([
      expect.objectContaining({ target: 'ghost-doc' }),
    ]);
    index.updateDocumentFromMarkdown('ghost-doc', '# Now it exists\n');
    expect(index.getDeadLinks(['mirror-only', 'ghost-doc'])).toEqual([]);
  });
});

describe('computeBrokenOutboundLinks — JSX src refs', () => {
  const fileOracle = (existing: string[]) => {
    const set = new Set(existing);
    return (p: string) => set.has(p);
  };

  test('a missing board reports no-such-file; an existing board is clean', () => {
    const md = '<Excalidraw src="board.excalidraw" />\n';
    expect(computeBrokenOutboundLinks(md, 'notes/index', new Set(), fileOracle([]))).toEqual([
      {
        href: 'board.excalidraw',
        resolvedTo: 'notes/board.excalidraw',
        reason: 'no-such-file',
        sourceForm: 'jsx',
      },
    ]);
    expect(
      computeBrokenOutboundLinks(
        md,
        'notes/index',
        new Set(),
        fileOracle(['notes/board.excalidraw']),
      ),
    ).toEqual([]);
  });

  test('a Mirror src naming a missing doc reports no-such-doc', () => {
    const md = '<Mirror src="ghost-doc" anchor="x" />\n';
    expect(computeBrokenOutboundLinks(md, 'index', new Set(['api-spec']))).toEqual([
      { href: 'ghost-doc', resolvedTo: 'ghost-doc', reason: 'no-such-doc', sourceForm: 'jsx' },
    ]);
    expect(
      computeBrokenOutboundLinks(
        md.replace('ghost-doc', 'api-spec'),
        'index',
        new Set(['api-spec']),
      ),
    ).toEqual([]);
  });

  test('contentDir-escaping and scheme-valued srcs report unresolvable; empty stays silent', () => {
    const md = [
      '<Excalidraw src="../../escape.excalidraw" />',
      '<Excalidraw src="https://example.com/b.excalidraw" />',
      '<Mirror src="mailto:someone@example.com" anchor="x" />',
      '<Excalidraw src="" />',
      '',
    ].join('\n');
    expect(computeBrokenOutboundLinks(md, 'notes/index', new Set(), fileOracle([]))).toEqual([
      {
        href: '../../escape.excalidraw',
        resolvedTo: null,
        reason: 'unresolvable',
        sourceForm: 'jsx',
      },
      {
        href: 'https://example.com/b.excalidraw',
        resolvedTo: null,
        reason: 'unresolvable',
        sourceForm: 'jsx',
      },
      {
        href: 'mailto:someone@example.com',
        resolvedTo: null,
        reason: 'unresolvable',
        sourceForm: 'jsx',
      },
    ]);
  });

  test('without a file oracle, board existence is unknowable and stays silent', () => {
    expect(
      computeBrokenOutboundLinks(
        '<Excalidraw src="board.excalidraw" />\n',
        'notes/index',
        new Set(),
      ),
    ).toEqual([]);
  });

  test('JSX refs inside fences and inline code are not validated', () => {
    const md = [
      '```mdx',
      '<Excalidraw src="fenced.excalidraw" />',
      '```',
      'Use `<Mirror src="ghost" anchor="x" />` like this.',
      '',
    ].join('\n');
    expect(computeBrokenOutboundLinks(md, 'notes/index', new Set(), fileOracle([]))).toEqual([]);
  });
});

describe('link target identity across canonically equivalent spellings', () => {
  const RENE_NFC = 'People/René';
  const RENE_NFD = 'People/René';
  const ZOE_NFC = 'People/Zoë';
  const ZOE_NFD = 'People/Zoë';

  function markdownLinkTo(docName: string): string {
    return `[link](/${encodeHrefPath(docName)}.md)`;
  }

  function createInMemoryIndex(): BacklinkIndex {
    return new BacklinkIndex({ projectDir: '/unused', contentDir: '/unused' });
  }

  test('an NFC markdown link to an NFD document is not dead and its backlink lands on the NFD node', () => {
    const index = createInMemoryIndex();
    index.updateDocumentFromMarkdown(RENE_NFD, '# René\n');
    index.updateDocumentFromMarkdown('Probe', `See ${markdownLinkTo(RENE_NFC)}.\n`);

    expect(index.getDeadLinks(['Probe', RENE_NFD])).toEqual([]);
    expect(index.getBacklinks(RENE_NFD).map((entry) => entry.source)).toEqual(['Probe']);
    expect(
      index
        .getLinkGraph()
        .nodes.filter((node) => node.docName.normalize('NFC') === RENE_NFC)
        .map((node) => node.docName),
    ).toEqual([RENE_NFD]);
  });

  test('deleting the document makes the link dead again and re-adding it heals the link', () => {
    const index = createInMemoryIndex();
    index.updateDocumentFromMarkdown(RENE_NFD, '# René\n');
    index.updateDocumentFromMarkdown('Probe', `See ${markdownLinkTo(RENE_NFC)}.\n`);
    expect(index.getDeadLinks(['Probe', RENE_NFD])).toEqual([]);

    index.deleteDocument(RENE_NFD);
    expect(index.getDeadLinks(['Probe']).map((entry) => entry.target)).toEqual([RENE_NFC]);
    expect(index.getBacklinks(RENE_NFD)).toEqual([]);

    index.updateDocumentFromMarkdown(RENE_NFD, '# René again\n');
    expect(index.getDeadLinks(['Probe', RENE_NFD])).toEqual([]);
    expect(index.getBacklinks(RENE_NFD).map((entry) => entry.source)).toEqual(['Probe']);
  });

  test('an NFD markdown link to an NFC document resolves the same way', () => {
    const index = createInMemoryIndex();
    index.updateDocumentFromMarkdown(ZOE_NFC, '# Zoë\n');
    index.updateDocumentFromMarkdown('Probe', `See ${markdownLinkTo(ZOE_NFD)}.\n`);

    expect(index.getDeadLinks(['Probe', ZOE_NFC])).toEqual([]);
    expect(index.getBacklinks(ZOE_NFC).map((entry) => entry.source)).toEqual(['Probe']);
  });

  test('backlinks requested under an equivalent spelling answer for the stored document', () => {
    const index = createInMemoryIndex();
    index.updateDocumentFromMarkdown(RENE_NFD, '# René\n');
    index.updateDocumentFromMarkdown('Probe', `See ${markdownLinkTo(RENE_NFD)}.\n`);

    expect(index.getBacklinks(RENE_NFC)).toEqual(index.getBacklinks(RENE_NFD));
    expect(index.getBacklinks(RENE_NFC).map((entry) => entry.source)).toEqual(['Probe']);
    expect(index.getBacklinkCount(RENE_NFC)).toBe(1);
    expect(index.getBacklinks('People/Ghost')).toEqual([]);
  });

  test('a document that appears after the link was indexed heals the link', () => {
    const index = createInMemoryIndex();
    index.updateDocumentFromMarkdown('Probe', `See ${markdownLinkTo(RENE_NFC)}.\n`);
    expect(index.getDeadLinks(['Probe']).map((entry) => entry.target)).toEqual([RENE_NFC]);

    index.updateDocumentFromMarkdown(RENE_NFD, '# René\n');
    expect(index.getDeadLinks(['Probe', RENE_NFD])).toEqual([]);
    expect(index.getBacklinks(RENE_NFD).map((entry) => entry.source)).toEqual(['Probe']);
  });

  test.each([
    [
      'an NFC wiki link',
      'an NFD folder index',
      'Café'.normalize('NFC'),
      `${'Café'.normalize('NFD')}/index`,
    ],
    [
      'an NFD wiki link',
      'an NFC folder index',
      'Café'.normalize('NFD'),
      `${'Café'.normalize('NFC')}/index`,
    ],
    [
      'an NFC wiki link',
      'an NFD folder note',
      'Notes/Café'.normalize('NFC'),
      `${'Notes/Café'.normalize('NFD')}/${'Café'.normalize('NFD')}`,
    ],
    [
      'an NFC wiki link',
      'a folder note whose leaf alone is NFD',
      'Notes/Café'.normalize('NFC'),
      `${'Notes/Café'.normalize('NFC')}/${'Café'.normalize('NFD')}`,
    ],
  ])(
    '%s follows %s added and deleted after the link, without a rebuild',
    (_link, _doc, target, docName) => {
      const index = createInMemoryIndex();
      index.updateDocumentFromMarkdown('Probe', `See [[${target}]].\n`);
      expect(index.getDeadLinks(['Probe']).map((entry) => entry.target)).toEqual([target]);

      index.updateDocumentFromMarkdown(docName, '# Café\n');
      expect(index.getDeadLinks(['Probe', docName])).toEqual([]);
      expect(index.getBacklinks(docName).map((entry) => entry.source)).toEqual(['Probe']);

      index.deleteDocument(docName);
      expect(index.getDeadLinks(['Probe']).map((entry) => entry.target)).toEqual([target]);
      expect(index.getBacklinks(docName)).toEqual([]);
    },
  );

  test('deleting an NFD folder index that an NFC wiki link already resolved to points the link back at its target', () => {
    const target = 'Café'.normalize('NFC');
    const docName = `${'Café'.normalize('NFD')}/index`;
    const index = createInMemoryIndex();
    index.updateDocumentFromMarkdown(docName, '# Café\n');
    index.updateDocumentFromMarkdown('Probe', `See [[${target}]].\n`);
    expect(index.getBacklinks(docName).map((entry) => entry.source)).toEqual(['Probe']);

    index.deleteDocument(docName);
    expect(index.getDeadLinks(['Probe']).map((entry) => entry.target)).toEqual([target]);
    expect(index.getLinkGraph().links.map((link) => `${link.source} -> ${link.target}`)).toEqual([
      `Probe -> ${target}`,
    ]);
  });

  const DOC_ALPHABET = [
    RENE_NFC,
    RENE_NFD,
    'People/rené',
    ZOE_NFC,
    ZOE_NFD,
    'Notes/README',
    'Notes/readme',
    'a/b',
    'a-b',
    'Café'.normalize('NFC'),
    `${'Café'.normalize('NFD')}/index`,
    `${'Café'.normalize('NFC')}/${'Café'.normalize('NFD')}`,
  ];

  function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pick<T>(random: () => number, items: readonly T[]): T {
    return items[Math.floor(random() * items.length)] as T;
  }

  function randomMarkdown(random: () => number): string {
    const lines: string[] = ['# Doc', ''];
    const linkCount = Math.floor(random() * 4);
    for (let i = 0; i < linkCount; i++) {
      const target = pick(random, DOC_ALPHABET);
      lines.push(random() < 0.5 ? markdownLinkTo(target) : `[[${target}]]`);
    }
    return `${lines.join('\n')}\n`;
  }

  function graphSnapshot(index: BacklinkIndex, liveDocs: ReadonlyMap<string, string>): string {
    const admitted = [...liveDocs.keys()].sort();
    const graph = index.getLinkGraph();
    return JSON.stringify({
      deadLinks: index
        .getDeadLinks(admitted)
        .map((entry) => ({
          target: entry.target,
          sources: entry.sources
            .map((source) => `${source.source}\0${source.sourceForm}\0${source.line}`)
            .sort(),
        }))
        .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0)),
      nodes: graph.nodes.map((node) => node.id).sort(),
      links: graph.links.map((link) => `${link.source} -> ${link.target}`).sort(),
      backlinks: admitted.map((docName) => [
        docName,
        index
          .getBacklinks(docName)
          .map((entry) => entry.source)
          .sort(),
      ]),
    });
  }

  test('an incrementally maintained graph equals a fresh rebuild over the same documents', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = seededRandom(seed);
      const incremental = createInMemoryIndex();
      const liveDocs = new Map<string, string>();
      for (let step = 0; step < 12; step++) {
        const docName = pick(random, DOC_ALPHABET);
        if (liveDocs.has(docName) && random() < 0.4) {
          liveDocs.delete(docName);
          incremental.deleteDocument(docName);
        } else {
          const markdown = randomMarkdown(random);
          liveDocs.set(docName, markdown);
          incremental.updateDocumentFromMarkdown(docName, markdown);
        }
        const fresh = createInMemoryIndex();
        for (const name of [...liveDocs.keys()].sort()) {
          fresh.updateDocumentFromMarkdown(name, liveDocs.get(name) as string);
        }
        expect(graphSnapshot(incremental, liveDocs), `seed ${seed} step ${step}`).toBe(
          graphSnapshot(fresh, liveDocs),
        );
      }
    }
  });
});

describe('computeBrokenOutboundLinks across canonically equivalent spellings', () => {
  const RENE_NFC = 'People/René';
  const RENE_NFD = 'People/René';

  test('a markdown href in either normalization form names the admitted document', () => {
    const toNfc = `[x](/${encodeHrefPath(RENE_NFC)}.md)\n`;
    const toNfd = `[x](/${encodeHrefPath(RENE_NFD)}.md)\n`;
    expect(computeBrokenOutboundLinks(toNfc, 'Probe', new Set([RENE_NFD]))).toEqual([]);
    expect(computeBrokenOutboundLinks(toNfd, 'Probe', new Set([RENE_NFC]))).toEqual([]);
    expect(
      computeBrokenOutboundLinks(toNfc, 'Probe', createTargetNamespace('document', [RENE_NFD])),
    ).toEqual([]);
    expect(computeBrokenOutboundLinks(`[[${RENE_NFC}]]\n`, 'Probe', new Set([RENE_NFD]))).toEqual(
      [],
    );
    expect(
      computeBrokenOutboundLinks('[x](/People/Nope.md)\n', 'Probe', new Set([RENE_NFD])),
    ).toEqual([{ href: '/People/Nope.md', resolvedTo: 'People/Nope', reason: 'no-such-doc' }]);
  });
});
