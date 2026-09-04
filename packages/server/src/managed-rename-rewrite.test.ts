import { resolveAssetProjectPath, resolveInternalHref } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  rewriteAssetReferencesForRename,
  rewriteJsxSrcRefsForDocumentRename,
  rewriteMarkdownLinksForDocumentRename,
  rewriteOutboundMarkdownLinksForSourceMove,
  rewriteWikiLinksForDocumentRename,
} from './managed-rename-rewrite.ts';

describe('rewriteWikiLinksForDocumentRename', () => {
  test('rewrites matching wiki-links while preserving alias and anchor', () => {
    expect(
      rewriteWikiLinksForDocumentRename(
        'See [[old#install|Install Guide]] and [[other]].\n',
        'old',
        'new',
      ),
    ).toEqual({
      markdown: 'See [[new#install|Install Guide]] and [[other]].\n',
      rewrites: 1,
    });
  });

  test('preserves escaped wiki-link brackets', () => {
    expect(rewriteWikiLinksForDocumentRename('See \\[[old]] here.\n', 'old', 'new')).toEqual({
      markdown: 'See \\[[old]] here.\n',
      rewrites: 0,
    });
  });

  test('ignores wiki-links inside tilde fences', () => {
    const markdown = ['~~~md', '[[old]]', '~~~', ''].join('\n');
    expect(rewriteWikiLinksForDocumentRename(markdown, 'old', 'new')).toEqual({
      markdown,
      rewrites: 0,
    });
  });

  test('ignores wiki-links inside inline code spans', () => {
    expect(rewriteWikiLinksForDocumentRename('Check `[[old]]` inline.\n', 'old', 'new')).toEqual({
      markdown: 'Check `[[old]]` inline.\n',
      rewrites: 0,
    });
  });

  test('rewrites multiple wiki-links on the same line', () => {
    expect(
      rewriteWikiLinksForDocumentRename('[[old]] and [[old#s]] and [[old|alias]]\n', 'old', 'new'),
    ).toEqual({
      markdown: '[[new]] and [[new#s]] and [[new|alias]]\n',
      rewrites: 3,
    });
  });

  test('rewrites wiki-links after markdown prefixes', () => {
    const markdown = ['- [[old]]', '> [[old]]', '## [[old]]', ''].join('\n');
    expect(rewriteWikiLinksForDocumentRename(markdown, 'old', 'new')).toEqual({
      markdown: ['- [[new]]', '> [[new]]', '## [[new]]', ''].join('\n'),
      rewrites: 3,
    });
  });
});

