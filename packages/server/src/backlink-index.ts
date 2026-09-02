import { type Dirent, existsSync, mkdirSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import {
  type BrokenLinkReason,
  buildPagesByBasenameIndex,
  buildPagesBySlugIndex,
  classifyMarkdownHref,
  classifyWikiLinkTarget,
  extractSkillRefs,
  getWikiLinkText,
  isExcalidrawDocFile,
  isExternalHref,
  isOrphanMode,
  type JsxSrcRefTagSpec,
  MANAGED_ARTIFACT_PREFIX_SKILL,
  ORPHAN_MODES,
  type OrphanMode,
  parseGlobalSkillBundleDoc,
  parseProjectSkillBundleDoc,
  resolveAssetProjectPath,
  resolveInternalHref,
  resolveSkillBundleWikiTarget,
  resolveWikiLinkTarget,
  resolveWikiLinkTargetDocName,
  skillLiveDocName,
  stripFrontmatter,
  toWikiLinkSlug,
  type WikiLinkLookupIndex,
} from '@inkeep/open-knowledge-core';
import { isLinkIndexExcludedDoc } from './cc1-broadcast.ts';
import { getLocalDir } from './config/paths.ts';
import type { ContentFilter } from './content-filter.ts';
import { isSupportedDocFile, stripDocExtension } from './doc-extensions.ts';
import { instrumentIndexRebuild } from './index-telemetry.ts';
import {
  createJsxSrcAttrRe,
  readJsxSrcRefTagAt,
  resolveJsxSrcRefTarget,
} from './jsx-src-ref-tags.ts';
import { readMarkdownLinkAt, readWikiLinkAt } from './link-syntax.ts';
import { extractLocalTargetOccurrences } from './local-target-occurrences.ts';
import { getLogger } from './logger.ts';
import { toPosix } from './path-utils.ts';

const log = getLogger('backlinks');

interface InlineWikiLinkOccurrence {
  target: string;
  anchor: string | null;
  start: number;
  end: number;
  rawWikiTarget?: boolean;
}

export interface GraphFileOracle {
  hasFile(contentRootRelativePath: string): boolean;
}

function namesExistingFile(
  href: string,
  sourceDocName: string,
  oracle: GraphFileOracle | undefined,
): boolean {
  if (!oracle) return false;
  if (isSupportedDocFile(href)) return false;
  const filePath = resolveAssetProjectPath(href, sourceDocName, { literal: false });
  return filePath !== null && oracle.hasFile(filePath);
}

interface FenceState {
  char: '`' | '~';
  length: number;
}

export interface ExtractedWikiLink {
  target: string;
  anchor: string | null;
  snippet: string | null;
  sourceForm?: 'wiki' | 'markdown' | 'jsx';
  line?: number;
  column?: number;
  rawWikiTarget?: boolean;
}

interface ExtractedExternalLink {
  url: string;
  label: string | null;
  snippet: string | null;
}

export interface BacklinkEntry {
  source: string;
  anchor: string | null;
  snippet: string | null;
  sourceForm?: 'wiki' | 'markdown' | 'jsx';
  line?: number;
  column?: number;
}

interface DocumentForwardLinkEntry {
  kind: 'doc';
  target: string;
  anchor: string | null;
  snippet: string | null;
}

interface ExternalForwardLinkEntry {
  kind: 'external';
  url: string;
  label: string | null;
  snippet: string | null;
}

type ForwardLinkEntry = DocumentForwardLinkEntry | ExternalForwardLinkEntry;

export interface HubEntry {
  docName: string;
  count: number;
}

interface DeadLinkEntry {
  target: string;
  sources: BacklinkEntry[];
}

interface DocGraphNode {
  kind: 'doc';
  id: string;
  docName: string;
  anchor: string | null;
}

interface ExternalGraphNode {
  kind: 'external';
  id: string;
  url: string;
  label: string | null;
}

export type GraphNode = DocGraphNode | ExternalGraphNode;

export { isOrphanMode, ORPHAN_MODES, type OrphanMode };

interface BackwardLinkMeta {
  anchor: string | null;
  snippet: string | null;
  sourceForm?: 'wiki' | 'markdown' | 'jsx';
  line?: number;
  column?: number;
  rawWikiTarget?: boolean;
}

interface BranchGraphState {
  backward: Map<string, Map<string, BackwardLinkMeta>>;
  forward: Map<string, Set<string>>;
  externalForward: Map<string, Map<string, { label: string | null; snippet: string | null }>>;
  externalBackward: Map<string, Map<string, { label: string | null; snippet: string | null }>>;
  skillRefs: Map<string, Set<string>>;
  epoch: number;
}

const SNAPSHOT_VERSION = 3;

interface SerializedBranchGraphState {
  version?: number;
  backward: Record<string, Array<BacklinkEntry & { rawWikiTarget?: boolean }>>;
  forward: Record<string, string[]>;
  externalForward: Record<
    string,
    Array<{ url: string; label: string | null; snippet: string | null }>
  >;
  skillRefs?: Record<string, string[]>;
  mtimes?: Record<string, number>;
}

interface BacklinkIndexOptions {
  projectDir: string;
  contentDir: string;
  contentFilter?: ContentFilter;
  getFileOracle?: () => GraphFileOracle | undefined;
}

function createEmptyState(): BranchGraphState {
  return {
    backward: new Map(),
    forward: new Map(),
    externalForward: new Map(),
    externalBackward: new Map(),
    skillRefs: new Map(),
    epoch: 0,
  };
}

function isUndecidedTarget(state: BranchGraphState, target: string): boolean {
  const sources = state.backward.get(target);
  if (!sources || sources.size === 0) return false;
  for (const meta of sources.values()) {
    if (meta.rawWikiTarget !== true) return false;
  }
  return true;
}

export function parseSkillBundleDocAnyScope(
  docName: string,
): { name: string; kind: 'skill' | 'reference'; skillDocName: string } | null {
  const project = parseProjectSkillBundleDoc(docName);
  if (project) {
    const skillDocName =
      project.kind === 'skill' ? docName : `${docName.split('/references/')[0]}/SKILL`;
    return {
      name: project.name,
      kind: project.kind,
      skillDocName,
    };
  }
  const global = parseGlobalSkillBundleDoc(docName);
  if (global) {
    return {
      name: global.name,
      kind: global.kind,
      skillDocName: skillLiveDocName('global', global.name),
    };
  }
  return null;
}

function mergeLinkMeta(
  existing: BackwardLinkMeta | undefined,
  next: BackwardLinkMeta,
): BackwardLinkMeta {
  if (!existing) return next;
  const positioned = existing.line !== undefined ? existing : next;
  return {
    anchor: existing.anchor ?? next.anchor,
    snippet: existing.snippet ?? next.snippet,
    sourceForm: existing.sourceForm ?? next.sourceForm,
    line: positioned.line,
    column: positioned.column,
    rawWikiTarget: existing.rawWikiTarget === true && next.rawWikiTarget === true,
  };
}

function getRepresentativeAnchor(
  sources: Map<string, BackwardLinkMeta> | undefined,
): string | null {
  if (!sources) return null;
  for (const [, meta] of [...sources.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (meta.anchor) return meta.anchor;
  }
  return null;
}

function externalNodeId(url: string): string {
  return `external:${url}`;
}

function externalUrlFromNodeId(id: string): string | null {
  return id.startsWith('external:') ? id.slice('external:'.length) : null;
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
  return new RegExp(`^\\s{0,3}\\${fence.char}{${fence.length},}\\s*$`).test(line);
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

  let i = openEnd;
  while (i < line.length) {
    if (line[i] !== '`') {
      i++;
      continue;
    }
    let closeLen = 0;
    while (line[i + closeLen] === '`') closeLen++;
    if (closeLen === runLength) {
      return { text: line.slice(openEnd, i), nextIndex: i + runLength };
    }
    i += closeLen;
  }
  return { text: line.slice(start, openEnd), nextIndex: openEnd };
}

function readWikiLink(
  line: string,
  start: number,
): { target: string; alias: string | null; anchor: string | null; nextIndex: number } | null {
  const match = readWikiLinkAt(line, start);
  if (!match) return null;
  return {
    target: match.target,
    alias: match.alias,
    anchor: match.anchor,
    nextIndex: match.end,
  };
}

function extractWikiLinksFromLine(
  line: string,
  sourceDocName: string,
): {
  text: string;
  occurrences: InlineWikiLinkOccurrence[];
} {
  let flatText = '';
  const occurrences: InlineWikiLinkOccurrence[] = [];
  let idx = leadingMarkdownPrefixLength(line);

  while (idx < line.length) {
    if (line[idx] === '\\' && idx + 1 < line.length) {
      flatText += line[idx + 1];
      idx += 2;
      continue;
    }

    if (line[idx] === '`') {
      const inlineCode = readInlineCode(line, idx);
      if (inlineCode) {
        flatText += inlineCode.text;
        idx = inlineCode.nextIndex;
        continue;
      }
    }

    if (line[idx] === '[' && line[idx + 1] === '[') {
      const wikiLink = readWikiLink(line, idx);
      if (wikiLink) {
        const label = getWikiLinkText(wikiLink);
        const start = flatText.length;
        flatText += label;
        const classified = classifyWikiLinkTarget(wikiLink.target, wikiLink.anchor);
        if (classified?.kind === 'doc') {
          const target =
            resolveSkillBundleWikiTarget(wikiLink.target, sourceDocName) ?? classified.docName;
          occurrences.push({
            target,
            anchor: classified.anchor,
            start,
            end: start + label.length,
          });
        } else if (classified?.kind === 'asset') {
          occurrences.push({
            target: classified.url,
            anchor: wikiLink.anchor?.trim() || null,
            start,
            end: start + label.length,
            rawWikiTarget: true,
          });
        }
        idx = wikiLink.nextIndex;
        continue;
      }
    }

    flatText += line[idx];
    idx++;
  }

  return { text: flatText, occurrences };
}

function extractExternalWikiLinksFromLine(line: string): {
  text: string;
  occurrences: Array<{ url: string; label: string | null; start: number; end: number }>;
} {
  let flatText = '';
  const occurrences: Array<{ url: string; label: string | null; start: number; end: number }> = [];
  let idx = leadingMarkdownPrefixLength(line);

  while (idx < line.length) {
    if (line[idx] === '\\' && idx + 1 < line.length) {
      flatText += line[idx + 1];
      idx += 2;
      continue;
    }

    if (line[idx] === '`') {
      const inlineCode = readInlineCode(line, idx);
      if (inlineCode) {
        flatText += inlineCode.text;
        idx = inlineCode.nextIndex;
        continue;
      }
    }

    if (line[idx] === '[' && line[idx + 1] === '[') {
      const wikiLink = readWikiLink(line, idx);
      if (wikiLink) {
        const label = getWikiLinkText(wikiLink);
        const start = flatText.length;
        flatText += label;
        const classified = classifyWikiLinkTarget(wikiLink.target, wikiLink.anchor);
        if (classified?.kind === 'external') {
          occurrences.push({
            url: classified.url,
            label,
            start,
            end: start + label.length,
          });
        }
        idx = wikiLink.nextIndex;
        continue;
      }
    }

    flatText += line[idx];
    idx++;
  }

  return { text: flatText, occurrences };
}

export function resolveMarkdownHref(href: string, sourceDocName: string): string | null {
  return resolveInternalHref(href, sourceDocName)?.docName ?? null;
}

function readMarkdownLink(
  line: string,
  start: number,
): { text: string; href: string; nextIndex: number } | null {
  const match = readMarkdownLinkAt(line, start);
  if (!match) return null;
  return {
    text: match.label,
    href: match.href,
    nextIndex: match.end,
  };
}

function extractMarkdownLinksFromLine(
  line: string,
  sourceDocName: string,
  fileOracle?: GraphFileOracle,
): { text: string; occurrences: InlineWikiLinkOccurrence[] } {
  let flatText = '';
  const occurrences: InlineWikiLinkOccurrence[] = [];
  let idx = leadingMarkdownPrefixLength(line);

  while (idx < line.length) {
    if (line[idx] === '\\' && idx + 1 < line.length) {
      flatText += line[idx + 1];
      idx += 2;
      continue;
    }

    if (line[idx] === '`') {
      const inlineCode = readInlineCode(line, idx);
      if (inlineCode) {
        flatText += inlineCode.text;
        idx = inlineCode.nextIndex;
        continue;
      }
    }

    if (line[idx] === '[' && line[idx + 1] === '[') {
      const wikiLink = readWikiLink(line, idx);
      if (wikiLink) {
        flatText += getWikiLinkText(wikiLink);
        idx = wikiLink.nextIndex;
        continue;
      }
    }

    if (line[idx] === '[' && line[idx - 1] !== '!') {
      const mdLink = readMarkdownLink(line, idx);
      if (mdLink) {
        const classified = classifyMarkdownHref(mdLink.href, sourceDocName);
        if (
          classified?.kind === 'doc' &&
          !namesExistingFile(mdLink.href, sourceDocName, fileOracle)
        ) {
          const start = flatText.length;
          flatText += mdLink.text;
          occurrences.push({
            target: classified.docName,
            anchor: classified.anchor,
            start,
            end: start + mdLink.text.length,
          });
        } else {
          flatText += mdLink.text;
        }
        idx = mdLink.nextIndex;
        continue;
      }
    }

    flatText += line[idx];
    idx++;
  }

  return { text: flatText, occurrences };
}

function extractExternalMarkdownLinksFromLine(
  line: string,
  sourceDocName: string,
): {
  text: string;
  occurrences: Array<{ url: string; label: string | null; start: number; end: number }>;
} {
  let flatText = '';
  const occurrences: Array<{ url: string; label: string | null; start: number; end: number }> = [];
  let idx = leadingMarkdownPrefixLength(line);

  while (idx < line.length) {
    if (line[idx] === '\\' && idx + 1 < line.length) {
      flatText += line[idx + 1];
      idx += 2;
      continue;
    }

    if (line[idx] === '`') {
      const inlineCode = readInlineCode(line, idx);
      if (inlineCode) {
        flatText += inlineCode.text;
        idx = inlineCode.nextIndex;
        continue;
      }
    }

    if (line[idx] === '[' && line[idx + 1] === '[') {
      const wikiLink = readWikiLink(line, idx);
      if (wikiLink) {
        flatText += getWikiLinkText(wikiLink);
        idx = wikiLink.nextIndex;
        continue;
      }
    }

    if (line[idx] === '[' && line[idx - 1] !== '!') {
      const mdLink = readMarkdownLink(line, idx);
      if (mdLink) {
        const classified = classifyMarkdownHref(mdLink.href, sourceDocName);
        flatText += mdLink.text;
        if (classified?.kind === 'external') {
          const start = flatText.length - mdLink.text.length;
          occurrences.push({
            url: classified.url,
            label: mdLink.text || null,
            start,
            end: start + mdLink.text.length,
          });
        }
        idx = mdLink.nextIndex;
        continue;
      }
    }

    flatText += line[idx];
    idx++;
  }

  return { text: flatText, occurrences };
}

export function extractJsxSrcRefsFromMarkdown(
  markdown: string,
  sourceDocName: string,
  lineOffset = 0,
): ExtractedWikiLink[] {
  const source = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = source.split('\n');
  const links: ExtractedWikiLink[] = [];
  let fence: FenceState | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? '';
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }
    const nextFence = matchFence(line);
    if (nextFence) {
      fence = nextFence;
      continue;
    }
    let idx = 0;
    while (idx < line.length) {
      if (line[idx] === '\\' && idx + 1 < line.length) {
        idx += 2;
        continue;
      }
      if (line[idx] === '`') {
        const inlineCode = readInlineCode(line, idx);
        if (inlineCode) {
          idx = inlineCode.nextIndex;
          continue;
        }
      }
      if (line[idx] === '<') {
        const tag = readJsxSrcRefTagAt(line, idx);
        if (tag) {
          for (const attrMatch of tag.attrs.matchAll(createJsxSrcAttrRe(tag.spec.attrName))) {
            const value = attrMatch[3] ?? '';
            if (isExternalHref(value)) continue;
            const target = resolveJsxSrcRefTarget(tag.spec, value, sourceDocName);
            if (target === null) continue;
            links.push({
              target,
              anchor: null,
              snippet: line.slice(idx, idx + tag.matchLength),
              line: lineOffset + lineIndex,
              column: idx,
            });
          }
          idx += tag.matchLength;
          continue;
        }
      }
      idx++;
    }
  }
  return links;
}

