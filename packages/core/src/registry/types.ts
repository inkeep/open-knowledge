/**
 * Registry types — React-free metadata for JSX component descriptors.
 *
 * Core owns the typed metadata; the app layer adds `Component: React.ComponentType<any>`.
 * This file MUST NOT import React.
 */

import type { Node as PmNode } from '@tiptap/pm/model';
import type { Nodes as HastNodes } from 'hast';
import type { Nodes as MdastNodes } from 'mdast';
import type { ComponentRegistry } from './index.ts';

// ── PropDef discriminated union ──────────────────────────────────────────────

export interface PropDefBase {
  name: string;
  required: boolean;
  description?: string;
  /**
   * Suppresses the prop from the auto-generated PropPanel UI, while keeping
   * it in the descriptor for documentation and MCP queries. Useful for extracted
   * props that shouldn't surface to authors (className, ref, style, internal-only
   * fields). Analogous to Storybook's `argTypes.X.control: false`. The
   * build-registry JSDoc extractor populates this from an `@hidden` tag on the
   * source prop.
   */
  hidden?: boolean;
  /**
   * Value-dependent visibility. When `hideWhen(values)` returns true, the
   * PropPanel hides this prop's control. Use for props that are valid on
   * some authoring paths but meaningless on others — e.g., the `video`
   * descriptor's HTML `preload` hint has no YouTube-iframe equivalent
   * (the lite-embed facade defers loading entirely until click), so it
   * hides when `src` is a YouTube URL.
   *
   * Receives the current `values` map (same shape PropPanel feeds to each
   * control). Returns true to hide. Cheap — evaluated on every panel
   * render, runs once per prop.
   */
  hideWhen?: (values: Record<string, unknown>) => boolean;
  /**
   * Marks a prop as belonging to the PropPanel "Advanced" collapsible section.
   * Closed by default; trigger reads "Advanced" with a count of non-default-valued
   * props. Used for HTML-native attrs that experienced authors want but don't
   * edit on every insert (srcset, sizes, decoding, fetchpriority, etc.).
   *
   * Mirrors the precedent of `hidden?: boolean` above: additive, non-discriminating,
   * doesn't trip the PropPanel assertUnreachable check (which switches on `type`).
   */
  advanced?: boolean;
  /**
   * Opt-in: when the prop value strictly equals the declared `defaultValue`,
   * omit the attribute on emit. The renderer applies the default at parse
   * time anyway (descriptor `translateProps` and React component-level
   * defaults), so the on-disk attribute is redundant.
   *
   * Distinct from `defaultValue`: `defaultValue` doubles as a UI initial-
   * state hint AND may carry semantic meaning (e.g., `<img alt="">` is
   * "decorative" — different from absent — even though defaultValue is `''`).
   * Set this flag only when the rendered behavior of `prop=default` and
   * `prop absent` is truly identical at the browser layer (e.g., HTML
   * `loading` defaults to `lazy`; HTML5 `<video controls>` defaults to
   * absent-controls = no controls but our descriptor flips that with
   * `defaultValue: true`).
   *
   * Strips redundant attrs on the dirty serialize path only — pristine
   * sourceRaw round-trips byte-identically (precedent #9 untouched).
   */
  omitOnDefault?: boolean;
}

