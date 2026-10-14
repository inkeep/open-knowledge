import { readFile } from 'node:fs/promises';
import type { Document, Hocuspocus } from '@hocuspocus/server';
import {
  resolveInternalHref,
  resolveSkillBundleWikiTarget,
  resolveWikiLinkTargetDocName,
  stripFrontmatter,
  toWikiLinkSlug,
  type WikiLinkLookupIndex,
} from '@inkeep/open-knowledge-core';
import type { FileIndexEntry } from './file-watcher.ts';
import { readMarkdownLinkAt, readWikiLinkAt } from './link-syntax.ts';
import { getLogger } from './logger.ts';
import { extractPageIdentity, type PageIdentity } from './page-identity.ts';
import { buildProjectWikiLinkLookup } from './project-wiki-link-lookup.ts';

const log = getLogger('suggest-links');

const WORD_CHAR_RE = /[\p{L}\p{M}\p{N}]/u;
const UNSPACED_SCRIPT_CHAR_RE =
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]/u;
const REGEXP_SYNTAX_CHAR_RE = /[\\^$.*+?()[\]{}|/]/g;

const WORD_SEGMENTER = new Intl.Segmenter('und', { granularity: 'word' });

interface FenceState {
  char: '`' | '~';
  length: number;
}

interface SearchLabel {
  raw: string;
  pattern: RegExp;
}

interface SegmentMatch {
  start: number;
  end: number;
}

interface PlainSegment {
  flatStart: number;
  text: string;
  sourceOffsets: number[];
}

interface SuggestLinksMention {
  source: string;
  excerpt: string;
  offset: number;
}

interface SuggestLinksTarget {
  docName: string;
  title: string;
  aliases: string[];
}

interface SuggestLinksResult {
  target: SuggestLinksTarget;
  mentions: SuggestLinksMention[];
  truncated: boolean;
}

interface SuggestLinksObservation {
  durationMs: number;
  corpusDocCount: number;
  candidateCount: number;
  truncated: boolean;
}

interface SuggestLinksOptions {
  hocuspocus: Pick<Hocuspocus, 'documents'>;
  fileIndex: ReadonlyMap<string, FileIndexEntry>;
  docName: string;
  scanBudgetMs?: number;
  now?: () => number;
  onComplete?: (observation: SuggestLinksObservation) => void;
}

export class SuggestLinksTargetNotFoundError extends Error {
  constructor(docName: string) {
    super(`Document not found: ${docName}`);
    this.name = 'SuggestLinksTargetNotFoundError';
  }
}

function normalizeSnippet(snippet: string): string {
  return snippet.replace(/\s+/g, ' ').trim();
}

function snippetAround(text: string, start: number, end: number): string | null {
  const normalizedText = normalizeSnippet(text);
  if (!normalizedText) return null;

  const leftPunctuation = Math.max(
    text.lastIndexOf('.', start - 1),
    text.lastIndexOf('?', start - 1),
    text.lastIndexOf('!', start - 1),
    text.lastIndexOf('\n', start - 1),
  );
  const rightPunctuationCandidates = [
    text.indexOf('.', end),
    text.indexOf('?', end),
    text.indexOf('!', end),
    text.indexOf('\n', end),
  ].filter((idx) => idx >= 0);

  const rawStart = leftPunctuation >= 0 ? leftPunctuation + 1 : Math.max(0, start - 60);
  const rawEnd =
    rightPunctuationCandidates.length > 0
      ? Math.min(...rightPunctuationCandidates) + 1
      : Math.min(text.length, end + 60);

  const prefix = rawStart > 0 ? '…' : '';
  const suffix = rawEnd < text.length ? '…' : '';
  const snippet = normalizeSnippet(text.slice(rawStart, rawEnd));
  if (!snippet) return null;
  return `${prefix}${snippet}${suffix}`;
}

