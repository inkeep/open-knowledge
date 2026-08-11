/**
 * Single line-oriented grammar for the server's inline link recognizers:
 * `[[wiki links]]` / `![[wiki embeds]]` and `[markdown](links)` /
 * `![markdown](images)`. Consumers: `backlink-index.ts`,
 * `managed-rename-rewrite.ts`, `suggest-links.ts`, `asset-references.ts`.
 * Before consolidation each site owned a subtly different regex, so a link
 * could count for backlinks yet be missed by rename rewriting — the
 * divergence class the canonical link contract (precedent #56) exists to
 * prevent. Recognition is consolidated here; resolution stays in
 * `resolveInternalHref` / `classifyMarkdownHref` (core).
 *
 * Line-oriented: callers pre-split into lines, so the character classes
 * exclude `\n` defensively rather than relying on multiline flags.
 * cf. packages/core/src/extensions/wiki-link.ts WIKI_LINK_PATTERN — the
 * editor-side pattern (no `\n` exclusion, `^`-anchored) is a sibling grammar
 * that must stay observationally aligned with this one on shared inputs.
 *
 * Known deliberate residual: `server-observers.ts` `markdownBareText` strips
 * link syntax with a LOOSER regex (`/!?\[([^\]]*)\]\([^)]*\)/g`) that admits
 * whitespace in destinations and ignores titles/angle wrappers. That is a
 * reduction for carrier attribution, not link recognition — over-stripping
 * is acceptable there, under-stripping is not — so it intentionally does not
 * share this grammar. See the divergence pins in `link-syntax.test.ts`.
 */

// Wiki form: [[target]], [[target#anchor]], [[target|alias]],
// [[target#anchor|alias]]. Target excludes `[ ] | #`; anchor excludes
// `[ ] |`; alias excludes `[ ]` (so aliases may contain `#` and later `|`
// chars fold into the alias, matching how `[[a|b|c]]` has alias `b|c`).
const WIKI_BODY_SOURCE = String.raw`\[\[([^\n#[\]|]+)(?:#([^\n[\]|]+))?(?:\|([^\n[\]]+))?\]\]`;

// Inline destination + optional CommonMark title: `<angle form>` admits
// spaces; the bare form runs to the first `)` or whitespace. Titles come in
// the three CommonMark forms ("…", '…', (…)); the authored whitespace+title
// suffix is captured verbatim so rewriters can re-emit it byte-identically.
// Does NOT match reference-style `[text][ref]`.
const DEST_AND_TITLE_SOURCE = String.raw`\((<[^>\n]+>|[^)\s\n]+)((?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?)\)`;

// Strict labels stop at the first `]`. The nested variant additionally
// admits one `]…` run inside the label so a bracketed construct nested in
// the label — badge-style `[![alt](img)](target)` — matches as ONE link
// carrying the outermost destination instead of stopping at the inner image.
const LABEL_STRICT_SOURCE = String.raw`([^\]\n]*)`;
const LABEL_NESTED_SOURCE = String.raw`([^\]\n]*(?:\][^[\]\n]*)?)`;

const wikiPattern = (flags: string) => new RegExp(`(!?)${WIKI_BODY_SOURCE}`, flags);
const markdownPattern = (label: string, flags: string) =>
  new RegExp(`(!?)\\[${label}\\]${DEST_AND_TITLE_SOURCE}`, flags);

// Sticky ('y') for position-based matching via lastIndex — no per-call
// line.slice allocation. Module-level regexes are shared mutable state
// (lastIndex); every use sets lastIndex immediately before exec.
const WIKI_AT_RE = wikiPattern('y');
const WIKI_SCAN_RE = wikiPattern('g');
const MD_AT_RE = markdownPattern(LABEL_STRICT_SOURCE, 'y');
const MD_AT_NESTED_RE = markdownPattern(LABEL_NESTED_SOURCE, 'y');
const MD_SCAN_STRICT_RE = markdownPattern(LABEL_STRICT_SOURCE, 'g');
const MD_SCAN_NESTED_RE = markdownPattern(LABEL_NESTED_SOURCE, 'g');