export interface PropDefString extends PropDefBase {
  type: 'string';
  defaultValue?: string;
  /**
   * Allowed file types for an optional upload affordance on this prop. When
   * set, the auto-rendered PropPanel input renders an upload icon-button next
   * to the URL field that opens a native file picker constrained to these
   * types. Each entry is either a MIME type (`image/png`), a MIME wildcard
   * (`image/*`), or a `.ext` shortcut (`.svg`) — all three forms are valid per
   * MDN Web/HTML/Element/input#accept. The array is joined to a comma-string
   * at the `<input accept>` boundary; clients are still expected to validate
   * server-side (the `accept` value is a UX hint, not a security control).
   */
  accept?: readonly string[];
  /**
   * When the PropPanel mounts, focus this prop's input first. Mirrors the
   * React DOM `autoFocus` convention. If multiple props on a descriptor set
   * `autoFocus: true`, the first match (in declared `props[]` order) wins —
   * deterministic and avoids a separate ordering field.
   */
  autoFocus?: boolean;
  /**
   * Render this string prop as a CodeMirror editor with the matching
   * language mode instead of a plain `<input type="text">`. Use for
   * multi-line or syntax-shaped content (LaTeX formulas, Mermaid
   * diagrams, JSON / HTML / YAML payloads) where line-aware editing +
   * syntax highlighting are non-negotiable. Omit for short single-line
   * strings (titles, labels, URLs, alt text).
   *
   * Languages map to `@codemirror/lang-*` packages:
   *   - `'mermaid'` — `codemirror-lang-mermaid` (Lezer grammar covering
   *     flowchart / sequence / class / state / pie / gantt / journey /
   *     mindmap / requirement diagrams; emits standard `tags.keyword` /
   *     `tags.tagName` / etc. so it shares the CM HighlightStyle)
   *   - `'latex'` — `@codemirror/legacy-modes/mode/stex` via
   *     `StreamLanguage`
   *   - `'html'` — `@codemirror/lang-html`
   *   - `'json'` — `@codemirror/lang-json`
   *   - `'yaml'` — `@codemirror/lang-yaml`
   *   - `'javascript'` — `@codemirror/lang-javascript` (also covers TS
   *     / JSX / TSX expressions inside MDX prop values)
   *   - `'markdown'` — `@codemirror/lang-markdown`
   *
   * The PropPanel renderer picks the editor branch when this is set; the
   * underlying string value (and its serialize / parse path) is unchanged
   * — the editor is purely an authoring affordance.
   */
  language?: 'mermaid' | 'latex' | 'html' | 'json' | 'yaml' | 'javascript' | 'markdown';
  /**
   * Render this string prop with a popover icon picker next to the input.
   * The picker grid is populated from `LUCIDE_ICON_ALLOWLIST` in
   * `packages/app/src/editor/components/lucide-icon-allowlist.ts` — the
   * same allowlist the renderers resolve against, so authors can only
   * choose names that actually resolve to a rendered icon.
   *
   * The underlying value remains a free string (`lucide:<Name>` or an
   * emoji or plain text) — the picker is an authoring affordance, not a
   * type constraint. Compatible with `iconPicker: true` + `autoFocus:
   * true` (the input still focuses, picker opens on click).
   *
   * Mutually exclusive with `language` and `accept` in practice — those
   * branches own the entire control surface and would clash with the
   * picker trigger.
   */
  iconPicker?: boolean;
  /**
   * Render this string prop with a color-picker trigger next to the
   * input. The trigger wraps the browser's native `<input type="color">`
   * so authors get OS-level color selection without us shipping a custom
   * palette UI. The underlying value remains a free hex string (e.g.
   * `#F05032`); the input still accepts arbitrary text so authors can
   * paste any value.
   *
   * Mutually exclusive with `language`, `accept`, and `iconPicker` —
   * each owns the right-side trigger slot of the input.
   */
  colorPicker?: boolean;
  /**
   * Validate this string prop as a CSS length — a unitless number (`100`
   * treated as `px`), a number + unit (`100px`, `50%`, `26rem`, `100vh`,
   * `100vw`, `100em`, `2ch`), or one of `auto` / `inherit` / `initial` /
   * `unset`.
   * Invalid input surfaces an inline error and `aria-invalid="true"` on
   * the field; the value still persists (renderer decides what to do
   * with garbage strings — typically falls back to the descriptor's
   * default geometry).
   *
   * Mirrors the existing media-URL validator's UX (see PropPanel's
   * `mediaErrorMessage` branch): the input remains free-form so authors
   * can paste any CSS length variant; the error is advisory not
   * blocking.
   */
  cssLengthInput?: boolean;
}

export interface PropDefBoolean extends PropDefBase {
  type: 'boolean';
  defaultValue?: boolean;
}

export interface PropDefNumber extends PropDefBase {
  type: 'number';
  defaultValue?: number;
}

export interface PropDefEnum extends PropDefBase {
  type: 'enum';
  enumValues: [string, ...string[]];
  defaultValue?: string;
}

export interface PropDefReactNode extends PropDefBase {
  type: 'reactnode';
}

export type PropDef =
  | PropDefString
  | PropDefBoolean
  | PropDefNumber
  | PropDefEnum
  | PropDefReactNode;