function matchFence(line: string): FenceState | null {
  const match = /^\s{0,3}([`~]{3,})/.exec(line);
  if (!match) return null;
  const fence = match[1];
  const char = fence[0];
  if (char !== '`' && char !== '~') return null;
  return { char, length: fence.length };
}

function isFenceClose(line: string, fence: FenceState): boolean {
  const trimmed = line.trimStart();
  if (line.length - trimmed.length > 3) return false;
  let markerCount = 0;
  while (trimmed[markerCount] === fence.char) markerCount += 1;
  if (markerCount < fence.length) return false;
  return trimmed.slice(markerCount).trim().length === 0;
}

function leadingMarkdownPrefixLength(line: string): number {
  const match = /^\s{0,3}(?:#{1,6}\s+|>\s+|(?:[-+*]|\d+[.)])\s+)/.exec(line);
  return match ? match[0].length : 0;
}

function readInlineCode(line: string, start: number): { text: string; nextIndex: number } | null {
  let runLength = 0;
  while (line[start + runLength] === '`') runLength++;
  if (runLength === 0) return null;
  const openEnd = start + runLength;

  let index = openEnd;
  while (index < line.length) {
    if (line[index] !== '`') {
      index += 1;
      continue;
    }
    let closeLength = 0;
    while (line[index + closeLength] === '`') closeLength += 1;
    if (closeLength === runLength) {
      return { text: line.slice(openEnd, index), nextIndex: index + runLength };
    }
    index += closeLength;
  }

  return { text: line.slice(start, openEnd), nextIndex: openEnd };
}

const HTML_TAG_HEAD_RE = /<\/?[A-Za-z][\w.-]*(?=[\s/>])/y;
const HTML_TAG_BODY_CHAR_RE = /[\s\w.:@$=/-]/;

function readHtmlTag(line: string, start: number): { text: string; nextIndex: number } | null {
  if (line.startsWith('<!--', start)) {
    const close = line.indexOf('-->', start + 4);
    return close === -1 ? null : { text: line.slice(start, close + 3), nextIndex: close + 3 };
  }

  HTML_TAG_HEAD_RE.lastIndex = start;
  const head = HTML_TAG_HEAD_RE.exec(line);
  if (!head) return null;

  let quote: string | null = null;
  let braceDepth = 0;
  for (let index = start + head[0].length; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '{') {
      braceDepth += 1;
    } else if (char === '}') {
      braceDepth -= 1;
    } else if (braceDepth === 0 && char === '>') {
      return { text: line.slice(start, index + 1), nextIndex: index + 1 };
    } else if (braceDepth === 0 && !HTML_TAG_BODY_CHAR_RE.test(char)) {
      return null;
    }
  }

  return null;
}

function readWikiLink(
  line: string,
  start: number,
): {
  target: string;
  alias: string | null;
  anchor: string | null;
  label: string;
  labelStart: number;
  nextIndex: number;
} | null {
  const match = readWikiLinkAt(line, start);
  if (!match) return null;

  const label = match.alias ?? match.target;
  const rawLabel = match.alias ? match.aliasRaw : match.targetRaw;
  const labelIndexInMatch =
    match.alias && match.aliasRaw ? match.end - match.start - 2 - match.aliasRaw.length : 2;
  const labelTrimOffset = rawLabel?.indexOf(label) ?? 0;

  return {
    target: match.target,
    alias: match.alias,
    anchor: match.anchor,
    label,
    labelStart: start + labelIndexInMatch + Math.max(labelTrimOffset, 0),
    nextIndex: match.end,
  };
}

function readMarkdownLink(
  line: string,
  start: number,
): { text: string; href: string; nextIndex: number } | null {
  const match = readMarkdownLinkAt(line, start);
  if (!match || match.image) return null;

  return {
    text: match.label,
    href: match.href,
    nextIndex: match.end,
  };
}

function readMarkdownImage(line: string, start: number): { alt: string; nextIndex: number } | null {
  const match = readMarkdownLinkAt(line, start);
  if (!match?.image) return null;
  return {
    alt: match.label,
    nextIndex: match.end,
  };
}

function charAt(text: string, index: number): string | undefined {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function charBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const lowIndex = index - 1;
  const unit = text.charCodeAt(lowIndex);
  const isTrailSurrogate = unit >= 0xdc00 && unit <= 0xdfff;
  return charAt(text, isTrailSurrogate && lowIndex > 0 ? lowIndex - 1 : lowIndex);
}

function isUnspacedScriptChar(char: string | undefined): boolean {
  return char !== undefined && UNSPACED_SCRIPT_CHAR_RE.test(char);
}

type WordBoundaryLookup = (index: number) => boolean;

function createWordBoundaryLookup(text: string): WordBoundaryLookup {
  let boundaries: Set<number> | null = null;
  return (index) => {
    if (!boundaries) {
      boundaries = new Set([text.length]);
      for (const segment of WORD_SEGMENTER.segment(text)) boundaries.add(segment.index);
    }
    return boundaries.has(index);
  };
}

function isMatchBoundary(
  outside: string | undefined,
  inside: string | undefined,
  index: number,
  isWordBoundary: WordBoundaryLookup,
): boolean {
  if (outside === undefined || !WORD_CHAR_RE.test(outside)) return true;
  if (!isUnspacedScriptChar(outside) && !isUnspacedScriptChar(inside)) return false;
  return isWordBoundary(index);
}

function hasWholeWordBoundaries(
  text: string,
  start: number,
  end: number,
  isWordBoundary: WordBoundaryLookup,
): boolean {
  return (
    isMatchBoundary(charBefore(text, start), charAt(text, start), start, isWordBoundary) &&
    isMatchBoundary(charAt(text, end), charBefore(text, end), end, isWordBoundary)
  );
}

function prepareSearchLabels(identity: PageIdentity): SearchLabel[] {
  const labels: SearchLabel[] = [];
  const seen = new Set<string>();

  for (const label of identity.matchLabels) {
    const trimmed = label.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push({
      raw: trimmed,
      pattern: new RegExp(trimmed.replace(REGEXP_SYNTAX_CHAR_RE, '\\$&'), 'giu'),
    });
  }

  return labels.sort((left, right) => {
    if (right.raw.length !== left.raw.length) return right.raw.length - left.raw.length;
    return left.raw.localeCompare(right.raw);
  });
}

function findSegmentMatches(text: string, labels: readonly SearchLabel[]): SegmentMatch[] {
  const candidates: SegmentMatch[] = [];
  const isWordBoundary = createWordBoundaryLookup(text);

  for (const label of labels) {
    const { pattern } = label;
    pattern.lastIndex = 0;
    for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
      const start = found.index;
      const end = start + found[0].length;
      if (hasWholeWordBoundaries(text, start, end, isWordBoundary)) {
        candidates.push({ start, end });
      }
      pattern.lastIndex = start + (charAt(text, start)?.length ?? 1);
    }
  }

  candidates.sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start;
    const leftLength = left.end - left.start;
    const rightLength = right.end - right.start;
    if (rightLength !== leftLength) return rightLength - leftLength;
    return left.end - right.end;
  });

  const matches: SegmentMatch[] = [];
  let lastAccepted: SegmentMatch | null = null;
  for (const candidate of candidates) {
    if (lastAccepted && candidate.start < lastAccepted.end) continue;
    matches.push(candidate);
    lastAccepted = candidate;
  }

  return matches;
}

