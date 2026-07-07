/**
 * Live-DOM clipboard walker — captures whatever React rendered + whatever CSS
 * resolved into a DocumentFragment suitable for cross-app text/html outbound.
 *
 * Design summary:
 *   1. Iterate top-level nodes in `view.state.selection`.
 *   2. For each, call `view.nodeDOM(pos)` to retrieve the LIVE styled DOM
 *      element from the editor.
 *   3. `cloneNode(true)` to detach a copy.
 *   4. Walk live + clone trees pairwise; on every element copy allowlisted
 *      computed styles inline and strip editor-only classes / attributes.
 *
 * This replaces a per-descriptor `toClipboardHast` contract for the v1 5-pack:
 * the React render IS the cross-app HTML shape. Future descriptors with hidden
 * state (Tabs / Carousel / Canvas) opt in to a `descriptor.toClipboardHast`
 * override.
 *
 * Activity-hidden edge: `view.nodeDOM(pos)` returns null when the slice is in
 * an `<Activity mode="hidden">` subtree whose DOM was unmounted. The walker
 * delegates to the per-descriptor static palette in
 * `clipboard-walker-fallback-palette.ts`.
 *
 * Opt-out: a descriptor can mark a subtree with `data-clipboard-omit="true"`
 * on its React render root. The walker drops that subtree from the output.
 *
 * Cardinality discipline: the style allowlist is hand-curated to email-safe
 * properties (Notion / Slack / Gmail rich-paste profiles all preserve them).
 * The class blocklist strips selection halo / drag chrome / ProseMirror
 * internals. The attribute blocklist strips `contenteditable` and PM-internal
 * markers so destinations don't see editor-only state.
 */

import { normalizeNullableString, wikiLinkHref } from '@inkeep/open-knowledge-core';
import type { Node as PmNode, Slice } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import {
  classifyUrlPortability,
  convertCssColors,
  isDangerousEventHandlerAttr,
  isSafeWalkerUrl,
  isSrcsetSafe,
  OPT_OUT_ATTR,
  sanitizeEmbeddedUrlValue,
  sanitizeStyleAttrValue,
  URL_BEARING_TEXT_ATTRS,
  URL_SCHEME_ATTRS,
  type UrlPortabilityReason,
} from './clipboard-sanitize.ts';
import { paletteFor } from './clipboard-walker-fallback-palette.ts';
import {
  classifyError,
  logNonPortableRenderSourceEmitted,
  logUnmappedLucideIcon,
  logWalkerFallback,
  logWalkerUrlBlocked,
  logWalkerUrlClassifierFailed,
  logWalkerUrlSourceEmitted,
  type WalkerUrlSourceClass,
  type WalkerUrlSourceTag,
} from './instrument.ts';
import { nonPortableRenderSourceFallback } from './non-portable-render-source-fallback.ts';

/**
 * CSS properties copied inline from the live element to the clone. Curated for
 * the Slack / Notion / Gmail / GitHub rich-paste profiles — everything in this
 * list survives at least one of the four. Layout / transform / animation
 * properties are intentionally excluded: destinations rebuild layout, and
 * inlining them across an arbitrary snippet would yield broken visuals.
 */
export const STYLE_ALLOWLIST = [
  'color',
  'background-color',
  'background-image',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-color',
  'border-width',
  'border-style',
  'border-radius',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-decoration',
  'text-align',
  'line-height',
  'list-style',
  'list-style-type',
  'list-style-position',
  'vertical-align',
  'white-space',
] as const;

/**
 * Editor-only chrome classes stripped from the clone. Selection halo
 * (`ProseMirror-selectednode`), trailing-break placeholder
 * (`ProseMirror-trailingBreak`), the JSX wrapper chrome, and table cell
 * selection markers all leak editor state if not stripped.
 */
export const CLASS_BLOCKLIST: ReadonlySet<string> = new Set([
  'jsx-component-wrapper',
  'selectedCell',
  'is-empty',
  'ProseMirror-selectednode',
  'ProseMirror-trailingBreak',
]);

/**
 * Editor-only attributes stripped from the clone. `contenteditable` would
 * make the pasted block accidentally editable in destinations that respect
 * it (Notion). `data-pm-slice` is PM's wire-format marker. The
 * `data-selected` / `data-has-child-selected` / `data-dragging` /
 * `data-range-selected` markers are interaction-state leaks emitted by
 * `JsxComponentView` — they describe transient selection state at the
 * moment of copy, never document content. `data-selection-origin` is
 * intentionally NOT here: it's a meta-property describing how the
 * selection was initiated, not a transient state of the node.
 */
export const ATTR_BLOCKLIST: ReadonlySet<string> = new Set([
  'data-selected',
  'data-has-child-selected',
  'data-dragging',
  'data-range-selected',
  'contenteditable',
  'data-pm-slice',
]);

// `OPT_OUT_ATTR` lives in `./clipboard-sanitize.ts` — descriptor authors
// import it directly from the leaf module to mark elements that must not
// reach the clipboard payload.

/**
 * Style-getter abstraction so the walker is testable without a real browser.
 * Returns an object with `getPropertyValue(name)` matching the standard
 * `CSSStyleDeclaration` interface. Defaults to `window.getComputedStyle`.
 */
export interface ComputedStyleLike {
  getPropertyValue(prop: string): string;
}

/**
 * Tagged-union return shape for `serializeElementMarkdown`. The `kind`
 * discriminator lets the walker switch on outcome without inferring it
 * from runtime types (string-vs-null-vs-object). Each terminal phase
 * the walker emits has a 1:1 mapping to a kind:
 *
 *   - `ok` — markdown bytes available (success).
 *   - `no-correspondence` — `posAtDOM` returned -1 OR `nodeAt` returned
 *     null because the PM doc is inconsistent with the live DOM. No
 *     throw occurred. Walker emits `phase: 'serializer-null'`.
 *   - `failed` — a step in the closure threw (`posAtDOM` RangeError on
 *     detached element, or `mdManager.serialize` on a corrupted slice).
 *     `errorClass` may be undefined when `classifyError` returns undefined
 *     for an unsubclassed `Error`. Walker emits
 *     `phase: 'serializer-throw'` with the classified error name attached
 *     so dashboards can distinguish a markdown-pipeline regression
 *     (content-loss class) from baseline async-detach noise.
 */
