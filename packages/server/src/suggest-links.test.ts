import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hocuspocus } from '@hocuspocus/server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type * as Y from 'yjs';
import { AGENT_WRITE_ORIGIN, applyAgentMarkdownWrite } from './agent-sessions.ts';
import { DocumentDurabilityState } from './document-durability-state.ts';
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
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-suggest-links-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const hocuspocus = new Hocuspocus({ quiet: true });
    const durabilityState = new DocumentDurabilityState();
    let conn: Conn | null = null;

    try {
      writeFileSync(join(contentDir, 'project-alpha.md'), '# Project Alpha\n', 'utf-8');
      writeFileSync(join(contentDir, 'notes.md'), 'Stale disk.\n', 'utf-8');

      conn = await hocuspocus.openDirectConnection('notes');
      const doc = getDoc(conn);
      applyExternalChange(
        durabilityState,
        hocuspocus,
        'notes',
        '---\n# Notes\n\nProject Alpha discussion.\n',
      );

      const yText = doc.getText('source').toString();
      expect(yText).toBe('---\n# Notes\n\nProject Alpha discussion.\n');

      const result = await suggestLinks({
        hocuspocus,
        fileIndex: buildFileIndex(contentDir, ['project-alpha', 'notes']),
        docName: 'project-alpha',
      });

      expect(result.mentions).toHaveLength(1);
      expect(result.mentions[0]?.offset).toBe(13);
      expect(result.mentions[0]?.source).toBe('notes');
    } finally {
      if (conn) await conn.disconnect();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('FR-43: angle-bracket autolink survives in mention excerpt (live doc body via ytext)', async () => {
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
      expect(excerpt).toContain('<https://example>');
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
