/**
 * Unit tests for the live-DOM clipboard walker pure helpers.
 *
 * The walker's full DOM behavior (cloneNode parallel walk, view.nodeDOM
 * lookup, fallback palette firing on Activity-hidden subtrees) requires a
 * real browser and is exercised in Playwright. Here we test the pure
 * transformation helpers + the static surface (allowlist / blocklist
 * contents) that live in this file.
 *
 * The cross-app re-emit sanitization helpers (URL classification,
 * embedded-URL substitution, event-handler / style-payload filters) live
 * in `clipboard-sanitize.ts` and are tested in `clipboard-sanitize.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { Schema } from '@tiptap/pm/model';
import {
  ATTR_BLOCKLIST,
  applyUrlClassifierPostPass,
  applyWikiLinkTransform,
  buildInlineStyleFrom,
  buildWikiEmbedMarkdownSource,
  CLASS_BLOCKLIST,
  type ComputedStyleLike,
  chooseEmissionClass,
  glyphForLucide,
  LUCIDE_GLYPH_MAP,
  STYLE_ALLOWLIST,
  selectionPartiallyCoversTopLevelNode,
  stripBlocklistedClasses,
  type WalkerEnv,
} from './clipboard-walker.ts';

function fakeStyles(map: Record<string, string>): ComputedStyleLike {
  return {
    getPropertyValue: (prop: string) => map[prop] ?? '',
  };
}

describe('STYLE_ALLOWLIST — surface contract', () => {
  test('includes the email-safe color + typography properties', () => {
    expect(STYLE_ALLOWLIST).toContain('color');
    expect(STYLE_ALLOWLIST).toContain('background-color');
    expect(STYLE_ALLOWLIST).toContain('font-family');
    expect(STYLE_ALLOWLIST).toContain('font-size');
    expect(STYLE_ALLOWLIST).toContain('font-weight');
    expect(STYLE_ALLOWLIST).toContain('text-align');
    expect(STYLE_ALLOWLIST).toContain('line-height');
  });

  test('includes the box-model spacing properties', () => {
    expect(STYLE_ALLOWLIST).toContain('padding');
    expect(STYLE_ALLOWLIST).toContain('margin');
    expect(STYLE_ALLOWLIST).toContain('border');
    expect(STYLE_ALLOWLIST).toContain('border-radius');
  });

  test('does NOT include layout / transform / animation properties', () => {
    // Cross-app destinations rebuild layout; inlining these would yield
    // broken visuals on paste-receive.
    expect(STYLE_ALLOWLIST).not.toContain('display');
    expect(STYLE_ALLOWLIST).not.toContain('position');
    expect(STYLE_ALLOWLIST).not.toContain('transform');
    expect(STYLE_ALLOWLIST).not.toContain('transition');
    expect(STYLE_ALLOWLIST).not.toContain('animation');
    expect(STYLE_ALLOWLIST).not.toContain('flex');
    expect(STYLE_ALLOWLIST).not.toContain('grid');
  });

  test('does NOT include vendor-prefixed or interaction properties', () => {
    expect(STYLE_ALLOWLIST.some((p) => p.startsWith('-webkit-'))).toBe(false);
    expect(STYLE_ALLOWLIST).not.toContain('pointer-events');
    expect(STYLE_ALLOWLIST).not.toContain('user-select');
  });
});

describe('CLASS_BLOCKLIST — surface contract', () => {
  test('strips the JSX wrapper chrome', () => {
    expect(CLASS_BLOCKLIST.has('jsx-component-wrapper')).toBe(true);
  });

  test('strips ProseMirror selection / placeholder internals', () => {
    expect(CLASS_BLOCKLIST.has('ProseMirror-selectednode')).toBe(true);
    expect(CLASS_BLOCKLIST.has('ProseMirror-trailingBreak')).toBe(true);
    expect(CLASS_BLOCKLIST.has('selectedCell')).toBe(true);
    expect(CLASS_BLOCKLIST.has('is-empty')).toBe(true);
  });
});

describe('ATTR_BLOCKLIST — surface contract', () => {
  test('strips data-* selection / drag markers', () => {
    expect(ATTR_BLOCKLIST.has('data-selected')).toBe(true);
    expect(ATTR_BLOCKLIST.has('data-has-child-selected')).toBe(true);
    expect(ATTR_BLOCKLIST.has('data-dragging')).toBe(true);
    expect(ATTR_BLOCKLIST.has('data-range-selected')).toBe(true);
  });

  test('strips contenteditable + data-pm-slice', () => {
    expect(ATTR_BLOCKLIST.has('contenteditable')).toBe(true);
    expect(ATTR_BLOCKLIST.has('data-pm-slice')).toBe(true);
  });
});

describe('buildInlineStyleFrom — pure style filter', () => {
  test('emits allowlisted properties only', () => {
    const styles = fakeStyles({
      color: 'rgb(20, 20, 20)',
      'background-color': 'rgb(255, 240, 240)',
      // Properties NOT in the allowlist — should not appear in output.
      display: 'flex',
      transform: 'rotate(0deg)',
      position: 'absolute',
    });
    const out = buildInlineStyleFrom(styles);
    expect(out).toContain('color: rgb(20, 20, 20)');
    expect(out).toContain('background-color: rgb(255, 240, 240)');
    expect(out).not.toContain('display:');
    expect(out).not.toContain('transform:');
    expect(out).not.toContain('position:');
  });

  test('skips empty / initial / normal property values', () => {
    const styles = fakeStyles({
      color: 'rgb(0, 0, 0)',
      'background-color': '',
      'font-family': 'initial',
      'line-height': 'normal',
    });
    const out = buildInlineStyleFrom(styles);
    expect(out).toContain('color:');
    expect(out).not.toContain('background-color:');
    expect(out).not.toContain('font-family:');
    expect(out).not.toContain('line-height:');
  });

  test('returns empty string when no allowlisted properties have values', () => {
    const styles = fakeStyles({});
    expect(buildInlineStyleFrom(styles)).toBe('');
  });

  test('honors a custom allowlist for selective emission', () => {
    const styles = fakeStyles({
      color: 'rgb(1, 2, 3)',
      'font-size': '14px',
    });
    const out = buildInlineStyleFrom(styles, ['color']);
    expect(out).toContain('color:');
    expect(out).not.toContain('font-size:');
  });
});

describe('stripBlocklistedClasses — pure class filter', () => {
  test('removes blocklisted entries and preserves others', () => {
    const result = stripBlocklistedClasses('callout jsx-component-wrapper callout-note');
    expect(result).toBe('callout callout-note');
  });

  test('returns null when ALL classes are blocklisted', () => {
    const result = stripBlocklistedClasses('jsx-component-wrapper ProseMirror-selectednode');
    expect(result).toBeNull();
  });

  test('returns null for an empty class string', () => {
    expect(stripBlocklistedClasses('')).toBeNull();
  });

  test('handles whitespace and multiple spaces', () => {
    const result = stripBlocklistedClasses('  callout    is-empty   callout-note  ');
    expect(result).toBe('callout callout-note');
  });

  test('honors a custom blocklist', () => {
    const result = stripBlocklistedClasses('foo bar baz', new Set(['bar']));
    expect(result).toBe('foo baz');
  });
});

describe('buildInlineStyleFrom — modern CSS color downgrade', () => {
  test('converts oklch values to rgb so destination renderers can paint them', () => {
    // Tailwind v4 themes resolve to oklch literals via `getComputedStyle`.
    // The walker must convert these to rgb() before emitting inline style;
    // otherwise destinations like Gmail / Notion render them as default
    // (invisible chevrons, missing accent borders).
    const styles = fakeStyles({
      color: 'oklch(0.62 0.15 240)',
      'background-color': 'oklch(0.95 0.02 240)',
    });
    const out = buildInlineStyleFrom(styles);
    expect(out).not.toContain('oklch(');
    expect(out).toMatch(/color: rgb\(/);
    expect(out).toMatch(/background-color: rgb\(/);
  });

  test('preserves rgb / hex values unchanged when already legacy', () => {
    const styles = fakeStyles({
      color: 'rgb(20, 20, 20)',
      'background-color': '#fef3c7',
    });
    const out = buildInlineStyleFrom(styles);
    expect(out).toContain('color: rgb(20, 20, 20)');
    expect(out).toContain('background-color: #fef3c7');
  });
});

describe('selectionPartiallyCoversTopLevelNode — selection-bound containment guard', () => {
  // Cross-app clipboard leak class: the walker's `view.nodeDOM(pos)` returns
  // the WHOLE top-level element for partial selections, leaking unselected
  // text. This guard short-circuits the walker so the markdown tier (which
  // serializes the slice directly) renders only the selected range.

  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: {
        group: 'block',
        content: 'text*',
        toDOM: () => ['p', 0],
        parseDOM: [{ tag: 'p' }],
      },
      text: { group: 'inline' },
    },
  });

  function buildDoc(...paragraphs: string[]) {
    return schema.node(
      'doc',
      null,
      paragraphs.map((p) => schema.node('paragraph', null, p.length > 0 ? [schema.text(p)] : [])),
    );
  }

  test('full single-paragraph selection → not partial (whole top-level node covered)', () => {
    // <p>hello</p> — paragraph at pos 0, nodeSize 7 (1 open + 5 chars + 1 close)
    const doc = buildDoc('hello');
    expect(selectionPartiallyCoversTopLevelNode(doc, 0, doc.nodeSize - 2)).toBe(false);
  });

  test('partial mid-paragraph selection → partial (leaks surrounding text in walker)', () => {
    // <p>Hello world</p> — selecting just `lo` (positions 4..6).
    // Paragraph is at pos 0, nodeSize 13.
    const doc = buildDoc('Hello world');
    expect(selectionPartiallyCoversTopLevelNode(doc, 4, 6)).toBe(true);
  });

  test('selection from start of paragraph but ending mid-paragraph → partial', () => {
    const doc = buildDoc('Hello world');
    // From=1 (just inside paragraph), to=6 (mid-text).
    expect(selectionPartiallyCoversTopLevelNode(doc, 1, 6)).toBe(true);
  });

  test('selection mid-paragraph to end → partial', () => {
    const doc = buildDoc('Hello world');
    // From=6 (mid-text), to=12 (end of text, just before close).
    expect(selectionPartiallyCoversTopLevelNode(doc, 6, 12)).toBe(true);
  });

  test('selection spanning two whole paragraphs → not partial', () => {
    // <p>foo</p><p>bar</p>
    // p1 at pos 0, nodeSize 5; p2 at pos 5, nodeSize 5
    const doc = buildDoc('foo', 'bar');
    expect(selectionPartiallyCoversTopLevelNode(doc, 0, 10)).toBe(false);
  });

  test('selection straddling a top-level boundary → partial', () => {
    // <p>foo</p><p>bar</p> — from end of p1 to mid p2 leaks text from p1.
    const doc = buildDoc('foo', 'bar');
    expect(selectionPartiallyCoversTopLevelNode(doc, 2, 7)).toBe(true);
  });

  test('selection covering all paragraphs → not partial', () => {
    const doc = buildDoc('foo', 'bar', 'baz');
    expect(selectionPartiallyCoversTopLevelNode(doc, 0, doc.content.size)).toBe(false);
  });
});

describe('glyphForLucide — pure lookup for cross-app icon substitution', () => {
  test('returns the glyph for a single-class lucide name', () => {
    expect(glyphForLucide('lucide-info')).toBe('ℹ');
    expect(glyphForLucide('lucide-chevron-right')).toBe('›');
    expect(glyphForLucide('lucide-chevron-down')).toBe('⌄');
    expect(glyphForLucide('lucide-alert-triangle')).toBe('⚠');
  });

  test('handles multi-class strings with the lucide name as prefix', () => {
    expect(glyphForLucide('lucide-info callout-icon')).toBe('ℹ');
    expect(glyphForLucide('lucide-chevron-right accordion-chevron')).toBe('›');
    expect(glyphForLucide('lucide-chevron-down callout-chevron')).toBe('⌄');
  });

  test('handles multi-class strings with the lucide name as suffix', () => {
    expect(glyphForLucide('callout-icon lucide-info')).toBe('ℹ');
    expect(glyphForLucide('lucide lucide-info')).toBe('ℹ');
  });

  test('handles multi-class strings with the lucide name in the middle', () => {
    expect(glyphForLucide('foo lucide-info bar')).toBe('ℹ');
  });

  test('does NOT substring-match — `lucide-info-darker` is not `lucide-info`', () => {
    // Anchor regression: a hyphenated extension of a mapped name must not
    // collide with the mapped glyph. The class regex requires the name to
    // be terminated by whitespace or string-end.
    expect(glyphForLucide('lucide-info-darker')).toBeNull();
    expect(glyphForLucide('lucide-info-foo lucide-foo')).toBeNull();
  });

  test('returns null for empty / no-lucide-class inputs', () => {
    expect(glyphForLucide('')).toBeNull();
    expect(glyphForLucide('callout-icon')).toBeNull();
    expect(glyphForLucide('foo bar baz')).toBeNull();
  });

  test('returns null for unmapped lucide-* classes (graceful degradation)', () => {
    // Unmapped lucide icons fall through to the walker's existing
    // sanitization — the SVG stays in place. Cross-app destinations
    // strip it, but a wrong glyph would be worse than no glyph.
    expect(glyphForLucide('lucide-nonexistent-icon')).toBeNull();
    expect(glyphForLucide('lucide-volume-2')).toBeNull();
    expect(glyphForLucide('lucide-trash2')).toBeNull();
  });

  test('LUCIDE_GLYPH_MAP entry count is anchored — adding/removing icons is intentional', () => {
    // Pin the surface so a mistakenly-deleted entry surfaces here, and
    // intentional additions force a test update. Seven entries cover the
    // current Callout (5 type icons) + collapsible chevron-down (open
    // state) + chevron-right (closed state, used by
    // Accordion); adding a new descriptor with new icons requires bumping
    // this count.
    expect(Object.keys(LUCIDE_GLYPH_MAP)).toHaveLength(7);
  });

  test('every LUCIDE_GLYPH_MAP key matches the lucide-<kebab-name> shape', () => {
    // The class regex uses `[a-z0-9-]+` after `lucide-`; if a key were
    // added with a capital letter or underscore it would never match the
    // class string emitted by lucide-react. Anchor the convention.
    for (const key of Object.keys(LUCIDE_GLYPH_MAP)) {
      expect(key).toMatch(/^lucide-[a-z0-9-]+$/);
    }
  });

  test('every LUCIDE_GLYPH_MAP value is a non-empty string', () => {
    for (const value of Object.values(LUCIDE_GLYPH_MAP)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

// ─── URL classifier + wiki-link transform test helpers ─────────────────
//
// bun-test has no DOM (`document.createElement` is unavailable; jsdom /
// happy-dom are not workspace dependencies — see existing convention in
// `clipboard-walker-fallback-palette.test.ts`). Full DOM behavior of the
// walker post-passes (cloneNode parallel walk, posAtDOM lookup, swap +
// replaceWith mechanics) is exercised in Playwright. The unit tests in
// this file pin pure decision logic via narrow Element-shaped fakes.

/**
 * Build a minimal Element-shaped fake for `chooseEmissionClass` —
 * `closest(selector)` is the only DOM method `chooseEmissionClass`
 * touches, so the fake's surface is intentionally tight.
 */