function frontmatterLineCount(frontmatter: string): number {
  if (!frontmatter) return 0;
  const normalized = frontmatter.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  let count = 0;
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] === '\n') count++;
  }
  return count;
}

export function extractMarkdownLinksFromMarkdown(
  markdown: string,
  sourceDocName: string,
  lineOffset = 0,
  fileOracle?: GraphFileOracle,
): ExtractedWikiLink[] {
  const source = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = source.split('\n');
  const links: ExtractedWikiLink[] = [];
  let fence: FenceState | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? '';

    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
    } else {
      const nextFence = matchFence(line);
      if (nextFence) {
        fence = nextFence;
      } else {
        const extracted = extractMarkdownLinksFromLine(line, sourceDocName, fileOracle);
        links.push(
          ...extracted.occurrences.map(({ target, anchor, start, end }) => ({
            target,
            anchor,
            snippet: snippetAround(extracted.text, start, end),
            line: lineOffset + lineIndex,
            column: start,
          })),
        );
      }
    }
  }

  links.push(...extractReferenceLinksFromMarkdown(source, sourceDocName, lineOffset, fileOracle));

  return links;
}

const HAS_REFERENCE_DEFINITION = /^ {0,3}\[(?:\\.|[^\\\]])*\]:/m;

function extractReferenceLinksFromMarkdown(
  source: string,
  sourceDocName: string,
  lineOffset: number,
  fileOracle: GraphFileOracle | undefined,
): ExtractedWikiLink[] {
  if (!HAS_REFERENCE_DEFINITION.test(source)) return [];

  const links: ExtractedWikiLink[] = [];
  for (const occurrence of extractLocalTargetOccurrences(source)) {
    if (occurrence.sourceForm !== 'markdown-reference' || occurrence.role !== 'link') continue;
    const classified = classifyMarkdownHref(occurrence.href, sourceDocName);
    if (classified?.kind !== 'doc') continue;
    if (namesExistingFile(occurrence.href, sourceDocName, fileOracle)) continue;
    links.push({
      target: classified.docName,
      anchor: classified.anchor,
      snippet: source.slice(occurrence.range.start, occurrence.range.end) || null,
      line: lineOffset + occurrence.line,
      column: occurrence.column,
    });
  }
  return links;
}

