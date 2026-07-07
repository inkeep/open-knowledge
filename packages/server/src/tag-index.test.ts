import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TagIndex } from './tag-index.ts';

function tempContentDir(): { contentDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ok-tag-index-'));
  return {
    contentDir: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('TagIndex', () => {
  test('indexes a single doc with inline tags', () => {
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown('alpha', 'A note on #typescript and #react.\n');
      expect(idx.getDocsForTag('typescript')).toEqual(['alpha']);
      expect(idx.getDocsForTag('react')).toEqual(['alpha']);
      expect(idx.getDocsForTag('nope')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('indexes a doc with frontmatter-only tags', () => {
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown(
        'alpha',
        '---\ntitle: Hello\ntags: [showcase, demo]\n---\nBody with no inline tags.\n',
      );
      expect(idx.getDocsForTag('showcase')).toEqual(['alpha']);
      expect(idx.getDocsForTag('demo')).toEqual(['alpha']);
    } finally {
      cleanup();
    }
  });

  test('merges inline + frontmatter tags into the same index', () => {
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown('alpha', '---\ntags: [showcase]\n---\nInline #demo here.\n');
      expect(idx.getDocsForTag('showcase')).toEqual(['alpha']);
      expect(idx.getDocsForTag('demo')).toEqual(['alpha']);
    } finally {
      cleanup();
    }
  });

  test('hierarchy rollup — clicking the parent finds docs registered under children', () => {
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown('alpha', '#proj/team/2026 doc body.\n');
      // Direct hit
      expect(idx.getDocsForTag('proj/team/2026')).toEqual(['alpha']);
      // Rollup hits at every prefix level
      expect(idx.getDocsForTag('proj/team')).toEqual(['alpha']);
      expect(idx.getDocsForTag('proj')).toEqual(['alpha']);
    } finally {
      cleanup();
    }
  });

  test('deleteDocument cleans up forward + reverse maps', () => {
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown('alpha', '#typescript #proj/team\n');
      idx.updateDocumentFromMarkdown('beta', '#typescript\n');
      expect(idx.getDocsForTag('typescript').sort()).toEqual(['alpha', 'beta']);
      idx.deleteDocument('alpha');
      expect(idx.getDocsForTag('typescript')).toEqual(['beta']);
      // proj/* was alpha-only; should disappear entirely
      expect(idx.getDocsForTag('proj')).toEqual([]);
      expect(idx.getDocsForTag('proj/team')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('updateDocumentFromMarkdown removes prior tags that no longer appear', () => {
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown('alpha', '#one #two #three\n');
      expect(idx.getDocsForTag('two')).toEqual(['alpha']);
      idx.updateDocumentFromMarkdown('alpha', '#one\n');
      expect(idx.getDocsForTag('one')).toEqual(['alpha']);
      expect(idx.getDocsForTag('two')).toEqual([]);
      expect(idx.getDocsForTag('three')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('getAllTags reports counts and leaf detection', () => {
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown('alpha', '#proj/team/2026\n');
      idx.updateDocumentFromMarkdown('beta', '#proj/team/2027\n');
      idx.updateDocumentFromMarkdown('gamma', '#standalone\n');

      const all = idx.getAllTags();
      const byName = new Map(all.map((t) => [t.name, t]));

      // proj has both alpha + beta via rollup
      expect(byName.get('proj')).toEqual({ name: 'proj', count: 2, isLeaf: false });
      expect(byName.get('proj/team')).toEqual({ name: 'proj/team', count: 2, isLeaf: false });
      expect(byName.get('proj/team/2026')).toEqual({
        name: 'proj/team/2026',
        count: 1,
        isLeaf: true,
      });
      expect(byName.get('proj/team/2027')).toEqual({
        name: 'proj/team/2027',
        count: 1,
        isLeaf: true,
      });
      expect(byName.get('standalone')).toEqual({ name: 'standalone', count: 1, isLeaf: true });

      // Sorted lexicographically
      expect(all.map((t) => t.name)).toEqual([
        'proj',
        'proj/team',
        'proj/team/2026',
        'proj/team/2027',
        'standalone',
      ]);
    } finally {
      cleanup();
    }
  });

  test('empty content yields empty index', () => {
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown('alpha', 'No tags here at all.\n');
      expect(idx.getAllTags()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('skips tags inside fenced code blocks', () => {
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown(
        'alpha',
        'Real tag #realtag\n```\n#fenced not a tag\n```\nAfter fence #after.\n',
      );
      expect(idx.getDocsForTag('realtag')).toEqual(['alpha']);
      expect(idx.getDocsForTag('after')).toEqual(['alpha']);
      expect(idx.getDocsForTag('fenced')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('does not index `#tag` inside inline code', () => {
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown('alpha', 'Use `#config` not #realtag here.\n');
      expect(idx.getDocsForTag('config')).toEqual([]);
      expect(idx.getDocsForTag('realtag')).toEqual(['alpha']);
    } finally {
      cleanup();
    }
  });

  test('inline-code stripping follows CommonMark §6.1 (no backslash escape inside spans)', () => {
    // Per CommonMark, backslash is NOT a meaningful escape inside a code
    // span — only the backtick run delimits. So `` `a\` `` is a complete
    // code span with content `a\`, and what follows (`b\` and a stray
    // backtick) is plain text. A `#tag` in that trailing text MUST be
    // indexed. The earlier escape-aware regex would have swallowed the
    // entire `` `a\`b` `` as one span, hiding the tag.
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown('alpha', 'span `a\\` then #realtag` end\n');
      expect(idx.getDocsForTag('realtag')).toEqual(['alpha']);
    } finally {
      cleanup();
    }
  });

  test('fence with info string opener does not close on a same-info-string line', () => {
    // CommonMark: closing fence is the marker char repeated, with NO info
    // string. An opener of ```python is closed only by ```/```` (or longer)
    // followed by optional whitespace — not by another ```python line.
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown(
        'alpha',
        '```python\n#fenced1\n```python\n#fenced2\n```\n#realtag after.\n',
      );
      expect(idx.getDocsForTag('fenced1')).toEqual([]);
      expect(idx.getDocsForTag('fenced2')).toEqual([]);
      expect(idx.getDocsForTag('realtag')).toEqual(['alpha']);
    } finally {
      cleanup();
    }
  });

  test('init walks contentDir and indexes every md/mdx file', async () => {
    const { contentDir, cleanup } = tempContentDir();
    try {
      writeFileSync(join(contentDir, 'alpha.md'), '#typescript\n', 'utf-8');
      writeFileSync(join(contentDir, 'beta.mdx'), '#react\n', 'utf-8');
      mkdirSync(join(contentDir, 'sub'));
      writeFileSync(join(contentDir, 'sub', 'gamma.md'), '#proj/team\n', 'utf-8');

      const idx = new TagIndex({ contentDir });
      await idx.init();

      expect(idx.getDocsForTag('typescript')).toEqual(['alpha']);
      expect(idx.getDocsForTag('react')).toEqual(['beta']);
      expect(idx.getDocsForTag('proj').map((d) => d.replace(/\\/g, '/'))).toEqual(['sub/gamma']);
      expect(idx.getDocsForTag('proj/team').map((d) => d.replace(/\\/g, '/'))).toEqual([
        'sub/gamma',
      ]);
    } finally {
      cleanup();
    }
  });

  test('synthetic doc names are short-circuited', () => {
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown('__system__', '#sys\n');
      idx.updateDocumentFromMarkdown('__config__/project', '#cfg\n');
      expect(idx.getDocsForTag('sys')).toEqual([]);
      expect(idx.getDocsForTag('cfg')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  // Managed-artifact docs (skills/templates) participate in the link-axis
  // indexes exactly like files — the gate excludes system + config only, not
  // tree-hidden docs. Pairs with the synthetic short-circuit test to pin
  // the two-axis split (tree-axis hides them from the file tree; link-axis
  // still indexes their tags/backlinks). Mirrors the backlink + live-derived
  // indexes' use of isLinkIndexExcludedDoc.
  test('managed-artifact docs are indexed for tags', () => {
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown('__skill__/project/my-skill', '#authoring guidance\n');
      idx.updateDocumentFromMarkdown('__template__/docs/my-template', '#scaffold note\n');
      expect(idx.getDocsForTag('authoring')).toEqual(['__skill__/project/my-skill']);
      expect(idx.getDocsForTag('scaffold')).toEqual(['__template__/docs/my-template']);
      idx.deleteDocument('__skill__/project/my-skill');
      expect(idx.getDocsForTag('authoring')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  // Coverage for the dialog-distinguishing path: rolling up under a
  // prefix should expose which authored tag(s) brought each doc in,
  // not just the doc identity. Pins the byDocLiteral secondary index
  // — if it regresses, the dialog's per-doc match chips silently
  // disappear and the rollup becomes invisible.
  test("getDocsForTagWithMatches surfaces each doc's authored tags under the prefix", () => {
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown('alpha', '#frontend/component #frontend/hook\n');
      idx.updateDocumentFromMarkdown('beta', '#frontend\n');
      idx.updateDocumentFromMarkdown('gamma', '#frontend #frontend/util\n');
      const result = idx.getDocsForTagWithMatches('frontend');
      // Sorted by docName; each entry's matchingTags sorted lexicographically.
      expect(result.map((r) => r.docName)).toEqual(['alpha', 'beta', 'gamma']);
      expect(result[0]?.matchingTags).toEqual(['frontend/component', 'frontend/hook']);
      expect(result[1]?.matchingTags).toEqual(['frontend']);
      expect(result[2]?.matchingTags).toEqual(['frontend', 'frontend/util']);
    } finally {
      cleanup();
    }
  });

  test('getDocsForTagWithMatches on a leaf prefix returns the literal tag only', () => {
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown('alpha', '#frontend/component\n');
      const result = idx.getDocsForTagWithMatches('frontend/component');
      expect(result).toEqual([{ docName: 'alpha', matchingTags: ['frontend/component'] }]);
    } finally {
      cleanup();
    }
  });

  test('getDocsForTagWithMatches returns empty array for unknown prefix', () => {
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown('alpha', '#frontend\n');
      expect(idx.getDocsForTagWithMatches('backend')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('renameDocument transfers tags from old name to new name', () => {
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown('alpha', '#frontend/component #typescript\n');
      expect(idx.getDocsForTag('typescript')).toEqual(['alpha']);
      idx.renameDocument('alpha', 'alpha-renamed', '#frontend/component #typescript\n');
      expect(idx.getDocsForTag('typescript')).toEqual(['alpha-renamed']);
      expect(idx.getDocsForTag('frontend')).toEqual(['alpha-renamed']);
      // Old key fully evicted from both maps.
      expect(idx.getDocsForTagWithMatches('frontend').map((r) => r.docName)).toEqual([
        'alpha-renamed',
      ]);
    } finally {
      cleanup();
    }
  });

  test('renameDocument with new content updates the tag set', () => {
    const { contentDir, cleanup } = tempContentDir();
    try {
      const idx = new TagIndex({ contentDir });
      idx.updateDocumentFromMarkdown('alpha', '#one #two\n');
      idx.renameDocument('alpha', 'beta', '#three\n');
      expect(idx.getDocsForTag('one')).toEqual([]);
      expect(idx.getDocsForTag('two')).toEqual([]);
      expect(idx.getDocsForTag('three')).toEqual(['beta']);
    } finally {
      cleanup();
    }
  });
});
