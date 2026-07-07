import { describe, expect, test } from 'bun:test';
import {
  applyRenameMap,
  buildRenameMap,
  ManagedRenameCollisionError,
} from './apply-managed-rename.ts';

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
    const result = applyRenameMap(
      'See [[old-page]] and [[other]].\n',
      'source',
      new Map([['old-page', 'new-page']]),
    );
    expect(result.markdown).toBe('See [[new-page]] and [[other]].\n');
    expect(result.rewrites).toBe(1);
  });

  test('rewrites does not touch unrelated content', () => {
    const result = applyRenameMap(
      '# Title\n\nNo links here.\n',
      'source',
      new Map([['old', 'new']]),
    );
    expect(result.markdown).toBe('# Title\n\nNo links here.\n');
    expect(result.rewrites).toBe(0);
  });

  test('skips identity entries (from === to)', () => {
    const result = applyRenameMap('See [[same]].\n', 'source', new Map([['same', 'same']]));
    expect(result.markdown).toBe('See [[same]].\n');
    expect(result.rewrites).toBe(0);
  });
});

describe('applyRenameMap — multi-entry rewrites', () => {
  test('rewrites all entries in a multi-entry map', () => {
    const result = applyRenameMap(
      'See [[A]] and [[B]] and [[C]].\n',
      'source',
      new Map([
        ['A', 'X'],
        ['B', 'Y'],
        ['C', 'Z'],
      ]),
    );
    expect(result.markdown).toBe('See [[X]] and [[Y]] and [[Z]].\n');
    expect(result.rewrites).toBe(3);
  });

  test('swap cycle ({A→B, B→A}) produces correct output via placeholder-substitute', () => {
    const result = applyRenameMap(
      'See [[A]] and [[B]].\n',
      'source',
      new Map([
        ['A', 'B'],
        ['B', 'A'],
      ]),
    );
    expect(result.markdown).toBe('See [[B]] and [[A]].\n');
    expect(result.rewrites).toBe(2);
  });

  test('swap cycle with multiple references each preserves both directions', () => {
    const result = applyRenameMap(
      'A1: [[A]]\nA2: [[A]]\nB1: [[B]]\nB2: [[B]]\n',
      'source',
      new Map([
        ['A', 'B'],
        ['B', 'A'],
      ]),
    );
    expect(result.markdown).toBe('A1: [[B]]\nA2: [[B]]\nB1: [[A]]\nB2: [[A]]\n');
    expect(result.rewrites).toBe(4);
  });

  test('three-way cycle ({A→B, B→C, C→A}) preserves correct mapping', () => {
    const result = applyRenameMap(
      '[[A]] [[B]] [[C]]\n',
      'source',
      new Map([
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'A'],
      ]),
    );
    expect(result.markdown).toBe('[[B]] [[C]] [[A]]\n');
    expect(result.rewrites).toBe(3);
  });

  test('rewrites count is Phase 1 only — Phase 2 unwrap does not double-count', () => {
    const result = applyRenameMap(
      'See [[A]] [[A]] [[B]].\n',
      'source',
      new Map([
        ['A', 'X'],
        ['B', 'Y'],
      ]),
    );
    expect(result.markdown).toBe('See [[X]] [[X]] [[Y]].\n');
    expect(result.rewrites).toBe(3);
  });

  test('preserves frontmatter unchanged across rewrites', () => {
    const result = applyRenameMap(
      `---\ntitle: Doc\n---\n\nSee [[A]].\n`,
      'source',
      new Map([['A', 'X']]),
    );
    expect(result.markdown).toBe(`---\ntitle: Doc\n---\n\nSee [[X]].\n`);
    expect(result.rewrites).toBe(1);
  });

  // The Mirror rewrite is unit-tested in managed-rename-rewrite.test.ts
  // (handler isolation). These tests pin the WIRING into `applyRenameMap`'s
  // pass chain — frontmatter strip / pass ordering / placeholder cycle — so
  // a regression in chaining-order can't silently leave Mirrors un-rewritten.
  test('rewrites Mirror src for a renamed source doc', () => {
    const result = applyRenameMap(
      '<Mirror src="api-spec" anchor="intro" />\n',
      'viewer-doc',
      new Map([['api-spec', 'api-reference']]),
    );
    expect(result.markdown).toBe('<Mirror src="api-reference" anchor="intro" />\n');
    expect(result.rewrites).toBe(1);
  });

  test('rewrites Mirror src alongside wiki + markdown links in the same body', () => {
    const result = applyRenameMap(
      'See [[api-spec]] and [docs](./api-spec.md):\n<Mirror src="api-spec" anchor="dep" />\n',
      'viewer-doc',
      new Map([['api-spec', 'api-reference']]),
    );
    expect(result.markdown).toBe(
      'See [[api-reference]] and [docs](./api-reference.md):\n<Mirror src="api-reference" anchor="dep" />\n',
    );
    expect(result.rewrites).toBe(3);
  });

  test('Mirror rewrite cooperates with frontmatter strip', () => {
    const result = applyRenameMap(
      `---\ntitle: Doc\n---\n\n<Mirror src="A" anchor="x" />\n`,
      'source',
      new Map([['A', 'B']]),
    );
    expect(result.markdown).toBe(`---\ntitle: Doc\n---\n\n<Mirror src="B" anchor="x" />\n`);
    expect(result.rewrites).toBe(1);
  });
});

