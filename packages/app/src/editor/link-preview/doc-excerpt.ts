/**
 * Pure markdown-to-plain-text excerpt extraction for the internal doc-preview
 * card. Given a document's markdown (frontmatter tolerated), returns a short
 * plain-text snippet of the opening prose — or, when an anchor is supplied and
 * resolves to a heading, of that section.
 *
 * Intentionally a lightweight line scanner rather than a full markdown parse:
 * the output feeds a hover preview, so "readable text, bounded work" beats
 * byte-perfect fidelity. Work is capped on both axes (line count and character
 * count) so a pathologically large document can't stall the hover.
 */

import {
  createCodeFenceTracker,
  getHeadingSlug,
  stripFrontmatter,
  toWikiLinkSlug,
} from '@inkeep/open-knowledge-core';

export interface DocExcerptOptions {
  /**
   * Heading slug to preview a specific section instead of the document head.
   * When it resolves to a heading, the excerpt is that heading plus its
   * following lines; when it doesn't resolve, extraction falls back to the head.
   */
  anchor?: string | null;
  /** Maximum number of prose source lines to gather. */
  maxLines?: number;
  /** Hard cap on the returned character count (a single huge line is truncated). */
  maxChars?: number;
}

const DEFAULT_MAX_LINES = 3;
const DEFAULT_MAX_CHARS = 240;

/**
 * Upper bound on lines scanned. A document that is thousands of blank lines
 * before its first prose (or a giant anchor section) resolves to a partial or
 * empty excerpt rather than walking the whole body on every hover.
 */
const MAX_SCAN_LINES = 400;

const ATX_HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Extract a plain-text excerpt from markdown for the hover preview card. */
export function extractDocExcerpt(markdown: string, options: DocExcerptOptions = {}): string {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const anchor = options.anchor?.trim() || null;

  const { body } = stripFrontmatter(markdown);
  const lines = body.split('\n').map(stripCarriageReturn);

  const sectionLines = anchor ? collectSection(lines, anchor, maxLines) : null;
  const collected = sectionLines ?? collectDocHead(lines, maxLines);

  const joined = collected.join(' ').replace(/\s+/g, ' ').trim();
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, maxChars).trimEnd()}…`;
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Gather the opening body — prose from the top of the document up to the first
 * heading that follows it. Leading headings (the title, an empty section) are
 * skipped so extraction lands on the first real prose; the first heading after
 * prose begins bounds the opening body so later sections don't leak in.
 */
function collectDocHead(lines: string[], maxLines: number): string[] {
  const isInCodeFence = createCodeFenceTracker();
  const out: string[] = [];
  let started = false;
  const scanLimit = Math.min(lines.length, MAX_SCAN_LINES);
  for (let i = 0; i < scanLimit && out.length < maxLines; i++) {
    const line = lines[i] ?? '';
    // The tracker is stateful and must observe every line in order; call it
    // first so fence state stays correct even for lines we go on to skip.
    if (isInCodeFence(line)) continue;
    if (ATX_HEADING_RE.test(line)) {
      if (started) break;
      continue;
    }
    const text = stripLineMarkup(line);
    if (!text) continue;
    out.push(text);
    started = true;
  }
  return out;
}

/**
 * Gather the heading matching `anchor` plus its section body. Returns null when
 * no heading matches so the caller can fall back to the document head.
 */
function collectSection(lines: string[], anchor: string, maxLines: number): string[] | null {
  const heading = findHeadingLineForAnchor(lines, anchor);
  if (!heading) return null;

  const out: string[] = [];
  const headingText = stripLineMarkup(lines[heading.index] ?? '');
  if (headingText) out.push(headingText);

  const isInCodeFence = createCodeFenceTracker();
  // Prime fence state up to and including the heading line so the body scan
  // below starts with the correct in/out-of-fence reading.
  for (let i = 0; i <= heading.index; i++) isInCodeFence(lines[i] ?? '');

  const scanLimit = Math.min(lines.length, heading.index + 1 + MAX_SCAN_LINES);
  for (let i = heading.index + 1; i < scanLimit && out.length < maxLines; i++) {
    const line = lines[i] ?? '';
    if (isInCodeFence(line)) continue;
    const headingMatch = line.match(ATX_HEADING_RE);
    if (headingMatch) {
      // A same-or-higher-level heading ends this section; a deeper subheading
      // keeps it going (skip only the marker line).
      if ((headingMatch[1] ?? '').length <= heading.level) break;
      continue;
    }
    const text = stripLineMarkup(line);
    if (text) out.push(text);
  }
  return out;
}

function findHeadingLineForAnchor(
  lines: string[],
  anchor: string,
): { index: number; level: number } | null {
  const anchorSlug = toWikiLinkSlug(anchor);
  const isInCodeFence = createCodeFenceTracker();
  const slugCounts = new Map<string, number>();
  const scanLimit = Math.min(lines.length, MAX_SCAN_LINES);
  for (let i = 0; i < scanLimit; i++) {
    const line = lines[i] ?? '';
    if (isInCodeFence(line)) continue;
    const match = line.match(ATX_HEADING_RE);
    if (!match) continue;
    const text = (match[2] ?? '').trim();
    const slug = getHeadingSlug(text, slugCounts);
    if (!slug) continue;
    // The stored href anchor is already a slug; also match a freshly-slugged
    // form so a hand-written `#Section Title` anchor still resolves.
    if (slug === anchor || slug === anchorSlug) {
      return { index: i, level: (match[1] ?? '').length };
    }
  }
  return null;
}

