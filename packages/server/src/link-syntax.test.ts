import { describe, expect, test } from 'vitest';
import { extractLocalAssetHrefs } from './asset-references.ts';
import {
  extractMarkdownLinksFromMarkdown,
  extractWikiLinksFromMarkdown,
} from './backlink-index.ts';
import {
  matchHtmlImgs,
  matchMarkdownLinks,
  matchWikiLinks,
  readHtmlImgAt,
  readMarkdownLinkAt,
  readMarkdownReferenceAt,
  readReferenceDefinition,
  readWikiLinkAt,
} from './link-syntax.ts';
import { rewriteWikiLinksForDocumentRename } from './managed-rename-rewrite.ts';

describe('readWikiLinkAt', () => {
  test('plain target', () => {
    expect(readWikiLinkAt('[[Wiki Page]]', 0)).toMatchObject({
      embed: false,
      target: 'Wiki Page',
      anchor: null,
      alias: null,
      start: 0,
      end: 13,
    });
  });

  test('target with anchor and alias', () => {
    expect(readWikiLinkAt('[[wiki#anchor|Alias]]', 0)).toMatchObject({
      target: 'wiki',
      anchor: 'anchor',
      alias: 'Alias',
    });
  });

  test('anchor may contain further # chars; alias may contain further | chars', () => {
    expect(readWikiLinkAt('[[a#b#c]]', 0)).toMatchObject({ target: 'a', anchor: 'b#c' });
    expect(readWikiLinkAt('[[a|b|c]]', 0)).toMatchObject({ target: 'a', alias: 'b|c' });
  });

  test('embed form at the ! position', () => {
    expect(readWikiLinkAt('![[embed.png]]', 0)).toMatchObject({
      embed: true,
      target: 'embed.png',
      end: 14,
    });
  });

  test('called at the [[ of an embed, the ! is outside the match', () => {
    expect(readWikiLinkAt('![[embed.png]]', 1)).toMatchObject({
      embed: false,
      target: 'embed.png',
      start: 1,
      end: 14,
    });
  });

  test('target is trimmed; raw capture is preserved', () => {
    expect(readWikiLinkAt('[[ spaced target ]]', 0)).toMatchObject({
      target: 'spaced target',
      targetRaw: ' spaced target ',
    });
  });

  test('whitespace-only target rejects the match', () => {
    expect(readWikiLinkAt('[[ ]]', 0)).toBeNull();
  });

  test('empty target with only anchor or alias rejects', () => {
    expect(readWikiLinkAt('[[#only-anchor]]', 0)).toBeNull();
    expect(readWikiLinkAt('[[|only-alias]]', 0)).toBeNull();
  });

  test('unterminated form does not match', () => {
    expect(readWikiLinkAt('[[unterminated', 0)).toBeNull();
  });

  test('nested opener: outer fails, inner matches at its own position', () => {
    expect(readWikiLinkAt('[[outer [[inner]] ]]', 0)).toBeNull();
    expect(readWikiLinkAt('[[outer [[inner]] ]]', 8)).toMatchObject({ target: 'inner' });
  });

  test('unicode targets pass through', () => {
    expect(readWikiLinkAt('[[héllo wörld]]', 0)).toMatchObject({ target: 'héllo wörld' });
    expect(readWikiLinkAt('[[emoji 🎉 target]]', 0)).toMatchObject({ target: 'emoji 🎉 target' });
  });

  test('only matches at exactly the given position', () => {
    expect(readWikiLinkAt('x [[a]]', 0)).toBeNull();
    expect(readWikiLinkAt('x [[a]]', 2)).toMatchObject({ target: 'a' });
  });
});