function fakeElementWithClosest(closestResults: Record<string, Element | null>): Element {
  return {
    closest: (selector: string) => closestResults[selector] ?? null,
  } as unknown as Element;
}

describe('chooseEmissionClass — paragraph-content-model rule', () => {
  test('returns `mdx-inline` when the element has a <p> ancestor', () => {
    // HTML5 §4.4.1: paragraph content forbids `<pre>` (block flow content).
    // Inserting `<pre class="mdx-component">` inside `<p>` would make the
    // browser auto-close the paragraph and break the surrounding context
    // in the destination renderer. Inline emission via `<span>` preserves
    // paragraph integrity.
    const fakeP = {} as Element;
    const el = fakeElementWithClosest({ p: fakeP });
    expect(chooseEmissionClass(el)).toBe('mdx-inline');
  });

  test('returns `mdx-component` when the element has no <p> ancestor', () => {
    // Flow context (top-level block, inside `<div>`, etc.) — block
    // emission via `<pre class="mdx-component">` is the canonical
    // styled-code-block shape that destinations preserve.
    const el = fakeElementWithClosest({});
    expect(chooseEmissionClass(el)).toBe('mdx-component');
  });
});

// ─── applyWikiLinkTransform — narrow DOM-fake test ──────────────────────
//
// `applyWikiLinkTransform` reads `data-target` / `data-anchor` from a
// `<span data-wiki-link>` and replaces the span with `<a href="#${slug}">
// {textContent}</a>`. The slug computation is the contract surface — the
// rest is plumbing. A narrow Element-shaped fake captures the rewrite
// shape without a real DOM.