export type SerializeResult =
  | { kind: 'ok'; markdown: string }
  | { kind: 'no-correspondence' }
  | { kind: 'failed'; errorClass: string | undefined };

export interface WalkerEnv {
  getComputedStyle: (el: Element) => ComputedStyleLike;
  /**
   * Compute markdown source bytes for the PM range covered by the live
   * DOM element. Used by the URL-portability classifier post-pass to
   * reconstruct source-fallback content via the canonical
   * `mdManager.serialize` pipeline.
   *
   * Returns a {@link SerializeResult} tagged union so the walker can
   * dispatch by `kind` rather than by runtime type. See the type for the
   * outcome → telemetry-phase mapping.
   *
   * Optional so existing tests + the no-op default env don't have to
   * provide it; when absent, `applyUrlClassifierPostPass` short-circuits
   * at entry and emits no telemetry — the URL classifier swap is
   * disabled entirely (graceful degradation preserves the pre-classifier
   * behavior).
   */
  serializeElementMarkdown?: (live: Element) => SerializeResult;
}

const DEFAULT_ENV: WalkerEnv = {
  getComputedStyle: (el) => window.getComputedStyle(el),
};

/**
 * Build an inline `style="..."` value from a computed-style declaration,
 * including only the allowlisted properties. Skips empty / `initial` /
 * `normal` values so the inline output stays small.
 *
 * Each value passes through `convertCssColors` to downgrade CSS Color 4
 * functions (`oklch`, `oklab`, `lab`, `lch`) to `rgb()` / `rgba()` —
 * destination HTML renderers (Gmail, Notion, Slack-class) don't parse
 * the modern color functions and would render the color as default
 * (invisible chevrons, missing accent borders) without this conversion.
 * Pass-through is a no-op for already-`rgb()` / hex / hsl / named values.
 */
export function buildInlineStyleFrom(
  computed: ComputedStyleLike,
  allowlist: readonly string[] = STYLE_ALLOWLIST,
): string {
  let style = '';
  for (const prop of allowlist) {
    const value = computed.getPropertyValue(prop);
    if (!value) continue;
    if (value === 'initial' || value === 'normal') continue;
    style += `${prop}: ${convertCssColors(value)}; `;
  }
  return style.trim();
}

/**
 * Drop blocklisted classes from a `class` attribute value. Returns the
 * filtered class list, or `null` if no classes survive.
 */
export function stripBlocklistedClasses(
  className: string,
  blocklist: ReadonlySet<string> = CLASS_BLOCKLIST,
): string | null {
  const kept = className
    .split(/\s+/)
    .filter((c) => c.length > 0 && !blocklist.has(c))
    .join(' ');
  return kept || null;
}

/**
 * Pure: detect whether the `[from, to)` selection range partially covers any
 * top-level child of `doc`. Returns `true` for a selection that bisects a
 * single top-level block (cursor selecting a few characters inside a
 * paragraph) OR straddles a top-level boundary (e.g., end of paragraph 1 +
 * start of paragraph 2). Returns `false` only when every top-level node the
 * range touches is fully contained — i.e., the selection is a clean
 * concatenation of whole top-level blocks.
 *
 * The walker uses this to decide whether to emit live-DOM HTML at all. A
 * partial top-level cover means `view.nodeDOM(pos)` would return a block
 * element containing more text than the user selected, so the walker
 * aborts and the markdown tier (which serializes the slice directly)
 * takes over.
 *
 * Exported for unit-test reach; the production caller is
 * `walkLiveDomToInlineStyledFragment` below.
 */
export function selectionPartiallyCoversTopLevelNode(
  doc: PmNode,
  from: number,
  to: number,
): boolean {
  let partial = false;
  doc.nodesBetween(from, to, (node, pos, parent) => {
    if (parent !== doc) return false;
    if (from > pos || to < pos + node.nodeSize) partial = true;
    return false;
  });
  return partial;
}

export function walkLiveDomToInlineStyledFragment(
  _slice: Slice,
  view: EditorView,
  env: WalkerEnv = DEFAULT_ENV,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const { from, to } = view.state.selection;
  if (from === to) return fragment;

  // Selection-bound containment guard. The walker emits the entire live
  // DOM element returned by `view.nodeDOM(pos)` for every top-level node
  // that `nodesBetween` visits. When the selection bisects a top-level
  // block (e.g., `from..to` covers `lo` inside `<p>Hello world</p>`) the
  // emitted `<p>` carries the unselected text too — content the user did
  // not authorize for the clipboard. Detect that condition up-front and
  // emit an empty fragment so the caller (`MdastClipboardSerializer`)
  // falls through to the markdown tier, which serializes from the
  // selection slice directly and respects the actual range.
  if (selectionPartiallyCoversTopLevelNode(view.state.doc, from, to)) return fragment;

  view.state.doc.nodesBetween(from, to, (node, pos, parent) => {
    // Walk only the top-level children of the document root.
    if (parent !== view.state.doc) return false;

    const liveDom = view.nodeDOM(pos);
    if (liveDom == null) {
      // Activity-hidden subtree — defer to the per-descriptor static
      // palette. Emit telemetry so a non-Activity-hidden null (a real
      // bug per the walker STOP_IF rule) surfaces in production logs.
      logWalkerFallback({ descriptor: node.type.name, view: 'wysiwyg' });
      const fallback = paletteFor(node);
      if (fallback) fragment.appendChild(fallback);
      return false;
    }
    if (!(liveDom instanceof Element)) return false;
    if (liveDom.getAttribute(OPT_OUT_ATTR) === 'true') return false;

    // Non-portable render source-fallback: top-level jsxComponent nodes
    // whose live React render doesn't paste cleanly cross-app (Math
    // emits dense KaTeX span trees; Mermaid emits inline SVG) opt into
    // a `<pre class="mdx-component"><code>{markdown source}</code></pre>`
    // shape. Plain-text apps see readable LaTeX / mermaid source; rich
    // apps with markdown re-parse round-trip the construct back.
    //
    // Inline mathInline atoms can't be intercepted here — the
    // `parent !== view.state.doc` gate restricts iteration to top-level
    // block nodes, and inline atoms always live inside a paragraph.
    // The post-clone pass `applyNonPortableInlineAtomReplacement`
    // handles inline atoms by walking the cloned paragraph subtree.
    //
    // Sister site at `clipboard-walker-fallback-palette.ts:paletteFor`
    // so the same shape emits when DOM is unmounted (Activity-hidden
    // subtree, top-level only — same gate constraint).
    const sourceFallback = nonPortableRenderSourceFallback(node, document);
    if (sourceFallback !== null) {
      fragment.appendChild(sourceFallback);
      logNonPortableRenderSourceEmitted({
        view: 'wysiwyg',
        descriptor: (node.attrs.componentName as string | undefined) ?? node.type.name,
      });
      return false;
    }

    fragment.appendChild(cloneAndStyle(liveDom, env));
    return false;
  });

  return fragment;
}