describe('readMarkdownLinkAt', () => {
  test('plain link', () => {
    expect(readMarkdownLinkAt('[doc](./target.md)', 0)).toMatchObject({
      image: false,
      label: 'doc',
      href: './target.md',
      hrefRaw: './target.md',
      titleSuffix: '',
      end: 18,
    });
  });

  test('image form at the ! position', () => {
    expect(readMarkdownLinkAt('![img](./photo.png)', 0)).toMatchObject({
      image: true,
      label: 'img',
      href: './photo.png',
    });
  });

  test('angle destination admits spaces and is unwrapped in href', () => {
    expect(readMarkdownLinkAt('[doc](<./my file.md>)', 0)).toMatchObject({
      href: './my file.md',
      hrefRaw: '<./my file.md>',
    });
  });

  test('empty angle destination falls to the bare-form alternative', () => {
    // `<...>` requires one char, so `<>` matches as a bare destination and
    // unwraps to ''.
    expect(readMarkdownLinkAt('[doc](<>)', 0)).toMatchObject({ hrefRaw: '<>', href: '' });
  });

  test('all three CommonMark title forms, captured as authored suffix', () => {
    expect(readMarkdownLinkAt('[doc](./t.md "title")', 0)).toMatchObject({
      href: './t.md',
      titleSuffix: ' "title"',
    });
    expect(readMarkdownLinkAt("[doc](./t.md 'title')", 0)).toMatchObject({
      titleSuffix: " 'title'",
    });
    expect(readMarkdownLinkAt('[doc](./t.md (title))', 0)).toMatchObject({
      titleSuffix: ' (title)',
    });
    expect(readMarkdownLinkAt('[doc](./t.md "it\'s here")', 0)).toMatchObject({
      titleSuffix: ' "it\'s here"',
    });
    expect(readMarkdownLinkAt('[doc](./t.md "ti)tle")', 0)).toMatchObject({
      href: './t.md',
      titleSuffix: ' "ti)tle"',
    });
  });

  test('mismatched title quotes reject the match', () => {
    expect(readMarkdownLinkAt('[a](./x.md "t\')', 0)).toBeNull();
  });

  test('bare destination stops at whitespace or )', () => {
    expect(readMarkdownLinkAt('[a](two words)', 0)).toBeNull();
    expect(readMarkdownLinkAt('[a](./x.md extra)', 0)).toBeNull();
    expect(readMarkdownLinkAt('[empty]()', 0)).toBeNull();
  });

  test('unterminated form does not match', () => {
    expect(readMarkdownLinkAt('[unterminated](./x.md', 0)).toBeNull();
  });

  test('empty label is allowed', () => {
    expect(readMarkdownLinkAt('[](./empty-label.md)', 0)).toMatchObject({
      label: '',
      href: './empty-label.md',
    });
  });

  test('strict label stops at the first ]', () => {
    expect(readMarkdownLinkAt('[a [b] c](./x.md)', 0)).toBeNull();
    expect(readMarkdownLinkAt('[a]b](./x.md)', 0)).toBeNull();
  });

  test('badge nesting at position 0 matches the inner image destination', () => {
    // The label runs `![alt` up to the inner `]`, so the match carries the
    // INNER destination. matchMarkdownLinks({ nestedBracketLabels }) is the
    // outer-destination variant.
    expect(readMarkdownLinkAt('[![alt](./inner.png)](./outer.pdf)', 0)).toMatchObject({
      image: false,
      label: '![alt',
      href: './inner.png',
    });
  });
});

describe('matchWikiLinks', () => {
  test('finds plain links and embeds across a line', () => {
    expect(matchWikiLinks('a [[x]] b ![[y.png]] c').map((m) => [m.target, m.embed])).toEqual([
      ['x', false],
      ['y.png', true],
    ]);
  });

  test('drops whitespace-only targets but keeps scanning past them', () => {
    expect(matchWikiLinks('[[ ]] [[real]]').map((m) => m.target)).toEqual(['real']);
  });

  test('skips a doubled opener and matches the inner form', () => {
    expect(matchWikiLinks('[[outer [[inner]] ]]').map((m) => m.target)).toEqual(['inner']);
  });
});

describe('matchMarkdownLinks', () => {
  test('finds links and images across a line', () => {
    expect(
      matchMarkdownLinks('[a](./x.md) and ![b](./y.png)').map((m) => [m.href, m.image]),
    ).toEqual([
      ['./x.md', false],
      ['./y.png', true],
    ]);
  });

  test('strict scan of badge nesting yields the inner destination', () => {
    expect(matchMarkdownLinks('[![alt](./inner.png)](./outer.pdf)').map((m) => m.href)).toEqual([
      './inner.png',
    ]);
  });

  test('nestedBracketLabels scan of badge nesting yields the outer destination', () => {
    expect(
      matchMarkdownLinks('[![alt](./inner.png)](./outer.pdf)', { nestedBracketLabels: true }).map(
        (m) => m.href,
      ),
    ).toEqual(['./outer.pdf']);
  });

  test('nestedBracketLabels admits one bracketed run inside the label', () => {
    expect(
      matchMarkdownLinks('[a [b] c](./x.md)', { nestedBracketLabels: true }).map((m) => m.href),
    ).toEqual(['./x.md']);
    expect(matchMarkdownLinks('[a [b] c](./x.md)').map((m) => m.href)).toEqual([]);
  });
});