describe('applyRenameMap — outbound link recomputation when source doc moves', () => {
  // The doc whose body we are rewriting is itself in the renameMap and its
  // dirname changes. Markdown links to NON-renamed targets must be
  // re-relativized so they still point at the same doc after the move.

  test('recomputes outbound markdown link to non-renamed target when source moves folders', () => {
    const result = applyRenameMap(
      'See [Picasso](./picasso.md).\n',
      'artists/some-file',
      new Map([['artists/some-file', 'venues/some-file']]),
    );
    expect(result.markdown).toBe('See [Picasso](../artists/picasso.md).\n');
    expect(result.rewrites).toBe(1);
  });

  test('recomputes multiple outbound markdown links in one body', () => {
    // `[C](../shared/c.md)` from 'artists/' resolves to 'shared/c'; from
    // 'venues/' the relative path is the same '../shared/c.md', so it does
    // NOT count as a rewrite even though the function visits it.
    const result = applyRenameMap(
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
    const result = applyRenameMap(
      'See [Section](./other.md#install?tab=api).\n',
      'artists/some-file',
      new Map([['artists/some-file', 'venues/some-file']]),
    );
    expect(result.markdown).toBe('See [Section](../artists/other.md#install?tab=api).\n');
    expect(result.rewrites).toBe(1);
  });

  test('preserves .mdx extension on outbound recomputation', () => {
    const result = applyRenameMap(
      'See [Component](./widget.mdx).\n',
      'artists/some-file',
      new Map([['artists/some-file', 'venues/some-file']]),
    );
    expect(result.markdown).toBe('See [Component](../artists/widget.mdx).\n');
    expect(result.rewrites).toBe(1);
  });

  test('preserves angle brackets on outbound recomputation', () => {
    const result = applyRenameMap(
      'See [Spaced](<./other.md>).\n',
      'artists/some-file',
      new Map([['artists/some-file', 'venues/some-file']]),
    );
    expect(result.markdown).toBe('See [Spaced](<../artists/other.md>).\n');
    expect(result.rewrites).toBe(1);
  });

  test('leaves external URLs, anchor-only links, and root-absolute links unchanged', () => {
    const result = applyRenameMap(
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
    const result = applyRenameMap(
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
    const result = applyRenameMap(
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
    // Just a basename change in the same folder — outbound paths still
    // resolve correctly relative to the new name. The rename-target spine
    // doesn't fire here because no link points at the renamed source.
    const result = applyRenameMap(
      'See [Picasso](./picasso.md).\n',
      'artists/some-file',
      new Map([['artists/some-file', 'artists/some-other-file']]),
    );
    expect(result.markdown).toBe('See [Picasso](./picasso.md).\n');
    expect(result.rewrites).toBe(0);
  });

  test('source moves AND target also renamed — both rewrites compose correctly', () => {
    // 'artists/some-file' moves to 'venues/some-file' and 'artists/picasso'
    // is concurrently renamed to 'galleries/picasso' (folder rename of
    // siblings). The outbound link must point at the target's NEW location
    // from the source's NEW location.
    const result = applyRenameMap(
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
    // Self-link in the moved doc — pass 1 rewrites it (target == self,
    // matches the rename), pass 2 re-relativizes the result. Final href
    // resolves back to the doc's new location.
    const result = applyRenameMap(
      '[self](./some-file.md)\n',
      'artists/some-file',
      new Map([['artists/some-file', 'venues/some-file']]),
    );
    // Path resolves to 'venues/some-file' from 'venues/' — valid self-link.
    expect(result.markdown).toContain('some-file.md');
    expect(result.rewrites).toBeGreaterThan(0);
    // Sanity: no '../artists/' leakage to a stale folder.
    expect(result.markdown).not.toContain('../artists/some-file');
  });

  test('image refs are handled by the self-rename pass (not double-recomputed)', () => {
    // Regression guard for the placeholder-cycle bug: feeding the image
    // recompute through (current → placeholder) then (placeholder →
    // newName) would corrupt the path arithmetic. The fix routes the
    // self-rename through one direct pass with the real (old, new) pair.
    const result = applyRenameMap(
      '![first draft](first-draft.png)\n',
      'docs/meeting-notes',
      new Map([['docs/meeting-notes', 'archive/2026/meeting-notes']]),
    );
    expect(result.markdown).toBe('![first draft](../../docs/first-draft.png)\n');
    expect(result.rewrites).toBe(1);
  });
});