describe('rewriteMarkdownLinksForDocumentRename', () => {
  test('rewrites matching internal inline markdown links while preserving text and title', () => {
    expect(
      rewriteMarkdownLinksForDocumentRename(
        'See [Install Guide](./old.md#install "Docs") and [Other](./other.md).\n',
        'notes',
        'old',
        'new',
      ),
    ).toEqual({
      markdown: 'See [Install Guide](./new.md#install "Docs") and [Other](./other.md).\n',
      rewrites: 1,
    });
  });

  test('recomputes the relative href when the renamed document moves paths', () => {
    expect(
      rewriteMarkdownLinksForDocumentRename(
        'See [Overview](../old.md#section).\n',
        'folder/page',
        'old',
        'guides/new',
      ),
    ).toEqual({
      markdown: 'See [Overview](../guides/new.md#section).\n',
      rewrites: 1,
    });
  });

  test('leaves unsupported or non-matching link forms unchanged', () => {
    const markdown = [
      'See [External](https://example.com), [Anchor](#section), ![Image](./old.md), [Ref][old], [Other](./other.md), and [Match](../old.md).',
      '',
      '```md',
      '[Code](../old.md)',
      '```',
      '',
      'Inline `[Skip](../old.md)` stays literal.',
    ].join('\n');

    expect(rewriteMarkdownLinksForDocumentRename(markdown, 'folder/page', 'old', 'new')).toEqual({
      markdown: [
        'See [External](https://example.com), [Anchor](#section), ![Image](./old.md), [Ref][old], [Other](./other.md), and [Match](../new.md).',
        '',
        '```md',
        '[Code](../old.md)',
        '```',
        '',
        'Inline `[Skip](../old.md)` stays literal.',
      ].join('\n'),
      rewrites: 1,
    });
  });

  test('preserves query strings in markdown links', () => {
    expect(
      rewriteMarkdownLinksForDocumentRename(
        'See [API](./old.md?tab=api#section).\n',
        'notes',
        'old',
        'new',
      ),
    ).toEqual({
      markdown: 'See [API](./new.md?tab=api#section).\n',
      rewrites: 1,
    });
  });

  test('preserves angle brackets around hrefs', () => {
    expect(
      rewriteMarkdownLinksForDocumentRename('See [Spaced](<./old.md>).\n', 'notes', 'old', 'new'),
    ).toEqual({
      markdown: 'See [Spaced](<./new.md>).\n',
      rewrites: 1,
    });
  });

  test('preserves .mdx extension on markdown-link rewrite', () => {
    expect(
      rewriteMarkdownLinksForDocumentRename(
        'See [Component](./old.mdx#section).\n',
        'notes',
        'old',
        'new',
      ),
    ).toEqual({
      markdown: 'See [Component](./new.mdx#section).\n',
      rewrites: 1,
    });
  });

  test('preserves .mdx extension when renamed doc moves paths', () => {
    expect(
      rewriteMarkdownLinksForDocumentRename(
        'See [Overview](../old.mdx#section).\n',
        'folder/page',
        'old',
        'guides/new',
      ),
    ).toEqual({
      markdown: 'See [Overview](../guides/new.mdx#section).\n',
      rewrites: 1,
    });
  });

  test('preserves root-absolute doc href shape on target rename', () => {
    expect(
      rewriteMarkdownLinksForDocumentRename(
        'See [Root](/docs/old.md?tab=api#section).\n',
        'notes/source',
        'docs/old',
        'docs/new',
      ),
    ).toEqual({
      markdown: 'See [Root](/docs/new.md?tab=api#section).\n',
      rewrites: 1,
    });
  });

  test('preserves root-absolute href shape when target moves to a different directory', () => {
    expect(
      rewriteMarkdownLinksForDocumentRename(
        'See [Root](/docs/old.md).\n',
        'notes/source',
        'docs/old',
        'archive/reference',
      ),
    ).toEqual({
      markdown: 'See [Root](/archive/reference.md).\n',
      rewrites: 1,
    });
  });
});

