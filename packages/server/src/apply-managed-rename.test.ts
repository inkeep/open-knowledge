import { describe, expect, test } from 'vitest';
import {
  applyRenameMap,
  buildRenameMap,
  ManagedRenameCollisionError,
} from './apply-managed-rename.ts';
import { createWikiRenameContext } from './managed-rename-rewrite.ts';

function rewriteInCorpus(content: string, source: string, renames: ReadonlyMap<string, string>) {
  return applyRenameMap(
    content,
    source,
    createWikiRenameContext([source, ...renames.keys()], renames),
  );
}

describe('buildRenameMap — collision detection', () => {
  test('builds a map for non-colliding entries', () => {
    const map = buildRenameMap([
      { from: 'a', to: 'b' },
      { from: 'c', to: 'd' },
    ]);
    expect(map.size).toBe(2);
    expect(map.get('a')).toBe('b');
    expect(map.get('c')).toBe('d');
  });

  test('handles a swap cycle without collision (different sources, different destinations)', () => {
    const map = buildRenameMap([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ]);
    expect(map.size).toBe(2);
    expect(map.get('a')).toBe('b');
    expect(map.get('b')).toBe('a');
  });

  test('throws ManagedRenameCollisionError when two entries share a destination', () => {
    expect(() =>
      buildRenameMap([
        { from: 'a', to: 'shared' },
        { from: 'b', to: 'shared' },
      ]),
    ).toThrow(ManagedRenameCollisionError);
  });

  test('collision error carries the colliding paths', () => {
    let error: ManagedRenameCollisionError | undefined;
    try {
      buildRenameMap([
        { from: 'a', to: 'shared' },
        { from: 'b', to: 'shared' },
      ]);
    } catch (e) {
      if (e instanceof ManagedRenameCollisionError) error = e;
    }
    expect(error).toBeDefined();
    expect(error?.colliding).toEqual([{ existing: 'a', incoming: 'b', to: 'shared' }]);
  });

  test('collision error message includes the colliding paths', () => {
    try {
      buildRenameMap([
        { from: 'articles/x', to: 'essays/x' },
        { from: 'notes/x', to: 'essays/x' },
      ]);
      throw new Error('expected ManagedRenameCollisionError');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain('articles/x');
      expect(msg).toContain('notes/x');
      expect(msg).toContain('essays/x');
    }
  });

  test('multiple entries collide on different destinations — all reported', () => {
    let error: ManagedRenameCollisionError | undefined;
    try {
      buildRenameMap([
        { from: 'a', to: 'x' },
        { from: 'b', to: 'x' },
        { from: 'c', to: 'y' },
        { from: 'd', to: 'y' },
      ]);
    } catch (e) {
      if (e instanceof ManagedRenameCollisionError) error = e;
    }
    expect(error?.colliding).toHaveLength(2);
  });
});

describe('applyRenameMap — single-entry rewrites', () => {
  test('rewrites wiki-links for a single entry', () => {
    const result = rewriteInCorpus(
      'See [[old-page]] and [[other]].\n',
      'source',
      new Map([['old-page', 'new-page']]),
    );
    expect(result.markdown).toBe('See [[new-page|old-page]] and [[other]].\n');
    expect(result.rewrites).toBe(1);
  });

  test('rewrites does not touch unrelated content', () => {
    const result = rewriteInCorpus(
      '# Title\n\nNo links here.\n',
      'source',
      new Map([['old', 'new']]),
    );
    expect(result.markdown).toBe('# Title\n\nNo links here.\n');
    expect(result.rewrites).toBe(0);
  });

  test('skips identity entries (from === to)', () => {
    const result = rewriteInCorpus('See [[same]].\n', 'source', new Map([['same', 'same']]));
    expect(result.markdown).toBe('See [[same]].\n');
    expect(result.rewrites).toBe(0);
  });
});