function cloneAndStyle(live: Element, env: WalkerEnv): Element {
  const clone = live.cloneNode(true) as Element;
  walkPair(live, clone, env);
  // Post-walk transforms run on the modified clone, paired pairwise with the
  // unchanged live tree (skipping opt-out subtrees that walkPair removed).
  //
  // Order matters: wiki-link transform runs FIRST so the resulting
  // `<a href="#${slug}">` evaluates as portable (fragment-href) when the
  // URL classifier sees it. The subsequent classifier pass then preserves
  // the wiki-link anchor verbatim.
  applyWikiLinkTransform(clone);
  // Non-portable inline-atom replacement: walks the cloned subtree for
  // inline PM atoms whose rendered DOM doesn't paste cleanly cross-app
  // — `mathInline` (KaTeX inline span trees) and non-image
  // `wikiLinkEmbed` (PDF / video / audio chips with doc-relative
  // hrefs) — and swaps each with a `<span class="mdx-inline">{markdown
  // source}</span>` source-fallback shape. The walker's top-level-only
  // iteration in `walkLiveDomToInlineStyledFragment` means inline atoms
  // inside paragraphs are never the iteration target — the post-clone
  // pass is the only reachable seam for inline-atom replacement.
  // Mirror of the block path's source-fallback dispatch via
  // `nonPortableRenderSourceFallback`.
  applyNonPortableInlineAtomReplacement(clone);
  // URL portability classifier — top-down on (live, clone). When an element
  // matches the leaf scope (img/video/audio/source/a/picture) and is
  // non-portable, swap to a source-fallback shape and STOP recursion into
  // its subtree. Innermost-element granularity falls out: portable outers
  // recurse; non-portable outers swap and discard the subtree, so a single
  // non-portable URL produces exactly one source-fallback emission.
  applyUrlClassifierPostPass(live, clone, env);
  // Replace lucide SVGs with Unicode glyphs LAST so SVG icons inside a
  // swapped subtree (which the URL classifier discards) don't waste glyph
  // replacement work. The escape filters in `walkPair` already ran on
  // every SVG above, so defense-in-depth on stray `lucide-` SVGs is
  // preserved regardless of the lucide-replace position.
  replaceLucideIconsWithGlyphs(clone);
  return clone;
}

/**
 * Walk the cloned subtree for non-portable inline PM atoms and replace
 * each with a `<span class="mdx-inline">{markdown source}</span>`
 * source-fallback element. Cross-app destinations see readable
 * markdown source instead of the rendered atom (which doesn't paste
 * cleanly across destinations).
 *
 * Block math + Mermaid get their source-fallback at the walker entry
 * point via `nonPortableRenderSourceFallback` (those are top-level
 * jsxComponent nodes, so the walker's `nodesBetween` callback sees
 * them directly). Inline atoms can't be intercepted there because the
 * walker's `parent !== view.state.doc` gate restricts iteration to
 * top-level block nodes — inline atoms live inside paragraphs and
 * never surface as the iteration target. This post-clone pass is
 * the equivalent seam for them.
 *
 * Coverage:
 *
 *   - `mathInline` PM atom — rendered as `<span class=
 *     "math-inline-trigger" data-component-type="math-inline"
 *     data-formula="...">…KaTeX HTML…</span>` by `MathInlineView.tsx`.
 *     Replaced with `<span class="mdx-inline">$$formula$$</span>`.
 *     The `$$…$$` form is the canonical mid-paragraph form remark-math
 *     recognises with `singleDollarTextMath: false`.
 *
 *   - Non-image `wikiLinkEmbed` PM atoms (PDF / video / audio) —
 *     rendered as `<a data-wiki-embed data-target="..." data-alias="..."
 *     data-anchor="...">` by `wiki-link-embed.ts`. The rendered chip
 *     pastes as a broken link in destinations (the `data-target` /
 *     `href` is a doc-relative path that won't resolve cross-app).
 *     Replaced with `<span class="mdx-inline">![[target#anchor|alias]]
 *     </span>` so destinations see the wikilink markdown source —
 *     readable in plain text, paste-back-compatible with markdown
 *     editors that recognise the `[[…]]` form (Obsidian, Logseq).
 *     Image `wikiLinkEmbed` atoms render as `<img data-wiki-embed src=
 *     "...">`; their portability is handled by the URL classifier
 *     post-pass (relative `src` → source-fallback shape) rather than
 *     here.
 *
 * `<span class="mdx-inline">` matches the existing inline source-
 * fallback shape used by `createSourceFallbackElement` (URL-portability
 * classifier path) so cross-app destinations see one consistent shape
 * across all inline source-fallback paths. Source bytes go through
 * `textContent` so HTML special chars (`<` / `>` / `&`) auto-escape on
 * serialization. Mirrors the same safety pattern in the block source-
 * fallback paths.
 */