describe('rewriteMarkdownLinksForDocumentRename — image refs (FR-7)', () => {
  test('cross-dir source-doc move recomputes bare-name image-ref to a `../` path', () => {
    const result = rewriteMarkdownLinksForDocumentRename(
      '![first draft](first-draft.png)\n',
      'docs/meeting-notes',
      'docs/meeting-notes',
      'archive/2026/meeting-notes',
    );
    expect(result).toEqual({
      markdown: '![first draft](../../docs/first-draft.png)\n',
      rewrites: 1,
    });
  });

  test('depth-decreasing source-doc move recomputes path with fewer `../`', () => {
    const result = rewriteMarkdownLinksForDocumentRename(
      '![alt](photo.png)\n',
      'archive/2026/meeting',
      'archive/2026/meeting',
      'meeting',
    );
    expect(result).toEqual({
      markdown: '![alt](archive/2026/photo.png)\n',
      rewrites: 1,
    });
  });

  test('source-doc move into the asset directory shortens to bare name', () => {
    const result = rewriteMarkdownLinksForDocumentRename(
      '![alt](./assets/photo.png)\n',
      'top-level',
      'top-level',
      'assets/top-level',
    );
    expect(result.markdown).toContain('photo.png');
    expect(result.markdown).not.toContain('./assets/photo.png');
    expect(result.rewrites).toBe(1);
  });

  test('absolute-path image refs are LEFT UNCHANGED — pre-F8 legacy guard', () => {
    const result = rewriteMarkdownLinksForDocumentRename(
      '![alt](/docs/photo.png)\n',
      'docs/meeting-notes',
      'docs/meeting-notes',
      'archive/2026/meeting-notes',
    );
    expect(result).toEqual({
      markdown: '![alt](/docs/photo.png)\n',
      rewrites: 0,
    });
  });

  test('full-URL image refs left unchanged', () => {
    const result = rewriteMarkdownLinksForDocumentRename(
      '![alt](https://cdn.example.com/photo.png)\n',
      'docs/meeting-notes',
      'docs/meeting-notes',
      'archive/2026/meeting-notes',
    );
    expect(result).toEqual({
      markdown: '![alt](https://cdn.example.com/photo.png)\n',
      rewrites: 0,
    });
  });

  test('protocol-relative image refs left unchanged', () => {
    const result = rewriteMarkdownLinksForDocumentRename(
      '![alt](//cdn.example.com/photo.png)\n',
      'docs/meeting-notes',
      'docs/meeting-notes',
      'archive/2026/meeting-notes',
    );
    expect(result).toEqual({
      markdown: '![alt](//cdn.example.com/photo.png)\n',
      rewrites: 0,
    });
  });

  test('wiki-embed refs (`![[file]]`) NOT rewritten — D-K refs-only', () => {
    const result = rewriteMarkdownLinksForDocumentRename(
      '![[first-draft.png]] and ![[diagram.svg|alt]]\n',
      'docs/meeting-notes',
      'docs/meeting-notes',
      'archive/2026/meeting-notes',
    );
    expect(result).toEqual({
      markdown: '![[first-draft.png]] and ![[diagram.svg|alt]]\n',
      rewrites: 0,
    });
  });

  test('mixed wiki-embed + markdown-image + doc-link in one body — only the latter two rewrite', () => {
    const md =
      '# Meeting\n\n![[wiki-embed.png]] and ![plain](md-image.png) and [other doc](./other.md)\n';
    const result = rewriteMarkdownLinksForDocumentRename(
      md,
      'docs/meeting',
      'docs/meeting',
      'archive/2026/meeting',
    );
    expect(result.rewrites).toBe(1);
    expect(result.markdown).toContain('![[wiki-embed.png]]');
    expect(result.markdown).toContain('../../docs/md-image.png');
    expect(result.markdown).toContain('](./other.md)');
  });

  test('image refs in a doc whose target rename is unrelated stay untouched', () => {
    const result = rewriteMarkdownLinksForDocumentRename(
      'Image: ![alt](photo.png) and link [other](./other.md)\n',
      'docs/meeting',
      'docs/other',
      'docs/other-renamed',
    );
    expect(result.markdown).toContain('![alt](photo.png)');
    expect(result.markdown).toContain('[other](./other-renamed.md)');
  });

  test('same-dir source-doc rename (sibling rename) leaves bare-name image-refs alone', () => {
    const result = rewriteMarkdownLinksForDocumentRename(
      '![alt](photo.png)\n',
      'docs/meeting',
      'docs/meeting',
      'docs/meeting-v2',
    );
    expect(result).toEqual({
      markdown: '![alt](photo.png)\n',
      rewrites: 0,
    });
  });

  test('image refs are skipped inside fenced code blocks', () => {
    const md = ['```md', '![alt](photo.png)', '```', ''].join('\n');
    const result = rewriteMarkdownLinksForDocumentRename(
      md,
      'docs/meeting',
      'docs/meeting',
      'archive/meeting',
    );
    expect(result).toEqual({ markdown: md, rewrites: 0 });
  });
});