describe('applyRenameMap — multi-entry rewrites', () => {
  test('rewrites all entries in a multi-entry map', () => {
    const result = rewriteInCorpus(
      'See [[A]] and [[B]] and [[C]].\n',
      'source',
      new Map([
        ['A', 'X'],
        ['B', 'Y'],
        ['C', 'Z'],
      ]),
    );
    expect(result.markdown).toBe('See [[X|A]] and [[Y|B]] and [[Z|C]].\n');
    expect(result.rewrites).toBe(3);
  });

  test('swap cycle ({A→B, B→A}) preserves destinations and display text', () => {
    const result = rewriteInCorpus(
      'See [[A]] and [[B]].\n',
      'source',
      new Map([
        ['A', 'B'],
        ['B', 'A'],
      ]),
    );
    expect(result.markdown).toBe('See [[B|A]] and [[A|B]].\n');
    expect(result.rewrites).toBe(2);
  });

  test('swap cycle with multiple references each preserves both directions', () => {
    const result = rewriteInCorpus(
      'A1: [[A]]\nA2: [[A]]\nB1: [[B]]\nB2: [[B]]\n',
      'source',
      new Map([
        ['A', 'B'],
        ['B', 'A'],
      ]),
    );
    expect(result.markdown).toBe('A1: [[B|A]]\nA2: [[B|A]]\nB1: [[A|B]]\nB2: [[A|B]]\n');
    expect(result.rewrites).toBe(4);
  });

  test('three-way cycle ({A→B, B→C, C→A}) preserves correct mapping', () => {
    const result = rewriteInCorpus(
      '[[A]] [[B]] [[C]]\n',
      'source',
      new Map([
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'A'],
      ]),
    );
    expect(result.markdown).toBe('[[B|A]] [[C|B]] [[A|C]]\n');
    expect(result.rewrites).toBe(3);
  });

  test('counts each wiki link once across a multi-entry rename', () => {
    const result = rewriteInCorpus(
      'See [[A]] [[A]] [[B]].\n',
      'source',
      new Map([
        ['A', 'X'],
        ['B', 'Y'],
      ]),
    );
    expect(result.markdown).toBe('See [[X|A]] [[X|A]] [[Y|B]].\n');
    expect(result.rewrites).toBe(3);
  });

  test('preserves frontmatter unchanged across rewrites', () => {
    const result = rewriteInCorpus(
      `---\ntitle: Doc\n---\n\nSee [[A]].\n`,
      'source',
      new Map([['A', 'X']]),
    );
    expect(result.markdown).toBe(`---\ntitle: Doc\n---\n\nSee [[X|A]].\n`);
    expect(result.rewrites).toBe(1);
  });

  test('rewrites Mirror src for a renamed source doc', () => {
    const result = rewriteInCorpus(
      '<Mirror src="api-spec" anchor="intro" />\n',
      'viewer-doc',
      new Map([['api-spec', 'api-reference']]),
    );
    expect(result.markdown).toBe('<Mirror src="api-reference" anchor="intro" />\n');
    expect(result.rewrites).toBe(1);
  });

  test('rewrites Mirror src alongside wiki + markdown links in the same body', () => {
    const result = rewriteInCorpus(
      'See [[api-spec]] and [docs](./api-spec.md):\n<Mirror src="api-spec" anchor="dep" />\n',
      'viewer-doc',
      new Map([['api-spec', 'api-reference']]),
    );
    expect(result.markdown).toBe(
      'See [[api-reference|api-spec]] and [docs](./api-reference.md):\n<Mirror src="api-reference" anchor="dep" />\n',
    );
    expect(result.rewrites).toBe(3);
  });

  test('Mirror rewrite cooperates with frontmatter strip', () => {
    const result = rewriteInCorpus(
      `---\ntitle: Doc\n---\n\n<Mirror src="A" anchor="x" />\n`,
      'source',
      new Map([['A', 'B']]),
    );
    expect(result.markdown).toBe(`---\ntitle: Doc\n---\n\n<Mirror src="B" anchor="x" />\n`);
    expect(result.rewrites).toBe(1);
  });

  test('rewrites a doc-relative Excalidraw src for a renamed board', () => {
    const result = rewriteInCorpus(
      '<Excalidraw src="board.excalidraw" />\n',
      'notes/index',
      new Map([['notes/board.excalidraw', 'notes/sketch.excalidraw']]),
    );
    expect(result.markdown).toBe('<Excalidraw src="sketch.excalidraw" />\n');
    expect(result.rewrites).toBe(1);
  });

  test('self-rename recomputes a doc-relative Excalidraw src for the new location', () => {
    const result = rewriteInCorpus(
      '<Excalidraw src="board.excalidraw" />\n',
      'notes/index',
      new Map([['notes/index', 'archive/index']]),
    );
    expect(result.markdown).toBe('<Excalidraw src="../notes/board.excalidraw" />\n');
    expect(result.rewrites).toBe(1);
  });

  test('folder move carrying both doc and board keeps the doc-relative src stable', () => {
    const result = rewriteInCorpus(
      '<Excalidraw src="board.excalidraw" />\n',
      'notes/index',
      new Map([
        ['notes/index', 'archive/index'],
        ['notes/board.excalidraw', 'archive/board.excalidraw'],
      ]),
    );
    expect(result.markdown).toBe('<Excalidraw src="board.excalidraw" />\n');
  });
});