function applyNonPortableInlineAtomReplacement(clone: Element): void {
  // mathInline atoms — `[data-component-type="math-inline"]`. The
  // selector matches the trigger span AND the inner placeholder spans
  // (`EmptyInlineMathPlaceholder` / `InlineLoadingPlaceholder` in
  // `MathInlineView.tsx`) which both carry the same data-attribute
  // since the placeholder IS the trigger's body when formula is empty
  // / lazy-loading. Document order returns the outer trigger first; on
  // its `replaceWith`, descendant placeholders detach. The
  // `el.parentNode === null` guard skips already-detached descendants
  // so each atom replaces (and emits telemetry) exactly once.
  const mathMatches = Array.from(clone.querySelectorAll('[data-component-type="math-inline"]'));
  for (const el of mathMatches) {
    if (!el.parentNode) continue;
    const formula = el.getAttribute('data-formula') ?? '';
    const span = clone.ownerDocument.createElement('span');
    span.className = 'mdx-inline';
    span.textContent = `$$${formula}$$`;
    el.replaceWith(span);
    logNonPortableRenderSourceEmitted({ view: 'wysiwyg', descriptor: 'mathInline' });
  }

  // Non-image wikiLinkEmbed atoms — `a[data-wiki-embed]`. Image-form
  // embeds render as `<img data-wiki-embed>` (handled by URL classifier
  // for non-portable `src`); only the `<a>` chip path needs source-
  // fallback here.
  const embedMatches = Array.from(clone.querySelectorAll('a[data-wiki-embed]'));
  for (const el of embedMatches) {
    if (!el.parentNode) continue;
    const target = el.getAttribute('data-target') ?? '';
    if (!target) continue; // sanity guard — wiki-link parser rejects empty targets upstream
    const alias = el.getAttribute('data-alias') || null;
    const anchor = el.getAttribute('data-anchor') || null;
    const span = clone.ownerDocument.createElement('span');
    span.className = 'mdx-inline';
    span.textContent = buildWikiEmbedMarkdownSource(target, anchor, alias);
    el.replaceWith(span);
    logNonPortableRenderSourceEmitted({ view: 'wysiwyg', descriptor: 'wikiLinkEmbed' });
  }
}

/**
 * Build the `![[target#anchor|alias]]` markdown source string for a
 * `wikiLinkEmbed` atom. Order matters: anchor follows target with `#`,
 * alias follows the target+anchor with `|`. Either may be absent.
 * Mirrors the canonical wikilink shape `wikiLinkEmbedHandler` in
 * `wiki-link-micromark.ts` emits for `wikiLinkEmbed` mdast on the
 * inverse direction; co-located drift-fence tests in
 * `clipboard-walker.test.ts` pin the four canonical shapes.
 */
export function buildWikiEmbedMarkdownSource(
  target: string,
  anchor: string | null,
  alias: string | null,
): string {
  let body = target;
  if (anchor) body += `#${anchor}`;
  if (alias) body += `|${alias}`;
  return `![[${body}]]`;
}

/**
 * Lucide icon class → Unicode glyph for cross-app paste fidelity.
 *
 * No mainstream paste destination preserves inline `<svg>`: Gmail's image
 * proxy refuses SVG, Outlook retired SVG support in September 2025, and
 * Notion / Slack / Google Docs strip on paste (their schemas have no
 * `<svg>` block type). At the walker emit boundary we substitute a
 * Unicode glyph that inherits the parent's already-inlined
 * `color: rgb(...)` (set by `convertCssColors`) so the icon survives with
 * the correct destination-renderable color.
 *
 * In-app render is unaffected — the React lucide-react components continue
 * to render real `<svg>` elements inside the editor. Only the clipboard
 * walker output is rewritten.
 *
 * Glyph choices favor BMP characters without U+FE0F variation selectors
 * so legacy Outlook desktop (pre-2019) renders them correctly. The single
 * supplementary-plane character (`💡` for `lightbulb`) renders monochrome
 * on legacy clients without misrendering — no FE0F is attached.
 *
 * Adding a new icon: when a descriptor ships a new lucide icon, add the
 * `lucide-<kebab-name>` class (matches the `lucide` class lucide-react
 * renders) and a glyph. The dev-time `clipboard-walker-unmapped-lucide-
 * icon` telemetry event surfaces icons that lack a mapping so they don't
 * silently degrade in cross-app paste.
 */
export const LUCIDE_GLYPH_MAP: Record<string, string> = {
  'lucide-chevron-right': '›', // SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
  'lucide-chevron-down': '⌄', // DOWN ARROWHEAD — collapsible-open Callout (Callout.tsx switched ChevronRight → ChevronDown for the open state)
  'lucide-info': 'ℹ', // INFORMATION SOURCE
  'lucide-lightbulb': '\u{1F4A1}', // ELECTRIC LIGHT BULB (renders monochrome on legacy)
  'lucide-message-square-warning': '❗', // HEAVY EXCLAMATION MARK SYMBOL
  'lucide-alert-triangle': '⚠', // WARNING SIGN
  'lucide-alert-octagon': '⛔', // NO ENTRY (octagonal stop semantics)
};

const LUCIDE_CLASS_RE = /(?:^|\s)(lucide-[a-z0-9-]+)(?:\s|$)/;

/**
 * Pure: extract a `lucide-<name>` token from a class string and return its
 * mapped glyph, or `null` if no lucide class is present or the class has
 * no glyph mapping. Anchors are tight on whitespace boundaries so
 * `lucide-info-darker` does NOT match `lucide-info`.
 */
export function glyphForLucide(className: string): string | null {
  const match = className.match(LUCIDE_CLASS_RE);
  if (!match) return null;
  return LUCIDE_GLYPH_MAP[match[1]] ?? null;
}

/**
 * In-place: replace each mapped `<svg.lucide-*>` descendant of `root` with
 * a `<span aria-hidden="true">{glyph}</span>`. Unmapped lucide-* SVGs stay
 * in place (graceful degradation — destinations strip them, but a wrong
 * glyph is worse than no glyph) and emit a dev-tier telemetry signal.
 *
 * Idempotent: replacing an SVG removes it from `root.querySelectorAll('svg')`'s
 * snapshot, so repeated invocations are no-ops on already-substituted trees.
 */