describe('rewriteJsxSrcRefsForDocumentRename', () => {
  test('rewrites Mirror src when value matches the rename source', () => {
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        'Before <Mirror src="api-spec" anchor="deprecation" /> after.\n',
        'index',
        'api-spec',
        'api-reference',
      ),
    ).toEqual({
      markdown: 'Before <Mirror src="api-reference" anchor="deprecation" /> after.\n',
      rewrites: 1,
    });
  });

  test('leaves Mirror src that points at a different doc untouched', () => {
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        '<Mirror src="other-doc" anchor="foo" />\n',
        'index',
        'api-spec',
        'api-reference',
      ),
    ).toEqual({
      markdown: '<Mirror src="other-doc" anchor="foo" />\n',
      rewrites: 0,
    });
  });

  test('supports single-quoted attribute values', () => {
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        "<Mirror src='api-spec' anchor='deprecation' />\n",
        'index',
        'api-spec',
        'api-reference',
      ),
    ).toEqual({
      markdown: "<Mirror src='api-reference' anchor='deprecation' />\n",
      rewrites: 1,
    });
  });

  test('handles multiple Mirrors on the same line', () => {
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        '<Mirror src="api-spec" anchor="a" /> and <Mirror src="api-spec" anchor="b" />\n',
        'index',
        'api-spec',
        'api-reference',
      ),
    ).toEqual({
      markdown:
        '<Mirror src="api-reference" anchor="a" /> and <Mirror src="api-reference" anchor="b" />\n',
      rewrites: 2,
    });
  });

  test('ignores Mirror tags inside fenced code blocks', () => {
    const md = ['```mdx', '<Mirror src="api-spec" anchor="x" />', '```', ''].join('\n');
    expect(rewriteJsxSrcRefsForDocumentRename(md, 'index', 'api-spec', 'api-reference')).toEqual({
      markdown: md,
      rewrites: 0,
    });
  });

  test('preserves prop order (anchor stays after src)', () => {
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        '<Mirror anchor="x" src="old" />\n',
        'index',
        'old',
        'new',
      ),
    ).toEqual({
      markdown: '<Mirror anchor="x" src="new" />\n',
      rewrites: 1,
    });
  });

  test('returns rewrites=0 for docs with no Mirror tags', () => {
    expect(
      rewriteJsxSrcRefsForDocumentRename('Just prose, no JSX here.\n', 'index', 'old', 'new'),
    ).toEqual({
      markdown: 'Just prose, no JSX here.\n',
      rewrites: 0,
    });
  });

  test('skips Mirror tags inside inline code spans (e.g. docs explaining Mirror syntax)', () => {
    const input =
      'To embed the deprecation block, write `<Mirror src="api-spec" anchor="dep" />`.\n';
    expect(rewriteJsxSrcRefsForDocumentRename(input, 'index', 'api-spec', 'api-reference')).toEqual(
      {
        markdown: input,
        rewrites: 0,
      },
    );
  });

  test('ignores Mirror tags inside tilde fences', () => {
    const markdown = ['~~~md', '<Mirror src="old" anchor="x" />', '~~~', ''].join('\n');
    expect(rewriteJsxSrcRefsForDocumentRename(markdown, 'index', 'old', 'new')).toEqual({
      markdown,
      rewrites: 0,
    });
  });

  test('rewrites Mirror outside inline code on the same line', () => {
    const input =
      'See `<Mirror src="api-spec" anchor="x" />` in docs. Live: <Mirror src="api-spec" anchor="y" />\n';
    const out =
      'See `<Mirror src="api-spec" anchor="x" />` in docs. Live: <Mirror src="api-reference" anchor="y" />\n';
    expect(rewriteJsxSrcRefsForDocumentRename(input, 'index', 'api-spec', 'api-reference')).toEqual(
      {
        markdown: out,
        rewrites: 1,
      },
    );
  });

  test('rewrites Excalidraw src preserving the leading slash', () => {
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        'Board: <Excalidraw src="/old/board.excalidraw" />\n',
        'index',
        'old/board.excalidraw',
        'new/board.excalidraw',
      ),
    ).toEqual({
      markdown: 'Board: <Excalidraw src="/new/board.excalidraw" />\n',
      rewrites: 1,
    });
  });

  test('rewrites a bare (no leading slash) Excalidraw src without adding one', () => {
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        '<Excalidraw src="old/board.excalidraw" />\n',
        'index',
        'old/board.excalidraw',
        'new/board.excalidraw',
      ),
    ).toEqual({
      markdown: '<Excalidraw src="new/board.excalidraw" />\n',
      rewrites: 1,
    });
  });

  test('leaves an Excalidraw src that points at a different board untouched', () => {
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        '<Excalidraw src="/other/board.excalidraw" />\n',
        'index',
        'old/board.excalidraw',
        'new/board.excalidraw',
      ),
    ).toEqual({
      markdown: '<Excalidraw src="/other/board.excalidraw" />\n',
      rewrites: 0,
    });
  });

  test('skips Excalidraw tags inside inline code spans', () => {
    const input = 'Write `<Excalidraw src="/old/board.excalidraw" />` to embed a board.\n';
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        input,
        'index',
        'old/board.excalidraw',
        'new/board.excalidraw',
      ),
    ).toEqual({
      markdown: input,
      rewrites: 0,
    });
  });

  test('ignores Excalidraw tags inside fenced code blocks', () => {
    const markdown = ['```mdx', '<Excalidraw src="/old/board.excalidraw" />', '```', ''].join('\n');
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        markdown,
        'index',
        'old/board.excalidraw',
        'new/board.excalidraw',
      ),
    ).toEqual({
      markdown,
      rewrites: 0,
    });
  });

  test('renaming a plain .md doc does not touch an Excalidraw src pointing elsewhere', () => {
    const markdown = 'See [[guides/setup]] and <Excalidraw src="/diagrams/arch.excalidraw" />\n';
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        markdown,
        'docs/overview',
        'guides/setup',
        'guides/install',
      ),
    ).toEqual({
      markdown,
      rewrites: 0,
    });
  });

  test('preserves title and other Excalidraw attrs byte-for-byte', () => {
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        '<Excalidraw title="Architecture  sketch" src=\'/old/board.excalidraw\' height="480" />\n',
        'index',
        'old/board.excalidraw',
        'new/board.excalidraw',
      ),
    ).toEqual({
      markdown:
        '<Excalidraw title="Architecture  sketch" src=\'/new/board.excalidraw\' height="480" />\n',
      rewrites: 1,
    });
  });

  test('rewrites Mirror and Excalidraw refs in one pass when both name the renamed doc', () => {
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        '<Mirror src="old" anchor="x" /> and <Excalidraw src="/old" />\n',
        'index',
        'old',
        'new',
      ),
    ).toEqual({
      markdown: '<Mirror src="new" anchor="x" /> and <Excalidraw src="/new" />\n',
      rewrites: 2,
    });
  });

  test('matches a doc-relative Excalidraw src the way the renderer resolves it', () => {
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        '<Excalidraw src="board.excalidraw" />\n',
        'notes/index',
        'notes/board.excalidraw',
        'notes/sketch.excalidraw',
      ),
    ).toEqual({
      markdown: '<Excalidraw src="sketch.excalidraw" />\n',
      rewrites: 1,
    });
  });

  test('a doc-relative src stays doc-relative when the board moves to a sibling folder', () => {
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        '<Excalidraw src="board.excalidraw" />\n',
        'notes/index',
        'notes/board.excalidraw',
        'archive/board.excalidraw',
      ),
    ).toEqual({
      markdown: '<Excalidraw src="../archive/board.excalidraw" />\n',
      rewrites: 1,
    });
  });

  test('a ./-prefixed doc-relative src keeps its prefix on a same-folder rename', () => {
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        '<Excalidraw src="./board.excalidraw" />\n',
        'notes/index',
        'notes/board.excalidraw',
        'notes/sketch.excalidraw',
      ),
    ).toEqual({
      markdown: '<Excalidraw src="./sketch.excalidraw" />\n',
      rewrites: 1,
    });
  });

  test('a doc-relative-looking src that resolves elsewhere does not match the rename', () => {
    const markdown = '<Excalidraw src="diagrams/board.excalidraw" />\n';
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        markdown,
        'notes/index',
        'diagrams/board.excalidraw',
        'archive/board.excalidraw',
      ),
    ).toEqual({ markdown, rewrites: 0 });
  });

  test('root-relative spelling is preserved on a doc-relative-capable tag', () => {
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        '<Excalidraw src="/notes/board.excalidraw" />\n',
        'notes/index',
        'notes/board.excalidraw',
        'archive/board.excalidraw',
      ),
    ).toEqual({
      markdown: '<Excalidraw src="/archive/board.excalidraw" />\n',
      rewrites: 1,
    });
  });

  test('containing-doc move recomputes a doc-relative src for the new location', () => {
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        '<Excalidraw src="board.excalidraw" />\n',
        'notes/index',
        'notes/index',
        'archive/index',
      ),
    ).toEqual({
      markdown: '<Excalidraw src="../notes/board.excalidraw" />\n',
      rewrites: 1,
    });
  });

  test('containing-doc same-folder rename leaves a doc-relative src untouched', () => {
    const markdown = '<Excalidraw src="board.excalidraw" />\n';
    expect(
      rewriteJsxSrcRefsForDocumentRename(markdown, 'notes/index', 'notes/index', 'notes/overview'),
    ).toEqual({ markdown, rewrites: 0 });
  });

  test('containing-doc move leaves root-relative and bare-doc-name srcs untouched', () => {
    const markdown =
      '<Excalidraw src="/notes/board.excalidraw" /> and <Mirror src="api-spec" anchor="x" />\n';
    expect(
      rewriteJsxSrcRefsForDocumentRename(markdown, 'notes/index', 'notes/index', 'archive/index'),
    ).toEqual({ markdown, rewrites: 0 });
  });

  test('refuses a quote-bearing newDocName on the bare-doc-name branch', () => {
    const markdown = '<Mirror src="api-spec" anchor="x" />\n';
    expect(rewriteJsxSrcRefsForDocumentRename(markdown, 'index', 'api-spec', 'api"spec')).toEqual({
      markdown,
      rewrites: 0,
    });
  });

  test('refuses a >-bearing newDocName on the bare-doc-name branch', () => {
    const markdown = '<Mirror src="api-spec" anchor="x" />\n';
    expect(
      rewriteJsxSrcRefsForDocumentRename(markdown, 'index', 'api-spec', 'notes > archive'),
    ).toEqual({ markdown, rewrites: 0 });
  });

  test('refuses a quote-bearing newDocName on the doc-relative branch', () => {
    const markdown = '<Excalidraw src="board.excalidraw" />\n';
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        markdown,
        'notes/index',
        'notes/board.excalidraw',
        'notes/bo"ard.excalidraw',
      ),
    ).toEqual({ markdown, rewrites: 0 });
  });

  test('refuses a >-bearing newDocName on the doc-relative branch', () => {
    const markdown = '<Excalidraw src="/notes/board.excalidraw" />\n';
    expect(
      rewriteJsxSrcRefsForDocumentRename(
        markdown,
        'index',
        'notes/board.excalidraw',
        'notes > archive.excalidraw',
      ),
    ).toEqual({ markdown, rewrites: 0 });
  });

  test('data-src is not read as src (whitespace-anchored attribute matcher)', () => {
    const markdown = '<Mirror data-src="old" anchor="x" src="other" />\n';
    expect(rewriteJsxSrcRefsForDocumentRename(markdown, 'index', 'old', 'new')).toEqual({
      markdown,
      rewrites: 0,
    });
  });
});