describe('applyRenameMap — outbound link recomputation when source doc moves', () => {
  test('recomputes outbound markdown link to non-renamed target when source moves folders', () => {
    const result = rewriteInCorpus(
      'See [Picasso](./picasso.md).\n',
      'artists/some-file',
      new Map([['artists/some-file', 'venues/some-file']]),
    );
    expect(result.markdown).toBe('See [Picasso](../artists/picasso.md).\n');
    expect(result.rewrites).toBe(1);
  });

  test('recomputes multiple outbound markdown links in one body', () => {
    const result = rewriteInCorpus(
      ['# Header', '', '[A](./a.md), [B](./b.md), and [C](../shared/c.md)', ''].join('\n'),
      'artists/some-file',
      new Map([['artists/some-file', 'venues/some-file']]),
    );
    expect(result.markdown).toBe(
      [
        '# Header',
        '',
        '[A](../artists/a.md), [B](../artists/b.md), and [C](../shared/c.md)',
        '',
      ].join('\n'),
    );
    expect(result.rewrites).toBe(2);
  });

  test('preserves anchors and query strings on outbound recomputation', () => {
    const result = rewriteInCorpus(
      'See [Section](./other.md#install?tab=api).\n',
      'artists/some-file',
      new Map([['artists/some-file', 'venues/some-file']]),
    );
    expect(result.markdown).toBe('See [Section](../artists/other.md#install?tab=api).\n');
    expect(result.rewrites).toBe(1);
  });

  test('preserves .mdx extension on outbound recomputation', () => {
    const result = rewriteInCorpus(
      'See [Component](./widget.mdx).\n',
      'artists/some-file',
      new Map([['artists/some-file', 'venues/some-file']]),
    );
    expect(result.markdown).toBe('See [Component](../artists/widget.mdx).\n');
    expect(result.rewrites).toBe(1);
  });

  test('preserves angle brackets on outbound recomputation', () => {
    const result = rewriteInCorpus(
      'See [Spaced](<./other.md>).\n',
      'artists/some-file',
      new Map([['artists/some-file', 'venues/some-file']]),
    );
    expect(result.markdown).toBe('See [Spaced](<../artists/other.md>).\n');
    expect(result.rewrites).toBe(1);
  });

  test('leaves external URLs, anchor-only links, and root-absolute links unchanged', () => {
    const result = rewriteInCorpus(
      [
        '[Ext](https://example.com)',
        '[Anchor](#section)',
        '[Mailto](mailto:hi@example.com)',
        '[Abs](/docs/foo.md)',
        '',
      ].join('\n'),
      'artists/some-file',
      new Map([['artists/some-file', 'venues/some-file']]),
    );
    expect(result.markdown).toBe(
      [
        '[Ext](https://example.com)',
        '[Anchor](#section)',
        '[Mailto](mailto:hi@example.com)',
        '[Abs](/docs/foo.md)',
        '',
      ].join('\n'),
    );
    expect(result.rewrites).toBe(0);
  });

  test('skips outbound recomputation inside fenced code blocks', () => {
    const result = rewriteInCorpus(
      ['```md', '[Code](./other.md)', '```', '', '[Real](./other.md)', ''].join('\n'),
      'artists/some-file',
      new Map([['artists/some-file', 'venues/some-file']]),
    );
    expect(result.markdown).toBe(
      ['```md', '[Code](./other.md)', '```', '', '[Real](../artists/other.md)', ''].join('\n'),
    );
    expect(result.rewrites).toBe(1);
  });

  test('skips outbound recomputation inside inline code spans', () => {
    const result = rewriteInCorpus(
      'Inline `[Skip](./other.md)` and live [Real](./other.md).\n',
      'artists/some-file',
      new Map([['artists/some-file', 'venues/some-file']]),
    );
    expect(result.markdown).toBe(
      'Inline `[Skip](./other.md)` and live [Real](../artists/other.md).\n',
    );
    expect(result.rewrites).toBe(1);
  });

  test('same-folder rename leaves outbound markdown links untouched', () => {
    const result = rewriteInCorpus(
      'See [Picasso](./picasso.md).\n',
      'artists/some-file',
      new Map([['artists/some-file', 'artists/some-other-file']]),
    );
    expect(result.markdown).toBe('See [Picasso](./picasso.md).\n');
    expect(result.rewrites).toBe(0);
  });

  test('source moves AND target also renamed — both rewrites compose correctly', () => {
    const result = rewriteInCorpus(
      'See [Picasso](./picasso.md).\n',
      'artists/some-file',
      new Map([
        ['artists/some-file', 'venues/some-file'],
        ['artists/picasso', 'galleries/picasso'],
      ]),
    );
    expect(result.markdown).toBe('See [Picasso](../galleries/picasso.md).\n');
    expect(result.rewrites).toBe(2);
  });

  test('moved doc with self-link resolves correctly post-move', () => {
    const result = rewriteInCorpus(
      '[self](./some-file.md)\n',
      'artists/some-file',
      new Map([['artists/some-file', 'venues/some-file']]),
    );
    expect(result.markdown).toContain('some-file.md');
    expect(result.rewrites).toBeGreaterThan(0);
    expect(result.markdown).not.toContain('../artists/some-file');
  });

  test('image refs are handled by the self-rename pass (not double-recomputed)', () => {
    const result = rewriteInCorpus(
      '![first draft](first-draft.png)\n',
      'docs/meeting-notes',
      new Map([['docs/meeting-notes', 'archive/2026/meeting-notes']]),
    );
    expect(result.markdown).toBe('![first draft](../../docs/first-draft.png)\n');
    expect(result.rewrites).toBe(1);
  });
});

describe('applyRenameMap across canonically equivalent spellings', () => {
  test('an NFC markdown link to an NFD document is rewritten when that document is renamed', () => {
    const nfd = 'people/Rene\u0301';
    const result = rewriteInCorpus(
      'See [R](./people/Ren\u00e9.md) and [[people/Ren\u00e9]].\n',
      'notes',
      new Map([[nfd, 'archive/Rene\u0301']]),
    );
    expect(result).toEqual({
      markdown: 'See [R](./archive/Rene%CC%81.md) and [[archive/Rene\u0301|people/Ren\u00e9]].\n',
      rewrites: 2,
    });
  });
});