/** Reduce one markdown line to its plain-text content. Empty when structural. */
function stripLineMarkup(rawLine: string): string {
  if (isStructuralLine(rawLine)) return '';

  let line = rawLine;
  // Leading block markers: nested blockquotes, then one list/heading marker.
  line = line.replace(/^\s*(?:>\s?)+/, '');
  line = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/, '');

  // Image transclusions carry no text; drop before generic wiki-link handling.
  line = line.replace(/!\[\[[^\]]*\]\]/g, '');
  // Standard image: keep the alt text.
  line = line.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Wiki link: prefer alias, else target (anchor dropped).
  line = line.replace(/\[\[([^\]]+)\]\]/g, (_match, inner: string) => wikiLinkDisplay(inner));
  // Inline and reference links: keep the visible text.
  line = line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  line = line.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  // Inline code: keep the code text, drop the backticks.
  line = line.replace(/``([^`]+)``/g, '$1');
  line = line.replace(/`([^`]+)`/g, '$1');
  // Emphasis / strong / strikethrough. Underscore emphasis is word-boundary
  // guarded so identifiers like snake_case survive.
  line = line.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  line = line.replace(/\*\*([^*]+)\*\*/g, '$1');
  line = line.replace(/\*([^*]+)\*/g, '$1');
  line = line.replace(/___([^_]+)___/g, '$1');
  line = line.replace(/__([^_]+)__/g, '$1');
  line = line.replace(/(^|[^A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/g, '$1$2');
  line = line.replace(/~~([^~]+)~~/g, '$1');
  // Autolinks: keep the address inside the angle brackets, then drop any
  // residual HTML tags.
  line = line.replace(/<((?:https?|mailto):[^>]+)>/g, '$1');
  line = line.replace(/<\/?[A-Za-z][^>]*>/g, '');
  // Backslash escapes resolve to the escaped character.
  line = line.replace(/\\([\\`*_{}[\]()#+\-.!~>|])/g, '$1');

  return line.replace(/\s+/g, ' ').trim();
}

/** Resolve a wiki-link inner (`target#anchor|alias`) to its display text. */
function wikiLinkDisplay(inner: string): string {
  const pipeIndex = inner.indexOf('|');
  if (pipeIndex >= 0) {
    const alias = inner.slice(pipeIndex + 1).trim();
    if (alias) return alias;
  }
  const target = pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner;
  return (target.split('#')[0] ?? '').trim();
}

/** Thematic breaks and setext underlines carry no preview text. */
function isStructuralLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^([-*_])(?:[ \t]*\1){2,}$/.test(trimmed)) return true;
  if (/^=+$/.test(trimmed)) return true;
  return false;
}