interface FakeNode {
  tagName: string;
  attrs: Record<string, string>;
  textContent: string;
  parent: FakeRoot | null;
}

interface FakeRoot {
  children: FakeNode[];
  querySelectorAll: (selector: string) => FakeNode[];
}

function makeFakeNode(
  tagName: string,
  attrs: Record<string, string>,
  textContent: string,
): FakeNode {
  return { tagName, attrs, textContent, parent: null };
}

function makeFakeDoc() {
  const created: FakeNode[] = [];
  return {
    createElement: (tag: string): FakeNode => {
      const node = makeFakeNode(tag.toLowerCase(), {}, '');
      created.push(node);
      return node;
    },
    created,
  };
}

function adaptFakeForTransform(root: FakeRoot, doc: ReturnType<typeof makeFakeDoc>): Element {
  // Wrap each FakeNode so it satisfies the methods `applyWikiLinkTransform`
  // calls. `querySelectorAll` returns spans; `getAttribute` / `textContent`
  // / `replaceWith` operate on each. `ownerDocument.createElement` returns
  // a fresh anchor.
  const wrap = (node: FakeNode): Element =>
    ({
      tagName: node.tagName.toUpperCase(),
      getAttribute: (name: string) => node.attrs[name] ?? null,
      setAttribute: (name: string, value: string) => {
        node.attrs[name] = value;
      },
      get textContent() {
        return node.textContent;
      },
      set textContent(v: string) {
        node.textContent = v;
      },
      ownerDocument: { createElement: (tag: string) => wrap(doc.createElement(tag)) },
      replaceWith: (replacement: { _node?: FakeNode } & Element) => {
        if (!node.parent) return;
        const i = node.parent.children.indexOf(node);
        const repl = (replacement as unknown as { _node?: FakeNode })._node ?? doc.created.at(-1);
        if (i >= 0 && repl) {
          node.parent.children[i] = repl;
          repl.parent = node.parent;
        }
      },
      _node: node,
    }) as unknown as Element;
  const wrappedRoot = {
    querySelectorAll: (selector: string) => {
      if (selector !== 'span[data-wiki-link]') return [];
      return root.children
        .filter((n) => n.tagName === 'span' && Object.hasOwn(n.attrs, 'data-wiki-link'))
        .map(wrap);
    },
  } as unknown as Element;
  return wrappedRoot;
}