function contiguousOffsets(start: number, text: string): number[] {
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    offsets.push(start + index);
  }
  return offsets;
}

function scanLineForMentions(
  line: string,
  lineStartOffset: number,
  sourceDocName: string,
  targetDocName: string,
  labels: readonly SearchLabel[],
  lookup: WikiLinkLookupIndex,
): Array<{ excerpt: string; offset: number }> {
  let flatText = '';
  const plainSegments: PlainSegment[] = [];
  let plainBuffer = '';
  let plainOffsets: number[] = [];

  function flushPlainBuffer(): void {
    if (!plainBuffer) return;
    plainSegments.push({
      flatStart: flatText.length,
      text: plainBuffer,
      sourceOffsets: plainOffsets,
    });
    flatText += plainBuffer;
    plainBuffer = '';
    plainOffsets = [];
  }

  function appendPlainChar(char: string, offset: number): void {
    plainBuffer += char;
    plainOffsets.push(offset);
  }

  function appendNonMatchableText(text: string): void {
    flushPlainBuffer();
    flatText += text;
  }

  function appendMatchableText(text: string, sourceOffsets: number[]): void {
    flushPlainBuffer();
    if (!text) return;
    plainSegments.push({
      flatStart: flatText.length,
      text,
      sourceOffsets,
    });
    flatText += text;
  }

  let index = leadingMarkdownPrefixLength(line);
  while (index < line.length) {
    if (line[index] === '\\' && index + 1 < line.length) {
      appendPlainChar(line[index + 1] ?? '', lineStartOffset + index + 1);
      index += 2;
      continue;
    }

    if (line[index] === '`') {
      const inlineCode = readInlineCode(line, index);
      if (inlineCode) {
        appendNonMatchableText(inlineCode.text);
        index = inlineCode.nextIndex;
        continue;
      }
    }

    if (line[index] === '<') {
      const tag = readHtmlTag(line, index);
      if (tag) {
        appendNonMatchableText(tag.text);
        index = tag.nextIndex;
        continue;
      }
    }

    if (line[index] === '!' && line[index + 1] === '[') {
      const image = readMarkdownImage(line, index);
      if (image) {
        appendNonMatchableText(image.alt);
        index = image.nextIndex;
        continue;
      }
    }

    if (line[index] === '[' && line[index + 1] === '[') {
      const wikiLink = readWikiLink(line, index);
      if (wikiLink) {
        const label = wikiLink.label;
        if (
          resolveWikiLinkTargetDocName(
            resolveSkillBundleWikiTarget(wikiLink.target, sourceDocName) ?? wikiLink.target,
            lookup,
          ) === targetDocName
        ) {
          appendNonMatchableText(label);
        } else {
          appendMatchableText(
            label,
            contiguousOffsets(lineStartOffset + wikiLink.labelStart, label),
          );
        }
        index = wikiLink.nextIndex;
        continue;
      }
    }

    if (line[index] === '[' && line[index - 1] !== '!') {
      const markdownLink = readMarkdownLink(line, index);
      if (markdownLink) {
        if (resolveInternalHref(markdownLink.href, sourceDocName)?.docName === targetDocName) {
          appendNonMatchableText(markdownLink.text);
        } else {
          appendMatchableText(
            markdownLink.text,
            contiguousOffsets(lineStartOffset + index + 1, markdownLink.text),
          );
        }
        index = markdownLink.nextIndex;
        continue;
      }
    }

    appendPlainChar(line[index] ?? '', lineStartOffset + index);
    index += 1;
  }

  flushPlainBuffer();

  const mentions: Array<{ excerpt: string; offset: number }> = [];
  for (const segment of plainSegments) {
    const matches = findSegmentMatches(segment.text, labels);
    for (const match of matches) {
      const flatStart = segment.flatStart + match.start;
      const flatEnd = segment.flatStart + match.end;
      const excerpt =
        snippetAround(flatText, flatStart, flatEnd) ?? segment.text.slice(match.start, match.end);
      const offset = segment.sourceOffsets[match.start];
      if (typeof offset !== 'number') continue;
      mentions.push({ excerpt, offset });
    }
  }

  return mentions;
}

