/**
 * Tokenize a YAML-frontmatter property string into a sequence of plain-text
 * runs interleaved with link-shaped substrings — wiki-links (`[[Page]]`,
 * `[[Page#anchor]]`, `[[Page|alias]]`), markdown links (`[text](url)`),
 * and bare http(s) URLs.
 *
 * Used by the property panel's list-chip + text-widget renderers so an
 * author who types `related: [[some/page]] — description` sees the
 * wikilink rendered as a navigable chip rather than the raw `[[…]]` source.
 * The output is consumed by `PropertyInlineLinks.tsx` which
 * walks the segments and emits the matching React elements.
 *
 * Pure — no DOM, no React, no navigation. Exported for unit testing.
 */

import { parseWikiLink } from '@inkeep/open-knowledge-core';

export type PropertyInlineSegment =
  | { type: 'text'; value: string }
  | {
      type: 'wikilink';
      raw: string;
      target: string;
      alias: string | null;
      anchor: string | null;
    }
  | { type: 'link'; raw: string; text: string; url: string }
  | { type: 'autolink'; raw: string; url: string };

/**
 * Match a markdown link `[text](url)` at the START of `src`. Returns null
 * if the prefix is not a well-formed link.
 *
 * Why hand-roll rather than feed through the full markdown pipeline:
 *   - Property values are short and never multi-line; the full unified
 *     pipeline would add tens of KB to the editor bundle for a feature
 *     that needs only two link shapes.
 *   - The output must be tokens, not mdast — `parseWithFallback` returns
 *     a tree we'd have to walk anyway.
 *
 * Closing-paren handling is intentionally simple: stop at the first `)`.
 * URLs containing a `)` would truncate, but the resulting text remains
 * the original raw string (segments concatenate back to identity) — no
 * silent data loss.
 */
function parseMarkdownLink(src: string): { raw: string; text: string; url: string } | null {
  if (src[0] !== '[') return null;
  // Find matching `]` for the text span. Brackets inside the text are
  // not allowed (CommonMark §6.3 disallows unescaped `]` inside link
  // text without balancing `[`); the simple scan rejects them by
  // returning null on the first nested `[`.
  let i = 1;
  let textEnd = -1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ']') {
      textEnd = i;
      break;
    }
    if (ch === '[') return null;
    i++;
  }
  if (textEnd < 0) return null;
  if (src[textEnd + 1] !== '(') return null;
  const urlStart = textEnd + 2;
  const urlEnd = src.indexOf(')', urlStart);
  if (urlEnd < 0) return null;
  const text = src.slice(1, textEnd);
  const url = src.slice(urlStart, urlEnd).trim();
  if (!url) return null;
  return { raw: src.slice(0, urlEnd + 1), text, url };
}

/**
 * Match a bare http(s) URL at the START of `src`. Returns null when
 * the prefix is not a URL.
 *
 * Greedy-match through any non-whitespace, non-quote character that's
 * URL-safe. Trailing sentence punctuation (`.`, `,`, `;`, `:`, `!`, `?`)
 * is stripped — common authoring habit: `… see https://foo.com.` should
 * not include the trailing period in the link target.
 *
 * `)` is intentionally NOT in this set — the balanced-parens carveout
 * below handles it. Putting `)` here would unconditionally strip the
 * closing paren of `…/Foo_(disambiguation)` Wikipedia-style URLs.
 */
const AUTOLINK_RE = /^https?:\/\/[^\s<>"'`]+/i;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

function parseAutolink(src: string): { raw: string; url: string } | null {
  const match = AUTOLINK_RE.exec(src);
  if (!match) return null;
  let url = match[0];
  // Don't strip the closing `)` of a balanced parenthesized URL —
  // Wikipedia URLs commonly include parens. Strip trailing `)` only
  // when there's no matching `(` inside the URL itself.
  if (url.endsWith(')') && !url.slice(0, -1).includes('(')) {
    url = url.slice(0, -1);
  }
  // Strip other trailing sentence punctuation.
  url = url.replace(TRAILING_PUNCT_RE, '');
  if (!url) return null;
  return { raw: url, url };
}

/**
 * Tokenize the property value into plain-text + link segments. The
 * concatenation of `seg.raw` (or `seg.value` for text) reconstructs the
 * input byte-for-byte — segments never drop or rewrite the source.
 */
export function tokenizePropertyInlineLinks(text: string): PropertyInlineSegment[] {
  const out: PropertyInlineSegment[] = [];
  let i = 0;
  let plainStart = 0;

  function flushPlain(end: number): void {
    if (end > plainStart) out.push({ type: 'text', value: text.slice(plainStart, end) });
  }

  while (i < text.length) {
    // 1. Wiki-link — `[[…]]`. parseWikiLink lives in core and is already
    //    the canonical recognizer (anchor + alias forms, target trimming).
    if (text[i] === '[' && text[i + 1] === '[') {
      const wiki = parseWikiLink(text.slice(i));
      if (wiki) {
        flushPlain(i);
        out.push({
          type: 'wikilink',
          raw: wiki.raw,
          target: wiki.target,
          alias: wiki.alias,
          anchor: wiki.anchor,
        });
        i += wiki.raw.length;
        plainStart = i;
        continue;
      }
    }
    // 2. Markdown link — `[text](url)`.
    if (text[i] === '[') {
      const md = parseMarkdownLink(text.slice(i));
      if (md) {
        flushPlain(i);
        out.push({ type: 'link', raw: md.raw, text: md.text, url: md.url });
        i += md.raw.length;
        plainStart = i;
        continue;
      }
    }
    // 3. Bare http(s) URL.
    if ((text[i] === 'h' || text[i] === 'H') && /^https?:\/\//i.test(text.slice(i, i + 8))) {
      const auto = parseAutolink(text.slice(i));
      if (auto) {
        flushPlain(i);
        out.push({ type: 'autolink', raw: auto.raw, url: auto.url });
        i += auto.raw.length;
        plainStart = i;
        continue;
      }
    }
    i++;
  }
  flushPlain(text.length);
  return out;
}

/**
 * True iff the input contains at least one non-text segment. Cheap pre-
 * check the widgets use to skip the React render path when the value is
 * pure plain text — avoids allocating a segment array on every render of
 * the (overwhelmingly common) plain-text case.
 */
export function hasInlineLinks(text: string): boolean {
  if (!text) return false;
  // Cheap substring probes before the full tokenizer — short-circuits
  // on the most common case (plain text without any link syntax).
  if (!text.includes('[[') && !text.includes('](') && !/https?:\/\//i.test(text)) return false;
  return tokenizePropertyInlineLinks(text).some((seg) => seg.type !== 'text');
}
