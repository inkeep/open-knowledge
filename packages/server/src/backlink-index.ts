import { type Dirent, existsSync, mkdirSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import {
  type BrokenLinkReason,
  classifyMarkdownHref,
  classifyWikiLinkTarget,
  getWikiLinkText,
  isOrphanMode,
  MANAGED_ARTIFACT_PREFIX_SKILL,
  managedArtifactDocNameFromContentTarget,
  ORPHAN_MODES,
  type OrphanMode,
  parseGlobalSkillBundleDoc,
  parseProjectSkillBundleDoc,
  resolveAssetProjectPath,
  resolveInternalHref,
  resolveSkillBundleWikiTarget,
  skillLiveDocName,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import { isLinkIndexExcludedDoc } from './cc1-broadcast.ts';
import { getLocalDir } from './config/paths.ts';
import type { ContentFilter } from './content-filter.ts';
import { isSupportedDocFile, stripDocExtension } from './doc-extensions.ts';
import { toPosix } from './path-utils.ts';

const WIKI_LINK_RE = /\[\[([^\n#[\]|]+)(?:#([^\n[\]|]+))?(?:\|([^\n[\]]+))?\]\]/y;

const MD_LINK_RE =
  /\[([^\]\n]*)\]\((<[^>\n]+>|[^)\s\n]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\)/y;

interface InlineWikiLinkOccurrence {
  target: string;
  anchor: string | null;
  start: number;
  end: number;
}

interface FenceState {
  char: '`' | '~';
  length: number;
}

export interface ExtractedWikiLink {
  target: string;
  anchor: string | null;
  snippet: string | null;
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

interface BranchGraphState {
  backward: Map<string, Map<string, { anchor: string | null; snippet: string | null }>>;
  forward: Map<string, Set<string>>;
  externalForward: Map<string, Map<string, { label: string | null; snippet: string | null }>>;
  externalBackward: Map<string, Map<string, { label: string | null; snippet: string | null }>>;
}

interface SerializedBranchGraphState {
  backward: Record<string, Array<BacklinkEntry>>;
  forward: Record<string, string[]>;
  externalForward: Record<
    string,
    Array<{ url: string; label: string | null; snippet: string | null }>
  >;
  mtimes?: Record<string, number>;
}

interface BacklinkIndexOptions {
  projectDir: string;
  contentDir: string;
  contentFilter?: ContentFilter;
}

function createEmptyState(): BranchGraphState {
  return {
    backward: new Map(),
    forward: new Map(),
    externalForward: new Map(),
    externalBackward: new Map(),
  };
}

function parseSkillBundleDocAnyScope(
  docName: string,
): { name: string; kind: 'skill' | 'reference'; skillDocName: string } | null {
  const project = parseProjectSkillBundleDoc(docName);
  if (project) {
    return {
      name: project.name,
      kind: project.kind,
      skillDocName: skillLiveDocName('project', project.name),
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
  existing: { anchor: string | null; snippet: string | null } | undefined,
  next: { anchor: string | null; snippet: string | null },
): { anchor: string | null; snippet: string | null } {
  if (!existing) return next;
  return {
    anchor: existing.anchor ?? next.anchor,
    snippet: existing.snippet ?? next.snippet,
  };
}

function getRepresentativeAnchor(
  sources: Map<string, { anchor: string | null; snippet: string | null }> | undefined,
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
  WIKI_LINK_RE.lastIndex = start;
  const match = WIKI_LINK_RE.exec(line);
  if (!match) return null;

  const target = match[1]?.trim();
  const anchor = match[2]?.trim() || null;
  const alias = match[3]?.trim() || null;
  if (!target) return null;

  return {
    target,
    alias,
    anchor,
    nextIndex: start + match[0].length,
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

function extractMarkdownLinksFromLine(
  line: string,
  sourceDocName: string,
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
        if (classified?.kind === 'doc') {
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

export function extractMarkdownLinksFromMarkdown(
  markdown: string,
  sourceDocName: string,
): ExtractedWikiLink[] {
  const source = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = source.split('\n');
  const links: ExtractedWikiLink[] = [];
  let fence: FenceState | null = null;

  for (const line of lines) {
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
    } else {
      const nextFence = matchFence(line);
      if (nextFence) {
        fence = nextFence;
      } else {
        const extracted = extractMarkdownLinksFromLine(line, sourceDocName);
        links.push(
          ...extracted.occurrences.map(({ target, anchor, start, end }) => ({
            target,
            anchor,
            snippet: snippetAround(extracted.text, start, end),
          })),
        );
      }
    }
  }

  return links;
}

export function extractWikiLinksFromMarkdown(
  markdown: string,
  sourceDocName = '',
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
          ...extracted.occurrences.map(({ target, anchor, start, end }) => ({
            target,
            anchor,
            snippet: snippetAround(extracted.text, start, end),
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
}

export function computeBrokenOutboundLinks(
  markdown: string,
  sourceDocName: string,
  admittedDocs: Iterable<string>,
  fileExists?: (contentRootRelativePath: string) => boolean,
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

  const record = (href: string, resolvedTo: string | null, reason: BrokenLinkReason): void => {
    if (seen.has(href)) return;
    seen.add(href);
    broken.push({ href, resolvedTo, reason });
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
      if (!admitted.has(classified.docName)) {
        record(trimmed, classified.docName, 'no-such-doc');
      }
      return;
    }
    if (classified.kind === 'asset') {
      if (!fileExists) return;
      const filePath = resolveAssetProjectPath(classified.url, sourceDocName);
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

  const recordWikiLink = (target: string, anchor: string | null): void => {
    const classified = classifyWikiLinkTarget(target, anchor);
    if (!classified || classified.kind !== 'doc') return;
    if (!admitted.has(classified.docName)) {
      record(`[[${target}${anchor ? `#${anchor}` : ''}]]`, classified.docName, 'no-such-doc');
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
  };
}

export class BacklinkIndex {
  private readonly projectDir: string;
  private readonly contentDir: string;
  private readonly contentFilter?: ContentFilter;
  private readonly states = new Map<string, BranchGraphState>();
  private readonly mtimesByBranch = new Map<string, Map<string, number>>();
  private activeBranch = 'main';

  constructor(options: BacklinkIndexOptions) {
    this.projectDir = options.projectDir;
    this.contentDir = options.contentDir;
    this.contentFilter = options.contentFilter;
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
    state.externalForward.set(docName, nextExternalTargets);

    for (const link of links) {
      if (!link.target) continue;
      const target = managedArtifactDocNameFromContentTarget(link.target) ?? link.target;
      nextTargets.add(target);
      let sources = state.backward.get(target);
      if (!sources) {
        sources = new Map();
        state.backward.set(target, sources);
      }
      sources.set(
        docName,
        mergeLinkMeta(sources.get(docName), { anchor: link.anchor, snippet: link.snippet }),
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
      const { body } = stripFrontmatter(markdown);
      const wikiLinks = extractWikiLinksFromMarkdown(body, docName);
      const mdLinks = extractMarkdownLinksFromMarkdown(body, docName);
      const wikiExternalLinks = extractExternalWikiLinksFromMarkdown(body);
      const mdExternalLinks = extractExternalMarkdownLinksFromMarkdown(body, docName);
      const seen = new Set(wikiLinks.map((l) => l.target));
      const merged = [...wikiLinks, ...mdLinks.filter((l) => !seen.has(l.target))];
      const externalSeen = new Set(wikiExternalLinks.map((l) => l.url));
      const mergedExternal = [
        ...wikiExternalLinks,
        ...mdExternalLinks.filter((link) => !externalSeen.has(link.url)),
      ];
      this.updateDocument(docName, merged, mergedExternal, branch);
    } catch (err) {
      console.warn(`[backlinks] Failed to scan ${docName} for link extraction:`, err);
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
    state.externalForward.delete(docName);
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
    for (const partner of this.structuralBundleNeighbors(target, branch)) {
      if (!entries.has(partner))
        entries.set(partner, { source: partner, anchor: null, snippet: null });
    }
    return [...entries.values()].sort((a, b) => a.source.localeCompare(b.source));
  }

  getBacklinkCount(target: string, branch = this.activeBranch): number {
    const state = this.getState(branch);
    const authored = state.backward.get(target);
    const structural = this.structuralBundleNeighbors(target, branch);
    if (structural.size === 0) return authored?.size ?? 0;
    const union = new Set(authored?.keys() ?? []);
    for (const partner of structural) union.add(partner);
    return union.size;
  }

  getForwardLinks(source: string, branch = this.activeBranch): string[] {
    const state = this.getState(branch);
    const targets = new Set(state.forward.get(source) ?? new Set<string>());
    for (const partner of this.structuralBundleNeighbors(source, branch)) targets.add(partner);
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

  getDeadLinks(
    admittedDocs: Iterable<string>,
    sourceDocNames?: readonly string[],
    branch = this.activeBranch,
  ): DeadLinkEntry[] {
    const state = this.getState(branch);
    const admittedDocSet = new Set(admittedDocs);
    const sourceDocSet = sourceDocNames?.length ? new Set(sourceDocNames) : null;

    return [...state.backward.entries()]
      .filter(([target, sources]) => {
        if (admittedDocSet.has(target) || state.forward.has(target)) return false;
        if (!sourceDocSet) return sources.size > 0;
        for (const source of sources.keys()) {
          if (sourceDocSet.has(source)) return true;
        }
        return false;
      })
      .map(([target, sources]) => ({
        target,
        sources: [...sources.entries()]
          .filter(([source]) => !sourceDocSet || sourceDocSet.has(source))
          .map(([source, meta]) => ({ source, anchor: meta.anchor, snippet: meta.snippet }))
          .sort((a, b) => a.source.localeCompare(b.source)),
      }))
      .filter((entry) => entry.sources.length > 0)
      .sort((a, b) =>
        b.sources.length === a.sources.length
          ? a.target.localeCompare(b.target)
          : b.sources.length - a.sources.length,
      );
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
      for (const target of this.structuralBundleNeighbors(source, branch)) {
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
          neighbors.add(target);
        }
        for (const url of state.externalForward.get(current.nodeId)?.keys() ?? []) {
          neighbors.add(externalNodeId(url));
        }
        for (const source of state.backward.get(current.nodeId)?.keys() ?? []) {
          neighbors.add(source);
        }
        for (const partner of this.structuralBundleNeighbors(current.nodeId, branch)) {
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
      for (const target of this.structuralBundleNeighbors(source, branch)) {
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
      this.states.set(branch, deserializeState(parsed));
      if (parsed.mtimes) {
        this.mtimesByBranch.set(branch, new Map(Object.entries(parsed.mtimes)));
      } else {
        this.mtimesByBranch.delete(branch);
      }
      return true;
    } catch (err) {
      console.warn(`[backlinks] Failed to load cache for ${branch}:`, err);
      return false;
    }
  }

  clear(branch = this.activeBranch): void {
    this.states.set(branch, createEmptyState());
    this.mtimesByBranch.delete(branch);
  }

  async rebuildFromDisk(branch = this.activeBranch): Promise<void> {
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
          console.warn('[backlinks] Failed to rebuild entry:', result.reason);
          continue;
        }
        const { docName, mtimeMs, markdown } = result.value;
        mtimes.set(docName, mtimeMs);
        const { body } = stripFrontmatter(markdown);
        const wikiLinks = extractWikiLinksFromMarkdown(body, docName);
        const mdLinks = extractMarkdownLinksFromMarkdown(body, docName);
        const wikiExternalLinks = extractExternalWikiLinksFromMarkdown(body);
        const mdExternalLinks = extractExternalMarkdownLinksFromMarkdown(body, docName);
        const seen = new Set(wikiLinks.map((l) => l.target));
        const links = [...wikiLinks, ...mdLinks.filter((l) => !seen.has(l.target))];
        const externalSeen = new Set(wikiExternalLinks.map((l) => l.url));
        const externalLinks = [
          ...wikiExternalLinks,
          ...mdExternalLinks.filter((link) => !externalSeen.has(link.url)),
        ];
        const targets = new Set<string>();
        const externalTargets = new Map<string, { label: string | null; snippet: string | null }>();
        state.forward.set(docName, targets);
        state.externalForward.set(docName, externalTargets);
        for (const link of links) {
          if (!link.target) continue;
          const target = managedArtifactDocNameFromContentTarget(link.target) ?? link.target;
          targets.add(target);
          let sources = state.backward.get(target);
          if (!sources) {
            sources = new Map();
            state.backward.set(target, sources);
          }
          sources.set(
            docName,
            mergeLinkMeta(sources.get(docName), { anchor: link.anchor, snippet: link.snippet }),
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
      console.warn(`[backlinks] Failed to read directory ${dir}:`, err);
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
  }> {
    if (!existsSync(this.contentDir)) return { added: 0, updated: 0, deleted: 0 };

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
      if (result.status === 'rejected') continue; // inaccessible; skip
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
          console.warn('[backlinks] Failed to reconcile file:', result.reason);
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
    const allKnownDocs = new Set([...storedMtimes.keys(), ...this.getState(branch).forward.keys()]);
    for (const docName of allKnownDocs) {
      if (parseGlobalSkillBundleDoc(docName)) continue;
      if (!currentDocSet.has(docName)) {
        this.deleteDocument(docName, branch);
        deleted++;
      }
    }

    this.mtimesByBranch.set(branch, newMtimes);
    return { added, updated, deleted };
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
        console.warn(`[backlinks] Failed to read global skills root ${root}:`, err);
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
        console.warn(`[backlinks] Failed to read skill references dir ${dir}:`, err);
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