describe('applyWikiLinkTransform — wiki-link rewrite', () => {
  test('rewrites span[data-wiki-link] to a fragment-href anchor with the rendered alias text', () => {
    // Live render shape per `wiki-link.ts` renderHTML — the span carries
    // data-target/data-anchor plus the rendered alias text.
    const span = makeFakeNode(
      'span',
      {
        'data-wiki-link': '',
        'data-target': 'Other Doc',
        'data-anchor': '',
        'data-resolved': 'false',
      },
      'Other Doc',
    );
    const root: FakeRoot = { children: [span], querySelectorAll: () => [] };
    span.parent = root;
    const doc = makeFakeDoc();
    applyWikiLinkTransform(adaptFakeForTransform(root, doc));
    expect(root.children).toHaveLength(1);
    const replaced = root.children[0];
    expect(replaced.tagName).toBe('a');
    // Slug for "Other Doc" — toWikiLinkSlug lowercases + replaces non-
    // alphanumeric runs with hyphens.
    expect(replaced.attrs.href).toBe('#other-doc');
    expect(replaced.textContent).toBe('Other Doc');
    // Cross-pipeline shape parity with mdast-to-hast wikiLinkHandler so
    // OK→OK paste reconstructs wikiLink node identity via the
    // `a.wiki-link[data-target]` parseHTML rule in `wiki-link.ts`.
    expect(replaced.attrs.class).toBe('wiki-link');
    expect(replaced.attrs['data-target']).toBe('Other Doc');
    expect(replaced.attrs['data-anchor']).toBe('');
    expect(replaced.attrs['data-alias']).toBe('');
  });

  test('rewrites with anchor to a slug-and-anchor-slug fragment href', () => {
    const span = makeFakeNode(
      'span',
      {
        'data-wiki-link': '',
        'data-target': 'Other Doc',
        'data-anchor': 'Section Name',
      },
      'Other Doc#Section Name',
    );
    const root: FakeRoot = { children: [span], querySelectorAll: () => [] };
    span.parent = root;
    applyWikiLinkTransform(adaptFakeForTransform(root, makeFakeDoc()));
    const replaced = root.children[0];
    expect(replaced.attrs.href).toBe('#other-doc-section-name');
    expect(replaced.textContent).toBe('Other Doc#Section Name');
    expect(replaced.attrs.class).toBe('wiki-link');
    expect(replaced.attrs['data-target']).toBe('Other Doc');
    expect(replaced.attrs['data-anchor']).toBe('Section Name');
  });

  test('preserves alias text when display text diverges from data-target', () => {
    // `[[Page#Section|Custom Alias]]` renders as a span with
    // `data-target='Page'`, `data-anchor='Section'`, `data-alias='Custom Alias'`,
    // and `textContent='Custom Alias'`. The walker MUST source display text
    // from `textContent` (the user's chosen alias), not derive it from
    // `data-target` or `data-anchor`. A regression that derived text
    // from `data-target` would silently strip aliases — pasting
    // `[[Page#Section|Custom Alias]]` into Gmail / Notion / Slack would
    // show `Page` instead of `Custom Alias`. The `data-alias` attribute
    // is also preserved so round-trip recovers the exact alias.
    const span = makeFakeNode(
      'span',
      {
        'data-wiki-link': '',
        'data-target': 'Page',
        'data-anchor': 'Section',
        'data-alias': 'Custom Alias',
      },
      'Custom Alias',
    );
    const root: FakeRoot = { children: [span], querySelectorAll: () => [] };
    span.parent = root;
    applyWikiLinkTransform(adaptFakeForTransform(root, makeFakeDoc()));
    const replaced = root.children[0];
    expect(replaced.attrs.href).toBe('#page-section');
    expect(replaced.textContent).toBe('Custom Alias');
    expect(replaced.attrs.class).toBe('wiki-link');
    expect(replaced.attrs['data-target']).toBe('Page');
    expect(replaced.attrs['data-anchor']).toBe('Section');
    expect(replaced.attrs['data-alias']).toBe('Custom Alias');
  });

  test('skips spans with empty data-target (defensive sanity guard)', () => {
    // The wiki-link parser rejects empty targets upstream so this is a
    // sanity guard rather than a real runtime case. Empty target → no
    // transform; the original span stays in place.
    const span = makeFakeNode('span', { 'data-wiki-link': '', 'data-target': '' }, '');
    const root: FakeRoot = { children: [span], querySelectorAll: () => [] };
    span.parent = root;
    applyWikiLinkTransform(adaptFakeForTransform(root, makeFakeDoc()));
    expect(root.children[0]).toBe(span);
    expect(root.children[0].tagName).toBe('span');
  });

  test('treats whitespace-only data-anchor as null (matches normalizeNullableString)', () => {
    // `normalizeNullableString('   ')` returns null; so the resulting
    // href should be `#${slug}` without a trailing `-`. Wiki-link parser
    // upstream produces null for whitespace-only anchor; this test pins
    // the same semantics at the walker boundary.
    const span = makeFakeNode(
      'span',
      {
        'data-wiki-link': '',
        'data-target': 'Doc',
        'data-anchor': '   ',
      },
      'Doc',
    );
    const root: FakeRoot = { children: [span], querySelectorAll: () => [] };
    span.parent = root;
    applyWikiLinkTransform(adaptFakeForTransform(root, makeFakeDoc()));
    expect(root.children[0].attrs.href).toBe('#doc');
  });

  test('Unicode targets/anchors NFKD-normalize through the slug helper', () => {
    // Cross-pipeline byte parity — same wikiLinkHref helper that
    // `mdast-to-hast-handlers.ts:wikiLinkHandler` uses. Combining marks
    // (e.g., café) get NFKD-decomposed and stripped.
    const span = makeFakeNode(
      'span',
      {
        'data-wiki-link': '',
        'data-target': 'Café Menu',
        'data-anchor': 'Pâté Selection',
      },
      'Café Menu#Pâté Selection',
    );
    const root: FakeRoot = { children: [span], querySelectorAll: () => [] };
    span.parent = root;
    applyWikiLinkTransform(adaptFakeForTransform(root, makeFakeDoc()));
    expect(root.children[0].attrs.href).toBe('#cafe-menu-pate-selection');
  });
});

// ─── applyUrlClassifierPostPass — decision-rule unit tests ──────────────
//
// Full DOM behavior (real cloneNode parallel walk, posAtDOM correlation,
// ownerDocument.createElement on real Documents) lives in Playwright. The
// unit tests below exercise the post-pass's decision logic via a narrow
// Element-fake that supports only the methods the post-pass touches:
// `tagName`, `getAttribute`, `closest`, `children`, `replaceWith`,
// `ownerDocument.createElement` (with `appendChild` + `textContent` so
// `createSourceFallbackElement` can build a `<pre><code>` shape).

interface PostPassFakeElement {
  tagName: string;
  attrs: Record<string, string>;
  children: PostPassFakeElement[];
  parent: PostPassFakeElement | null;
  closestP: PostPassFakeElement | null;
  textContent: string;
  /** Set after `createSourceFallbackElement` has appended a textNode child. */
  swappedMarkdown?: string;
}

function makePostPassNode(
  tagName: string,
  attrs: Record<string, string> = {},
  children: PostPassFakeElement[] = [],
): PostPassFakeElement {
  const node: PostPassFakeElement = {
    tagName: tagName.toLowerCase(),
    attrs: { ...attrs },
    children,
    parent: null,
    closestP: null,
    textContent: '',
  };
  for (const c of children) c.parent = node;
  return node;
}