export function extractWikiLinksFromMarkdown(
  markdown: string,
  sourceDocName = '',
  lineOffset = 0,
): ExtractedWikiLink[] {
  const source = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = source.split('\n');
  const links: ExtractedWikiLink[] = [];
  let fence: FenceState | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? '';

    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
    } else {
      const nextFence = matchFence(line);
      if (nextFence) {
        fence = nextFence;
      } else {
        const extracted = extractWikiLinksFromLine(line, sourceDocName);
        links.push(
          ...extracted.occurrences.map(({ target, anchor, start, end, rawWikiTarget }) => ({
            rawWikiTarget,
            target,
            anchor,
            snippet: snippetAround(extracted.text, start, end),
            line: lineOffset + lineIndex,
            column: start,
          })),
        );
      }
    }
  }

  return links;
}

function extractExternalWikiLinksFromMarkdown(markdown: string): ExtractedExternalLink[] {
  const source = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = source.split('\n');
  const links: ExtractedExternalLink[] = [];
  let fence: FenceState | null = null;

  for (const line of lines) {
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
    } else {
      const nextFence = matchFence(line);
      if (nextFence) {
        fence = nextFence;
      } else {
        const extracted = extractExternalWikiLinksFromLine(line);
        links.push(
          ...extracted.occurrences.map(({ url, label, start, end }) => ({
            url,
            label,
            snippet: snippetAround(extracted.text, start, end),
          })),
        );
      }
    }
  }

  return links;
}

function extractExternalMarkdownLinksFromMarkdown(
  markdown: string,
  sourceDocName: string,
): ExtractedExternalLink[] {
  const source = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = source.split('\n');
  const links: ExtractedExternalLink[] = [];
  let fence: FenceState | null = null;

  for (const line of lines) {
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
    } else {
      const nextFence = matchFence(line);
      if (nextFence) {
        fence = nextFence;
      } else {
        const extracted = extractExternalMarkdownLinksFromLine(line, sourceDocName);
        links.push(
          ...extracted.occurrences.map(({ url, label, start, end }) => ({
            url,
            label,
            snippet: snippetAround(extracted.text, start, end),
          })),
        );
      }
    }
  }

  return links;
}

export interface BrokenOutboundLink {
  href: string;
  resolvedTo: string | null;
  reason: BrokenLinkReason;
  sourceForm?: 'jsx';
}

export function computeBrokenOutboundLinks(
  markdown: string,
  sourceDocName: string,
  admittedDocs: Iterable<string>,
  fileExists?: (contentRootRelativePath: string) => boolean,
  folderExists?: (folderPath: string) => boolean,
): BrokenOutboundLink[] {
  const admitted = admittedDocs instanceof Set ? admittedDocs : new Set(admittedDocs);

  let body: string;
  try {
    ({ body } = stripFrontmatter(markdown));
  } catch {
    body = markdown;
  }

  const source = body.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = source.split('\n');
  const broken: BrokenOutboundLink[] = [];
  const seen = new Set<string>();
  let fence: FenceState | null = null;

  const record = (
    href: string,
    resolvedTo: string | null,
    reason: BrokenLinkReason,
    sourceForm?: 'jsx',
  ): void => {
    const key = `${sourceForm ?? 'md'}\0${href}`;
    if (seen.has(key)) return;
    seen.add(key);
    broken.push({
      href,
      resolvedTo,
      reason,
      ...(sourceForm ? { sourceForm } : {}),
    });
  };

  const recordMarkdownLink = (rawHref: string): void => {
    const trimmed = rawHref.trim();
    if (trimmed.startsWith('#')) return;
    const classified = classifyMarkdownHref(trimmed, sourceDocName);
    if (!classified) {
      record(trimmed, null, 'unresolvable');
      return;
    }
    if (classified.kind === 'doc') {
      if (!admitted.has(classified.docName) && folderExists?.(classified.docName) !== true) {
        record(trimmed, classified.docName, 'no-such-doc');
      }
      return;
    }
    if (classified.kind === 'asset') {
      if (!fileExists) return;
      const filePath = resolveAssetProjectPath(classified.url, sourceDocName, {
        literal: classified.literal,
      });
      if (filePath === null) {
        record(trimmed, null, 'unresolvable');
        return;
      }
      if (!fileExists(filePath)) {
        record(trimmed, filePath, 'no-such-file');
      }
      return;
    }
  };

  const recordJsxSrcRef = (spec: JsxSrcRefTagSpec, value: string): void => {
    if (value === '') return;
    if (isExternalHref(value)) {
      record(value, null, 'unresolvable', 'jsx');
      return;
    }
    const resolved = resolveJsxSrcRefTarget(spec, value, sourceDocName);
    if (resolved === null) {
      record(value, null, 'unresolvable', 'jsx');
      return;
    }
    if (isExcalidrawDocFile(resolved)) {
      if (!fileExists) return;
      if (!fileExists(resolved)) record(value, resolved, 'no-such-file', 'jsx');
      return;
    }
    if (!admitted.has(resolved) && folderExists?.(resolved) !== true) {
      record(value, resolved, 'no-such-doc', 'jsx');
    }
  };

  let pagesBySlug: ReadonlyMap<string, string> | undefined;
  let pagesByBasename: ReadonlyMap<string, string> | undefined;
  const wikiLookup: WikiLinkLookupIndex = {
    pages: admitted,
    get pagesBySlug() {
      pagesBySlug ??= buildPagesBySlugIndex(admitted, toWikiLinkSlug);
      return pagesBySlug;
    },
    get pagesByBasename() {
      pagesByBasename ??= buildPagesByBasenameIndex(admitted, toWikiLinkSlug);
      return pagesByBasename;
    },
  };

  const recordWikiLink = (target: string, anchor: string | null): void => {
    const resolved = resolveWikiLinkTarget(target, anchor, wikiLookup);
    if (!resolved || resolved.kind !== 'doc') return;
    if (
      resolveWikiLinkTargetDocName(resolved.docName, wikiLookup) === undefined &&
      folderExists?.(resolved.docName) !== true
    ) {
      record(`[[${target}${anchor ? `#${anchor}` : ''}]]`, resolved.docName, 'no-such-doc');
    }
  };

  for (const line of lines) {
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }
    const nextFence = matchFence(line);
    if (nextFence) {
      fence = nextFence;
      continue;
    }

    let idx = leadingMarkdownPrefixLength(line);
    while (idx < line.length) {
      if (line[idx] === '\\' && idx + 1 < line.length) {
        idx += 2;
        continue;
      }
      if (line[idx] === '`') {
        const inlineCode = readInlineCode(line, idx);
        if (inlineCode) {
          idx = inlineCode.nextIndex;
          continue;
        }
      }
      if (line[idx] === '<') {
        const tag = readJsxSrcRefTagAt(line, idx);
        if (tag) {
          for (const attrMatch of tag.attrs.matchAll(createJsxSrcAttrRe(tag.spec.attrName))) {
            recordJsxSrcRef(tag.spec, attrMatch[3] ?? '');
          }
          idx += tag.matchLength;
          continue;
        }
      }
      if (line[idx] === '[' && line[idx + 1] === '[') {
        const wikiLink = readWikiLink(line, idx);
        if (wikiLink) {
          recordWikiLink(wikiLink.target, wikiLink.anchor);
          idx = wikiLink.nextIndex;
          continue;
        }
      }
      if (line[idx] === '[' && line[idx - 1] !== '!') {
        const mdLink = readMarkdownLink(line, idx);
        if (mdLink) {
          recordMarkdownLink(mdLink.href);
          idx = mdLink.nextIndex;
          continue;
        }
      }
      idx++;
    }
  }

  return broken;
}