describe('readMarkdownReferenceAt', () => {
  test('full reference carries the second-bracket label', () => {
    expect(readMarkdownReferenceAt('[text][ref]', 0)).toMatchObject({
      image: false,
      label: 'text',
      form: 'full',
      referenceLabelRaw: 'ref',
      start: 0,
      end: 11,
      labelEnd: 6,
    });
  });

  test('collapsed reference reuses the label', () => {
    expect(readMarkdownReferenceAt('[text][]', 0)).toMatchObject({
      form: 'collapsed',
      label: 'text',
      referenceLabelRaw: 'text',
      end: 8,
      labelEnd: 6,
    });
  });

  test('shortcut reference ends at the label', () => {
    expect(readMarkdownReferenceAt('[text]', 0)).toMatchObject({
      form: 'shortcut',
      referenceLabelRaw: 'text',
      end: 6,
      labelEnd: 6,
    });
  });

  test('image form at the ! position', () => {
    expect(readMarkdownReferenceAt('![alt][ref]', 0)).toMatchObject({
      image: true,
      label: 'alt',
      form: 'full',
      referenceLabelRaw: 'ref',
      labelEnd: 6,
    });
  });

  test('a space between the brackets is a shortcut, not a full reference', () => {
    expect(readMarkdownReferenceAt('[text] [ref]', 0)).toMatchObject({
      form: 'shortcut',
      end: 6,
    });
  });

  test('unterminated label does not match', () => {
    expect(readMarkdownReferenceAt('[text', 0)).toBeNull();
  });

  test('end always equals start + matched length (range fidelity)', () => {
    for (const [input, matched] of [
      ['[text][ref]', '[text][ref]'],
      ['![alt][ref]', '![alt][ref]'],
      ['[text][]', '[text][]'],
      ['[text]', '[text]'],
    ] as const) {
      const m = readMarkdownReferenceAt(input, 0);
      expect(m).not.toBeNull();
      expect(input.slice(m?.start, m?.end)).toBe(matched);
    }
  });
});

describe('readReferenceDefinition', () => {
  test('bare destination with the repair range bounding the destination token', () => {
    const line = '[ref]: ./file.pdf';
    const def = readReferenceDefinition(line);
    expect(def).toMatchObject({ label: 'ref', destination: './file.pdf', titleSuffix: '' });
    expect(line.slice(def?.destinationStart, def?.destinationEnd)).toBe('./file.pdf');
  });

  test('angle-wrapped destination admits spaces and unwraps', () => {
    const line = '[ref]: <./my file.pdf> "title"';
    const def = readReferenceDefinition(line);
    expect(def).toMatchObject({ destination: './my file.pdf', titleSuffix: ' "title"' });
    expect(line.slice(def?.destinationStart, def?.destinationEnd)).toBe('<./my file.pdf>');
  });

  test('up to three leading spaces are tolerated; the repair range still lands on the destination', () => {
    const line = '   [ref]: ./file.pdf';
    const def = readReferenceDefinition(line);
    expect(line.slice(def?.destinationStart, def?.destinationEnd)).toBe('./file.pdf');
  });

  test('four leading spaces disqualify the definition (indented code)', () => {
    expect(readReferenceDefinition('    [ref]: ./file.pdf')).toBeNull();
  });

  test('a non-definition line does not match', () => {
    expect(readReferenceDefinition('see [ref] here')).toBeNull();
    expect(readReferenceDefinition('[ref]: ./a ./b')).toBeNull();
  });
});

describe('readHtmlImgAt / matchHtmlImgs', () => {
  test('bare void form with a double-quoted src', () => {
    expect(readHtmlImgAt('<img src="./photo.png">', 0)).toMatchObject({
      src: './photo.png',
      selfClosing: false,
      start: 0,
      end: 23,
    });
  });

  test('self-closing form is flagged', () => {
    expect(readHtmlImgAt('<img src="./photo.png" />', 0)).toMatchObject({
      src: './photo.png',
      selfClosing: true,
    });
  });

  test('quoted attributes may contain src-like text and greater-than signs', () => {
    expect(
      readHtmlImgAt('<img alt="fake src=\'./wrong.png\' > still alt" src="./right.png">', 0),
    ).toMatchObject({ src: './right.png' });
  });

  test('does not treat data-src, srcset, or quoted text as src', () => {
    expect(readHtmlImgAt('<img data-src="./wrong.png" srcset="./also.png 2x">', 0)).toBeNull();
  });

  test('single-quoted and unquoted src values', () => {
    expect(readHtmlImgAt("<img src='./a.png'>", 0)).toMatchObject({ src: './a.png' });
    expect(readHtmlImgAt('<img src=./a.png>', 0)).toMatchObject({ src: './a.png' });
  });

  test('src after other attributes; data-src / srcset are not read as the source', () => {
    expect(readHtmlImgAt('<img alt="x" src="./a.png">', 0)).toMatchObject({ src: './a.png' });
    expect(readHtmlImgAt('<img data-src="./decoy.png" src="./real.png">', 0)).toMatchObject({
      src: './real.png',
    });
    expect(readHtmlImgAt('<img srcset="./a.png 1x">', 0)).toBeNull();
  });

  test('non-img tags and img without src do not match', () => {
    expect(readHtmlImgAt('<a href="./a.png">', 0)).toBeNull();
    expect(readHtmlImgAt('<img alt="no source">', 0)).toBeNull();
  });

  test('scans every img on a line and preserves exact spans', () => {
    const line = 'a <img src="./a.png"> b <img src="./b.png"/> c';
    const matches = matchHtmlImgs(line);
    expect(matches.map((m) => m.src)).toEqual(['./a.png', './b.png']);
    for (const m of matches) expect(line.slice(m.start, m.end).startsWith('<img')).toBe(true);
  });
});