function scanMarkdownForMentions(
  markdown: string,
  sourceDocName: string,
  targetDocName: string,
  labels: readonly SearchLabel[],
  lookup: WikiLinkLookupIndex,
): Array<{ excerpt: string; offset: number }> {
  const { frontmatter, body } = stripFrontmatter(markdown);
  const bodyStartOffset = frontmatter.length;
  const mentions: Array<{ excerpt: string; offset: number }> = [];

  let fence: FenceState | null = null;
  let lineStart = 0;
  let index = 0;
  while (index <= body.length) {
    const char = body[index];
    const isLineBreak = index === body.length || char === '\n' || char === '\r';
    if (!isLineBreak) {
      index += 1;
      continue;
    }

    const line = body.slice(lineStart, index);
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
    } else {
      const nextFence = matchFence(line);
      if (nextFence) {
        fence = nextFence;
      } else {
        mentions.push(
          ...scanLineForMentions(
            line,
            bodyStartOffset + lineStart,
            sourceDocName,
            targetDocName,
            labels,
            lookup,
          ),
        );
      }
    }

    if (index === body.length) break;

    if (char === '\r' && body[index + 1] === '\n') {
      index += 2;
      lineStart = index;
      continue;
    }

    index += 1;
    lineStart = index;
  }

  return mentions;
}

