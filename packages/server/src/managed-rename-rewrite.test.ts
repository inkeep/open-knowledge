import { resolveAssetProjectPath, resolveInternalHref } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  rewriteAssetReferencesForRename,
  rewriteMarkdownLinksForDocumentRename,
  rewriteMirrorSrcForDocumentRename,
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
  // Image refs only rewrite when the SOURCE doc itself moves (sourceDocName
  // === oldDocName). When a remote doc renames and we're updating links in
  // OUR doc, our image refs are unrelated and stay verbatim.

  test('cross-dir source-doc move recomputes bare-name image-ref to a `../` path', () => {
    // 'docs/meeting-notes.md' moves to 'archive/2026/meeting-notes.md'.
    // The image at 'docs/first-draft.png' stays put; the ref must point
    // up two levels and back down into docs/.
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
    // 'archive/2026/meeting.md' → 'meeting.md' (root).
    // Asset at 'archive/2026/photo.png' stays put.
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
    // 'top-level.md' contains './assets/photo.png'; doc moves into assets/
    // → ref shortens to bare-name.
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
    // An absolute path was emitted
    // by shortestImageRef; rewriting it would silently break.
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
    // The basename index resolves wiki-embeds dynamically, so the ref body
    // must be byte-identical after the rename.
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
    expect(result.rewrites).toBe(1); // only md-image rewrites; doc-link target ('other') doesn't match oldDocName
    expect(result.markdown).toContain('![[wiki-embed.png]]'); // wiki-embed unchanged
    expect(result.markdown).toContain('../../docs/md-image.png'); // md-image recomputed
    expect(result.markdown).toContain('](./other.md)'); // doc-link untouched (target wasn't oldDocName)
  });

  test('image refs in a doc whose target rename is unrelated stay untouched', () => {
    // sourceDocName !== oldDocName → no image-ref rewrite. Only doc-to-doc
    // rewriting happens, and our image-ref is preserved verbatim.
    // resolveInternalHref on './other.md' with sourceDocName 'docs/meeting'
    // yields 'docs/other', so oldDocName needs the 'docs/' prefix.
    const result = rewriteMarkdownLinksForDocumentRename(
      'Image: ![alt](photo.png) and link [other](./other.md)\n',
      'docs/meeting',
      'docs/other',
      'docs/other-renamed',
    );
    expect(result.markdown).toContain('![alt](photo.png)'); // image unchanged
    expect(result.markdown).toContain('[other](./other-renamed.md)'); // link rewrote
  });

  test('same-dir source-doc rename (sibling rename) leaves bare-name image-refs alone', () => {
    // Renaming docs/meeting.md → docs/meeting-v2.md doesn't change dirname,
    // so a bare-name image ref is still correct.
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

describe('rewriteMirrorSrcForDocumentRename', () => {
  test('rewrites Mirror src when value matches the rename source', () => {
    expect(
      rewriteMirrorSrcForDocumentRename(
        'Before <Mirror src="api-spec" anchor="deprecation" /> after.\n',
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
      rewriteMirrorSrcForDocumentRename(
        '<Mirror src="other-doc" anchor="foo" />\n',
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
      rewriteMirrorSrcForDocumentRename(
        "<Mirror src='api-spec' anchor='deprecation' />\n",
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
      rewriteMirrorSrcForDocumentRename(
        '<Mirror src="api-spec" anchor="a" /> and <Mirror src="api-spec" anchor="b" />\n',
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
    expect(rewriteMirrorSrcForDocumentRename(md, 'api-spec', 'api-reference')).toEqual({
      markdown: md,
      rewrites: 0,
    });
  });

  test('preserves prop order (anchor stays after src)', () => {
    expect(
      rewriteMirrorSrcForDocumentRename('<Mirror anchor="x" src="old" />\n', 'old', 'new'),
    ).toEqual({
      markdown: '<Mirror anchor="x" src="new" />\n',
      rewrites: 1,
    });
  });

  test('returns rewrites=0 for docs with no Mirror tags', () => {
    expect(rewriteMirrorSrcForDocumentRename('Just prose, no JSX here.\n', 'old', 'new')).toEqual({
      markdown: 'Just prose, no JSX here.\n',
      rewrites: 0,
    });
  });

  test('skips Mirror tags inside inline code spans (e.g. docs explaining Mirror syntax)', () => {
    // Documentation about the Mirror feature itself naturally embeds the
    // tag inside inline code — rewriting there would corrupt example text.
    // Mirrors `rewriteWikiLinksInLine`'s `readInlineCode` skip behavior.
    const input =
      'To embed the deprecation block, write `<Mirror src="api-spec" anchor="dep" />`.\n';
    expect(rewriteMirrorSrcForDocumentRename(input, 'api-spec', 'api-reference')).toEqual({
      markdown: input,
      rewrites: 0,
    });
  });

  test('ignores Mirror tags inside tilde fences', () => {
    // The backtick-fence skip is exercised separately; tilde fences
    // use the same `matchFence` / `isFenceClose` machinery and must skip
    // identically. Symmetry guard.
    const markdown = ['~~~md', '<Mirror src="old" anchor="x" />', '~~~', ''].join('\n');
    expect(rewriteMirrorSrcForDocumentRename(markdown, 'old', 'new')).toEqual({
      markdown,
      rewrites: 0,
    });
  });

  test('rewrites Mirror outside inline code on the same line', () => {
    // The inline-code skip is scoped to the backtick span only — Mirrors
    // outside it on the same line still rewrite.
    const input =
      'See `<Mirror src="api-spec" anchor="x" />` in docs. Live: <Mirror src="api-spec" anchor="y" />\n';
    const out =
      'See `<Mirror src="api-spec" anchor="x" />` in docs. Live: <Mirror src="api-reference" anchor="y" />\n';
    expect(rewriteMirrorSrcForDocumentRename(input, 'api-spec', 'api-reference')).toEqual({
      markdown: out,
      rewrites: 1,
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

    // Parens are escaped, not passed through: the canonical segment encoder
    // neutralizes `!'()*` so an unbalanced paren can never terminate a bare
    // CommonMark destination. Both spellings resolve back to the same asset.
    expect(result).toEqual({
      markdown: '![Spaced](./final/asset%20with%20spaces%20%282%29.png?dl=1#hero)\n',
      rewrites: 1,
    });
  });

  test('matches a %2520 href to a literal %20-bearing asset filename without double decoding', () => {
    // RFC 3986 §2.4: an escaped octet is decoded exactly once — `%2520`
    // denotes the literal bytes `%20` in the target filename. A second
    // decode would turn it into a space and silently miss the asset.
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
    // `![[100%20done.png]]` names a file whose name really contains those three
    // characters. Reading the target as a URI resolves it to `100 done.png`,
    // which is not the asset being renamed, so the embed is left behind
    // pointing at a path that no longer exists.
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
    // Companion to the assertion above. Renaming `docs/media/100 done.png` —
    // the file the decoded reading names — must leave the literal-named embed
    // untouched, or the rewrite repoints a working link at someone else's move.
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
    // The other half of the plane split: identical authored bytes, markdown
    // syntax, must resolve to the space-named file and rewrite.
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

// Resolvers decode, so a rewriter that rebuilds an href from a decoded docName
// must re-encode it. Without that the rewrite emits a literal space, `#`, or
// `?` into the destination and the link stops parsing — corrupting the user's
// markdown on disk on an ordinary rename.
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