export interface WikiLinkMatch {
  /** True for the `![[…]]` embed form. */
  embed: boolean;
  /** Trimmed target; matches with a whitespace-only target are rejected. */
  target: string;
  /** Target capture as authored (untrimmed), for label-offset math. */
  targetRaw: string;
  /** Trimmed anchor; null when absent or whitespace-only. */
  anchor: string | null;
  anchorRaw: string | null;
  /** Trimmed alias; null when absent or whitespace-only. */
  alias: string | null;
  aliasRaw: string | null;
  start: number;
  /** Index just past the closing `]]` — the caller's next cursor position. */
  end: number;
}

export interface MarkdownLinkMatch {
  /** True for the `![…](…)` image form. */
  image: boolean;
  label: string;
  /** Destination as authored, including any `<…>` wrapper. */
  hrefRaw: string;
  /** Destination with a `<…>` wrapper removed. */
  href: string;
  /** Authored whitespace+title suffix, '' when no title. */
  titleSuffix: string;
  start: number;
  /** Index just past the closing `)` — the caller's next cursor position. */
  end: number;
}

function toWikiLinkMatch(match: RegExpExecArray, start: number): WikiLinkMatch | null {
  const targetRaw = match[2] ?? '';
  const target = targetRaw.trim();
  if (!target) return null;
  const anchorRaw = match[3] ?? null;
  const aliasRaw = match[4] ?? null;
  return {
    embed: match[1] === '!',
    target,
    targetRaw,
    anchor: anchorRaw?.trim() || null,
    anchorRaw,
    alias: aliasRaw?.trim() || null,
    aliasRaw,
    start,
    end: start + match[0].length,
  };
}

function unwrapAngleHref(rawHref: string): string {
  return rawHref.startsWith('<') && rawHref.endsWith('>') ? rawHref.slice(1, -1) : rawHref;
}

function toMarkdownLinkMatch(match: RegExpExecArray, start: number): MarkdownLinkMatch {
  const hrefRaw = match[3] ?? '';
  return {
    image: match[1] === '!',
    label: match[2] ?? '',
    hrefRaw,
    href: unwrapAngleHref(hrefRaw),
    titleSuffix: match[4] ?? '',
    start,
    end: start + match[0].length,
  };
}

/**
 * Match a wiki link or embed starting exactly at `start`. `![[…]]` at
 * `start` is an embed; `[[…]]` is a plain wiki link. Callers that treat a
 * preceding `!` as ordinary text simply call at the `[[` position.
 */
export function readWikiLinkAt(line: string, start: number): WikiLinkMatch | null {
  WIKI_AT_RE.lastIndex = start;
  const match = WIKI_AT_RE.exec(line);
  if (!match) return null;
  return toWikiLinkMatch(match, start);
}

/**
 * Match a markdown inline link or image starting exactly at `start`.
 * `![…](…)` at `start` is an image; `[…](…)` is a link — dispatch on
 * `.image` when the two forms need different handling.
 */
export function readMarkdownLinkAt(
  line: string,
  start: number,
  options?: MatchMarkdownLinksOptions,
): MarkdownLinkMatch | null {
  const pattern = options?.nestedBracketLabels ? MD_AT_NESTED_RE : MD_AT_RE;
  pattern.lastIndex = start;
  const match = pattern.exec(line);
  if (!match) return null;
  return toMarkdownLinkMatch(match, start);
}

/**
 * All wiki links and embeds on a line, left to right, non-overlapping.
 * Whitespace-only targets are dropped (the scan still advances past them).
 */
export function matchWikiLinks(line: string): WikiLinkMatch[] {
  const matches: WikiLinkMatch[] = [];
  WIKI_SCAN_RE.lastIndex = 0;
  for (const match of line.matchAll(WIKI_SCAN_RE)) {
    const wikiLink = toWikiLinkMatch(match, match.index);
    if (wikiLink) matches.push(wikiLink);
  }
  return matches;
}

export interface MatchMarkdownLinksOptions {
  /**
   * Admit one `]…` run inside the label so badge-style image-in-link
   * (`[![alt](img)](target)`) matches as one link with the OUTER
   * destination. Without it the scan matches the nested image and yields
   * the inner destination instead. Neither mode yields both destinations.
   */
  nestedBracketLabels?: boolean;
}

/**
 * All markdown inline links AND images on a line, left to right,
 * non-overlapping. Filter on `.image` when only one form is wanted.
 */