describe('rewriteAssetReferencesForRename', () => {
  test('rewrites markdown images, markdown links, and wiki embeds that point at the moved asset', () => {
    const result = rewriteAssetReferencesForRename(
      [
        '![Diagram](./media/diagram.png)',
        '[Download](./media/diagram.png?dl=1#page)',
        '![[media/diagram.png|Diagram]]',
        '[[media/diagram.png#page=2|PDF-ish]]',
        '',
      ].join('\n'),
      'docs/guide',
      'docs/media/diagram.png',
      'docs/assets/hero.png',
    );

    expect(result).toEqual({
      markdown: [
        '![Diagram](./assets/hero.png)',
        '[Download](./assets/hero.png?dl=1#page)',
        '![[assets/hero.png|Diagram]]',
        '[[assets/hero.png#page=2|PDF-ish]]',
        '',
      ].join('\n'),
      rewrites: 4,
    });
  });

  test('preserves root-absolute asset href shape', () => {
    const result = rewriteAssetReferencesForRename(
      '![Root](/docs/media/root.png)\n',
      'docs/guide',
      'docs/media/root.png',
      'assets/root.png',
    );

    expect(result).toEqual({
      markdown: '![Root](/assets/root.png)\n',
      rewrites: 1,
    });
  });

  test('preserves percent encoding for rewritten markdown asset hrefs', () => {
    const result = rewriteAssetReferencesForRename(
      '![Spaced](./media/asset%20with%20spaces.png?dl=1#hero)\n',
      'docs/guide',
      'docs/media/asset with spaces.png',
      'docs/final/asset with spaces (2).png',
    );

    expect(result).toEqual({
      markdown: '![Spaced](./final/asset%20with%20spaces%20%282%29.png?dl=1#hero)\n',
      rewrites: 1,
    });
  });

  test('matches a %2520 href to a literal %20-bearing asset filename without double decoding', () => {
    const result = rewriteAssetReferencesForRename(
      '![Literal](./media/name%2520with%2520percents.png)\n',
      'docs/guide',
      'docs/media/name%20with%20percents.png',
      'docs/final/name%20with%20percents.png',
    );

    expect(result).toEqual({
      markdown: '![Literal](./final/name%2520with%2520percents.png)\n',
      rewrites: 1,
    });
  });

  test('preserves literal spaces for rewritten wiki asset hrefs', () => {
    const result = rewriteAssetReferencesForRename(
      '![[media/asset with spaces.png|Spaced]]\n',
      'docs/guide',
      'docs/media/asset with spaces.png',
      'docs/final/asset with spaces (2).png',
    );

    expect(result).toEqual({
      markdown: '![[final/asset with spaces (2).png|Spaced]]\n',
      rewrites: 1,
    });
  });

  test('a wiki asset target matches on its literal percent sequences', () => {
    const result = rewriteAssetReferencesForRename(
      '![[media/100%20done.png|Progress]]\n',
      'docs/guide',
      'docs/media/100%20done.png',
      'docs/final/100%20done.png',
    );

    expect(result).toEqual({
      markdown: '![[final/100%20done.png|Progress]]\n',
      rewrites: 1,
    });
  });

  test('a wiki asset target does not match the decoded neighbour asset', () => {
    const result = rewriteAssetReferencesForRename(
      '![[media/100%20done.png|Progress]]\n',
      'docs/guide',
      'docs/media/100 done.png',
      'docs/final/100 done.png',
    );

    expect(result).toEqual({
      markdown: '![[media/100%20done.png|Progress]]\n',
      rewrites: 0,
    });
  });

  test('a markdown asset href still matches the decoded asset path', () => {
    const result = rewriteAssetReferencesForRename(
      '![Progress](./media/100%20done.png)\n',
      'docs/guide',
      'docs/media/100 done.png',
      'docs/final/100 done.png',
    );

    expect(result).toEqual({
      markdown: '![Progress](./final/100%20done.png)\n',
      rewrites: 1,
    });
  });

  test('rewrites HTML src and href attributes that point at the moved asset', () => {
    const result = rewriteAssetReferencesForRename(
      [
        '<img alt="diagram" src="./media/diagram.png">',
        "<a href='./media/diagram.png?dl=1'>download</a>",
        '<!-- <img src="./media/diagram.png"> -->',
        '',
      ].join('\n'),
      'docs/guide',
      'docs/media/diagram.png',
      'docs/assets/hero.png',
    );

    expect(result).toEqual({
      markdown: [
        '<img alt="diagram" src="./assets/hero.png">',
        "<a href='./assets/hero.png?dl=1'>download</a>",
        '<!-- <img src="./media/diagram.png"> -->',
        '',
      ].join('\n'),
      rewrites: 2,
    });
  });

  test('skips remote URLs, fenced code, and inline code', () => {
    const markdown = [
      '![Remote](https://example.com/media/diagram.png)',
      '`![Inline](./media/diagram.png)`',
      '```md',
      '![Code](./media/diagram.png)',
      '```',
      '',
    ].join('\n');

    expect(
      rewriteAssetReferencesForRename(
        markdown,
        'docs/guide',
        'docs/media/diagram.png',
        'docs/assets/hero.png',
      ),
    ).toEqual({ markdown, rewrites: 0 });
  });
});

