/**
 * Fence info-string meta-token utilities.
 *
 * CommonMark §4.5 lets the info-string carry an arbitrary suffix after the
 * language token (e.g. ` ```html preview title="demo" `). The parser captures
 * everything after the first whitespace into the `meta` node attribute; this
 * file owns the small set of helpers that read / toggle whitespace-delimited
 * tokens inside that meta without disturbing tokens we don't recognize.
 */

/**
 * Quote-aware tokenizer. The previous `/\s+/` split was sufficient when
 * every meta token was a single word (`preview`, `h=40px`), but with
 * `title="hello  world"` the whitespace-only path would shred
 * the quoted value's interior whitespace — neighboring ops (preview
 * toggle, resize) would then re-join with collapsed single spaces,
 * silently mutating the title value through any unrelated meta op.
 *
 * The regex matches one of:
 *   - `"..."` double-quoted segment (interior whitespace preserved)
 *   - `'...'` single-quoted segment
 *   - any non-whitespace-non-quote chars
 * combined with `+` so a `key="..."` token stays whole.
 *
 * Other tokens (unquoted keys, plain words) tokenize identically to the
 * old whitespace split, so existing callers keep working without change.
 */
const TOKEN_RE = /(?:"[^"]*"|'[^']*'|[^\s"'])+/g;

/** Split a fence-meta string into tokens, keeping quoted values intact. */
export function splitMetaTokens(meta: string | null | undefined): string[] {
  if (!meta) return [];
  return meta.match(TOKEN_RE) ?? [];
}

/** Recombine tokens into a meta string (single-space delimited, trimmed). */
export function joinMetaTokens(tokens: readonly string[]): string | null {
  const filtered = tokens.filter((t) => t.length > 0);
  if (filtered.length === 0) return null;
  return filtered.join(' ');
}

/** True when `token` (case-sensitive) is present as a standalone meta token. */
export function metaHasToken(meta: string | null | undefined, token: string): boolean {
  return splitMetaTokens(meta).includes(token);
}

/** Return a meta string with `token` toggled on (idempotent). */
export function addMetaToken(meta: string | null | undefined, token: string): string | null {
  const tokens = splitMetaTokens(meta);
  if (tokens.includes(token)) return joinMetaTokens(tokens);
  tokens.push(token);
  return joinMetaTokens(tokens);
}

/** Return a meta string with `token` removed (no-op if absent). */
export function removeMetaToken(meta: string | null | undefined, token: string): string | null {
  const tokens = splitMetaTokens(meta).filter((t) => t !== token);
  return joinMetaTokens(tokens);
}

/**
 * Languages whose `preview` flag actually renders a live preview pane.
 *
 * Includes `html`/`htm` (what users type) AND `xml` (highlight.js's canonical
 * key — `normalizeCodeLanguage` rewrites `html` → `xml` for token coloring).
 * Both forms have to match because `shouldShowPreview` is called with the
 * normalized language from the NodeView. SVG also lives under the `xml` key
 * but isn't worth a special carve-out — `xml preview` will render an iframe;
 * for typical SVG that's a valid preview shape.
 */
export const PREVIEWABLE_LANGUAGES = new Set(['html', 'htm', 'xml']);

/** Test whether a (language, meta) pair should render its preview pane. */
export function shouldShowPreview(
  language: string | null | undefined,
  meta: string | null | undefined,
): boolean {
  if (!language) return false;
  if (!PREVIEWABLE_LANGUAGES.has(language.toLowerCase())) return false;
  return metaHasToken(meta, 'preview');
}

const KV_RE = /^([a-zA-Z][a-zA-Z0-9_-]*)=(.+)$/;
const HEIGHT_VALUE_RE = /^(\d+(?:\.\d+)?)(px|rem|em|vh|vw|%)?$/i;

/**
 * Return the value of a `key=value` meta token (first occurrence) or null.
 * Whitespace-delimited; values may not themselves contain whitespace.
 */
export function getMetaKeyValue(meta: string | null | undefined, key: string): string | null {
  for (const token of splitMetaTokens(meta)) {
    const m = token.match(KV_RE);
    if (m && m[1] === key) return m[2] ?? null;
  }
  return null;
}

/**
 * Add or replace a `key=value` meta token, preserving the rest of the meta.
 * If the key already exists, only its FIRST occurrence is rewritten (mirrors
 * `getMetaKeyValue`'s first-wins lookup). Pass `null` as the value to remove
 * the token entirely.
 */
export function setMetaKeyValue(
  meta: string | null | undefined,
  key: string,
  value: string | null,
): string | null {
  const tokens = splitMetaTokens(meta);
  let replaced = false;
  const next: string[] = [];
  for (const token of tokens) {
    const m = token.match(KV_RE);
    if (m && m[1] === key) {
      if (replaced) {
        // Drop duplicate keys — first-wins matches the read side.
        continue;
      }
      replaced = true;
      if (value !== null) next.push(`${key}=${value}`);
      // else: omit (removal case)
      continue;
    }
    next.push(token);
  }
  if (!replaced && value !== null) next.push(`${key}=${value}`);
  return joinMetaTokens(next);
}

/**
 * Parse a `h=…` token from fence meta into a CSS length value.
 * Unitless numbers are treated as `px` — `h=430` means 430 pixels, which is
 * what a hand- or agent-authored fence overwhelmingly intends (a `rem` default
 * turned `h=430` into `430rem` ≈ 6880px). Returns `null` when absent or
 * malformed (caller falls back to the CSS default).
 */
