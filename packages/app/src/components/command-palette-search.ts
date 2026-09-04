import {
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  searchWorkspaceCorpus,
  type WorkspaceSearchCorpus,
  type WorkspaceSearchDocument,
  workspaceSearchBasename,
} from '@inkeep/open-knowledge-core';
import { parseApiError } from '@/lib/parse-api-error';
import type { PageMeta } from './PageListContext';

export interface WorkspaceEntry {
  kind: 'file' | 'folder';
  path: string;
  name: string;
  title?: string;
  docExt?: string;
  modifiedTs?: number;
  bodyIndexed?: boolean;
}

export interface WorkspaceSearchEntry extends WorkspaceEntry {
  snippet?: string;
  score?: number;
}

interface HighlightSegment {
  text: string;
  match: boolean;
  start: number;
}

interface WorkspaceEntrySearchCorpus {
  entries: readonly WorkspaceEntry[];
  byId: ReadonlyMap<string, WorkspaceEntry>;
  corpus: WorkspaceSearchCorpus;
}

export const EMPTY_QUERY_NAV_LIMIT = 20;
const MATCH_QUERY_NAV_LIMIT = 50;
const API_SEARCH_LIMIT = 50;
export const SEMANTIC_RESULT_LIMIT = 30;

let cachedEntriesFingerprint = '';
let cachedEntrySearchCorpus: WorkspaceEntrySearchCorpus | null = null;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function queryTerms(query: string): string[] {
  const normalized = query.trim();
  if (!normalized) return [];
  return [...new Set(normalized.split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
}

export function buildWorkspaceEntries(
  pages: ReadonlySet<string>,
  folderPaths: ReadonlySet<string>,
  pageTitles: ReadonlyMap<string, string> = new Map(),
  pageMeta: ReadonlyMap<string, PageMeta> = new Map(),
  filePaths: ReadonlySet<string> = new Set(),
): WorkspaceEntry[] {
  const entries: WorkspaceEntry[] = [];
  const seenFilePaths = new Set<string>();

  for (const path of pages) {
    seenFilePaths.add(path);
    const meta = pageMeta.get(path);
    const modified = meta?.modified;
    const title = pageTitles.get(path);
    entries.push({
      kind: 'file',
      path,
      name: workspaceSearchBasename(path),
      ...(title && { title }),
      ...(meta?.docExt && { docExt: meta.docExt }),
      ...(modified && { modifiedTs: Date.parse(modified) }),
    });
  }
  for (const path of filePaths) {
    if (seenFilePaths.has(path)) continue;
    seenFilePaths.add(path);
    entries.push({
      kind: 'file',
      path,
      name: workspaceSearchBasename(path),
      bodyIndexed: false,
    });
  }
  for (const path of folderPaths) {
    entries.push({ kind: 'folder', path, name: workspaceSearchBasename(path) });
  }

  entries.sort((a, b) => {
    const pathCompare = a.path.localeCompare(b.path);
    if (pathCompare !== 0) return pathCompare;
    if (a.kind === b.kind) return 0;
    return a.kind === 'folder' ? -1 : 1;
  });

  return entries;
}

function toSearchDocument(entry: WorkspaceEntry): WorkspaceSearchDocument {
  const searchKind: 'page' | 'folder' | 'file' =
    entry.kind === 'folder' ? 'folder' : entry.bodyIndexed === false ? 'file' : 'page';
  return createWorkspaceSearchDocument({
    kind: searchKind,
    path: entry.path,
    title: entry.title ?? entry.name,
    modifiedTs: entry.modifiedTs ?? 0,
  });
}

function buildWorkspaceEntrySearchCorpus(
  entries: readonly WorkspaceEntry[],
): WorkspaceEntrySearchCorpus {
  const byId = new Map(
    entries.map((entry) => {
      const searchKind: 'page' | 'folder' | 'file' =
        entry.kind === 'folder' ? 'folder' : entry.bodyIndexed === false ? 'file' : 'page';
      return [`${searchKind}:${entry.path}`, entry];
    }),
  );
  return {
    entries,
    byId,
    corpus: createWorkspaceSearchCorpus(entries.map(toSearchDocument)),
  };
}

function workspaceEntriesFingerprint(entries: readonly WorkspaceEntry[]): string {
  return entries
    .map(
      (entry) =>
        `${entry.kind}\u0000${entry.path}\u0000${entry.title ?? ''}\u0000${entry.docExt ?? ''}\u0000${entry.modifiedTs ?? 0} ${entry.bodyIndexed === false ? '0' : '1'}`,
    )
    .join('\u0001');
}

function getCachedWorkspaceEntrySearchCorpus(
  entries: readonly WorkspaceEntry[],
): WorkspaceEntrySearchCorpus {
  const fingerprint = workspaceEntriesFingerprint(entries);
  if (cachedEntrySearchCorpus && cachedEntriesFingerprint === fingerprint) {
    return cachedEntrySearchCorpus;
  }
  cachedEntriesFingerprint = fingerprint;
  cachedEntrySearchCorpus = buildWorkspaceEntrySearchCorpus(entries);
  return cachedEntrySearchCorpus;
}

export function searchWorkspaceEntries(
  entries: readonly WorkspaceEntry[],
  query: string,
  limit = MATCH_QUERY_NAV_LIMIT,
): WorkspaceEntry[] {
  return searchWorkspaceEntryCorpus(getCachedWorkspaceEntrySearchCorpus(entries), query, limit);
}

function searchWorkspaceEntryCorpus(
  entryCorpus: WorkspaceEntrySearchCorpus,
  query: string,
  limit = MATCH_QUERY_NAV_LIMIT,
): WorkspaceEntry[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return entryCorpus.entries.slice(0, EMPTY_QUERY_NAV_LIMIT);
  }

  return searchWorkspaceCorpus(entryCorpus.corpus, normalizedQuery, {
    intent: 'omnibar',
    limit,
    scopes: ['page', 'folder', 'file'],
  })
    .map((result) => entryCorpus.byId.get(result.document.id))
    .filter((entry): entry is WorkspaceEntry => entry !== undefined);
}

export function splitTextByQueryMatches(text: string, query: string): HighlightSegment[] {
  const terms = queryTerms(query);
  if (terms.length === 0 || text.length === 0) return [{ text, match: false, start: 0 }];

  const regex = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  const segments: HighlightSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(regex)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, index), match: false, start: lastIndex });
    }
    segments.push({ text: match[0], match: true, start: index });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), match: false, start: lastIndex });
  }
  return segments.length > 0 ? segments : [{ text, match: false, start: 0 }];
}