describe('rewritten hrefs round-trip back through the canonical resolvers', () => {
  const awkward = [
    'Agent Memory',
    'team plan (draft) #1',
    'R&D notes',
    "don't panic!",
    'café résumé',
  ];

  for (const name of awkward) {
    test(`document rename to ${JSON.stringify(name)} emits a resolvable href`, () => {
      const { markdown, rewrites } = rewriteMarkdownLinksForDocumentRename(
        '[Link](./Old%20Name.md)\n',
        'blogs/drafts/index',
        'blogs/drafts/Old Name',
        `blogs/drafts/${name}`,
      );

      expect(rewrites).toBe(1);
      const href = markdown.match(/\]\((.*)\)/)?.[1] ?? '';
      expect(href).not.toMatch(/[ ()#?]/);
      expect(resolveInternalHref(href, 'blogs/drafts/index')?.docName).toBe(`blogs/drafts/${name}`);
    });

    test(`asset rename to ${JSON.stringify(name)} emits a resolvable href`, () => {
      const { markdown, rewrites } = rewriteAssetReferencesForRename(
        '![Img](./media/old%20name.png)\n',
        'docs/guide',
        'docs/media/old name.png',
        `docs/final/${name}.png`,
      );

      expect(rewrites).toBe(1);
      const href = markdown.match(/\]\((.*)\)/)?.[1] ?? '';
      expect(href).not.toMatch(/[ ()#?]/);
      expect(resolveAssetProjectPath(href, 'docs/guide', { literal: false })).toBe(
        `docs/final/${name}.png`,
      );
    });
  }

  test('a source move re-encodes outbound links to space-bearing targets', () => {
    const { markdown, rewrites } = rewriteOutboundMarkdownLinksForSourceMove(
      '[Agent Memory](./Agent%20Memory.md)\n',
      'blogs/drafts/index',
      'blogs/index',
    );

    expect(rewrites).toBe(1);
    expect(markdown).toBe('[Agent Memory](./drafts/Agent%20Memory.md)\n');
    expect(resolveInternalHref('./drafts/Agent%20Memory.md', 'blogs/index')?.docName).toBe(
      'blogs/drafts/Agent Memory',
    );
  });

  test('an asset name containing # is escaped, not left to truncate the href', () => {
    const { markdown } = rewriteAssetReferencesForRename(
      '![Hash](./media/my%23file.png)\n',
      'docs/guide',
      'docs/media/my#file.png',
      'docs/final/my#file.png',
    );

    expect(markdown).toBe('![Hash](./final/my%23file.png)\n');
    expect(resolveAssetProjectPath('./final/my%23file.png', 'docs/guide', { literal: false })).toBe(
      'docs/final/my#file.png',
    );
  });
});
