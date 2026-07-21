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
export function readMarkdownLinkAt(line: string, start: number): MarkdownLinkMatch | null {
  MD_AT_RE.lastIndex = start;
  const match = MD_AT_RE.exec(line);
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
