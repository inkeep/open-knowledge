import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hocuspocus } from '@hocuspocus/server';
import type * as Y from 'yjs';
import { AGENT_WRITE_ORIGIN, applyAgentMarkdownWrite } from './agent-sessions.ts';
import { applyExternalChange } from './external-change.ts';
import type { FileIndexEntry } from './file-watcher.ts';
import { installTestLoggers, loggerFactory } from './logger.ts';
import { suggestLinks } from './suggest-links.ts';

function buildFileIndex(dir: string, docNames: string[]): ReadonlyMap<string, FileIndexEntry> {
  const index = new Map<string, FileIndexEntry>();
  for (const docName of docNames) {
    const filePath = join(dir, `${docName}.md`);
    const stats = statSync(filePath);
    index.set(docName, {
      size: stats.size,
      modified: stats.mtime.toISOString(),
      canonicalPath: filePath,
      inode: stats.ino,
      aliases: [],
    });
  }
  return index;
}

type Conn = Awaited<ReturnType<Hocuspocus['openDirectConnection']>>;

function getDoc(conn: Conn): Y.Doc {
  const doc = (conn as unknown as { document: Y.Doc }).document;
  if (!doc) throw new Error('DirectConnection has no document');
  return doc;
}

describe('suggestLinks', () => {
  beforeEach(() => {
    installTestLoggers();
  });

  afterEach(() => {
    loggerFactory.reset();
  });

  test('returns a plain unlinked mention from the admitted disk corpus', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-suggest-links-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const hocuspocus = new Hocuspocus({ quiet: true });

    try {
      writeFileSync(join(contentDir, 'project-alpha.md'), '# Project Alpha\n', 'utf-8');
      writeFileSync(
        join(contentDir, 'notes.md'),
        'We should document Project Alpha before launch.\n',
        'utf-8',
      );

      const result = await suggestLinks({
        hocuspocus,
        fileIndex: buildFileIndex(contentDir, ['project-alpha', 'notes']),
        docName: 'project-alpha',
      });

      expect(result.target.docName).toBe('project-alpha');
      expect(result.target.title).toBe('Project Alpha');
      expect(result.truncated).toBe(false);
      expect(result.mentions).toEqual([
        {
          source: 'notes',
          excerpt: 'We should document Project Alpha before launch.',
          offset: 19,
        },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('matches title and aliases case-insensitively without substring false positives', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-suggest-links-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const hocuspocus = new Hocuspocus({ quiet: true });
    const source =
      'project alpha ships soon. PA owners are ready. alphabet soup stays unrelated.\n';

    try {
      writeFileSync(
        join(contentDir, 'project-alpha.md'),
        ['---', 'title: Project Alpha', 'aliases:', '  - PA', '---', '', 'Body.'].join('\n'),
        'utf-8',
      );
      writeFileSync(join(contentDir, 'notes.md'), source, 'utf-8');

      const result = await suggestLinks({
        hocuspocus,
        fileIndex: buildFileIndex(contentDir, ['project-alpha', 'notes']),
        docName: 'project-alpha',
      });

      expect(result.mentions).toHaveLength(2);
      expect(result.mentions.map((mention) => mention.offset)).toEqual([
        source.indexOf('project alpha'),
        source.indexOf('PA'),
      ]);
      expect(result.mentions.map((mention) => mention.excerpt)).toEqual([
        'project alpha ships soon.…',
        '…PA owners are ready.…',
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('ignores frontmatter, fenced code, inline code, and existing links', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-suggest-links-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const hocuspocus = new Hocuspocus({ quiet: true });
    const source = [
      '---',
      'summary: Project Alpha frontmatter mention',
      '---',
      '',
      'Inline `Project Alpha` should be ignored.',
      '',
      '```ts',
      'const target = "Project Alpha";',
      '```',
      '',
      'Already linked: [[Project Alpha]] and [Project Alpha](./project-alpha.md).',
      '',
      'Plain Project Alpha mention.',
    ].join('\n');

    try {
      writeFileSync(join(contentDir, 'project-alpha.md'), '# Project Alpha\n', 'utf-8');
      writeFileSync(join(contentDir, 'notes.md'), source, 'utf-8');

      const result = await suggestLinks({
        hocuspocus,
        fileIndex: buildFileIndex(contentDir, ['project-alpha', 'notes']),
        docName: 'project-alpha',
      });

      expect(result.mentions).toEqual([
        {
          source: 'notes',
          excerpt: 'Plain Project Alpha mention.',
          offset: source.indexOf('Project Alpha', source.indexOf('Plain Project Alpha mention.')),
        },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('keeps labels linked to other pages matchable', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-suggest-links-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const hocuspocus = new Hocuspocus({ quiet: true });
    const source = [
      'See [Project Alpha](./other.md) for the external plan.',
      'Alias form [[other|  Project Alpha  ]] should also stay matchable.',
    ].join('\n');

    try {
      writeFileSync(join(contentDir, 'project-alpha.md'), '# Project Alpha\n', 'utf-8');
      writeFileSync(join(contentDir, 'other.md'), '# Other\n', 'utf-8');
      writeFileSync(join(contentDir, 'notes.md'), source, 'utf-8');

      const result = await suggestLinks({
        hocuspocus,
        fileIndex: buildFileIndex(contentDir, ['project-alpha', 'other', 'notes']),
        docName: 'project-alpha',
      });

      const firstOffset = source.indexOf('Project Alpha');
      const secondOffset = source.indexOf('Project Alpha', firstOffset + 1);

      expect(result.mentions).toEqual([
        {
          source: 'notes',
          excerpt: 'See Project Alpha for the external plan.',
          offset: firstOffset,
        },
        {
          source: 'notes',
          excerpt: 'Alias form Project Alpha should also stay matchable.',
          offset: secondOffset,
        },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('prefers live open-doc content over stale disk content', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-suggest-links-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const hocuspocus = new Hocuspocus({ quiet: true });
    let conn: Conn | null = null;

    try {
      writeFileSync(join(contentDir, 'project-alpha.md'), '# Project Alpha\n', 'utf-8');
      writeFileSync(join(contentDir, 'notes.md'), 'No mention on disk.\n', 'utf-8');

      conn = await hocuspocus.openDirectConnection('notes');
      const doc = getDoc(conn);
      // Seed via applyAgentMarkdownWrite so both XmlFragment and Y.Text are populated
      // (suggest-links reads live state; agent-write path is the post-precedent-#12 template).
      doc.transact(() => {
        applyAgentMarkdownWrite(doc, 'Project Alpha only in live state.\n', 'replace');
      }, AGENT_WRITE_ORIGIN);

      const result = await suggestLinks({
        hocuspocus,
        fileIndex: buildFileIndex(contentDir, ['project-alpha', 'notes']),
        docName: 'project-alpha',
      });

      expect(result.mentions).toEqual([
        {
          source: 'notes',
          excerpt: 'Project Alpha only in live state.',
          offset: 0,
        },
      ]);
    } finally {
      if (conn) await conn.disconnect();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('FR-43: doc-start `---` thematic-break form survives via ytext (discriminating)', async () => {
    // suggest-links read body via `mdManager.serialize(fragment)`.
    // mdast canonicalizes a doc-start `---\n` thematic break to `***\n` on
    // serialize, inserting a blank line because mdast also forces
    // `\n\n` between blocks. A regression to serialize(fragment)-based
    // reading would shift "Project Alpha"'s byte offset by exactly the byte
    // count of that canonicalization difference. Pinning the exact offset
    // catches the regression — angle-bracket autolinks (the existing
    // case) round-trip byte-equal under sourceFidelity attrs and so
    // are NOT discriminating against this class of revert.
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-suggest-links-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const hocuspocus = new Hocuspocus({ quiet: true });
    let conn: Conn | null = null;

    try {
      writeFileSync(join(contentDir, 'project-alpha.md'), '# Project Alpha\n', 'utf-8');
      writeFileSync(join(contentDir, 'notes.md'), 'Stale disk.\n', 'utf-8');

      // Open notes — gives us a live Document. Seed via applyExternalChange
      // (FILE_WATCHER_ORIGIN paired-write) so ytext gets the raw bytes
      // verbatim and fragment derives via parse.
      conn = await hocuspocus.openDirectConnection('notes');
      const doc = getDoc(conn);
      applyExternalChange(hocuspocus, 'notes', '---\n# Notes\n\nProject Alpha discussion.\n');

      // ytext byte-equal: user form preserved.
      const yText = doc.getText('source').toString();
      expect(yText).toBe('---\n# Notes\n\nProject Alpha discussion.\n');

      const result = await suggestLinks({
        hocuspocus,
        fileIndex: buildFileIndex(contentDir, ['project-alpha', 'notes']),
        docName: 'project-alpha',
      });

      expect(result.mentions).toHaveLength(1);
      // Discriminating: in ytext bytes, "Project Alpha" sits at byte 13
      // (after `---\n# Notes\n\n` = 4 + 8 + 1 = 13). In canonical bytes
      // (`***\n\n# Notes\n\nProject Alpha…`), it sits at byte 14 — mdast
      // serialize emits `***\n\n` (extra blank) instead of `---\n` for the
      // doc-start thematic break. A regression to serialize(fragment)
      // makes this assertion fail with offset 14.
      expect(result.mentions[0]?.offset).toBe(13);
      expect(result.mentions[0]?.source).toBe('notes');
    } finally {
      if (conn) await conn.disconnect();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('FR-43: angle-bracket autolink survives in mention excerpt (live doc body via ytext)', async () => {
    // Under the Y.Text-is-truth contract, suggest-links reads body bytes
    // from `Y.Text('source')` directly (matching live-derived-index +
    // persistence). A regression that reverts to `serialize(fragment)`
    // alongside an fidelity-attr regression would surface the
    // canonical `[url](url)` form in the excerpt instead of the user-typed
    // `<url>` autolink — same shape as live-derived-index.test.ts
    // coverage, here verified at the suggest-links surface that consumers
    // actually read.
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-suggest-links-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const hocuspocus = new Hocuspocus({ quiet: true });
    let conn: Conn | null = null;

    try {
      writeFileSync(join(contentDir, 'project-alpha.md'), '# Project Alpha\n', 'utf-8');
      writeFileSync(join(contentDir, 'notes.md'), 'No mention on disk.\n', 'utf-8');

      conn = await hocuspocus.openDirectConnection('notes');
      const doc = getDoc(conn);
      // Body keeps the URL host punctuation-free so the snippet's sentence-
      // boundary truncation (`.` is a stop char in `snippetAround`) does NOT
      // chop the URL mid-host. Mention sits between the URL and the trailing
      // period so leftPunc=-1 and rightPunc=trailing period, capturing the
      // full angle-bracket form in the excerpt.
      doc.transact(() => {
        applyAgentMarkdownWrite(doc, 'Visit <https://example> for Project Alpha.\n', 'replace');
      }, AGENT_WRITE_ORIGIN);

      const result = await suggestLinks({
        hocuspocus,
        fileIndex: buildFileIndex(contentDir, ['project-alpha', 'notes']),
        docName: 'project-alpha',
      });

      expect(result.mentions).toHaveLength(1);
      const excerpt = result.mentions[0]?.excerpt ?? '';
      // Angle-bracket autolink form survives — `<` and `>` reach flatText
      // as plain chars, not stripped as markdown link syntax.
      expect(excerpt).toContain('<https://example>');
      // Canonical `[url](url)` form would have stripped the angle brackets
      // (Markdown link readers extract only the visible text). Asserting
      // its absence catches regressions that route body through serialize
      // canonicalization instead of raw ytext.
      expect(excerpt).not.toContain('](https://example)');
    } finally {
      if (conn) await conn.disconnect();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('orders results by mention density then source name', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-suggest-links-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const hocuspocus = new Hocuspocus({ quiet: true });

    try {
      writeFileSync(join(contentDir, 'project-alpha.md'), '# Project Alpha\n', 'utf-8');
      writeFileSync(
        join(contentDir, 'alpha.md'),
        'Project Alpha once. Project Alpha twice.\n',
        'utf-8',
      );
      writeFileSync(
        join(contentDir, 'beta.md'),
        'Project Alpha one. Project Alpha two.\n',
        'utf-8',
      );
      writeFileSync(join(contentDir, 'zeta.md'), 'Project Alpha only.\n', 'utf-8');

      const result = await suggestLinks({
        hocuspocus,
        fileIndex: buildFileIndex(contentDir, ['project-alpha', 'alpha', 'beta', 'zeta']),
        docName: 'project-alpha',
      });

      expect(result.mentions.map((mention) => mention.source)).toEqual([
        'alpha',
        'alpha',
        'beta',
        'beta',
        'zeta',
      ]);
      expect(result.mentions.map((mention) => mention.offset)).toEqual([0, 20, 0, 19, 0]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('returns partial ordered results and scan observations when budget is exceeded', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-suggest-links-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const hocuspocus = new Hocuspocus({ quiet: true });
    const observations: Array<{
      durationMs: number;
      corpusDocCount: number;
      candidateCount: number;
      truncated: boolean;
    }> = [];
    const nowValues = [0, 0, 600, 600];

    try {
      writeFileSync(join(contentDir, 'project-alpha.md'), '# Project Alpha\n', 'utf-8');
      writeFileSync(join(contentDir, 'alpha.md'), 'Project Alpha first.\n', 'utf-8');
      writeFileSync(join(contentDir, 'beta.md'), 'Project Alpha second.\n', 'utf-8');

      const result = await suggestLinks({
        hocuspocus,
        fileIndex: buildFileIndex(contentDir, ['project-alpha', 'alpha', 'beta']),
        docName: 'project-alpha',
        scanBudgetMs: 500,
        now: () => nowValues.shift() ?? 600,
        onComplete: (observation) => observations.push(observation),
      });

      expect(result.truncated).toBe(true);
      expect(result.mentions.map((mention) => mention.source)).toEqual(['alpha']);
      expect(observations).toEqual([
        {
          durationMs: 600,
          corpusDocCount: 2,
          candidateCount: 1,
          truncated: true,
        },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('returns an empty success result when no candidates exist', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-suggest-links-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const hocuspocus = new Hocuspocus({ quiet: true });

    try {
      writeFileSync(join(contentDir, 'project-alpha.md'), '# Project Alpha\n', 'utf-8');
      writeFileSync(join(contentDir, 'notes.md'), 'No relevant content here.\n', 'utf-8');

      const result = await suggestLinks({
        hocuspocus,
        fileIndex: buildFileIndex(contentDir, ['project-alpha', 'notes']),
        docName: 'project-alpha',
      });

      expect(result.truncated).toBe(false);
      expect(result.mentions).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