function serializeState(state: BranchGraphState): SerializedBranchGraphState {
  return {
    backward: Object.fromEntries(
      [...state.backward.entries()].map(([target, sources]) => [
        target,
        [...sources.entries()].map(([source, meta]) => ({
          source,
          anchor: meta.anchor,
          snippet: meta.snippet,
          sourceForm: meta.sourceForm,
          line: meta.line,
          column: meta.column,
          ...(meta.rawWikiTarget === true ? { rawWikiTarget: true as const } : {}),
        })),
      ]),
    ),
    forward: Object.fromEntries(
      [...state.forward.entries()].map(([source, targets]) => [source, [...targets].sort()]),
    ),
    externalForward: Object.fromEntries(
      [...state.externalForward.entries()].map(([source, targets]) => [
        source,
        [...targets.entries()]
          .map(([url, meta]) => ({
            url,
            label: meta.label,
            snippet: meta.snippet,
          }))
          .sort((a, b) => a.url.localeCompare(b.url)),
      ]),
    ),
    skillRefs: Object.fromEntries(
      [...state.skillRefs.entries()].map(([source, names]) => [source, [...names].sort()]),
    ),
  };
}

function buildExternalBackward(
  externalForward: BranchGraphState['externalForward'],
): BranchGraphState['externalBackward'] {
  const externalBackward = new Map<
    string,
    Map<string, { label: string | null; snippet: string | null }>
  >();

  for (const [source, targets] of externalForward) {
    for (const [url, meta] of targets) {
      let sources = externalBackward.get(url);
      if (!sources) {
        sources = new Map();
        externalBackward.set(url, sources);
      }
      sources.set(source, meta);
    }
  }

  return externalBackward;
}