/** Wrap a fake node so it satisfies the Element surface the post-pass touches. */
function wrapPostPassNode(node: PostPassFakeElement): Element {
  const wrapped = {
    get tagName() {
      return node.tagName.toUpperCase();
    },
    getAttribute: (name: string) => node.attrs[name] ?? null,
    setAttribute: (name: string, value: string) => {
      node.attrs[name] = value;
    },
    set className(value: string) {
      node.attrs.class = value;
    },
    get className() {
      return node.attrs.class ?? '';
    },
    set textContent(value: string) {
      node.textContent = value;
      node.swappedMarkdown = value;
    },
    get textContent() {
      return node.textContent;
    },
    get children() {
      return node.children.map(wrapPostPassNode);
    },
    closest: (selector: string) => {
      if (selector === 'p') return node.closestP === null ? null : wrapPostPassNode(node.closestP);
      return null;
    },
    querySelectorAll: (selector: string) => {
      // Only `<picture>` descendants are queried by `classifyPictureDescendants`.
      if (selector === 'source, img') {
        const matches: PostPassFakeElement[] = [];
        const walk = (n: PostPassFakeElement) => {
          for (const c of n.children) {
            if (c.tagName === 'source' || c.tagName === 'img') matches.push(c);
            walk(c);
          }
        };
        walk(node);
        return matches.map(wrapPostPassNode);
      }
      return [];
    },
    appendChild: (child: { _node?: PostPassFakeElement } & Element) => {
      const cn = (child as unknown as { _node?: PostPassFakeElement })._node;
      if (cn) {
        cn.parent = node;
        node.children.push(cn);
      }
      return child;
    },
    replaceWith: (replacement: { _node?: PostPassFakeElement } & Element) => {
      if (!node.parent) return;
      const i = node.parent.children.indexOf(node);
      const repl = (replacement as unknown as { _node?: PostPassFakeElement })._node;
      if (i >= 0 && repl) {
        node.parent.children[i] = repl;
        repl.parent = node.parent;
      }
    },
    ownerDocument: {
      createElement: (tag: string) => wrapPostPassNode(makePostPassNode(tag)),
    },
    _node: node,
  } as unknown as Element & { _node: PostPassFakeElement };
  return wrapped;
}

interface WarningCapture {
  warnings: string[];
  restore: () => void;
}

function captureWarnings(): WarningCapture {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (msg: unknown) => {
    warnings.push(typeof msg === 'string' ? msg : String(msg));
  };
  return { warnings, restore: () => (console.warn = orig) };
}