interface WorkspaceSearchApiResponse {
  results?: Array<{
    kind?: string;
    path?: string;
    title?: string;
    snippet?: string;
    score?: number;
  }>;
  truncated?: boolean;
  ready?: boolean;
}

export interface WorkspaceSearchFetchResult {
  entries: WorkspaceSearchEntry[];
  truncated: boolean;
  ready: boolean;
}

function toWorkspaceSearchEntry(
  row: NonNullable<WorkspaceSearchApiResponse['results']>[number],
): WorkspaceSearchEntry | null {
  if (
    (row.kind !== 'page' && row.kind !== 'folder' && row.kind !== 'file') ||
    typeof row.path !== 'string'
  ) {
    return null;
  }
  const name = workspaceSearchBasename(row.path);
  const kind = row.kind === 'folder' ? 'folder' : 'file';
  return {
    kind,
    path: row.path,
    name,
    ...(row.kind === 'file' && { bodyIndexed: false }),
    ...(row.title && { title: row.title }),
    ...(row.snippet && { snippet: row.snippet }),
    ...(typeof row.score === 'number' && { score: row.score }),
  };
}

export async function fetchWorkspaceSearchEntries(
  query: string,
  options: { signal?: AbortSignal; limit?: number; semantic?: boolean } = {},
): Promise<WorkspaceSearchFetchResult> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return { entries: [], truncated: false, ready: true };

  const response = await fetch('/api/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: normalizedQuery,
      intent: 'full_text',
      ranking: options.semantic ? 'relevance' : 'navigation',
      scopes: ['page', 'folder', 'content', 'file'],
      limit: options.limit ?? API_SEARCH_LIMIT,
      source: 'omnibar',
      ...(options.semantic ? { semantic: true } : {}),
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as unknown;
    throw new Error(parseApiError(body) ?? `Search failed with status ${response.status}`);
  }

  const payload = (await response.json()) as WorkspaceSearchApiResponse;
  const entries = (payload.results ?? []).map(toWorkspaceSearchEntry).filter((entry) => !!entry);

  return { entries, truncated: payload.truncated === true, ready: payload.ready !== false };
}

export function matchesCommandQuery(
  label: string,
  query: string,
  keywords: readonly string[] = [],
): boolean {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return true;
  const haystack = normalize([label, ...keywords].join(' '));
  return queryTerms(normalizedQuery).every((term) => haystack.includes(term));
}

export type OmnibarSearchHintMode = 'idle' | 'content' | 'name-only' | 'empty' | 'truncated';

export function classifyOmnibarSearchHint(
  query: string,
  visibleResults: readonly (WorkspaceEntry | WorkspaceSearchEntry)[],
  options: { truncated?: boolean } = {},
): OmnibarSearchHintMode {
  if (query.trim() === '') return 'idle';
  if (visibleResults.length === 0) return 'empty';
  if (options.truncated) return 'truncated';
  for (const entry of visibleResults) {
    if ('snippet' in entry && typeof entry.snippet === 'string' && entry.snippet.length > 0) {
      return 'content';
    }
  }
  return 'name-only';
}
