import {
  createCodeFenceTracker,
  getHeadingSlug,
  stripFrontmatter,
  toWikiLinkSlug,
} from '@inkeep/open-knowledge-core';

export interface DocExcerptOptions {
  anchor?: string | null;
  maxLines?: number;
  maxChars?: number;
}

const DEFAULT_MAX_LINES = 3;
const DEFAULT_MAX_CHARS = 240;

const MAX_SCAN_LINES = 400;

const ATX_HEADING_RE = /^(#{1,6})\s+(.*)$/;

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

function collectDocHead(lines: string[], maxLines: number): string[] {
  const isInCodeFence = createCodeFenceTracker();
  const out: string[] = [];
  let started = false;
  const scanLimit = Math.min(lines.length, MAX_SCAN_LINES);
  for (let i = 0; i < scanLimit && out.length < maxLines; i++) {
    const line = lines[i] ?? '';
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

function collectSection(lines: string[], anchor: string, maxLines: number): string[] | null {
  const heading = findHeadingLineForAnchor(lines, anchor);
  if (!heading) return null;

  const out: string[] = [];
  const headingText = stripLineMarkup(lines[heading.index] ?? '');
  if (headingText) out.push(headingText);

  const isInCodeFence = createCodeFenceTracker();
  for (let i = 0; i <= heading.index; i++) isInCodeFence(lines[i] ?? '');

  const scanLimit = Math.min(lines.length, heading.index + 1 + MAX_SCAN_LINES);
  for (let i = heading.index + 1; i < scanLimit && out.length < maxLines; i++) {
    const line = lines[i] ?? '';
    if (isInCodeFence(line)) continue;
    const headingMatch = line.match(ATX_HEADING_RE);
    if (headingMatch) {
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
    if (slug === anchor || slug === anchorSlug) {
      return { index: i, level: (match[1] ?? '').length };
    }
  }
  return null;
}

function stripLineMarkup(rawLine: string): string {
  if (isStructuralLine(rawLine)) return '';

  let line = rawLine;
  line = line.replace(/^\s*(?:>\s?)+/, '');
  line = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/, '');

  line = line.replace(/!\[\[[^\]]*\]\]/g, '');
  line = line.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  line = line.replace(/\[\[([^\]]+)\]\]/g, (_match, inner: string) => wikiLinkDisplay(inner));
  line = line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  line = line.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  line = line.replace(/``([^`]+)``/g, '$1');
  line = line.replace(/`([^`]+)`/g, '$1');
  line = line.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  line = line.replace(/\*\*([^*]+)\*\*/g, '$1');
  line = line.replace(/\*([^*]+)\*/g, '$1');
  line = line.replace(/___([^_]+)___/g, '$1');
  line = line.replace(/__([^_]+)__/g, '$1');
  line = line.replace(/(^|[^A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/g, '$1$2');
  line = line.replace(/~~([^~]+)~~/g, '$1');
  line = line.replace(/<((?:https?|mailto):[^>]+)>/g, '$1');
  line = line.replace(/<\/?[A-Za-z][^>]*>/g, '');
  line = line.replace(/\\([\\`*_{}[\]()#+\-.!~>|])/g, '$1');

  return line.replace(/\s+/g, ' ').trim();
}

function wikiLinkDisplay(inner: string): string {
  const pipeIndex = inner.indexOf('|');
  if (pipeIndex >= 0) {
    const alias = inner.slice(pipeIndex + 1).trim();
    if (alias) return alias;
  }
  const target = pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner;
  return (target.split('#')[0] ?? '').trim();
}

function isStructuralLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^([-*_])(?:[ \t]*\1){2,}$/.test(trimmed)) return true;
  if (/^=+$/.test(trimmed)) return true;
  return false;
}