function replaceLucideIconsWithGlyphs(root: Element): void {
  const svgs = root.querySelectorAll('svg');
  for (const svg of Array.from(svgs)) {
    const className = svg.getAttribute('class') ?? '';
    const lucideMatch = className.match(LUCIDE_CLASS_RE);
    if (!lucideMatch) continue;
    const lucideClass = lucideMatch[1];
    const glyph = LUCIDE_GLYPH_MAP[lucideClass];
    if (!glyph) {
      logUnmappedLucideIcon({ lucideClass, view: 'wysiwyg' });
      continue;
    }
    const span = svg.ownerDocument.createElement('span');
    span.setAttribute('aria-hidden', 'true');
    span.textContent = glyph;
    svg.replaceWith(span);
  }
}

function walkPair(live: Element, clone: Element, env: WalkerEnv): void {
  // Inline computed styles via the allowlist.
  const styleStr = buildInlineStyleFrom(env.getComputedStyle(live));
  if (styleStr) {
    const existing = clone.getAttribute('style');
    clone.setAttribute('style', existing ? `${existing}; ${styleStr}` : styleStr);
  }

  // Strip blocklisted classes.
  const className = clone.getAttribute('class');
  if (className !== null) {
    const filtered = stripBlocklistedClasses(className);
    if (filtered) clone.setAttribute('class', filtered);
    else clone.removeAttribute('class');
  }

  // Escape contract: the pre-walker pipeline ran rehypeSanitizeUrls
  // downstream of mdast-to-hast; the walker bypasses that pipeline so the
  // filter has to live here. Allowlist parity with `isSafeUrl` (safe-url.ts)
  // and `URL_SCHEME_ALLOWLIST` (sanitize-url.ts) — see helpers above.
  for (const attr of Array.from(clone.attributes)) {
    if (ATTR_BLOCKLIST.has(attr.name)) {
      clone.removeAttribute(attr.name);
      continue;
    }
    if (isDangerousEventHandlerAttr(attr.name)) {
      // React strips `on*` from JSX before render, but the walker is a
      // re-emit boundary to untrusted destinations — defense-in-depth.
      clone.removeAttribute(attr.name);
      logWalkerUrlBlocked({ attr: 'on*', reason: 'event-handler', view: 'wysiwyg' });
      continue;
    }
    if (attr.name === 'style') {
      const safeStyle = sanitizeStyleAttrValue(attr.value);
      if (safeStyle === '') {
        clone.removeAttribute('style');
        logWalkerUrlBlocked({
          attr: 'style',
          reason: 'unsafe-url-or-expression',
          view: 'wysiwyg',
        });
      } else if (safeStyle !== attr.value) {
        clone.setAttribute('style', safeStyle);
      }
      continue;
    }
    if (URL_SCHEME_ATTRS.has(attr.name)) {
      const valueIsSafe =
        attr.name === 'srcset' ? isSrcsetSafe(attr.value) : isSafeWalkerUrl(attr.value);
      if (!valueIsSafe) {
        // Drop the attribute rather than substitute `about:blank` — destinations
        // that strip the resulting unsafe-removed anchor surface clean text
        // instead of a clickable trap. For `srcset`, drop the entire attribute
        // when ANY candidate is unsafe (conservative; matches the walker's
        // existing remove-rather-than-rewrite policy).
        clone.removeAttribute(attr.name);
        logWalkerUrlBlocked({
          attr: attr.name,
          reason: attr.name === 'srcset' ? 'srcset-candidate' : 'scheme',
          view: 'wysiwyg',
        });
      }
      continue;
    }
    if (URL_BEARING_TEXT_ATTRS.has(attr.name)) {
      // Internal-link mark renders `aria-label="Link: <href>"` (see
      // internal-link.ts); a dangerous-scheme href would land verbatim
      // in cross-app HTML. Replace the URL portion with `[blocked]` so
      // assistive tech sees clean text and the surrounding label stays
      // informative ("Link: [blocked]" vs. silent attribute drop).
      const sanitized = sanitizeEmbeddedUrlValue(attr.value, { reportNoChange: true });
      if (sanitized !== null) {
        clone.setAttribute(attr.name, sanitized);
        logWalkerUrlBlocked({ attr: attr.name, reason: 'embedded-url', view: 'wysiwyg' });
      }
    }
  }

  // Recurse pairwise.
  const liveKids = Array.from(live.children);
  const cloneKids = Array.from(clone.children);
  const len = Math.min(liveKids.length, cloneKids.length);
  for (let i = 0; i < len; i++) {
    const liveKid = liveKids[i];
    const cloneKid = cloneKids[i];
    if (liveKid.getAttribute(OPT_OUT_ATTR) === 'true') {
      cloneKid.remove();
      continue;
    }
    walkPair(liveKid, cloneKid, env);
  }
}

// ─── Wiki-link transform ────────────────────────────────────────────────
//
// OK's `WikiLink` extension renders to `<span data-wiki-link data-target=
// "..." data-anchor="..." data-alias="..." data-resolved="...">{text}</span>`
// (see the `renderHTML` block in `packages/core/src/extensions/wiki-link.ts`).
// That live-render shape is what users see in WYSIWYG. For cross-app
// destinations (Gmail / Notion / Slack / Discord / Outlook / GDocs), an
// opaque `<span>` with `data-*` attributes is just unstyled text — no
// clickable affordance, no semantic meaning, no signal that this used to
// be a wiki-link.
//
// We rewrite the span to the SAME shape that
// `mdast-to-hast-handlers.ts:wikiLinkHandler` produces:
// `<a class="wiki-link" data-target="..." data-anchor="..." data-alias="..."
// href="#${slug}">{text}</a>`. This shape is dual-purpose:
//
//   1. Cross-app destinations (Gmail / Notion / etc.) strip unknown
//      `class` and `data-*` attributes and render the anchor as a clickable
//      affordance — restoring clickable behavior for wiki-links pasted
//      into destinations that have no notion of OK's `data-wiki-link` span.
//
//   2. OK→OK paste through Branch C (`parseFromClipboard` via
//      `data-pm-slice`) reconstructs the wikiLink node identity via the
//      `a.wiki-link[data-target]` parseHTML rule at `wiki-link.ts:111`.
//      Without the class + data-* markers, Branch C falls back to a
//      generic Link mark and the `[[...]]` round-trip is lost for
//      selections whose `text/plain` doesn't trigger the markdown
//      heuristic (e.g., a single paragraph with one wiki-link and no
//      headings/bold/etc.).
//
// The slug is computed via `wikiLinkHref(target, anchor)` from
// `@inkeep/open-knowledge-core` — the EXACT helper that
// `mdast-to-hast-handlers.ts:wikiLinkHandler` uses, so cross-pipeline
// emission is byte-identical. The fragment href evaluates as portable
// (fragment-only ref), so the URL classifier preserves the new anchor
// verbatim.

