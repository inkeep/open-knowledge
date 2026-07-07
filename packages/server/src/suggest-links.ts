import { readFile } from 'node:fs/promises';
import type { Document, Hocuspocus } from '@hocuspocus/server';
import { resolveInternalHref, stripFrontmatter, toWikiLinkSlug } from '@inkeep/open-knowledge-core';
import type { FileIndexEntry } from './file-watcher.ts';
import { getLogger } from './logger.ts';
import { extractPageIdentity, type PageIdentity } from './page-identity.ts';

const log = getLogger('suggest-links');

const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

// Line-oriented variants: excludes \n since lines are pre-split.
const WIKI_LINK_RE = /\[\[([^\n#[\]|]+)(?:#([^\n[\]|]+))?(?:\|([^\n[\]]+))?\]\]/y;
const MD_LINK_RE =
  /\[([^\]\n]*)\]\((<[^>\n]+>|[^)\s\n]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\)/y;
const MD_IMAGE_RE =
  /!\[([^\]\n]*)\]\((<[^>\n]+>|[^)\s\n]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\)/y;

interface FenceState {
  char: '`' | '~';
  length: number;
}

interface SearchLabel {
  raw: string;
  lower: string;
  length: number;
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

  // Unmatched opening run — see backlink-index.ts readInlineCode for the
  // CommonMark §6.1 rationale. Skip past the full run to avoid O(N²) re-scans
  // on long unclosed backtick runs (DoS bound).
  return { text: line.slice(start, openEnd), nextIndex: openEnd };
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
  WIKI_LINK_RE.lastIndex = start;
  const match = WIKI_LINK_RE.exec(line);
  if (!match) return null;

  const targetRaw = match[1] ?? '';
  const target = targetRaw.trim();
  const anchor = match[2]?.trim() || null;
  const aliasRaw = match[3] ?? null;
  const alias = aliasRaw?.trim() || null;
  if (!target) return null;

  const label = alias ?? target;
  const rawLabel = alias ? aliasRaw : targetRaw;
  const labelIndexInMatch = alias ? match[0].lastIndexOf(aliasRaw ?? '') : 2;
  const labelTrimOffset = rawLabel?.indexOf(label) ?? 0;

  return {
    target,
    alias,
    anchor,
    label,
    labelStart: start + labelIndexInMatch + Math.max(labelTrimOffset, 0),
    nextIndex: start + match[0].length,
  };
}

function normalizeMarkdownHref(rawHref: string): string {
  return rawHref.startsWith('<') && rawHref.endsWith('>') ? rawHref.slice(1, -1) : rawHref;
}

function readMarkdownLink(
  line: string,
  start: number,
): { text: string; href: string; nextIndex: number } | null {
  MD_LINK_RE.lastIndex = start;
  const match = MD_LINK_RE.exec(line);
  if (!match) return null;

  return {
    text: match[1] ?? '',
    href: normalizeMarkdownHref(match[2] ?? ''),
    nextIndex: start + match[0].length,
  };
}

function readMarkdownImage(line: string, start: number): { alt: string; nextIndex: number } | null {
  MD_IMAGE_RE.lastIndex = start;
  const match = MD_IMAGE_RE.exec(line);
  if (!match) return null;
  return {
    alt: match[1] ?? '',
    nextIndex: start + match[0].length,
  };
}

function isWordBoundaryChar(char: string | undefined): boolean {
  return !char || !WORD_CHAR_RE.test(char);
}

function hasWholeWordBoundaries(text: string, start: number, end: number): boolean {
  return isWordBoundaryChar(text[start - 1]) && isWordBoundaryChar(text[end]);
}

function prepareSearchLabels(identity: PageIdentity): SearchLabel[] {
  const labels: SearchLabel[] = [];
  const seen = new Set<string>();

  for (const label of identity.matchLabels) {
    const trimmed = label.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLocaleLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    labels.push({
      raw: trimmed,
      lower,
      length: trimmed.length,
    });
  }

  return labels.sort((left, right) => {
    if (right.length !== left.length) return right.length - left.length;
    return left.raw.localeCompare(right.raw);
  });
}

function findSegmentMatches(text: string, labels: readonly SearchLabel[]): SegmentMatch[] {
  const lowerText = text.toLocaleLowerCase();
  const candidates: SegmentMatch[] = [];

  for (const label of labels) {
    let startIndex = 0;
    while (startIndex <= lowerText.length - label.length) {
      const foundIndex = lowerText.indexOf(label.lower, startIndex);
      if (foundIndex === -1) break;
      const endIndex = foundIndex + label.length;
      if (hasWholeWordBoundaries(text, foundIndex, endIndex)) {
        candidates.push({ start: foundIndex, end: endIndex });
      }
      startIndex = foundIndex + 1;
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

function wikiLinkResolvesToTarget(target: string, targetDocName: string): boolean {
  const trimmed = target.trim();
  if (!trimmed) return false;
  return trimmed === targetDocName || toWikiLinkSlug(trimmed) === targetDocName;
}

function scanLineForMentions(
  line: string,
  lineStartOffset: number,
  sourceDocName: string,
  targetDocName: string,
  labels: readonly SearchLabel[],
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
        if (wikiLinkResolvesToTarget(wikiLink.target, targetDocName)) {
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
  // Y.Text-is-truth contract (precedent #38): body source is the raw user
  // bytes in `Y.Text('source')`. Reading from serialize(fragment) would
  // emit canonical bytes (e.g., `[https://x](https://x)` instead of the
  // user's typed `<https://x>` autolink form), making suggest-link
  // snippets reflect a form the user never chose.
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
