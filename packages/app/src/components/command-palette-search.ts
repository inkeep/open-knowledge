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
  /**
   * When `kind === 'file'`, distinguishes a markdown page
   * (body searchable — `bodyIndexed: true`, the default for back-compat) from
   * a name-only non-markdown file (`bodyIndexed: false`). Drives the
   * search-corpus kind selection in {@link toSearchDocument} so non-markdown
   * files land in the name-only `kind:'file'` corpus tier, picking up the
   * canonical-first ranking demotion instead of competing with
   * markdown pages for the same rank. Absent + true are equivalent: a
   * markdown page is the default. Always false for non-markdown entries
   * pushed from the `filePaths` set.
   */
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
/**
 * Fetch depth for the per-keystroke lexical search. Sized to give exact-name
 * matches headroom: when many files share a basename, the specific one must not
 * fall past the fetch window. The per-kind cap then keeps the visible list
 * content-first, so the larger fetch surfaces content, not a wall of siblings.
 */
const API_SEARCH_LIMIT = 50;
/**
 * Display cap for the deliberate "by meaning" submit. Semantic retrieval is
 * nearest-neighbor:
 * it always returns the closest pages, so there is no natural "no match" — the
 * bound is a COUNT, not a cosine threshold (which is model-specific and can't
 * separate a weak-real hit from weak noise). The strongest matches lead; rank
 * carries the relevance signal. A separate constant so semantic can be tuned
 * apart from lexical later without disturbing the per-keystroke path.
 */
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
  /**
   * Tracked non-markdown, non-asset files (e.g. `data.csv`,
   * `packages/app/src/index.ts`) surfaced by `/api/documents` as
   * `kind:'file'`. Folded into the workspace entry corpus as `kind:'file'`
   * (the WorkspaceEntry shape already discriminates by `file`/`folder` — see
   * the interface above), so ⌘K finds them by name AND partial path
   * alongside markdown pages. Pages take precedence on path collision
   * (markdown is the canonical entry; a file `notes/foo.md` would already
   * arrive via `pages`).
   */
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
  // Non-markdown files (bodyIndexed:false) land in the
  // search corpus's name-only `kind:'file'` tier. This composes with the
  // canonical-first ranking so a query that ties a markdown page
  // `foo` with a non-markdown sibling `foo.csv` ranks the markdown page
  // first. Default-true preserves the markdown-page behavior for any caller
  // that builds a WorkspaceEntry without setting `bodyIndexed`.
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
  // Mirror the `${kind}:${path}` id `createWorkspaceSearchDocument` synthesizes
  // so `byId.get(result.document.id)` lands on the same entry — non-markdown
  // entries split into a `kind:'file'` corpus row, so the byId key needs the
  // same three-way classification.
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
    // Include the name-only `kind:'file'` tier so the local
    // per-keystroke search returns non-markdown matches alongside markdown
    // pages and folders. Without `'file'` in scopes, every non-markdown
    // entry pushed into the corpus by `buildWorkspaceEntries(filePaths)`
    // would be filtered out by `scopeAllows`.
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
  /**
   * Server sets this `true` when the corpus build dropped deepest-tail
   * `kind:'file'` entries at the `OK_SEARCH_MAX_ENTRIES` cap. Omnibar surfaces
   * a "results capped" hint so the user understands a missing file might be a
   * cap artifact, not a typo. Optional + missing-is-false; the cap is per-build
   * and persists across queries on the same corpus until the fingerprint flips.
   */
  truncated?: boolean;
  /**
   * Server cold-start signal. `false` while the search index is still warming
   * (boot seed or first corpus build), so an empty `results` is not yet
   * authoritative — the caller should show a warming state and retry. Absent or
   * `true` means the index is built and the results are complete.
   */
  ready?: boolean;
}

/**
 * The omnibar's view of one `/api/search` round-trip: the mapped result entries
 * plus the corpus-truncation flag. Returning a wrapped shape (not a bare array)
 * lets the hint classifier surface the cap signal without an out-of-band fetch.
 */
export interface WorkspaceSearchFetchResult {
  entries: WorkspaceSearchEntry[];
  truncated: boolean;
  // `false` while the server search index is warming; the caller retries.
  ready: boolean;
}

function toWorkspaceSearchEntry(
  row: NonNullable<WorkspaceSearchApiResponse['results']>[number],
): WorkspaceSearchEntry | null {
  // The server distinguishes `'page'` (markdown body searchable) from `'file'`
  // (name-only non-markdown row) for ranking, but both are leaves the user
  // navigates to — the omnibar collapses them into the same client
  // `kind:'file'` WorkspaceEntry. Folders stay folders. Any other `row.kind`
  // value (or a missing `path`) is dropped.
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

/**
 * POST the omnibar's full-text search to `/api/search` and map server rows to
 * palette entries. Lexical by default; pass `semantic: true` — the deliberate
 * "by meaning" submit — to opt the request into the server's vector fusion. The
 * server gates `semantic` on capability + key, so `true` with the feature off is
 * a no-op lexical search. Always tags `source: 'omnibar'` so semantic submits are
 * counted apart from the MCP tool (the lexical per-keystroke call carries it too;
 * harmless — `source` only labels telemetry on the semantic path).
 */
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
      // Per-keystroke navigation ranks name-first (tier-dominant) and bounds
      // folders/files, so an exact filename leads even when same-named siblings
      // have stronger body scores. The deliberate "by meaning" submit keeps the
      // body-weighted (relevance) ranking, where a strong content match should
      // win. Intent stays `full_text` either way — that controls WHICH fields
      // are matched (content + fuzzy tolerance), `ranking` controls the order.
      ranking: options.semantic ? 'relevance' : 'navigation',
      // Opt the omnibar's full-text request into the
      // server's name-only `kind:'file'` corpus tier.
      // Without `'file'` in `scopes`, the server's `scopeAllows` filter would
      // exclude every name-only file row from the response — exactly the
      // tier we just started emitting. `'content'` still gates body search,
      // which only markdown pages support; `'file'` lets name/path matches
      // surface for tracked non-markdown files.
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
  return haystack.includes(normalizedQuery);
}

/**
 * Classify the current omnibar result set for the search-
 * hint affordance. The hint is unobtrusive and absent when content hits are
 * present, so the classifier returns:
 *   - `'content'` — at least one result carries a `snippet`, meaning the
 *     server matched body text on a markdown page; no hint shown.
 *   - `'name-only'` — there are results, but every one is a name / path /
 *     folder hit (no `snippet`). The omnibar surfaces a one-line hint that
 *     content search is name-only.
 *   - `'empty'` — no results for a non-empty query. The omnibar surfaces a
 *     "ignored / hidden files aren't indexed" note so the empty state is
 *     informative rather than silent (covers the gitignored-but-visible
 *     case where a file in `?showAll=true` tree wouldn't reach the corpus).
 *   - `'truncated'` — the corpus build hit the `OK_SEARCH_MAX_ENTRIES` cap
 *     and dropped deepest-tail file paths. Returned in preference to
 *     `'name-only'` / `'content'` so the user sees the cap signal regardless
 *     of how the surviving results rank — a missing file might be a cap
 *     artifact, not a typo. Still flows through to `'empty'` if the cap fired
 *     AND the surviving corpus has zero hits.
 *   - `'idle'` — no query typed; no hint applicable. The empty/idle split
 *     keeps the hint out of the initial Recents view.
 *
 * Pure / synchronous — derives from the same visible-result list the
 * NavigationItems render, so the hint's appearance can never disagree with
 * what's on screen.
 */
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