/**
 * In-place: rewrite every `<span data-wiki-link>` in `root` to an
 * `<a class="wiki-link" data-target="..." data-anchor="..." data-alias="..."
 * href="#${slug}">{textContent}</a>` — the same shape
 * `mdast-to-hast-handlers.ts:wikiLinkHandler` emits, so the existing
 * `a.wiki-link[data-target]` parseHTML rule at `wiki-link.ts:111`
 * reconstructs wikiLink node identity on Branch C OK→OK paste.
 *
 * Wiki-link-embed (rendered as `<img data-wiki-embed>` or `<a data-
 * wiki-embed>`) is OUT of scope here. Image-form embeds have their
 * non-portable `src` handled by the URL classifier on the `<img>`
 * element directly (matching palette parity); `<a>`-form embeds (PDF /
 * video / audio) get a `![[target]]` source-fallback via the post-
 * clone pass `applyNonPortableInlineAtomReplacement`.
 *
 * Defensive on empty target: a span with no `data-target` attribute
 * (or empty value) is left unchanged — the wiki-link parser upstream
 * rejects empty targets so this is a sanity guard rather than a real
 * runtime case.
 */
export function applyWikiLinkTransform(root: Element): void {
  const spans = root.querySelectorAll('span[data-wiki-link]');
  for (const span of Array.from(spans)) {
    const target = span.getAttribute('data-target') ?? '';
    if (!target) continue;
    const anchor = normalizeNullableString(span.getAttribute('data-anchor'));
    const alias = normalizeNullableString(span.getAttribute('data-alias'));
    const href = wikiLinkHref(target, anchor);
    const a = span.ownerDocument.createElement('a');
    // Cross-pipeline shape parity with mdast-to-hast wikiLinkHandler:
    // class + data-* attrs are what the parseHTML rule keys off for
    // Branch C round-trip. Cross-app destinations strip them.
    a.setAttribute('class', 'wiki-link');
    a.setAttribute('href', href);
    a.setAttribute('data-target', target);
    a.setAttribute('data-anchor', anchor ?? '');
    a.setAttribute('data-alias', alias ?? '');
    a.textContent = span.textContent ?? '';
    span.replaceWith(a);
  }
}

// ─── URL portability classifier post-pass ──────────────────────────────
//
// Top-down recursion over (live, clone) pairs. At each node:
//
//   1. `<picture>`: if any descendant `<source>` / `<img>` URL is
//      non-portable, swap the entire `<picture>` element atomically (whole
//      element as a unit — `<source>` is a void element; per-`<source>`
//      substitution makes no semantic sense). Subtree is discarded.
//
//   2. Leaf scope (`img`, `video`, `audio`, `source`, `a`): if any URL
//      attribute (`src`, `srcset`, `href`) is non-portable, swap the
//      element to a source-fallback shape (`<pre class="mdx-component">`
//      block / `<span class="mdx-inline">` inline based on parent context).
//      Subtree is discarded.
//
//   3. Other elements: recurse into children.
//
// Top-down semantics produce innermost-element granularity naturally: when
// an outer URL-bearing element is portable (e.g., `<a href="https://
// public/">`), recursion descends and a non-portable inner element swaps;
// when the outer is non-portable, it swaps and the subtree is gone, so a
// single non-portable URL produces exactly one source-fallback emission +
// one telemetry event.
//
// Pairing with live: walkPair removes opt-out children from clone before
// this post-pass, leaving clone with fewer children at some levels. We
// pair by skipping opt-out live children (`OPT_OUT_ATTR === 'true'`) so
// non-opt-out live children align positionally with all clone children.
// Snapshots taken via `Array.from(...)` so a mid-iteration swap doesn't
// invalidate the iteration.

// `WalkerUrlLeafTag` excludes `'picture'` because the picture-as-unit
// swap is handled separately by `maybeSwapPicture`, not the leaf path.
// The full 6-tag `WalkerUrlSourceTag` stays intact for the telemetry
// emission boundary where `'picture'` is valid.
type WalkerUrlLeafTag = Exclude<WalkerUrlSourceTag, 'picture'>;

const URL_LEAF_TAGS: ReadonlySet<WalkerUrlLeafTag> = new Set<WalkerUrlLeafTag>([
  'img',
  'video',
  'audio',
  'source',
  'a',
]);

/** Type guard: narrow `tag` to the leaf-scope subset of {@link WalkerUrlSourceTag}. */
function isUrlLeafTag(tag: string): tag is WalkerUrlLeafTag {
  return (URL_LEAF_TAGS as ReadonlySet<string>).has(tag);
}

/**
 * Determine the source-fallback emission shape. An element with a `<p>`
 * ancestor uses `mdx-inline` because `<pre>` inside `<p>` is invalid HTML5
 * (the browser would auto-close the paragraph and break paragraph context
 * in the destination). Everything else uses `mdx-component` block.
 *
 * `<picture>` picture-as-unit inherits this rule: a `<picture>` in flow
 * context emits block; a `<picture>` inside a `<p>` (HTML5 transparent
 * content model permits this) emits inline.
 */
export function chooseEmissionClass(clone: Element): WalkerUrlSourceClass {
  return clone.closest('p') !== null ? 'mdx-inline' : 'mdx-component';
}