/**
 * Characterization ledger for the pre-consolidation recognizer divergences.
 * Each entry pins how the shared grammar decided a case where the four
 * original per-consumer recognizers disagreed, exercised through the
 * consumers' own exported surfaces so a regression in either direction
 * fails here first.
 */
describe('cross-consumer divergence ledger', () => {
  test('paren and apostrophe titles: asset extraction now agrees with the backlink indexer', () => {
    // Pre-consolidation asset-references missed both title forms entirely.
    for (const md of ['[doc](./t.pdf (title))', '[doc](./t.pdf "it\'s here")']) {
      expect(extractLocalAssetHrefs(md)).toEqual(['./t.pdf']);
      expect(extractMarkdownLinksFromMarkdown(md.replace('.pdf', '.md'), 'src')).toHaveLength(1);
    }
  });

  test('mismatched title quotes: asset extraction now rejects, agreeing with the indexer', () => {
    // Pre-consolidation asset-references matched `"t'` as a title.
    expect(extractLocalAssetHrefs('[a](./x.pdf "t\')')).toEqual([]);
    expect(extractMarkdownLinksFromMarkdown('[a](./x.md "t\')', 'src')).toEqual([]);
  });

  test('wiki targets in asset extraction are now trimmed and whitespace-only targets drop', () => {
    // Pre-consolidation asset-references collected the raw untrimmed target;
    // downstream href decoration stripping trimmed it anyway, so resolution
    // is unchanged.
    expect(extractLocalAssetHrefs('[[ spaced.png ]]')).toEqual(['spaced.png']);
    expect(extractLocalAssetHrefs('[[ ]]')).toEqual([]);
  });

  test('badge-style image-in-link: asset extraction keeps the outer destination', () => {
    expect(extractLocalAssetHrefs('[![alt](./inner.png)](./outer.pdf)')).toEqual(['./outer.pdf']);
  });

  test('escape handling is a scanner concern, not a grammar concern', () => {
    // Cursor-based consumers (backlink indexer, rename rewriter) honor a
    // leading backslash escape before dispatching into the grammar; the
    // regex-scan consumer (asset-references) never did and still does not.
    const md = '\\[[not-wiki.png]]';
    expect(extractWikiLinksFromMarkdown(md, 'src')).toEqual([]);
    expect(rewriteWikiLinksForDocumentRename(md, 'not-wiki.png', 'renamed')).toMatchObject({
      rewrites: 0,
    });
    expect(extractLocalAssetHrefs(md)).toEqual(['not-wiki.png']);
  });

  test('deliberate residual: the observer bare-text strip is looser than the grammar', () => {
    // Characterization copy of `markdownBareText`'s strip regex in
    // server-observers.ts. That reduction deliberately over-matches
    // (whitespace destinations, no title handling) because attribution
    // only needs a stable common form — see link-syntax.ts. WARN: if the
    // strip regex in server-observers.ts changes, re-pin here.
    const observerStrip = (line: string) => line.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
    // The loose strip reduces a whitespace destination the grammar rejects.
    expect(observerStrip('[a](two words)')).toBe('a');
    expect(readMarkdownLinkAt('[a](two words)', 0)).toBeNull();
    // The loose strip truncates at the first `)` inside a quoted title.
    expect(observerStrip('[doc](./t.md "ti)tle")')).toBe('doctle")');
    expect(readMarkdownLinkAt('[doc](./t.md "ti)tle")', 0)).toMatchObject({ href: './t.md' });
  });
});