describe('applyUrlClassifierPostPass — decision rules', () => {
  test('no-op when env.serializeElementMarkdown is undefined: no swaps, no telemetry', () => {
    // The WalkerEnv contract: when the closure is absent, the URL
    // classifier swap is disabled entirely. Without an early-return at
    // the post-pass entry, a non-portable leaf would tumble into
    // `performSwap` and emit `phase: 'serializer-null'` even though the
    // closure was never wired in the first place — conflating the
    // closure-absent case with the closure-present-returned-null case
    // (the latter being a real PM-correspondence bug worth alerting on).
    const liveImg = makePostPassNode('img', { src: './local.jpg' });
    const cloneImg = makePostPassNode('img', { src: './local.jpg' });
    const liveRoot = makePostPassNode('div', {}, [liveImg]);
    const cloneRoot = makePostPassNode('div', {}, [cloneImg]);
    // No `serializeElementMarkdown` — this is the DEFAULT_ENV shape.
    const env: WalkerEnv = { getComputedStyle: () => ({ getPropertyValue: () => '' }) };
    const cap = captureWarnings();
    try {
      applyUrlClassifierPostPass(wrapPostPassNode(liveRoot), wrapPostPassNode(cloneRoot), env);
    } finally {
      cap.restore();
    }
    // Clone preserved (no swap).
    expect(cloneRoot.children).toHaveLength(1);
    expect(cloneRoot.children[0]).toBe(cloneImg);
    expect(cloneRoot.children[0].tagName).toBe('img');
    // No telemetry of any kind — neither classifier-failed nor source-emitted.
    const telemetry = cap.warnings
      .map((w) => JSON.parse(w))
      .filter(
        (e) =>
          e.event === 'clipboard-walker-url-classifier-failed' ||
          e.event === 'clipboard-walker-url-source-emitted',
      );
    expect(telemetry).toHaveLength(0);
  });

  test('recursion-stop: outer-portable + inner-non-portable swaps the INNER element only', () => {
    // Outer `<a href="https://example.com/">` wrapping inner
    // `<img src="./local.jpg">`. The outer is portable (recurse into
    // children); the inner is non-portable (swap and stop). The serializer
    // must be called exactly once and with the live counterpart of the
    // INNER element — not the outer.
    const liveImg = makePostPassNode('img', { src: './local.jpg' });
    const liveA = makePostPassNode('a', { href: 'https://example.com/' }, [liveImg]);
    const cloneImg = makePostPassNode('img', { src: './local.jpg' });
    const cloneA = makePostPassNode('a', { href: 'https://example.com/' }, [cloneImg]);
    // Synthesize a parent so the inner clone has somewhere to swap into.
    const liveRoot = makePostPassNode('div', {}, [liveA]);
    const cloneRoot = makePostPassNode('div', {}, [cloneA]);
    const seen: Element[] = [];
    const env: WalkerEnv = {
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      serializeElementMarkdown: (live) => {
        seen.push(live);
        return { kind: 'ok', markdown: '![](./local.jpg)' };
      },
    };
    const cap = captureWarnings();
    try {
      applyUrlClassifierPostPass(wrapPostPassNode(liveRoot), wrapPostPassNode(cloneRoot), env);
    } finally {
      cap.restore();
    }
    // Exactly one swap.
    expect(seen).toHaveLength(1);
    // The live element passed to the serializer is the inner <img>.
    const seenNode = (seen[0] as unknown as { _node: PostPassFakeElement })._node;
    expect(seenNode).toBe(liveImg);
    // The outer clone <a> still exists; its child is now a <pre> source-
    // fallback (the inner clone <img> was replaced).
    expect(cloneA.children).toHaveLength(1);
    expect(cloneA.children[0].tagName).toBe('pre');
    // Source-emitted telemetry fires once at tag='img' (NOT tag='a').
    const emitted = cap.warnings
      .map((w) => JSON.parse(w))
      .filter((e) => e.event === 'clipboard-walker-url-source-emitted');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].tag).toBe('img');
  });

  test('picture precedence: a <picture> with non-portable <source> swaps as `tag: picture`', () => {
    // `<picture><source src="./local.webp"><img src="./fallback.jpg"></picture>`
    // — both descendants are non-portable. The post-pass swaps the entire
    // `<picture>` and emits a single source-emitted event at tag='picture',
    // NOT a sequence of leaf-level events for the <source> + <img>.
    const liveSource = makePostPassNode('source', { src: './local.webp' });
    const liveFallback = makePostPassNode('img', { src: './fallback.jpg' });
    const livePicture = makePostPassNode('picture', {}, [liveSource, liveFallback]);
    const cloneSource = makePostPassNode('source', { src: './local.webp' });
    const cloneFallback = makePostPassNode('img', { src: './fallback.jpg' });
    const clonePicture = makePostPassNode('picture', {}, [cloneSource, cloneFallback]);
    const liveRoot = makePostPassNode('div', {}, [livePicture]);
    const cloneRoot = makePostPassNode('div', {}, [clonePicture]);
    const env: WalkerEnv = {
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      serializeElementMarkdown: () => ({ kind: 'ok', markdown: '![](./local.webp)' }),
    };
    const cap = captureWarnings();
    try {
      applyUrlClassifierPostPass(wrapPostPassNode(liveRoot), wrapPostPassNode(cloneRoot), env);
    } finally {
      cap.restore();
    }
    const emitted = cap.warnings
      .map((w) => JSON.parse(w))
      .filter((e) => e.event === 'clipboard-walker-url-source-emitted');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].tag).toBe('picture');
  });

  test('picture with malformed descendant URL emits classifier-throw at both picture AND leaf level', () => {
    // Pin the documented double-emission contract on `maybeSwapPicture`'s
    // JSDoc: when `classifyPictureDescendants` throws on a malformed URL,
    // `maybeSwapPicture` catches and emits `tag: 'picture'`, then the
    // post-pass recurses into children and `maybeSwapLeaf` emits a SECOND
    // event with the descendant tag. Operators rely on both events for
    // dashboard segmentation. A refactor that swallows the throw inside
    // `classifyPictureDescendants` would silently lose the picture-level
    // event — this test guards against that regression.
    //
    // `http://` is a known-malformed URL: `new URL('http://')` throws
    // TypeError. The walker forwards `classifyError(err)` as `errorClass`.
    const liveSource = makePostPassNode('source', { src: 'http://' });
    const livePicture = makePostPassNode('picture', {}, [liveSource]);
    const cloneSource = makePostPassNode('source', { src: 'http://' });
    const clonePicture = makePostPassNode('picture', {}, [cloneSource]);
    const liveRoot = makePostPassNode('div', {}, [livePicture]);
    const cloneRoot = makePostPassNode('div', {}, [clonePicture]);
    const env: WalkerEnv = {
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      serializeElementMarkdown: () => ({ kind: 'ok', markdown: 'unused' }),
    };
    const cap = captureWarnings();
    try {
      applyUrlClassifierPostPass(wrapPostPassNode(liveRoot), wrapPostPassNode(cloneRoot), env);
    } finally {
      cap.restore();
    }
    const failed = cap.warnings
      .map((w) => JSON.parse(w))
      .filter((e) => e.event === 'clipboard-walker-url-classifier-failed');
    // Two events: one at picture-level (from maybeSwapPicture's catch), one
    // at leaf-level (from maybeSwapLeaf's catch on the same descendant URL
    // when the post-pass recurses after the picture-level decline).
    expect(failed).toHaveLength(2);
    const tags = failed.map((e) => e.tag).sort();
    expect(tags).toEqual(['picture', 'source']);
    // Both phases are 'classifier-throw' (vs 'serializer-null' /
    // 'serializer-throw') because the URL classifier itself threw.
    for (const event of failed) {
      expect(event.phase).toBe('classifier-throw');
      expect(event.errorClass).toBe('TypeError');
    }
  });

  test('opt-out alignment: live counterparts skip opt-out children when pairing into clone', () => {
    // walkPair removes opt-out elements from the clone tree before this
    // post-pass runs. The live tree still has them. The post-pass must
    // pair non-opt-out live children with all clone children — otherwise
    // the wrong live element reaches the serializer (off-by-one), and the
    // markdown bytes are wrong even though the swap fires.
    const liveOptOut = makePostPassNode('div', { 'data-clipboard-omit': 'true' });
    const liveImg = makePostPassNode('img', { src: './target.jpg' });
    const liveRoot = makePostPassNode('div', {}, [liveOptOut, liveImg]);
    // Clone has only the img (walkPair already removed the opt-out).
    const cloneImg = makePostPassNode('img', { src: './target.jpg' });
    const cloneRoot = makePostPassNode('div', {}, [cloneImg]);
    let received: PostPassFakeElement | null = null;
    const env: WalkerEnv = {
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      serializeElementMarkdown: (live) => {
        received = (live as unknown as { _node: PostPassFakeElement })._node;
        return { kind: 'ok', markdown: '![](./target.jpg)' };
      },
    };
    const cap = captureWarnings();
    try {
      applyUrlClassifierPostPass(wrapPostPassNode(liveRoot), wrapPostPassNode(cloneRoot), env);
    } finally {
      cap.restore();
    }
    // The serializer received the LIVE img (skipping the opt-out div),
    // not the opt-out div. Without opt-out skip, the post-pass would have
    // recursed into the opt-out div with the clone img on the right —
    // misaligned, and the swap would have classified the wrong element.
    expect(received).toBe(liveImg);
  });

  test('serializer-null: classifier-failed telemetry fires with phase=serializer-null when env returns null', () => {
    // env.serializeElementMarkdown returns null (no PM correspondence —
    // detached / unmounted; baseline noise during `<Activity>` flips). The
    // sister `serializer-throw` phase (a step in the closure threw) is
    // distinct and is exercised in the test below. The post-pass must NOT
    // swap; the clone element stays in place; telemetry surfaces the
    // failure.
    const liveImg = makePostPassNode('img', { src: './local.jpg' });
    const cloneImg = makePostPassNode('img', { src: './local.jpg' });
    const liveRoot = makePostPassNode('div', {}, [liveImg]);
    const cloneRoot = makePostPassNode('div', {}, [cloneImg]);
    const env: WalkerEnv = {
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      serializeElementMarkdown: () => ({ kind: 'no-correspondence' }),
    };
    const cap = captureWarnings();
    try {
      applyUrlClassifierPostPass(wrapPostPassNode(liveRoot), wrapPostPassNode(cloneRoot), env);
    } finally {
      cap.restore();
    }
    // Clone element preserved (no swap).
    expect(cloneRoot.children).toHaveLength(1);
    expect(cloneRoot.children[0]).toBe(cloneImg);
    expect(cloneRoot.children[0].tagName).toBe('img');
    // classifier-failed telemetry fires with phase='serializer-null' so an
    // operator triaging a rate spike can distinguish it from
    // classifier-throw (URL parse / portability bug).
    const failed = cap.warnings
      .map((w) => JSON.parse(w))
      .filter((e) => e.event === 'clipboard-walker-url-classifier-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toEqual({
      event: 'clipboard-walker-url-classifier-failed',
      view: 'wysiwyg',
      tag: 'img',
      phase: 'serializer-null',
    });
    // Source-emitted MUST NOT fire (no swap actually occurred).
    const emitted = cap.warnings
      .map((w) => JSON.parse(w))
      .filter((e) => e.event === 'clipboard-walker-url-source-emitted');
    expect(emitted).toHaveLength(0);
  });

  test('serializer-throw: classifier-failed telemetry attaches errorClass when env returns a failed result', () => {
    // The serializer chain threw — the closure surfaces this as a
    // `{ kind: 'failed', errorClass }` result so the walker can attach
    // errorClass. Sister-symmetric with classifier-throw at
    // maybeSwapLeaf / maybeSwapPicture: a markdown-pipeline regression
    // (content-loss class) is distinguishable from baseline async-detach
    // noise.
    const liveImg = makePostPassNode('img', { src: './local.jpg' });
    const cloneImg = makePostPassNode('img', { src: './local.jpg' });
    const liveRoot = makePostPassNode('div', {}, [liveImg]);
    const cloneRoot = makePostPassNode('div', {}, [cloneImg]);
    const env: WalkerEnv = {
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      serializeElementMarkdown: () => ({ kind: 'failed', errorClass: 'RangeError' }),
    };
    const cap = captureWarnings();
    try {
      applyUrlClassifierPostPass(wrapPostPassNode(liveRoot), wrapPostPassNode(cloneRoot), env);
    } finally {
      cap.restore();
    }
    expect(cloneRoot.children).toHaveLength(1);
    expect(cloneRoot.children[0]).toBe(cloneImg);
    const failed = cap.warnings
      .map((w) => JSON.parse(w))
      .filter((e) => e.event === 'clipboard-walker-url-classifier-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toEqual({
      event: 'clipboard-walker-url-classifier-failed',
      view: 'wysiwyg',
      tag: 'img',
      phase: 'serializer-throw',
      errorClass: 'RangeError',
    });
  });

  test('serializer-throw: errorClass omitted when classifyError returns undefined', () => {
    // When the underlying error is a bare `Error` (not a typed subclass),
    // classifyError returns undefined and the emitter spreads
    // conditionally — the field is absent rather than `errorClass: undefined`.
    // Sister-symmetric with the classifier-throw path's spread shape.
    const liveImg = makePostPassNode('img', { src: './local.jpg' });
    const cloneImg = makePostPassNode('img', { src: './local.jpg' });
    const liveRoot = makePostPassNode('div', {}, [liveImg]);
    const cloneRoot = makePostPassNode('div', {}, [cloneImg]);
    const env: WalkerEnv = {
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      serializeElementMarkdown: () => ({ kind: 'failed', errorClass: undefined }),
    };
    const cap = captureWarnings();
    try {
      applyUrlClassifierPostPass(wrapPostPassNode(liveRoot), wrapPostPassNode(cloneRoot), env);
    } finally {
      cap.restore();
    }
    const failed = cap.warnings
      .map((w) => JSON.parse(w))
      .filter((e) => e.event === 'clipboard-walker-url-classifier-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toEqual({
      event: 'clipboard-walker-url-classifier-failed',
      view: 'wysiwyg',
      tag: 'img',
      phase: 'serializer-throw',
    });
    expect('errorClass' in failed[0]).toBe(false);
  });

  test('classifier-throw: malformed URL surfaces as classifier-throw with errorClass', () => {
    // `http://` survives `isRelativeUrl`'s short-circuit (it has a
    // colon followed by `//`, looks scheme-like) but trips the URL
    // constructor inside classifyUrlPortability. The walker post-pass
    // catches the throw and emits classifier-throw — preserving the
    // user's content while surfacing the failure for follow-up. This
    // covers the integration glue between classifyError + telemetry
    // emission inside maybeSwapLeaf that the unit-level
    // classifyUrlPortability tests can't exercise.
    const liveImg = makePostPassNode('img', { src: 'http://' });
    const cloneImg = makePostPassNode('img', { src: 'http://' });
    const liveRoot = makePostPassNode('div', {}, [liveImg]);
    const cloneRoot = makePostPassNode('div', {}, [cloneImg]);
    const env: WalkerEnv = {
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      serializeElementMarkdown: () => ({ kind: 'ok', markdown: '![](http://)' }),
    };
    const cap = captureWarnings();
    try {
      applyUrlClassifierPostPass(wrapPostPassNode(liveRoot), wrapPostPassNode(cloneRoot), env);
    } finally {
      cap.restore();
    }
    // Element preserved (no swap on classifier throw).
    expect(cloneRoot.children).toHaveLength(1);
    expect(cloneRoot.children[0]).toBe(cloneImg);
    expect(cloneRoot.children[0].tagName).toBe('img');
    // No source-emitted (no swap occurred).
    const emitted = cap.warnings
      .map((w) => JSON.parse(w))
      .filter((e) => e.event === 'clipboard-walker-url-source-emitted');
    expect(emitted).toHaveLength(0);
    // classifier-failed fires with phase='classifier-throw' and errorClass
    // attached (TypeError from `new URL('http://')`).
    const failed = cap.warnings
      .map((w) => JSON.parse(w))
      .filter((e) => e.event === 'clipboard-walker-url-classifier-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].event).toBe('clipboard-walker-url-classifier-failed');
    expect(failed[0].view).toBe('wysiwyg');
    expect(failed[0].tag).toBe('img');
    expect(failed[0].phase).toBe('classifier-throw');
    // Real URL constructor throws TypeError on `http://` — pin that the
    // walker forwards the classified error name from `classifyError(err)`.
    expect(failed[0].errorClass).toBe('TypeError');
  });

  // Per-tag dispatch coverage. classifyLeafElement reads attributes
  // differently per tag (img/source: src + srcset, video/audio: src,
  // a: href). A regression in any branch — e.g., `<a>` reading `src`
  // instead of `href` — would silently leak non-portable URLs. These
  // tests pin the per-tag wiring so the walker integration glue is
  // covered (the underlying classifier is unit-tested separately in
  // clipboard-sanitize.test.ts).
  for (const { tag, attr, value, expectedReason, markdown } of [
    {
      tag: 'video',
      attr: 'src',
      value: './local.mp4',
      expectedReason: 'relative',
      markdown: '<video src="./local.mp4"></video>',
    },
    {
      tag: 'audio',
      attr: 'src',
      value: './local.mp3',
      expectedReason: 'relative',
      markdown: '<audio src="./local.mp3"></audio>',
    },
    {
      tag: 'source',
      attr: 'src',
      value: './local.webp',
      expectedReason: 'relative',
      markdown: '![](./local.webp)',
    },
    {
      tag: 'a',
      attr: 'href',
      value: './local-doc',
      expectedReason: 'relative',
      markdown: '[link](./local-doc)',
    },
    {
      tag: 'img',
      attr: 'src',
      value: './local.jpg',
      expectedReason: 'relative',
      markdown: '![](./local.jpg)',
    },
  ] as const) {
    test(`per-tag swap: <${tag} ${attr}="${value}"> classifies and swaps`, () => {
      const liveLeaf = makePostPassNode(tag, { [attr]: value });
      const cloneLeaf = makePostPassNode(tag, { [attr]: value });
      const liveRoot = makePostPassNode('div', {}, [liveLeaf]);
      const cloneRoot = makePostPassNode('div', {}, [cloneLeaf]);
      const env: WalkerEnv = {
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        serializeElementMarkdown: () => ({ kind: 'ok', markdown }),
      };
      const cap = captureWarnings();
      try {
        applyUrlClassifierPostPass(wrapPostPassNode(liveRoot), wrapPostPassNode(cloneRoot), env);
      } finally {
        cap.restore();
      }
      const emitted = cap.warnings
        .map((w) => JSON.parse(w))
        .filter((e) => e.event === 'clipboard-walker-url-source-emitted');
      expect(emitted).toHaveLength(1);
      expect(emitted[0].tag).toBe(tag);
      expect(emitted[0].reason).toBe(expectedReason);
    });
  }

  test('srcset all-or-nothing: a single non-portable candidate triggers <img> swap', () => {
    // `<img srcset>` must classify as a unit. Sister-pattern of
    // `isSrcsetSafe` (clipboard-sanitize.ts) — first non-portable
    // candidate triggers the entire `<img>` swap, NOT a per-candidate
    // strip. Mixed srcset (one portable, one relative) covers the
    // common authoring case where retina assets ship next to the
    // primary src.
    const liveImg = makePostPassNode('img', {
      src: 'https://example.com/photo.jpg',
      srcset: 'https://example.com/photo.jpg 1x, ./local@2x.jpg 2x',
    });
    const cloneImg = makePostPassNode('img', {
      src: 'https://example.com/photo.jpg',
      srcset: 'https://example.com/photo.jpg 1x, ./local@2x.jpg 2x',
    });
    const liveRoot = makePostPassNode('div', {}, [liveImg]);
    const cloneRoot = makePostPassNode('div', {}, [cloneImg]);
    const env: WalkerEnv = {
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      serializeElementMarkdown: () => ({ kind: 'ok', markdown: '![](photo.jpg)' }),
    };
    const cap = captureWarnings();
    try {
      applyUrlClassifierPostPass(wrapPostPassNode(liveRoot), wrapPostPassNode(cloneRoot), env);
    } finally {
      cap.restore();
    }
    // Source-emitted fires once for the entire <img> with reason='relative'
    // (the relative `./local@2x.jpg` candidate triggered the swap).
    const emitted = cap.warnings
      .map((w) => JSON.parse(w))
      .filter((e) => e.event === 'clipboard-walker-url-source-emitted');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].tag).toBe('img');
    expect(emitted[0].reason).toBe('relative');
  });

  test('emission class: non-portable URL inside <p> ancestor emits class=mdx-inline', () => {
    // `<p>` ancestor → `chooseEmissionClass` returns `'mdx-inline'`. Pin
    // the `class` field on the source-emitted telemetry so an operator
    // triaging emission-shape distribution by destination can rely on
    // the field being present and discriminative.
    const liveImg = makePostPassNode('img', { src: './local.jpg' });
    const cloneImg = makePostPassNode('img', { src: './local.jpg' });
    const livePara = makePostPassNode('p', {}, [liveImg]);
    const clonePara = makePostPassNode('p', {}, [cloneImg]);
    // Wire the `closest('p')` shortcut on the clone img to its parent.
    cloneImg.closestP = clonePara;
    const liveRoot = makePostPassNode('div', {}, [livePara]);
    const cloneRoot = makePostPassNode('div', {}, [clonePara]);
    const env: WalkerEnv = {
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      serializeElementMarkdown: () => ({ kind: 'ok', markdown: '![](./local.jpg)' }),
    };
    const cap = captureWarnings();
    try {
      applyUrlClassifierPostPass(wrapPostPassNode(liveRoot), wrapPostPassNode(cloneRoot), env);
    } finally {
      cap.restore();
    }
    const emitted = cap.warnings
      .map((w) => JSON.parse(w))
      .filter((e) => e.event === 'clipboard-walker-url-source-emitted');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].class).toBe('mdx-inline');
  });

  test('emission class: non-portable URL in flow context emits class=mdx-component', () => {
    // No `<p>` ancestor → `chooseEmissionClass` returns `'mdx-component'`
    // (block-level `<pre><code>` shape). Sister test of the inline case;
    // together they pin both arms of the discriminator.
    const liveImg = makePostPassNode('img', { src: './local.jpg' });
    const cloneImg = makePostPassNode('img', { src: './local.jpg' });
    // Default `closestP` is null — flow context.
    const liveRoot = makePostPassNode('div', {}, [liveImg]);
    const cloneRoot = makePostPassNode('div', {}, [cloneImg]);
    const env: WalkerEnv = {
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      serializeElementMarkdown: () => ({ kind: 'ok', markdown: '![](./local.jpg)' }),
    };
    const cap = captureWarnings();
    try {
      applyUrlClassifierPostPass(wrapPostPassNode(liveRoot), wrapPostPassNode(cloneRoot), env);
    } finally {
      cap.restore();
    }
    const emitted = cap.warnings
      .map((w) => JSON.parse(w))
      .filter((e) => e.event === 'clipboard-walker-url-source-emitted');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].class).toBe('mdx-component');
  });
});