export function matchMarkdownLinks(
  line: string,
  options?: MatchMarkdownLinksOptions,
): MarkdownLinkMatch[] {
  const scanRe = options?.nestedBracketLabels ? MD_SCAN_NESTED_RE : MD_SCAN_STRICT_RE;
  scanRe.lastIndex = 0;
  const matches: MarkdownLinkMatch[] = [];
  for (const match of line.matchAll(scanRe)) {
    matches.push(toMarkdownLinkMatch(match, match.index));
  }
  return matches;
}

// Reference-style label: `[text][ref]` (full), `[text][]` (collapsed),
// `[text]` (shortcut). Label + optional second bracket use the same strict
// `[^\]]*` class as the inline label above, so recognition stays observationally
// aligned with `readMarkdownLinkAt`. Whether a shortcut/collapsed form is a real
// reference depends on a matching definition, which only the caller (holding the
// whole-document definition table) can decide — this recognizer reports the
// authored shape and leaves resolution to the caller.
const MD_REFERENCE_SOURCE = String.raw`(!?)\[([^\]\n]*)\](?:\[([^\]\n]*)\])?`;
const MD_REFERENCE_AT_RE = new RegExp(MD_REFERENCE_SOURCE, 'y');

// A link reference definition line: up to 3 leading spaces, `[label]:`, a
// destination (`<…>` admits spaces; the bare form runs to the first whitespace),
// and an optional CommonMark title. Anchored to the whole line — definitions are
// block-level and carry no other content. Group 1 captures the prefix so the
// destination's offset is `prefix.length` without needing match indices.
const REFERENCE_DEFINITION_RE =
  /^( {0,3}\[([^\]\n]+)\]:[ \t]*)(<[^>\n]*>|[^\s\n]+)((?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*)$/;

type MarkdownReferenceForm = 'full' | 'collapsed' | 'shortcut';

export interface MarkdownReferenceMatch {
  /** True for the `![…][…]` image form. */
  image: boolean;
  /** Link text as authored (the first bracket's contents). */
  label: string;
  form: MarkdownReferenceForm;
  /**
   * Label to resolve against the definition table: the second bracket's
   * contents for `full`, otherwise `label` (collapsed and shortcut reuse the
   * text as the reference).
   */
  referenceLabelRaw: string;
  start: number;
  /** Index just past the whole form (through the second bracket for full/collapsed). */
  end: number;
  /** Index just past the label's closing `]` — where a shortcut form ends. */
  labelEnd: number;
}

export interface ReferenceDefinitionMatch {
  /** Definition label as authored (untrimmed, not case-folded). */
  label: string;
  /** Destination as authored, including any `<…>` wrapper. */
  destinationRaw: string;
  /** Destination with a `<…>` wrapper removed. */
  destination: string;
  /** Offset of the destination token within the line — the repair-range start. */
  destinationStart: number;
  /** Index just past the destination token — the repair-range end. */
  destinationEnd: number;
  /** Authored whitespace+title suffix, '' when no title. */
  titleSuffix: string;
}

export interface HtmlImgMatch {
  /** The `src` value as authored (quotes removed, not URL-decoded). */
  src: string;
  /** True when the tag closes with `/>` rather than a bare `>`. */
  selfClosing: boolean;
  start: number;
  /** Index just past the closing `>`. */
  end: number;
}

function toMarkdownReferenceMatch(match: RegExpExecArray, start: number): MarkdownReferenceMatch {
  const image = match[1] === '!';
  const label = match[2] ?? '';
  const secondBracket = match[3];
  const labelEnd = start + (image ? 2 : 1) + label.length + 1;
  const end = start + match[0].length;
  if (secondBracket === undefined) {
    return { image, label, form: 'shortcut', referenceLabelRaw: label, start, end, labelEnd };
  }
  if (secondBracket === '') {
    return { image, label, form: 'collapsed', referenceLabelRaw: label, start, end, labelEnd };
  }
  return { image, label, form: 'full', referenceLabelRaw: secondBracket, start, end, labelEnd };
}

/**
 * Match a reference-style markdown link or image starting exactly at `start`.
 * `![…]` at `start` is an image; `[…]` is a link. Returns the authored shape
 * ({@link MarkdownReferenceForm}); the caller decides whether a matching
 * definition exists. Returns null when the label is unterminated.
 */
export function readMarkdownReferenceAt(
  line: string,
  start: number,
): MarkdownReferenceMatch | null {
  MD_REFERENCE_AT_RE.lastIndex = start;
  const match = MD_REFERENCE_AT_RE.exec(line);
  if (!match) return null;
  return toMarkdownReferenceMatch(match, start);
}

/**
 * Parse a whole line as a link reference definition (`[label]: dest "title"`).
 * Returns null when the line is not a definition. `destinationStart` /
 * `destinationEnd` bound the destination token so a rewriter can replace just
 * that span (the definition repair range).
 */
export function readReferenceDefinition(line: string): ReferenceDefinitionMatch | null {
  const match = REFERENCE_DEFINITION_RE.exec(line);
  if (!match) return null;
  const prefix = match[1] ?? '';
  const destinationRaw = match[3] ?? '';
  return {
    label: match[2] ?? '',
    destinationRaw,
    destination: unwrapAngleHref(destinationRaw),
    destinationStart: prefix.length,
    destinationEnd: prefix.length + destinationRaw.length,
    titleSuffix: match[4] ?? '',
  };
}

function isHtmlSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '\f';
}