/**
 * Build the source-fallback element. DOM construction with `textContent =`
 * produces a textNode child rather than parsed HTML, so the bytes that
 * matter for HTML injection (`<` / `>` / `&`) are auto-escaped on
 * serialization, and quote characters (`"` / `'`) survive verbatim
 * because they're not special inside textNode content. The markdown
 * source lands in the destination clipboard without HTML-injection
 * risk. Mirrors the same safety pattern in `clipboard-walker-fallback-
 * palette.ts` (no manual escapeHtml required).
 */
function createSourceFallbackElement(
  doc: Document,
  klass: WalkerUrlSourceClass,
  markdown: string,
): Element {
  if (klass === 'mdx-component') {
    const pre = doc.createElement('pre');
    pre.className = 'mdx-component';
    const code = doc.createElement('code');
    code.textContent = markdown;
    pre.appendChild(code);
    return pre;
  }
  const span = doc.createElement('span');
  span.className = 'mdx-inline';
  span.textContent = markdown;
  return span;
}

/**
 * Classify a single URL on a leaf element. Returns `null` for portable;
 * the reason for non-portable. May throw if `classifyUrlPortability`
 * throws on truly malformed input — caller wraps in try/catch.
 */
function classifyUrlAttr(rawUrl: string): UrlPortabilityReason | null {
  const result = classifyUrlPortability(rawUrl);
  return result.portable ? null : result.reason;
}

/**
 * Per-candidate srcset classifier. All-or-nothing: any non-portable
 * candidate triggers swap of the entire `<img>` (mirrors the existing
 * `isSrcsetSafe` sister-pattern in `clipboard-sanitize.ts` — conservative
 * fail-fast on the first non-portable candidate). Returns the first
 * non-portable reason, or `null` when every candidate is portable.
 * May throw if `classifyUrlPortability` throws on a candidate URL —
 * caller wraps in try/catch.
 */
function classifySrcset(srcset: string): UrlPortabilityReason | null {
  for (const raw of srcset.split(',')) {
    const candidate = raw.trim();
    if (candidate === '') continue;
    const url = candidate.split(/\s+/)[0] ?? '';
    const reason = classifyUrlAttr(url);
    if (reason !== null) return reason;
  }
  return null;
}

/**
 * Compute the non-portable reason for a leaf element, or `null` if
 * portable. Tag scope drives which attributes get classified:
 *   - `img`     → `src` + `srcset` (all-or-nothing).
 *   - `video`   → `src`.
 *   - `audio`   → `src`.
 *   - `source`  → `src` + `srcset`.
 *   - `a`       → `href`.
 *
 * The walker's URL-scheme filter has already dropped unsafe-scheme
 * values from clone (e.g., a `javascript:` href is gone). Reading clone
 * attributes here means we only classify URLs that survived the security
 * gate — `null` from `getAttribute` falls through cleanly.
 *
 * May throw via `classifyUrlPortability` on truly malformed inputs that
 * survived `isRelativeUrl`'s short-circuit; caller wraps in try/catch.
 */
function classifyLeafElement(clone: Element, tag: WalkerUrlLeafTag): UrlPortabilityReason | null {
  switch (tag) {
    case 'img':
    case 'source': {
      const src = clone.getAttribute('src');
      if (src !== null) {
        const reason = classifyUrlAttr(src);
        if (reason !== null) return reason;
      }
      const srcset = clone.getAttribute('srcset');
      if (srcset !== null) {
        const reason = classifySrcset(srcset);
        if (reason !== null) return reason;
      }
      return null;
    }
    case 'video':
    case 'audio': {
      const src = clone.getAttribute('src');
      if (src !== null) return classifyUrlAttr(src);
      return null;
    }
    case 'a': {
      const href = clone.getAttribute('href');
      if (href !== null) return classifyUrlAttr(href);
      return null;
    }
    default: {
      // Exhaustiveness guard: adding a new tag to `WalkerUrlLeafTag`
      // becomes a compile error here until the switch is updated.
      const _exhaust: never = tag;
      void _exhaust;
      return null;
    }
  }
}

/**
 * `<picture>` whole-element classifier. Walks descendants in document
 * order; first non-portable URL on a `<source>` (`src` or `srcset`) or
 * fallback `<img>` (`src` or `srcset`) provides the swap reason. May
 * throw via `classifyUrlPortability`; caller wraps in try/catch.
 */
function classifyPictureDescendants(clone: Element): UrlPortabilityReason | null {
  const candidates = clone.querySelectorAll('source, img');
  for (const c of Array.from(candidates)) {
    const tag = c.tagName.toLowerCase();
    // The querySelector restricts the result set to `source` / `img`,
    // both members of `WalkerUrlLeafTag`. The runtime guard keeps the
    // narrowing honest in case selector or tag set ever drift.
    if (!isUrlLeafTag(tag)) continue;
    const reason = classifyLeafElement(c, tag);
    if (reason !== null) return reason;
  }
  return null;
}

/**
 * Try to swap a leaf element to a source-fallback shape. Returns `true`
 * if swapped (caller stops recursion into the discarded subtree).
 * Encapsulates the failure contract: classifier throws → emit
 * `clipboard-walker-url-classifier-failed` and preserve the element.
 */
function maybeSwapLeaf(
  env: WalkerEnv,
  live: Element,
  clone: Element,
  tag: WalkerUrlLeafTag,
): boolean {
  let reason: UrlPortabilityReason | null;
  try {
    reason = classifyLeafElement(clone, tag);
  } catch (err) {
    const errorClass = classifyError(err);
    logWalkerUrlClassifierFailed({
      view: 'wysiwyg',
      tag,
      phase: 'classifier-throw',
      ...(errorClass !== undefined ? { errorClass } : {}),
    });
    return false;
  }
  if (reason === null) return false;
  return performSwap(env, live, clone, tag, reason);
}

