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

const WIKI_BODY_SOURCE = String.raw`\[\[([^\n#[\]|]+)(?:#([^\n[\]|]+))?(?:\|([^\n[\]]+))?\]\]`;

const DEST_AND_TITLE_SOURCE = String.raw`\((<[^>\n]+>|[^)\s\n]+)((?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?)\)`;

const LABEL_STRICT_SOURCE = String.raw`([^\]\n]*)`;
const LABEL_NESTED_SOURCE = String.raw`([^\]\n]*(?:\][^[\]\n]*)?)`;

const wikiPattern = (flags: string) => new RegExp(`(!?)${WIKI_BODY_SOURCE}`, flags);
const markdownPattern = (label: string, flags: string) =>
  new RegExp(`(!?)\\[${label}\\]${DEST_AND_TITLE_SOURCE}`, flags);

const WIKI_AT_RE = wikiPattern('y');
const WIKI_SCAN_RE = wikiPattern('g');
const MD_AT_RE = markdownPattern(LABEL_STRICT_SOURCE, 'y');
const MD_AT_NESTED_RE = markdownPattern(LABEL_NESTED_SOURCE, 'y');
const MD_SCAN_STRICT_RE = markdownPattern(LABEL_STRICT_SOURCE, 'g');
const MD_SCAN_NESTED_RE = markdownPattern(LABEL_NESTED_SOURCE, 'g');

export interface WikiLinkMatch {
  embed: boolean;
  target: string;
  targetRaw: string;
  anchor: string | null;
  anchorRaw: string | null;
  alias: string | null;
  aliasRaw: string | null;
  start: number;
  end: number;
}

export interface MarkdownLinkMatch {
  image: boolean;
  label: string;
  hrefRaw: string;
  href: string;
  titleSuffix: string;
  start: number;
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

export function readWikiLinkAt(line: string, start: number): WikiLinkMatch | null {
  WIKI_AT_RE.lastIndex = start;
  const match = WIKI_AT_RE.exec(line);
  if (!match) return null;
  return toWikiLinkMatch(match, start);
}

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
  nestedBracketLabels?: boolean;
}

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

const MD_REFERENCE_SOURCE = String.raw`(!?)\[([^\]\n]*)\](?:\[([^\]\n]*)\])?`;
const MD_REFERENCE_AT_RE = new RegExp(MD_REFERENCE_SOURCE, 'y');

const REFERENCE_DEFINITION_RE =
  /^( {0,3}\[([^\]\n]+)\]:[ \t]*)(<[^>\n]*>|[^\s\n]+)((?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*)$/;

type MarkdownReferenceForm = 'full' | 'collapsed' | 'shortcut';

export interface MarkdownReferenceMatch {
  image: boolean;
  label: string;
  form: MarkdownReferenceForm;
  referenceLabelRaw: string;
  start: number;
  end: number;
  labelEnd: number;
}

export interface ReferenceDefinitionMatch {
  label: string;
  destinationRaw: string;
  destination: string;
  destinationStart: number;
  destinationEnd: number;
  titleSuffix: string;
}

export interface HtmlImgMatch {
  src: string;
  selfClosing: boolean;
  start: number;
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

export function readMarkdownReferenceAt(
  line: string,
  start: number,
): MarkdownReferenceMatch | null {
  MD_REFERENCE_AT_RE.lastIndex = start;
  const match = MD_REFERENCE_AT_RE.exec(line);
  if (!match) return null;
  return toMarkdownReferenceMatch(match, start);
}

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