// ── SerializeContext + helper types ──────────────────────────────────────────

/**
 * State threaded into a descriptor's `serialize(node, ctx)` call. Provides the
 * minimum surface a descriptor needs to emit its source-form mdast.
 *
 * Mirror of remark-prosemirror's internal `State` (not publicly exported); the
 * field names must stay in lockstep with `markdown/index.ts` (`MdastToPmState`).
 */
export interface SerializeContext {
  /** Recursively serialize a PM node's children to mdast nodes. */
  all: (node: PmNode) => MdastNodes[];
  /** Read-only access to the registry. Used by descriptors that delegate. */
  registry: Pick<ComponentRegistry, 'getOrWildcard'>;
  /**
   * Render PM children to markdown bytes. Required by source forms whose emit
   * is a single `html` mdast node carrying the body verbatim (e.g.,
   * `<details>...</details>`). The host wires this from
   * `mdast-util-to-markdown`'s `containerFlow`. May throw if the host has not
   * provided it; descriptors that don't need it must not call it.
   */
  serializeChildren: (node: PmNode) => string;
}

/**
 * Translates a compat descriptor's stored prop bag to the render-time props
 * its `rendersAs` canonical Component expects. Pure; no React. Identity for
 * v1's three compat descriptors (their prop names already match canonical).
 */
type TranslateProps = (compatProps: Record<string, unknown>) => Record<string, unknown>;

// ── JsxComponentMeta — discriminated on `surface` ───────────────────────────

/**
 * Fields shared by both surfaces of `JsxComponentMeta`.
 *
 * Registry tracks block components only. No isInline field — inline JSX
 * is the thin jsxInline node and doesn't use descriptors.
 */
interface JsxComponentMetaBase {
  /** Component tag name, or '*' for the wildcard fallback. */
  name: string;
  /** PropPanel/slash-menu hint; NodeViewContent always renders per Precedent #26. */
  hasChildren: boolean;
  /** Hint: component is typically self-closing (e.g., <Chart />). */
  isSelfClosing?: boolean;
  /** Auto-generated by react-docgen-typescript or hand-authored. */
  props: PropDef[];
  /** Slash menu icon name (resolved to Lucide in app). */
  icon?: string;
  /** Slash menu grouping category. Precedent #9 keeps this add-only —
   *  extending with new members is free; narrowing is permanent lock-in. */
  category?: 'content' | 'media';
  /** Slash menu label. */
  displayName?: string;
  /** One-line summary for slash menu + MCP agent discovery. */
  description?: string;
  /** Slash-command aliases (e.g., Callout → ['note','warning','tip','info','alert']). */
  searchTerms?: string[];
  /** For empty-container placeholder UX — Steps → 'Step', Tabs → 'Tab'. */
  emptyChildName?: string;
  /**
   * Notion-style empty-state copy when an autoFocus-flagged required prop is
   * empty (e.g. fresh `<img src="" />`). Both fields optional; the resolver
   * falls back to `Add ${displayName.toLowerCase()}` for label and to
   * `descriptor.icon` for the icon when omitted. Only consulted for descriptors
   * with `hasChildren: false` — containers route through `emptyChildName`.
   */
  placeholder?: { label?: string; icon?: string };
  /**
   * Body content used when synthesizing the agent-facing source-form example
   * for descriptors whose body shape isn't reproducible from props alone —
   * compositional containers (`<Tabs>` needs a nested `<Tab>`, `<Accordion>`
   * needs prose between the wrapper tags, `<Tab>` needs example panel content).
   * Other `hasChildren: true` descriptors fall back to a generic placeholder
   * inside the projection helper; `hasChildren: false` descriptors ignore this
   * field. Pure metadata — no React, no PM-shape, no Y.Doc context required.
   */
  exampleBody?: string;
  /**
   * Emit this descriptor's source form as mdast. Required.
   *
   * Pristine-path round-trip is handled upstream by the caller via
   * `data.sourceRaw` passthrough — descriptors only own the dirty path. Each
   * canonical descriptor emits an `mdxJsxFlowElement`; each compat descriptor
   * emits its native source form (blockquote for GFMCallout, paragraph+image
   * for CommonMarkImage, html-block for HtmlDetailsAccordion).
   */
  serialize: (node: PmNode, ctx: SerializeContext) => MdastNodes;
  /**
   * OPTIONAL override for cross-app text/html outbound emission.
   *
   * The default outbound mechanism is the live-DOM walker (whatever the
   * descriptor's React component rendered + whatever CSS resolved). For v1's
   * 5-pack and 3 compat descriptors no override is needed — the React render
   * IS the cross-app shape.
   *
   * Declare this only when the descriptor has hidden state the walker can't
   * see — e.g. a Tabs descriptor whose inactive tab panels are never mounted,
   * or a Canvas descriptor whose bitmap state lives outside the DOM. Returns
   * `null` to fall back to the walker default. The optional `liveDom` arg is
   * the same Element the walker would clone, so overrides can decorate the
   * walker output rather than rebuilding from scratch.
   *
   * **Not yet wired.** Today ships zero overrides, so the walker has no
   * dispatch site that reads this property. The first descriptor that
   * declares an override must also wire the dispatch — call
   * `descriptor.toClipboardHast?.(node, ctx, liveDom)` from within
   * `walkLiveDomToInlineStyledFragment` (two-layer cascade) BEFORE
   * falling through to the live-DOM clone path, and emit the
   * `clipboard-hast-override-invoked` telemetry event registered in
   * `clipboard/instrument.ts`.
   *
   * @example Tabs override (illustrative — no v1 descriptor uses this).
   * ```ts
   * toClipboardHast(node, ctx, liveDom) {
   *   // The live DOM only carries the active tab panel; rebuild a
   *   // representation that includes every tab's children.
   *   const panels = (node.attrs.props as { panels?: Array<{ label: string; body: string }> }).panels ?? [];
   *   return {
   *     type: 'element',
   *     tagName: 'section',
   *     properties: { className: ['tabs'] },
   *     children: panels.map((p) => ({
   *       type: 'element',
   *       tagName: 'details',
   *       properties: {},
   *       children: [
   *         { type: 'element', tagName: 'summary', properties: {}, children: [{ type: 'text', value: p.label }] },
   *         { type: 'text', value: p.body },
   *       ],
   *     })),
   *   };
   * }
   * ```
   */
  toClipboardHast?: (
    node: PmNode,
    ctx: ClipboardHastContext,
    liveDom?: Element,
  ) => HastNodes | null;
}