/**
 * `<picture>` atomic swap. Returns `true` if any descendant URL is
 * non-portable and the entire picture was replaced.
 *
 * Telemetry contract on classifier throw — actual mechanism in two phases:
 *
 * 1. `classifyPictureDescendants` is a pure function (no try/catch, no
 *    telemetry). When `classifyLeafElement` throws on a malformed
 *    descendant URL, the throw propagates synchronously into the
 *    `try` block here and is caught.
 *    `maybeSwapPicture` emits the picture-level
 *    `clipboard-walker-url-classifier-failed` event with `tag: 'picture'`
 *    and returns `false` (no swap).
 *
 * 2. With `<picture>` swap declined, `applyUrlClassifierPostPass` recurses
 *    into the picture's children. Each `<source>` / `<img>` re-classifies
 *    via `maybeSwapLeaf` → if the same malformed URL is encountered
 *    again, that catch site emits a SECOND classifier-failed event with
 *    `tag: 'source' | 'img'`.
 *
 * Net: one malformed URL → two telemetry events with different `tag`
 * dimensions. The double emission is deliberate — dashboards segmented
 * by `tag` see BOTH the leaf-level failure (which descendant tag carried
 * the bad URL) and the picture-level failure (which user-facing element
 * couldn't be swapped). Cardinality stays bounded (`tag` is in
 * {`img`, `source`, `picture`}).
 */
function maybeSwapPicture(env: WalkerEnv, live: Element, clone: Element): boolean {
  let reason: UrlPortabilityReason | null;
  try {
    reason = classifyPictureDescendants(clone);
  } catch (err) {
    const errorClass = classifyError(err);
    logWalkerUrlClassifierFailed({
      view: 'wysiwyg',
      tag: 'picture',
      phase: 'classifier-throw',
      ...(errorClass !== undefined ? { errorClass } : {}),
    });
    return false;
  }
  if (reason === null) return false;
  return performSwap(env, live, clone, 'picture', reason);
}

/**
 * Execute the swap: serialize the live element's PM range to markdown
 * (single canonical pipeline via the env closure), wrap in the source-
 * fallback shape selected by parent context, replace the clone in its
 * parent. Emits `clipboard-walker-url-source-emitted` on success.
 *
 * Fall-through contract: when serialization fails, preserve the element
 * unchanged + emit `clipboard-walker-url-classifier-failed` so the
 * failure is visible for follow-up rather than silently dropping
 * content. The phase discriminator separates the two failure modes:
 *   - `'serializer-null'` — closure returned null (no PM correspondence;
 *     baseline detach / unmount noise during `<Activity>` flips).
 *   - `'serializer-throw'` — a step in the closure threw (`posAtDOM`
 *     RangeError on a detached element, or `mdManager.serialize` on a
 *     corrupted slice). Carries `errorClass` from `classifyError(err)`
 *     so a markdown-pipeline regression is distinguishable from baseline
 *     detach noise — sister-symmetric with `'classifier-throw'` at
 *     `maybeSwapLeaf` / `maybeSwapPicture`.
 */
function performSwap(
  env: WalkerEnv,
  live: Element,
  clone: Element,
  tag: WalkerUrlSourceTag,
  reason: UrlPortabilityReason,
): boolean {
  // The post-pass entry-point short-circuits when `serializeElementMarkdown`
  // is undefined, so this branch only runs when the closure is wired.
  // Synthesizing `no-correspondence` for the unwired case keeps the swap
  // disabled if the post-pass guard is ever bypassed.
  const result: SerializeResult = env.serializeElementMarkdown
    ? env.serializeElementMarkdown(live)
    : { kind: 'no-correspondence' };
  switch (result.kind) {
    case 'no-correspondence': {
      logWalkerUrlClassifierFailed({ view: 'wysiwyg', tag, phase: 'serializer-null' });
      return false;
    }
    case 'failed': {
      const errorClass = result.errorClass;
      logWalkerUrlClassifierFailed({
        view: 'wysiwyg',
        tag,
        phase: 'serializer-throw',
        ...(errorClass !== undefined ? { errorClass } : {}),
      });
      return false;
    }
    case 'ok': {
      const klass = chooseEmissionClass(clone);
      const replacement = createSourceFallbackElement(clone.ownerDocument, klass, result.markdown);
      clone.replaceWith(replacement);
      logWalkerUrlSourceEmitted({ view: 'wysiwyg', tag, class: klass, reason });
      return true;
    }
    default: {
      const _exhaust: never = result;
      void _exhaust;
      return false;
    }
  }
}

/**
 * Top-down post-pass walker. Pairs live ↔ clone children skipping
 * opt-out subtrees (which `walkPair` already removed from clone). On a
 * swap, returns immediately — the caller's recursion does not descend
 * into the now-detached subtree.
 *
 * When `env.serializeElementMarkdown` is undefined the post-pass is a
 * no-op — the URL classifier swap is disabled entirely (graceful
 * degradation matches the WalkerEnv contract). Without this short-
 * circuit, every non-portable leaf would emit a `serializer-null`
 * classifier-failed event from `performSwap` even though the closure
 * was never wired in the first place.
 */
export function applyUrlClassifierPostPass(live: Element, clone: Element, env: WalkerEnv): void {
  if (!env.serializeElementMarkdown) return;
  const tag = clone.tagName.toLowerCase();

  // <picture>: atomic check before recursing. If any descendant URL is
  // non-portable, swap the whole element and stop. Otherwise fall
  // through to normal recursion (descendants would all classify portable
  // — recursion is harmless).
  if (tag === 'picture') {
    if (maybeSwapPicture(env, live, clone)) return;
  }

  // Leaf scope: classify THIS element. On swap, stop recursion.
  if (isUrlLeafTag(tag)) {
    if (maybeSwapLeaf(env, live, clone, tag)) return;
  }

  // Recurse into children, pairing live (skipping opt-outs) with clone.
  // Snapshot both lists up front so a mid-iteration swap doesn't shift
  // the live iterator.
  const liveKidsAll = Array.from(live.children);
  const cloneKids = Array.from(clone.children);
  const liveKids: Element[] = [];
  for (const k of liveKidsAll) {
    if (k.getAttribute(OPT_OUT_ATTR) === 'true') continue;
    liveKids.push(k);
  }
  const len = Math.min(liveKids.length, cloneKids.length);
  for (let i = 0; i < len; i++) {
    applyUrlClassifierPostPass(liveKids[i], cloneKids[i], env);
  }
}