function serializeLiveDocument(document: Document): string {
  return document.getText('source').toString();
}

async function readDocumentMarkdown(
  hocuspocus: Pick<Hocuspocus, 'documents'>,
  docName: string,
  entry: FileIndexEntry,
): Promise<string> {
  const liveDocument = hocuspocus.documents.get(docName);
  if (liveDocument) {
    try {
      return serializeLiveDocument(liveDocument);
    } catch (error) {
      log.warn(
        { docName, err: error },
        '[suggest-links] Failed live serialization, falling back to live source text',
      );
      return liveDocument.getText('source').toString();
    }
  }

  return await readFile(entry.canonicalPath, 'utf-8');
}

function toPublicTarget(identity: PageIdentity): SuggestLinksTarget {
  return {
    docName: identity.docName,
    title: identity.title,
    aliases: identity.aliases,
  };
}

export async function suggestLinks(options: SuggestLinksOptions): Promise<SuggestLinksResult> {
  const {
    hocuspocus,
    fileIndex,
    docName,
    scanBudgetMs = 500,
    now = () => Date.now(),
    onComplete,
  } = options;

  const startTime = now();
  const targetEntry = fileIndex.get(docName);
  if (!targetEntry) {
    throw new SuggestLinksTargetNotFoundError(docName);
  }

  const targetMarkdown = await readDocumentMarkdown(hocuspocus, docName, targetEntry);
  const targetIdentity = extractPageIdentity(targetMarkdown, docName);
  const searchLabels = prepareSearchLabels(targetIdentity);
  const candidateDocNames = [...fileIndex.keys()]
    .filter((candidateDocName) => candidateDocName !== docName)
    .sort((left, right) => left.localeCompare(right));

  const lookup = buildProjectWikiLinkLookup(fileIndex.keys());
  const mentionsBySource = new Map<string, SuggestLinksMention[]>();
  let truncated = false;

  for (const sourceDocName of candidateDocNames) {
    if (now() - startTime > scanBudgetMs) {
      truncated = true;
      break;
    }

    const entry = fileIndex.get(sourceDocName);
    if (!entry) continue;

    let markdown: string;
    try {
      markdown = await readDocumentMarkdown(hocuspocus, sourceDocName, entry);
    } catch (error) {
      log.warn({ docName: sourceDocName, err: error }, '[suggest-links] Failed to read source doc');
      continue;
    }

    const sourceMentions = scanMarkdownForMentions(
      markdown,
      sourceDocName,
      docName,
      searchLabels,
      lookup,
    ).map((mention) => ({
      source: sourceDocName,
      excerpt: mention.excerpt,
      offset: mention.offset,
    }));

    if (sourceMentions.length > 0) {
      mentionsBySource.set(sourceDocName, sourceMentions);
    }
  }

  const orderedMentions = [...mentionsBySource.entries()]
    .sort(([leftSource, leftMentions], [rightSource, rightMentions]) => {
      if (rightMentions.length !== leftMentions.length) {
        return rightMentions.length - leftMentions.length;
      }
      if (leftSource !== rightSource) return leftSource.localeCompare(rightSource);
      const leftFirstOffset = leftMentions[0]?.offset ?? Number.MAX_SAFE_INTEGER;
      const rightFirstOffset = rightMentions[0]?.offset ?? Number.MAX_SAFE_INTEGER;
      return leftFirstOffset - rightFirstOffset;
    })
    .flatMap(([, sourceMentions]) => sourceMentions);

  const durationMs = now() - startTime;
  const observation = {
    durationMs,
    corpusDocCount: candidateDocNames.length,
    candidateCount: orderedMentions.length,
    truncated,
  };

  log.info(
    {
      docName,
      durationMs,
      corpusDocCount: candidateDocNames.length,
      candidateCount: orderedMentions.length,
      truncated,
      labelCount: searchLabels.length,
      normalizedTarget: toWikiLinkSlug(targetIdentity.title),
    },
    '[suggest-links] scan completed',
  );
  onComplete?.(observation);

  return {
    target: toPublicTarget(targetIdentity),
    mentions: orderedMentions,
    truncated,
  };
}