/**
 * Context threaded into a descriptor's `toClipboardHast` override. Mirrors
 * the shape of `SerializeContext` but for the hast emission tier. Exported
 * so descriptor authors can type their override parameter explicitly.
 */
export interface ClipboardHastContext {
  registry: Pick<ComponentRegistry, 'getOrWildcard'>;
  /** Descriptor name dispatch context — same as `node.attrs.componentName`. */
  descriptorName: string;
}

/**
 * Canonical descriptor — appears in the slash menu, what WYSIWYG writes for
 * fresh inserts. Renders directly through its own React component in
 * `componentMap` (keyed by `name`).
 */
interface CanonicalMeta extends JsxComponentMetaBase {
  surface: 'canonical';
}

/**
 * Compat descriptor — read-only; never offered for new insertion. Preserves
 * the source form on round-trip via its own `serialize` even after edits.
 *
 * Renders through the canonical descriptor's React component (looked up via
 * `rendersAs`), with `translateProps` adapting the compat's prop names to
 * whatever the canonical Component expects.
 */
export interface CompatMeta extends JsxComponentMetaBase {
  surface: 'compat';
  /**
   * Canonical descriptor name to render through. Must resolve to a registered
   * `CanonicalMeta` at registry build time; the app-side registry throws on
   * init if the reference is dangling.
   */
  rendersAs: string;
  /**
   * Per-descriptor prop-name remap from compat storage shape to canonical
   * Component render-prop shape. Identity for v1's three compat descriptors
   * (their prop names already match canonical's spelling).
   */
  translateProps: TranslateProps;
}

/**
 * Descriptor union — runtime dispatch on `surface` discriminator. Closes
 * exhaustive switches with `assertNever` per type-safety idioms.
 */
export type JsxComponentMeta = CanonicalMeta | CompatMeta;