export function parsePreviewHeight(meta: string | null | undefined): string | null {
  return parseLengthToken(meta, 'h');
}

/**
 * Parse a `w=…` token from fence meta into a CSS length value. Same shape
 * as `parsePreviewHeight` — unitless numbers are `px`, malformed + zero /
 * negative values return `null` so the CSS default takes over.
 */
export function parsePreviewWidth(meta: string | null | undefined): string | null {
  return parseLengthToken(meta, 'w');
}

/**
 * Title token — `title="…"` inside the fence info-string (CommonMark §4.5).
 * Quote-aware because the value commonly contains spaces (`title="my Title"`)
 * which would shred under the rest of this file's whitespace-split path.
 *
 * Both helpers operate on the raw meta string directly (regex pass), then
 * delegate the rest of the meta to `splitMetaTokens` so unrelated tokens
 * (`preview`, `h=…`, `w=…`, future ones) survive untouched.
 *
 * Recognized authoring shapes — first match wins:
 *   - `title="double quoted"` (Mintlify / Docusaurus / Nextra convention)
 *   - `title='single quoted'`
 *   - `title=Unquoted` (single word, no spaces)
 *
 * Word-boundary anchored at the start so `subtitle=…` / `xtitle=…` don't
 * false-match.
 */
const TITLE_RE = /\btitle=(?:"([^"]*)"|'([^']*)'|(\S+))/;

/**
 * Global variant used by the setter to strip every existing `title=…` token
 * (dedup-on-write). Kept separate from `TITLE_RE` for two reasons:
 *   - `/g` flag is required for `replace`-all semantics (the reader's
 *     first-match-wins regex stays single-shot — that's the fast path).
 *   - The unquoted alternative is `\S*` (not `\S+`) so a *bare* `title=`
 *     with no value is also matched and stripped. A hand-authored fence
 *     like ` ```ts title= preview ` can sit on disk; without `\S*` the
 *     reader returns null (no value), but the next `setMetaTitle` write
 *     would NOT strip the stray `title=` — successive edits would
 *     accumulate `title= title="x"` and friends. `\S*` always consumes
 *     at least 6 chars (`\btitle=`) so there's no zero-length-match
 *     infinite-loop concern with the `/g` engine.
 */
const TITLE_RE_GLOBAL = /\btitle=(?:"[^"]*"|'[^']*'|\S*)/g;

export function getMetaTitle(meta: string | null | undefined): string | null {
  if (!meta) return null;
  const m = meta.match(TITLE_RE);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/**
 * Set / replace / remove the `title="…"` token. Always emits the double-
 * quoted form on write (`title="…"`) — the canonical Mintlify / Docusaurus
 * shape and the only form that survives arbitrary value text (spaces,
 * single quotes, unquoted-illegal chars).
 *
 * Other meta tokens are preserved in their original order, but the title
 * token itself is always emitted at the FRONT of the output. The position
 * of `title=` inside the source string is not preserved — re-writing a
 * fence with `preview title="x"` yields `title="x" preview`. This is by
 * design: the dedup pass strips every `title=` occurrence before the
 * rewrite, so there's no "in-place" position to preserve, and a
 * predictable canonical position is easier to reason about than a
 * "wherever the first one was" rule.
 *
 * `value === null` removes the token. `value === ''` writes `title=""`
 * (an explicit empty title is distinct from "no title set" — the caller
 * decides which they want).
 *
 * Embedded `"` characters in the new value are stripped — there's no
 * escape syntax in fence info-strings and a literal `"` would break the
 * round-trip. Newlines are stripped for the same reason (info-strings
 * are single-line per CommonMark §4.5).
 */
export function setMetaTitle(meta: string | null | undefined, value: string | null): string | null {
  // Strip EVERY existing title token from the meta string first (regex
  // pass with /g, not token-split — keeps quoted values together).
  // Multiple `title=` occurrences collapse to a single first-wins
  // replacement, matching `getMetaTitle`'s read semantics.
  const stripped = meta ? meta.replace(TITLE_RE_GLOBAL, '').trim() : '';
  const rest = stripped.length > 0 ? stripped.replace(/\s+/g, ' ') : '';
  if (value === null) {
    return rest.length > 0 ? rest : null;
  }
  // Sanitize the value: drop embedded `"` chars (no escape syntax in
  // fence meta). Newlines are illegal in info-strings — strip those too.
  const safe = value.replace(/["\r\n]/g, '');
  const titleToken = `title="${safe}"`;
  return rest.length > 0 ? `${titleToken} ${rest}` : titleToken;
}

function parseLengthToken(meta: string | null | undefined, key: 'h' | 'w'): string | null {
  const raw = getMetaKeyValue(meta, key);
  if (!raw) return null;
  const m = raw.match(HEIGHT_VALUE_RE);
  if (!m) return null;
  const num = m[1];
  // Drop non-positive values — the CSS min-* floor would clamp anyway,
  // and the meta would lie about the rendered size.
  if (!num || Number.parseFloat(num) <= 0) return null;
  // Unitless → `px`. A `rem` default is a footgun: an author writing `h=430`
  // means pixels, and `430rem` is ~6880px (clamped to a viewport-tall void).
  const unit = m[2]?.toLowerCase() ?? 'px';
  return `${num}${unit}`;
}