/**
 * Drift fence between `buildWikiEmbedMarkdownSource` (clipboard post-
 * clone path) and `wikiLinkEmbedHandler` in `wiki-link-micromark.ts`
 * (canonical mdast → markdown serializer). Both reconstruct the
 * `![[target#anchor|alias]]` shape from independent inputs (DOM
 * attributes vs mdast `data` payload). If the canonical serializer
 * gains escaping rules or shape changes, this test failing is the
 * prompt to update the clipboard path in lockstep — before silent
 * drift produces clipboard paste different from save-to-disk.
 *
 * Coverage: the four canonical shapes — bare target, target+anchor,
 * target+alias, target+anchor+alias.
 */
describe('buildWikiEmbedMarkdownSource — drift fence vs canonical wikiLinkEmbedHandler', () => {
  test('bare target', () => {
    expect(buildWikiEmbedMarkdownSource('photo.png', null, null)).toBe('![[photo.png]]');
  });

  test('target + anchor', () => {
    expect(buildWikiEmbedMarkdownSource('file.pdf', 'page=3', null)).toBe('![[file.pdf#page=3]]');
  });

  test('target + alias', () => {
    expect(buildWikiEmbedMarkdownSource('file.pdf', null, 'My PDF')).toBe('![[file.pdf|My PDF]]');
  });

  test('target + anchor + alias (full form)', () => {
    expect(buildWikiEmbedMarkdownSource('file.pdf', 'page=3', 'Page 3')).toBe(
      '![[file.pdf#page=3|Page 3]]',
    );
  });

  test('empty target produces a malformed `![[]]` — guarded at the call site', () => {
    // The call site in `applyNonPortableInlineAtomReplacement` skips
    // empty-target embeds (the wiki-link parser rejects them upstream),
    // so this output is never emitted into the clipboard. Pinned here
    // as a contract: the helper itself does no validation; callers do.
    expect(buildWikiEmbedMarkdownSource('', null, null)).toBe('![[]]');
  });
});
