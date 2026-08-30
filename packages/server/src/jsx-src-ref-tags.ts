/**
 * Syntax helpers over the by-reference JSX component registry
 * (`JSX_SRC_REF_TAGS` in core, beside the component descriptors it is
 * guarded against).
 *
 * Shared by the rename rewriter (`managed-rename-rewrite.ts`) and the
 * backlink extractor (`backlink-index.ts`): both must agree on how a
 * registry tag is matched in source and how a `src` value resolves to a
 * docName, or a reference the graph discovers is one the rewriter cannot
 * rewrite (and vice versa).
 */

import {
  isExternalHref,
  JSX_SRC_REF_TAGS,
  type JsxSrcRefTagSpec,
  normalizeDocRelativeAssetUrl,
} from '@inkeep/open-knowledge-core';

// Single-line JSX matcher over the registry tags: a self-closing tag whose
// attributes are captured for the per-attribute pass. Every registry
// canonical is jsx-void / self-closing per its descriptor, so paired
// open/close forms don't need handling. Sticky (`y`): `readJsxSrcRefTagAt`
// owns this instance and re-anchors `lastIndex` on every call, and every
// caller consumes its match synchronously, so the shared mutable `lastIndex`
// is safe — the same discipline as `WIKI_AT_RE` in link-syntax.ts.
const JSX_SRC_REF_TAG_AT_RE = new RegExp(
  `<(${JSX_SRC_REF_TAGS.map((tag) => tag.tagName).join('|')})\\b([^>]*)\\/>`,
  'y',
);

export interface JsxSrcRefTagMatch {
  readonly spec: JsxSrcRefTagSpec;
  /** The tag's attribute region, exactly as authored (between the tag name and `/>`). */
  readonly attrs: string;
  /** Source length of the whole `<Tag …/>` match, for advancing a scan past it. */
  readonly matchLength: number;
}

/**
 * Match a registry src-ref tag starting exactly at `idx` (the `<`), or null.
 * Mirrors `readWikiLinkAt` / `readMarkdownLinkAt` in link-syntax.ts: one
 * hoisted sticky regex anchored via `lastIndex`, no per-candidate slice
 * allocation, and no regex work at all for a `<` that cannot open a tag.
 * A rejected candidate still costs a native scan to the next `>`, so a
 * whole-line walk is not linear — it is quadratic with a memchr constant
 * rather than a regex-engine one. Callers scanning untrusted single lines
 * should bound line length rather than rely on this being cheap.
 */
export function readJsxSrcRefTagAt(line: string, idx: number): JsxSrcRefTagMatch | null {
  // A self-closing tag's first `>` at or after `idx` must be its own,
  // immediately preceded by `/` — `[^>]*` cannot span a `>`. Testing that,
  // rather than merely "a `>` exists somewhere", keeps the attribute window
  // from consuming (then backtracking across) the remainder of a line whose
  // only `>` is distant and unmatched. With the probe satisfied, the regex's
  // backtracking is bounded by that first `>`.
  const close = line.indexOf('>', idx);
  if (close === -1 || line[close - 1] !== '/') return null;
  JSX_SRC_REF_TAG_AT_RE.lastIndex = idx;
  const match = JSX_SRC_REF_TAG_AT_RE.exec(line);
  if (!match) return null;
  const spec = JSX_SRC_REF_TAGS.find((tag) => tag.tagName === match[1]);
  if (!spec) return null;
  return { spec, attrs: match[2] ?? '', matchLength: match[0].length };
}

/**
 * Attribute matcher for a registry entry's ref-carrying attribute. Anchored on
 * a preceding whitespace character (not `\b`): a word boundary also matches
 * the `-`→`s` transition inside `data-src=`, which would read a
 * coincidentally-suffixed attribute as the tag's real `src`. Same anchoring
 * choice as `HTML_ASSET_ATTR_RE` in `managed-rename-rewrite.ts`.
 */
export function createJsxSrcAttrRe(attrName: string): RegExp {
  return new RegExp(`(?<=\\s)(${attrName}=)(["'])([^"']*)\\2`, 'g');
}

/**
 * Resolve a src-ref attribute value to the docName it addresses at render
 * time, or null when it addresses none (empty value, and for doc-relative
 * entries an external scheme or contentDir escape).
 *
 * `'bare-doc-name'` values return verbatim, scheme-looking ones included —
 * deliberate parity with the renderer, which hands a `<Mirror src>` straight
 * to the live-doc provider without scheme-filtering. A scheme-valued bare
 * name is a reference the rename machinery can never track, so the graph
 * extractor and the broken-link advisory apply their own `isExternalHref`
 * gate before calling this (skip the edge; surface an advisory).
 *
 * For `'doc-relative'` entries this is pinned to the renderer's own
 * resolution (`normalizeDocRelativeAssetUrl`, the function the app's
 * render-prop normalization calls before the component ever sees `src`), so
 * the rewriter and the graph cannot diverge from what the embed loads.
 */
export function resolveJsxSrcRefTarget(
  spec: JsxSrcRefTagSpec,
  value: string,
  sourceDocName: string,
): string | null {
  if (value === '') return null;
  if (spec.resolution === 'bare-doc-name') return value;
  // Scheme-qualified values (`https:`, `mailto:`) address no document under
  // doc-relative resolution. A fast path, not a verdict change: the
  // renderer's normalizer below returns them un-anchored and they'd resolve
  // to null anyway.
  if (isExternalHref(value)) return null;
  const normalized = normalizeDocRelativeAssetUrl(value, sourceDocName);
  // The renderer's normalizer returns unresolvable input unchanged (external
  // scheme, contentDir escape, missing source doc) — only a `/`-anchored
  // result addresses a document.
  if (!normalized.startsWith('/')) return null;
  const docName = normalized.slice(1);
  return docName === '' ? null : docName;
}