function cachePosition(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function deserializeState(data: SerializedBranchGraphState): BranchGraphState {
  const externalForward = new Map(
    Object.entries(data.externalForward ?? {}).map(([source, targets]) => [
      source,
      new Map(
        targets.map((target) => [
          target.url,
          {
            label: target.label ?? null,
            snippet: target.snippet ?? null,
          },
        ]),
      ),
    ]),
  );

  return {
    backward: new Map(
      Object.entries(data.backward ?? {}).map(([target, entries]) => [
        target,
        new Map(
          entries.map((entry) => [
            entry.source,
            {
              anchor: entry.anchor ?? null,
              snippet: entry.snippet ?? null,
              sourceForm:
                entry.sourceForm === 'wiki' ||
                entry.sourceForm === 'markdown' ||
                entry.sourceForm === 'jsx'
                  ? entry.sourceForm
                  : undefined,
              line: cachePosition(entry.line),
              column: cachePosition(entry.column),
              rawWikiTarget: entry.rawWikiTarget === true,
            },
          ]),
        ),
      ]),
    ),
    forward: new Map(
      Object.entries(data.forward ?? {}).map(([source, targets]) => [source, new Set(targets)]),
    ),
    externalForward,
    externalBackward: buildExternalBackward(externalForward),
    skillRefs: new Map(
      Object.entries(data.skillRefs ?? {}).map(([source, names]) => [source, new Set(names)]),
    ),
    epoch: 0,
  };
}

function deriveFolderPathsFromDocNames(docNames: Iterable<string>): Set<string> {
  const folderPaths = new Set<string>();
  for (const docName of docNames) {
    let slash = docName.indexOf('/');
    while (slash !== -1) {
      folderPaths.add(docName.slice(0, slash));
      slash = docName.indexOf('/', slash + 1);
    }
  }
  return folderPaths;
}

export class BacklinkIndex {
  private readonly projectDir: string;
  private readonly contentDir: string;
  private readonly contentFilter?: ContentFilter;
  private readonly getFileOracle: () => GraphFileOracle | undefined;
  private readonly states = new Map<string, BranchGraphState>();
  private readonly mtimesByBranch = new Map<string, Map<string, number>>();
  private readonly documentLookups = new WeakMap<
    BranchGraphState,
    { epoch: number; lookup: WikiLinkLookupIndex }
  >();
  private activeBranch = 'main';

  constructor(options: BacklinkIndexOptions) {
    this.projectDir = options.projectDir;
    this.contentDir = options.contentDir;
    this.contentFilter = options.contentFilter;
    this.getFileOracle = options.getFileOracle ?? (() => undefined);
    this.states.set(this.activeBranch, createEmptyState());
  }

  private getState(branch = this.activeBranch): BranchGraphState {
    let state = this.states.get(branch);
    if (!state) {
      state = createEmptyState();
      this.states.set(branch, state);
    }
    return state;
  }

  private structuralBundleNeighbors(docName: string, branch = this.activeBranch): Set<string> {
    const parsed = parseSkillBundleDocAnyScope(docName);
    const neighbors = new Set<string>();
    if (!parsed) return neighbors;
    const state = this.getState(branch);
    if (!state.forward.has(docName)) return neighbors;
    if (parsed.kind === 'skill') {
      for (const candidate of state.forward.keys()) {
        const other = parseSkillBundleDocAnyScope(candidate);
        if (other?.kind === 'reference' && other.skillDocName === docName) {
          neighbors.add(candidate);
        }
      }
    } else {
      if (state.forward.has(parsed.skillDocName)) neighbors.add(parsed.skillDocName);
    }
    return neighbors;
  }

  private skillRefNeighbors(docName: string, branch = this.activeBranch): Set<string> {
    const neighbors = new Set<string>();
    const state = this.getState(branch);
    if (!state.forward.has(docName)) return neighbors;
    const parsed = parseSkillBundleDocAnyScope(docName);
    if (!parsed) return neighbors;
    const globalScope = docName.startsWith(MANAGED_ARTIFACT_PREFIX_SKILL);
    const refs = state.skillRefs.get(docName);
    if (refs) {
      for (const ref of refs) {
        if (ref === parsed.name) continue;
        if (globalScope) {
          const target = skillLiveDocName('global', ref);
          if (state.forward.has(target)) neighbors.add(target);
        } else {
          for (const candidate of state.forward.keys()) {
            const other = parseSkillBundleDocAnyScope(candidate);
            if (
              other?.kind === 'skill' &&
              other.name === ref &&
              !candidate.startsWith(MANAGED_ARTIFACT_PREFIX_SKILL)
            ) {
              neighbors.add(candidate);
            }
          }
        }
      }
    }
    if (parsed.kind === 'skill') {
      for (const [source, names] of state.skillRefs) {
        if (source === docName || !names.has(parsed.name)) continue;
        if (source.startsWith(MANAGED_ARTIFACT_PREFIX_SKILL) !== globalScope) continue;
        if (state.forward.has(source)) neighbors.add(source);
      }
    }
    return neighbors;
  }

  private bundleNeighbors(docName: string, branch = this.activeBranch): Set<string> {
    const neighbors = this.structuralBundleNeighbors(docName, branch);
    for (const n of this.skillRefNeighbors(docName, branch)) neighbors.add(n);
    return neighbors;
  }

  private recordSkillRefs(docName: string, body: string, branch = this.activeBranch): void {
    this.recordSkillRefsInto(this.getState(branch), docName, body);
  }

  private recordSkillRefsInto(state: BranchGraphState, docName: string, body: string): void {
    if (!parseSkillBundleDocAnyScope(docName)) return;
    const refs = extractSkillRefs(body);
    if (refs.length === 0) state.skillRefs.delete(docName);
    else state.skillRefs.set(docName, new Set(refs));
  }

  getActiveBranch(): string {
    return this.activeBranch;
  }

  switchBranch(branch: string): void {
    this.activeBranch = branch;
    this.getState(branch);
  }

  private cachePath(branch = this.activeBranch): string {
    return resolve(getLocalDir(this.projectDir), 'cache', branch, 'backlinks.json');
  }

  private registerNodeOnly(docName: string, branch = this.activeBranch): void {
    const state = this.getState(branch);
    const priorTargets = state.forward.get(docName) ?? new Set<string>();
    const priorExternalTargets = state.externalForward.get(docName) ?? new Map();
    for (const target of priorTargets) {
      const sources = state.backward.get(target);
      if (!sources) continue;
      sources.delete(docName);
      if (sources.size === 0) state.backward.delete(target);
    }
    for (const url of priorExternalTargets.keys()) {
      const sources = state.externalBackward.get(url);
      if (!sources) continue;
      sources.delete(docName);
      if (sources.size === 0) state.externalBackward.delete(url);
    }
    state.forward.set(docName, new Set());
    state.epoch++;
    state.externalForward.set(docName, new Map());
  }

  registerGlobalSkillBundleNode(docName: string, branch = this.activeBranch): void {
    if (!parseGlobalSkillBundleDoc(docName)) return;
    this.registerNodeOnly(docName, branch);
  }

  updateDocument(
    docName: string,
    links: ExtractedWikiLink[],
    externalLinks: ExtractedExternalLink[] = [],
    branch = this.activeBranch,
  ): void {
    if (isLinkIndexExcludedDoc(docName)) return;
    if (parseGlobalSkillBundleDoc(docName)) {
      this.registerNodeOnly(docName, branch);
      return;
    }
    const state = this.getState(branch);
    const priorTargets = state.forward.get(docName) ?? new Set<string>();
    const priorExternalTargets = state.externalForward.get(docName) ?? new Map();

    for (const target of priorTargets) {
      const sources = state.backward.get(target);
      if (!sources) continue;
      sources.delete(docName);
      if (sources.size === 0) state.backward.delete(target);
    }

    for (const url of priorExternalTargets.keys()) {
      const sources = state.externalBackward.get(url);
      if (!sources) continue;
      sources.delete(docName);
      if (sources.size === 0) state.externalBackward.delete(url);
    }

    const nextTargets = new Set<string>();
    const nextExternalTargets = new Map<string, { label: string | null; snippet: string | null }>();
    state.forward.set(docName, nextTargets);
    state.epoch++;
    state.externalForward.set(docName, nextExternalTargets);

    for (const link of links) {
      if (!link.target) continue;
      nextTargets.add(link.target);
      let sources = state.backward.get(link.target);
      if (!sources) {
        sources = new Map();
        state.backward.set(link.target, sources);
      }
      sources.set(
        docName,
        mergeLinkMeta(sources.get(docName), {
          anchor: link.anchor,
          snippet: link.snippet,
          sourceForm: link.sourceForm,
          line: link.line,
          column: link.column,
          rawWikiTarget: link.rawWikiTarget === true,
        }),
      );
    }

    for (const link of externalLinks) {
      if (!link.url) continue;
      nextExternalTargets.set(link.url, {
        label: link.label,
        snippet: link.snippet,
      });
      let sources = state.externalBackward.get(link.url);
      if (!sources) {
        sources = new Map();
        state.externalBackward.set(link.url, sources);
      }
      if (!sources.has(docName) || (!sources.get(docName)?.snippet && link.snippet)) {
        sources.set(docName, {
          label: link.label,
          snippet: link.snippet,
        });
      }
    }
  }

  updateDocumentFromMarkdown(docName: string, markdown: string, branch = this.activeBranch): void {
    try {
      const { frontmatter, body } = stripFrontmatter(markdown);
      const lineOffset = frontmatterLineCount(frontmatter);
      const wikiLinks = extractWikiLinksFromMarkdown(body, docName, lineOffset).map((link) => ({
        ...link,
        sourceForm: 'wiki' as const,
      }));
      const mdLinks = extractMarkdownLinksFromMarkdown(
        body,
        docName,
        lineOffset,
        this.getFileOracle(),
      ).map((link) => ({ ...link, sourceForm: 'markdown' as const }));
      const jsxLinks = extractJsxSrcRefsFromMarkdown(body, docName, lineOffset).map((link) => ({
        ...link,
        sourceForm: 'jsx' as const,
      }));
      const wikiExternalLinks = extractExternalWikiLinksFromMarkdown(body);
      const mdExternalLinks = extractExternalMarkdownLinksFromMarkdown(body, docName);
      const seen = new Set(wikiLinks.map((l) => l.target));
      const merged: ExtractedWikiLink[] = [
        ...wikiLinks,
        ...mdLinks.filter((l) => !seen.has(l.target)),
      ];
      for (const link of merged) seen.add(link.target);
      merged.push(...jsxLinks.filter((l) => !seen.has(l.target)));
      const externalSeen = new Set(wikiExternalLinks.map((l) => l.url));
      const mergedExternal = [
        ...wikiExternalLinks,
        ...mdExternalLinks.filter((link) => !externalSeen.has(link.url)),
      ];
      this.recordSkillRefs(docName, body, branch);
      this.updateDocument(docName, merged, mergedExternal, branch);
    } catch (err) {
      log.warn({ docName, err }, `Failed to scan ${docName} for link extraction`);
      this.deleteDocument(docName, branch);
    }
  }

  deleteDocument(docName: string, branch = this.activeBranch): void {
    if (isLinkIndexExcludedDoc(docName)) return;
    const state = this.getState(branch);
    const targets = state.forward.get(docName) ?? new Set<string>();
    const externalTargets = state.externalForward.get(docName) ?? new Map();
    for (const target of targets) {
      const sources = state.backward.get(target);
      if (!sources) continue;
      sources.delete(docName);
      if (sources.size === 0) state.backward.delete(target);
    }
    for (const url of externalTargets.keys()) {
      const sources = state.externalBackward.get(url);
      if (!sources) continue;
      sources.delete(docName);
      if (sources.size === 0) state.externalBackward.delete(url);
    }
    state.forward.delete(docName);
    state.epoch++;
    state.externalForward.delete(docName);
    state.skillRefs.delete(docName);
  }

  renameDocument(
    oldDocName: string,
    newDocName: string,
    markdown: string,
    branch = this.activeBranch,
  ): void {
    this.deleteDocument(oldDocName, branch);
    this.updateDocumentFromMarkdown(newDocName, markdown, branch);
  }

  getBacklinks(target: string, branch = this.activeBranch): BacklinkEntry[] {
    const state = this.getState(branch);
    const sources = state.backward.get(target);
    const entries = new Map<string, BacklinkEntry>();
    if (sources) {
      for (const [source, meta] of sources) {
        entries.set(source, { source, anchor: meta.anchor, snippet: meta.snippet });
      }
    }
    for (const partner of this.bundleNeighbors(target, branch)) {
      if (!entries.has(partner))
        entries.set(partner, { source: partner, anchor: null, snippet: null });
    }
    return [...entries.values()].sort((a, b) => a.source.localeCompare(b.source));
  }

  getBacklinkCount(target: string, branch = this.activeBranch): number {
    const state = this.getState(branch);
    const authored = state.backward.get(target);
    const structural = this.bundleNeighbors(target, branch);
    if (structural.size === 0) return authored?.size ?? 0;
    const union = new Set(authored?.keys() ?? []);
    for (const partner of structural) union.add(partner);
    return union.size;
  }

  getForwardLinks(source: string, branch = this.activeBranch): string[] {
    const state = this.getState(branch);
    const targets = new Set(state.forward.get(source) ?? new Set<string>());
    for (const partner of this.bundleNeighbors(source, branch)) targets.add(partner);
    return [...targets].sort((a, b) => a.localeCompare(b));
  }

  getForwardLinkEntries(source: string, branch = this.activeBranch): ForwardLinkEntry[] {
    const state = this.getState(branch);
    const internalEntries: ForwardLinkEntry[] = this.getForwardLinks(source, branch).map(
      (target) => ({
        kind: 'doc',
        target,
        anchor: state.backward.get(target)?.get(source)?.anchor ?? null,
        snippet: state.backward.get(target)?.get(source)?.snippet ?? null,
      }),
    );
    const externalEntries: ForwardLinkEntry[] = [
      ...(state.externalForward.get(source) ?? new Map()).entries(),
    ]
      .map(([url, meta]) => ({
        kind: 'external' as const,
        url,
        label: meta.label,
        snippet: meta.snippet,
      }))
      .sort((a, b) => a.url.localeCompare(b.url));
    return [...internalEntries, ...externalEntries];
  }

  getOrphans(allDocs: string[], mode: OrphanMode = 'both', branch = this.activeBranch): string[] {
    const state = this.getState(branch);
    const skillDocsWithReference = new Set<string>();
    for (const candidate of state.forward.keys()) {
      const parsed = parseSkillBundleDocAnyScope(candidate);
      if (parsed?.kind === 'reference') skillDocsWithReference.add(parsed.skillDocName);
    }
    const hasStructuralEdge = (docName: string): boolean => {
      const parsed = parseSkillBundleDocAnyScope(docName);
      if (!parsed || !state.forward.has(docName)) return false;
      return parsed.kind === 'skill'
        ? skillDocsWithReference.has(docName)
        : state.forward.has(parsed.skillDocName);
    };
    return [...allDocs]
      .filter((docName) => {
        const structural = hasStructuralEdge(docName);
        const hasInboundEdges = structural || (state.backward.get(docName)?.size ?? 0) > 0;
        const hasOutboundEdges = structural || (state.forward.get(docName)?.size ?? 0) > 0;

        if (mode === 'incoming') return !hasInboundEdges;
        if (mode === 'outgoing') return !hasOutboundEdges;
        return !hasInboundEdges && !hasOutboundEdges;
      })
      .sort((a, b) => a.localeCompare(b));
  }

  getHubs(limit = 20, branch = this.activeBranch): HubEntry[] {
    const state = this.getState(branch);
    return [...state.backward.entries()]
      .map(([docName, sources]) => ({ docName, count: sources.size }))
      .sort((a, b) =>
        b.count === a.count ? a.docName.localeCompare(b.docName) : b.count - a.count,
      )
      .slice(0, limit);
  }

  getIndexedDocNames(branch = this.activeBranch): string[] {
    return [...this.getState(branch).forward.keys()];
  }

  getDeadLinks(
    admittedDocs: Iterable<string>,
    sourceDocNames?: readonly string[],
    branch = this.activeBranch,
    knownFolderPaths?: Iterable<string>,
  ): DeadLinkEntry[] {
    const state = this.getState(branch);
    const admittedDocSet = new Set(admittedDocs);
    const sourceDocSet = sourceDocNames?.length ? new Set(sourceDocNames) : null;
    const folderPathSet = deriveFolderPathsFromDocNames([
      ...admittedDocSet,
      ...state.forward.keys(),
    ]);
    for (const folderPath of knownFolderPaths ?? []) folderPathSet.add(folderPath);

    return [...state.backward.entries()]
      .filter(([target, sources]) => {
        if (admittedDocSet.has(target) || state.forward.has(target)) return false;
        if (folderPathSet.has(target.replace(/\/+$/, ''))) return false;
        if (!sourceDocSet) return sources.size > 0;
        for (const source of sources.keys()) {
          if (sourceDocSet.has(source)) return true;
        }
        return false;
      })
      .map(([target, sources]) => ({
        target,
        sources: [...sources.entries()]
          .filter(([, meta]) => meta.rawWikiTarget !== true)
          .filter(([, meta]) => {
            if (meta.sourceForm !== 'jsx' || !isExcalidrawDocFile(target)) return true;
            const oracle = this.getFileOracle();
            return oracle !== undefined && !oracle.hasFile(target);
          })
          .filter(
            ([, meta]) =>
              meta.sourceForm !== 'wiki' ||
              resolveWikiLinkTargetDocName(target, this.documentLookup(branch)) === undefined,
          )
          .filter(([source]) => !sourceDocSet || sourceDocSet.has(source))
          .map(([source, meta]) => ({
            source,
            anchor: meta.anchor,
            snippet: meta.snippet,
            sourceForm: meta.sourceForm,
            line: meta.line,
            column: meta.column,
          }))
          .sort((a, b) => a.source.localeCompare(b.source)),
      }))
      .filter((entry) => entry.sources.length > 0)
      .sort((a, b) =>
        b.sources.length === a.sources.length
          ? a.target.localeCompare(b.target)
          : b.sources.length - a.sources.length,
      );
  }

  private documentLookup(branch = this.activeBranch): WikiLinkLookupIndex {
    const state = this.getState(branch);
    const cached = this.documentLookups.get(state);
    if (cached?.epoch === state.epoch) return cached.lookup;

    const pages = new Set(state.forward.keys());
    const lookup: WikiLinkLookupIndex = {
      pages,
      pagesBySlug: buildPagesBySlugIndex(pages, toWikiLinkSlug),
      pagesByBasename: buildPagesByBasenameIndex(pages, toWikiLinkSlug),
    };
    this.documentLookups.set(state, { epoch: state.epoch, lookup });
    return lookup;
  }

  private undecidedTargetResolves(target: string, branch = this.activeBranch): boolean {
    return resolveWikiLinkTarget(target, null, this.documentLookup(branch))?.kind === 'doc';
  }

  getLinkGraph(branch = this.activeBranch): {
    nodes: GraphNode[];
    links: Array<{ source: string; target: string }>;
  } {
    const state = this.getState(branch);
    const nodes = new Map<string, GraphNode>();
    const links: Array<{ source: string; target: string }> = [];

    for (const [source, targets] of state.forward) {
      nodes.set(source, {
        kind: 'doc',
        id: source,
        docName: source,
        anchor: getRepresentativeAnchor(state.backward.get(source)),
      });
      for (const target of targets) {
        if (isUndecidedTarget(state, target) && !this.undecidedTargetResolves(target, branch)) {
          continue;
        }
        nodes.set(target, {
          kind: 'doc',
          id: target,
          docName: target,
          anchor: getRepresentativeAnchor(state.backward.get(target)),
        });
        links.push({ source, target });
      }
    }

    for (const [source, targets] of state.externalForward) {
      nodes.set(source, {
        kind: 'doc',
        id: source,
        docName: source,
        anchor: getRepresentativeAnchor(state.backward.get(source)),
      });
      for (const [url, meta] of targets) {
        const id = externalNodeId(url);
        nodes.set(id, { kind: 'external', id, url, label: meta.label });
        links.push({ source, target: id });
      }
    }

    for (const source of state.forward.keys()) {
      const parsed = parseSkillBundleDocAnyScope(source);
      if (parsed?.kind !== 'skill') continue;
      for (const target of this.bundleNeighbors(source, branch)) {
        if (state.forward.get(source)?.has(target) || state.forward.get(target)?.has(source)) {
          continue;
        }
        nodes.set(source, {
          kind: 'doc',
          id: source,
          docName: source,
          anchor: getRepresentativeAnchor(state.backward.get(source)),
        });
        nodes.set(target, {
          kind: 'doc',
          id: target,
          docName: target,
          anchor: getRepresentativeAnchor(state.backward.get(target)),
        });
        links.push({ source, target });
      }
    }

    return {
      nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
      links,
    };
  }

  getLinkGraphNeighborhood(
    centerDocName: string,
    maxDegrees: number,
    branch = this.activeBranch,
  ): {
    nodes: GraphNode[];
    links: Array<{ source: string; target: string }>;
  } {
    const state = this.getState(branch);
    const externalLabelsByUrl = new Map<string, string | null>();
    for (const targets of state.externalForward.values()) {
      for (const [url, meta] of targets) {
        if (!externalLabelsByUrl.has(url)) {
          externalLabelsByUrl.set(url, meta.label);
        }
      }
    }
    const visited = new Set<string>([centerDocName]);
    const queue: Array<{ nodeId: string; degree: number }> = [{ nodeId: centerDocName, degree: 0 }];
    let queueIndex = 0;

    while (queueIndex < queue.length) {
      const current = queue[queueIndex++];
      if (current.degree >= maxDegrees) continue;

      const currentExternalUrl = externalUrlFromNodeId(current.nodeId);
      const neighbors = new Set<string>();

      if (currentExternalUrl) {
        for (const source of state.externalBackward.get(currentExternalUrl)?.keys() ?? []) {
          neighbors.add(source);
        }
      } else {
        for (const target of state.forward.get(current.nodeId) ?? new Set<string>()) {
          if (isUndecidedTarget(state, target) && !this.undecidedTargetResolves(target, branch)) {
            continue;
          }
          neighbors.add(target);
        }
        for (const url of state.externalForward.get(current.nodeId)?.keys() ?? []) {
          neighbors.add(externalNodeId(url));
        }
        for (const source of state.backward.get(current.nodeId)?.keys() ?? []) {
          neighbors.add(source);
        }
        for (const partner of this.bundleNeighbors(current.nodeId, branch)) {
          neighbors.add(partner);
        }
      }

      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push({ nodeId: neighbor, degree: current.degree + 1 });
      }
    }

    const links: Array<{ source: string; target: string }> = [];
    for (const [source, targets] of state.forward) {
      if (!visited.has(source)) continue;
      for (const target of targets) {
        if (!visited.has(target)) continue;
        links.push({ source, target });
      }
    }

    for (const [source, targets] of state.externalForward) {
      if (!visited.has(source)) continue;
      for (const url of targets.keys()) {
        const id = externalNodeId(url);
        if (!visited.has(id)) continue;
        links.push({ source, target: id });
      }
    }

    for (const source of visited) {
      const parsed = parseSkillBundleDocAnyScope(source);
      if (parsed?.kind !== 'skill') continue;
      for (const target of this.bundleNeighbors(source, branch)) {
        if (!visited.has(target)) continue;
        if (state.forward.get(source)?.has(target) || state.forward.get(target)?.has(source)) {
          continue;
        }
        links.push({ source, target });
      }
    }

    const nodes = [...visited].sort().map<GraphNode>((nodeId) => {
      const url = externalUrlFromNodeId(nodeId);
      if (!url) {
        return {
          kind: 'doc',
          id: nodeId,
          docName: nodeId,
          anchor: getRepresentativeAnchor(state.backward.get(nodeId)),
        };
      }
      return {
        kind: 'external',
        id: nodeId,
        url,
        label: externalLabelsByUrl.get(url) ?? null,
      };
    });

    return { nodes, links };
  }

  async saveToDisk(branch = this.activeBranch): Promise<void> {
    const filePath = this.cachePath(branch);
    mkdirSync(dirname(filePath), { recursive: true });
    const state = this.getState(branch);
    const mtimes = this.mtimesByBranch.get(branch);
    const data: SerializedBranchGraphState = {
      version: SNAPSHOT_VERSION,
      ...serializeState(state),
      ...(mtimes ? { mtimes: Object.fromEntries(mtimes) } : {}),
    };
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  async loadFromDisk(branch = this.activeBranch): Promise<boolean> {
    const filePath = this.cachePath(branch);
    if (!existsSync(filePath)) return false;
    try {
      const raw = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as SerializedBranchGraphState;
      if (parsed.version !== SNAPSHOT_VERSION) return false;
      this.states.set(branch, deserializeState(parsed));
      if (parsed.mtimes) {
        this.mtimesByBranch.set(branch, new Map(Object.entries(parsed.mtimes)));
      } else {
        this.mtimesByBranch.delete(branch);
      }
      return true;
    } catch (err) {
      log.warn({ branch, err }, `Failed to load cache for ${branch}`);
      return false;
    }
  }

  clear(branch = this.activeBranch): void {
    this.states.set(branch, createEmptyState());
    this.mtimesByBranch.delete(branch);
  }

  async rebuildFromDisk(branch = this.activeBranch): Promise<void> {
    return instrumentIndexRebuild('backlink', 'full', () => this.rebuildFromDiskUnspanned(branch));
  }

  private async rebuildFromDiskUnspanned(branch: string): Promise<void> {
    const state = createEmptyState();
    const mtimes = new Map<string, number>();
    const rawDocs: Array<{ docName: string; filePath: string }> = [];
    await this.walkForPaths(this.contentDir, rawDocs);

    const seen = new Set<string>();
    const allDocs = rawDocs.filter(({ docName }) => {
      if (seen.has(docName)) return false;
      seen.add(docName);
      return true;
    });

    const BATCH_SIZE = 50;
    for (let i = 0; i < allDocs.length; i += BATCH_SIZE) {
      const batch = allDocs.slice(i, i + BATCH_SIZE);
      const settled = await Promise.allSettled(
        batch.map(async ({ docName, filePath }) => {
          const [fileStat, markdown] = await Promise.all([
            stat(filePath),
            readFile(filePath, 'utf-8'),
          ]);
          return { docName, mtimeMs: fileStat.mtimeMs, markdown };
        }),
      );

      for (const result of settled) {
        if (result.status === 'rejected') {
          log.warn({ err: result.reason }, 'Failed to rebuild entry');
          continue;
        }
        const { docName, mtimeMs, markdown } = result.value;
        mtimes.set(docName, mtimeMs);
        const { frontmatter, body } = stripFrontmatter(markdown);
        const lineOffset = frontmatterLineCount(frontmatter);
        const wikiLinks = extractWikiLinksFromMarkdown(body, docName, lineOffset).map((link) => ({
          ...link,
          sourceForm: 'wiki' as const,
        }));
        const mdLinks = extractMarkdownLinksFromMarkdown(
          body,
          docName,
          lineOffset,
          this.getFileOracle(),
        ).map((link) => ({ ...link, sourceForm: 'markdown' as const }));
        const jsxLinks = extractJsxSrcRefsFromMarkdown(body, docName, lineOffset).map((link) => ({
          ...link,
          sourceForm: 'jsx' as const,
        }));
        const wikiExternalLinks = extractExternalWikiLinksFromMarkdown(body);
        const mdExternalLinks = extractExternalMarkdownLinksFromMarkdown(body, docName);
        const seen = new Set(wikiLinks.map((l) => l.target));
        const links: ExtractedWikiLink[] = [
          ...wikiLinks,
          ...mdLinks.filter((l) => !seen.has(l.target)),
        ];
        for (const link of links) seen.add(link.target);
        links.push(...jsxLinks.filter((l) => !seen.has(l.target)));
        const externalSeen = new Set(wikiExternalLinks.map((l) => l.url));
        const externalLinks = [
          ...wikiExternalLinks,
          ...mdExternalLinks.filter((link) => !externalSeen.has(link.url)),
        ];
        const targets = new Set<string>();
        const externalTargets = new Map<string, { label: string | null; snippet: string | null }>();
        this.recordSkillRefsInto(state, docName, body);
        state.forward.set(docName, targets);
        state.epoch++;
        state.externalForward.set(docName, externalTargets);
        for (const link of links) {
          if (!link.target) continue;
          targets.add(link.target);
          let sources = state.backward.get(link.target);
          if (!sources) {
            sources = new Map();
            state.backward.set(link.target, sources);
          }
          sources.set(
            docName,
            mergeLinkMeta(sources.get(docName), {
              anchor: link.anchor,
              snippet: link.snippet,
              sourceForm: link.sourceForm,
              line: link.line,
              column: link.column,
              rawWikiTarget: link.rawWikiTarget === true,
            }),
          );
        }
        for (const link of externalLinks) {
          if (!link.url) continue;
          externalTargets.set(link.url, { label: link.label, snippet: link.snippet });
          let sources = state.externalBackward.get(link.url);
          if (!sources) {
            sources = new Map();
            state.externalBackward.set(link.url, sources);
          }
          sources.set(docName, { label: link.label, snippet: link.snippet });
        }
      }
    }

    this.states.set(branch, state);
    this.mtimesByBranch.set(branch, mtimes);
  }

  private async walkForPaths(
    dir: string,
    results: Array<{ docName: string; filePath: string }>,
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      log.warn({ dir, err }, `Failed to read directory ${dir}`);
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const relDir = toPosix(relative(this.contentDir, fullPath));
        if (this.contentFilter && relDir && this.contentFilter.isDirExcluded(relDir)) continue;
        await this.walkForPaths(fullPath, results);
      } else if (entry.isFile() && isSupportedDocFile(entry.name)) {
        const relPath = toPosix(relative(this.contentDir, fullPath));
        if (this.contentFilter?.isExcluded(relPath)) continue;
        results.push({ docName: stripDocExtension(relPath), filePath: fullPath });
      }
    }
  }

  async reconcileWithDisk(branch = this.activeBranch): Promise<{
    added: number;
    updated: number;
    deleted: number;
    changedDocs: Array<{ docName: string; filePath: string }>;
    deletedDocNames: string[];
  }> {
    return instrumentIndexRebuild(
      'backlink',
      'reconcile',
      () => this.reconcileWithDiskUnspanned(branch),
      (diff) => ({
        'index.added': diff.added,
        'index.updated': diff.updated,
        'index.deleted': diff.deleted,
      }),
    );
  }

  private async reconcileWithDiskUnspanned(branch: string): Promise<{
    added: number;
    updated: number;
    deleted: number;
    deletedDocNames: string[];
    changedDocs: Array<{ docName: string; filePath: string }>;
  }> {
    if (!existsSync(this.contentDir))
      return { added: 0, updated: 0, deleted: 0, deletedDocNames: [], changedDocs: [] };

    const storedMtimes = this.mtimesByBranch.get(branch) ?? new Map<string, number>();
    const rawDocs: Array<{ docName: string; filePath: string }> = [];
    await this.walkForPaths(this.contentDir, rawDocs);

    const seen = new Set<string>();
    const docs = rawDocs.filter(({ docName }) => {
      if (seen.has(docName)) return false;
      seen.add(docName);
      return true;
    });

    const currentDocSet = new Set(docs.map((d) => d.docName));
    const newMtimes = new Map<string, number>();
    let added = 0;
    let updated = 0;

    const toProcess: Array<{ docName: string; filePath: string; mtimeMs: number; isNew: boolean }> =
      [];
    const statResults = await Promise.allSettled(
      docs.map(async ({ docName, filePath }) => ({
        docName,
        filePath,
        mtimeMs: (await stat(filePath)).mtimeMs,
      })),
    );
    for (const result of statResults) {
      if (result.status === 'rejected') continue;
      const { docName, filePath, mtimeMs } = result.value;
      const storedMtime = storedMtimes.get(docName);
      if (storedMtime !== undefined && storedMtime === mtimeMs) {
        newMtimes.set(docName, mtimeMs);
        continue;
      }
      toProcess.push({ docName, filePath, mtimeMs, isNew: storedMtime === undefined });
    }

    const BATCH_SIZE = 50;
    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
      const batch = toProcess.slice(i, i + BATCH_SIZE);
      const settled = await Promise.allSettled(
        batch.map(async ({ docName, filePath, mtimeMs, isNew }) => ({
          docName,
          mtimeMs,
          isNew,
          markdown: await readFile(filePath, 'utf-8'),
        })),
      );
      for (const result of settled) {
        if (result.status === 'rejected') {
          log.warn({ err: result.reason }, 'Failed to reconcile file');
          continue;
        }
        const { docName, mtimeMs, isNew, markdown } = result.value;
        this.updateDocumentFromMarkdown(docName, markdown, branch);
        newMtimes.set(docName, mtimeMs);
        if (isNew) added++;
        else updated++;
      }
    }

    let deleted = 0;
    const deletedDocNames: string[] = [];
    const allKnownDocs = new Set([...storedMtimes.keys(), ...this.getState(branch).forward.keys()]);
    for (const docName of allKnownDocs) {
      if (parseGlobalSkillBundleDoc(docName)) continue;
      if (!currentDocSet.has(docName)) {
        this.deleteDocument(docName, branch);
        deleted++;
        deletedDocNames.push(docName);
      }
    }

    this.mtimesByBranch.set(branch, newMtimes);
    return {
      added,
      updated,
      deleted,
      deletedDocNames,
      changedDocs: toProcess.map(({ docName, filePath }) => ({ docName, filePath })),
    };
  }

  async ingestGlobalSkillBundles(
    roots: ReadonlyArray<string>,
    branch = this.activeBranch,
  ): Promise<void> {
    const live = new Set<string>();
    for (const root of roots) {
      if (!existsSync(root)) continue;
      let skillDirs: Dirent[];
      try {
        skillDirs = await readdir(root, { withFileTypes: true });
      } catch (err) {
        log.warn({ root, err }, `Failed to read global skills root ${root}`);
        continue;
      }
      for (const skillDir of skillDirs) {
        if (!skillDir.isDirectory()) continue;
        const name = skillDir.name;
        const dir = join(root, name);
        const skillDocName = skillLiveDocName('global', name);
        if (existsSync(join(dir, 'SKILL.md'))) {
          if (parseGlobalSkillBundleDoc(skillDocName)) {
            this.registerNodeOnly(skillDocName, branch);
            live.add(skillDocName);
            try {
              const raw = await readFile(join(dir, 'SKILL.md'), 'utf-8');
              this.recordSkillRefs(skillDocName, stripFrontmatter(raw).body, branch);
            } catch (err) {
              log.warn({ dir, err }, 'global skill ref-scan failed; edges skipped');
            }
          }
        }
        const refs: Array<{ docName: string }> = [];
        await this.walkGlobalSkillReferences(join(dir, 'references'), name, '', refs);
        for (const { docName } of refs) {
          this.registerNodeOnly(docName, branch);
          live.add(docName);
        }
      }
    }
    const stale: string[] = [];
    for (const docName of this.getState(branch).forward.keys()) {
      if (parseGlobalSkillBundleDoc(docName) && !live.has(docName)) stale.push(docName);
    }
    for (const docName of stale) this.deleteDocument(docName, branch);
  }

  private async walkGlobalSkillReferences(
    dir: string,
    skillName: string,
    prefix: string,
    results: Array<{ docName: string }>,
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        log.warn({ dir, err }, `Failed to read skill references dir ${dir}`);
      }
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await this.walkGlobalSkillReferences(join(dir, entry.name), skillName, rel, results);
      } else if (entry.isFile() && isSupportedDocFile(entry.name)) {
        const extLess = stripDocExtension(rel);
        results.push({
          docName: `${MANAGED_ARTIFACT_PREFIX_SKILL}global/${skillName}/references/${extLess}`,
        });
      }
    }
  }
}