/** Find the closing `>` without letting one inside a quoted attribute terminate the tag. */
function findHtmlTagEnd(line: string, start: number): number | null {
  let quote: '"' | "'" | null = null;
  for (let i = start; i < line.length; i++) {
    const char = line[i];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return i;
  }
  return null;
}

/** Read the first exact `src` attribute from a bounded `<img ...>` tag. */
function readImgSrcAttribute(line: string, attributesStart: number, tagEnd: number): string | null {
  let cursor = attributesStart;
  while (cursor < tagEnd) {
    while (isHtmlSpace(line[cursor]) || line[cursor] === '/') cursor += 1;
    if (cursor >= tagEnd) break;

    const nameStart = cursor;
    while (
      cursor < tagEnd &&
      !isHtmlSpace(line[cursor]) &&
      line[cursor] !== '=' &&
      line[cursor] !== '/' &&
      line[cursor] !== '>'
    ) {
      cursor += 1;
    }
    const name = line.slice(nameStart, cursor).toLowerCase();
    if (!name) {
      cursor += 1;
      continue;
    }
    while (isHtmlSpace(line[cursor])) cursor += 1;
    if (line[cursor] !== '=') continue;
    cursor += 1;
    while (isHtmlSpace(line[cursor])) cursor += 1;
    if (cursor >= tagEnd) return null;

    const quote = line[cursor];
    let value: string;
    if (quote === '"' || quote === "'") {
      const valueStart = cursor + 1;
      const valueEnd = line.indexOf(quote, valueStart);
      if (valueEnd < 0 || valueEnd > tagEnd) return null;
      value = line.slice(valueStart, valueEnd);
      cursor = valueEnd + 1;
    } else {
      const valueStart = cursor;
      while (cursor < tagEnd && !isHtmlSpace(line[cursor]) && line[cursor] !== '>') cursor += 1;
      value = line.slice(valueStart, cursor);
    }
    if (name === 'src') return value;
  }
  return null;
}

/**
 * Match an HTML `<img>` starting exactly at `start`, reading its `src`. Covers
 * the bare void form and the self-closing form. Returns null when `start` is not
 * an `<img>` with a `src`.
 */
export function readHtmlImgAt(line: string, start: number): HtmlImgMatch | null {
  if (line.slice(start, start + 4).toLowerCase() !== '<img') return null;
  const boundary = line[start + 4];
  if (boundary !== '>' && boundary !== '/' && !isHtmlSpace(boundary)) return null;
  const tagEnd = findHtmlTagEnd(line, start + 4);
  if (tagEnd === null) return null;
  const src = readImgSrcAttribute(line, start + 4, tagEnd);
  if (src === null) return null;
  let beforeClose = tagEnd - 1;
  while (beforeClose >= start && isHtmlSpace(line[beforeClose])) beforeClose -= 1;
  return {
    src,
    selfClosing: line[beforeClose] === '/',
    start,
    end: tagEnd + 1,
  };
}

/** Every HTML `<img src>` on a line, left to right, non-overlapping. */
export function matchHtmlImgs(line: string): HtmlImgMatch[] {
  const matches: HtmlImgMatch[] = [];
  const lower = line.toLowerCase();
  for (let cursor = 0; cursor < line.length; ) {
    const start = lower.indexOf('<img', cursor);
    if (start < 0) break;
    const match = readHtmlImgAt(line, start);
    if (match) {
      matches.push(match);
      cursor = match.end;
    } else {
      cursor = start + 1;
    }
  }
  return matches;
}
