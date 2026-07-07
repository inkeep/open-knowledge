import { type AnyOrama, create, insertMultiple, search } from '@orama/orama';
import { isHiddenDocName } from '../util/doc-name.ts';

export type WorkspaceSearchKind = 'page' | 'folder' | 'file';
export type WorkspaceSearchIntent = 'omnibar' | 'autocomplete' | 'full_text';
export type WorkspaceSearchScope = WorkspaceSearchKind | 'content';

/**
 * How a candidate set is ORDERED, decoupled from `intent` (which selects WHICH
 * fields/scopes are matched and the fuzzy tolerance). `navigation` is
 * tier-dominant — the lexical bracket dominates, so an exact-name match leads;
 * `relevance` is body-weighted — a strong body match can outrank a weak name
 * match. The omnibar searches content (a `full_text` candidate set, with fuzzy
 * tolerance) but ranks `navigation`; the MCP `search` tool ranks `relevance`.
 * Defaults from intent when unset: `full_text` → relevance, else navigation.
 */
export type WorkspaceSearchRanking = 'navigation' | 'relevance';

export interface WorkspaceSearchDocument {
  id: string;
  kind: WorkspaceSearchKind;
  path: string;
  title: string;
  name: string;
  pathSegments: string;
  content: string;
  modifiedTs: number;
}

export interface WorkspaceSearchResult {
  document: WorkspaceSearchDocument;
  score: number;
  signals: {
    lexical: number;
    fullText: number;
    recency: number;
    /**
     * Max chunk cosine for this doc against the query. Present ONLY when
     * semantic ranking is active AND the doc had a cached vector — so the
     * flag-OFF response carries exactly `{lexical, fullText, recency}`,
     * byte-identical to the pre-embeddings contract.
     */
    vector?: number;
  };
}

/**
 * Vector-search input supplied by the server when semantic ranking is active.
 * Core stays pure: it owns candidate selection + fusion but never embeds — the
 * server computes the per-doc cosine map and passes it in. When this is absent,
 * `searchWorkspaceCorpus` runs the exact pre-embeddings path.
 */
export interface WorkspaceSemanticInput {
  /** docId (`${kind}:${path}`) → max-chunk cosine, for already-embedded docs. */
  scores: ReadonlyMap<string, number>;
  /** Reciprocal-rank-fusion constant for the body tier (default 60). */
  rrfK?: number;
  /** Max vector-only docs to union into the candidate set. */
  candidateLimit?: number;
  /** Min cosine for a vector-only doc to (a) join candidates and (b) earn a vector rank. */
  similarityFloor?: number;
}

export interface WorkspaceSearchOptions {
  intent?: WorkspaceSearchIntent;
  /**
   * Ordering strategy, independent of `intent`. Omit to derive from intent
   * (`full_text` → relevance, else navigation). The omnibar sets
   * `navigation` over a `full_text` candidate set so it searches body but ranks
   * name-first; the MCP `search` tool leaves it unset (relevance).
   */
  ranking?: WorkspaceSearchRanking;
  scopes?: readonly WorkspaceSearchScope[];
  limit?: number;
  /** Present only when semantic search is on, capable, warm, and query-gated. */
  semantic?: WorkspaceSemanticInput;
}

export interface WorkspaceSearchCorpus {
  documents: readonly WorkspaceSearchDocument[];
}

export const DEFAULT_WORKSPACE_SEARCH_LIMIT = 20;
export const MAX_WORKSPACE_SEARCH_LIMIT = 100;

/** Canonical reciprocal-rank-fusion constant (Cormack/Clarke/Büttcher). */
export const DEFAULT_RRF_K = 60;
/**
 * Default top-K vector candidates unioned into the pool. Retrieval is rank-based:
 * the top docs by cosine become candidates and RRF orders them, so the absolute
 * cosine never decides admission — only rank does. This is the generalizable
 * gate (an absolute cosine threshold is model-specific and, on a compressed-scale
 * model, cannot separate a weak-but-real hit from weak noise — they overlap).
 */
export const DEFAULT_VECTOR_CANDIDATE_LIMIT = 64;
/**
 * Default cosine floor — OFF (0): retrieval is rank-based (top-K by cosine via
 * `candidateLimit`), so by default every non-negative cosine is eligible and the
 * strongest float to the top. A `0` floor still drops only docs pointing AWAY
 * from the query (negative cosine), which are never matches on any model. The
 * floor exists as an optional power-user hard cutoff — set
 * `search.semantic.similarityFloor` to suppress everything below an absolute
 * score — but it is not the default mechanism, because the right value is
 * model-specific and a wrong one silently discards real hits (a `0.35` default
 * once dropped every match on `text-embedding-3-small`, whose correct keyword
 * hits score only ~0.13–0.29). Callers bound the visible set by COUNT, not score.
 */
export const DEFAULT_VECTOR_SIMILARITY_FLOOR = 0;

/**
 * Per-kind result caps: the omnibar is content-first. A query matching a common
 * folder/file basename (`evidence`, `index`) otherwise fills the entire list
 * with one kind and crowds out content. Folders and name-only files are each
 * capped; pages (content) are uncapped and fill the rest. Capping keeps the
 * top-N of each kind by rank — so a uniquely-named folder/file match (which
 * ranks highest) is retained, while a pile of same-named ones is bounded.
 * Applied when ranking is `navigation` (the omnibar) and skipped for
 * `relevance` (the MCP `search` tool, which legitimately wants every match).
 * Autocomplete is page-scoped, so no folders/files ever enter its set. Tunable.
 */
export const DEFAULT_FOLDER_RESULT_CAP = 3;
export const DEFAULT_FILE_RESULT_CAP = 3;

/**
 * Per-CATEGORY result caps, applied (navigation ranking only) AFTER ranking and
 * BEFORE the per-kind quota. Where the per-kind cap bounds folders/files by
 * KIND, the category cap bounds results by WHERE the query hit, so a query like
 * `spec.md` returns a useful spread — the exact-name page + folder, then a
 * bounded set of body hits, then a bounded set of path-substring hits — instead
 * of a wall of one match-class crowding the rest out.
 *
 * Three buckets partition the candidate set by match provenance:
 *   - `lexical`  — a real title/name match (exact / prefix / contains), an exact
 *     path, or a path-segment-prefix (bracket >= {@link LEXICAL_BRACKET_FLOOR}).
 *     These are the strongest "the user typed this name" hits and what the user
 *     most wants; the cap is set to the max display limit so lexical is bounded
 *     only by the overall `limit`, never trimmed below a weaker bucket. This
 *     preserves the existing "content pages are uncapped by the quota" contract:
 *     a name-matched page is `lexical`, and the per-kind quota leaves pages
 *     uncapped, so neither phase trims it.
 *   - `body`     — matched only on content (no lexical bracket). Content the user
 *     can't see from the name; bounded so body hits inform without flooding.
 *   - `pathOnly` — matched only as a path substring (bracket
 *     {@link PATH_SUBSTRING_BRACKET}) with no body match. The weakest signal
 *     (an incidental path-segment overlap), so it is capped tightest.
 *
 * Sized generously: the body/pathOnly caps only fire when one weak class would
 * otherwise dominate. Tunable — calibrate against a labeled query set, not by feel.
 */
const DEFAULT_LEXICAL_RESULT_CAP = MAX_WORKSPACE_SEARCH_LIMIT;
export const DEFAULT_BODY_RESULT_CAP = 6;
export const DEFAULT_PATH_ONLY_RESULT_CAP = 4;

/**
 * Lexical-bracket boundaries the category phase keys off. Kept beside the
 * brackets in {@link lexicalBracket} (700…450) so the split stays a single
 * contract: `>= LEXICAL_BRACKET_FLOOR` (500, title/name contains and stronger)
 * is the `lexical` bucket; exactly `PATH_SUBSTRING_BRACKET` (450, path substring
 * only) with no body match is `pathOnly`; everything else (no bracket, body-only)
 * is `body`. Adjust together with the bracket values.
 */
const LEXICAL_BRACKET_FLOOR = 500;
const PATH_SUBSTRING_BRACKET = 450;

const WORKSPACE_SEARCH_SCHEMA = {
  id: 'string',
  kind: 'enum',
  path: 'string',
  title: 'string',
  name: 'string',
  pathSegments: 'string',
  content: 'string',
  modifiedTs: 'number',
} as const;

type WorkspaceSearchDocumentField = 'title' | 'name' | 'path' | 'pathSegments' | 'content';
type WorkspaceSearchIndex = AnyOrama;

const workspaceSearchIndexes = new WeakMap<WorkspaceSearchCorpus, WorkspaceSearchIndex>();

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_WORKSPACE_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_WORKSPACE_SEARCH_LIMIT, Math.trunc(limit)));
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

const DOC_EXTENSION_RE = /\.(?:md|mdx)$/;

/**
 * Markdown docNames are extension-less, but the file tree shows `STORY.md` and a
 * user often types the filename with its extension. For `page` docs, match the
 * query with a trailing `.md`/`.mdx` stripped so `STORY.md` resolves to the page
 * named `STORY`. Non-markdown `file` entries keep their extension in `name`/`path`
 * (so `data.csv` matches the raw query); folders are unaffected. When stripping
 * would empty the query (a bare `.md` input), the original query is used
 * unchanged — so a bare extension can't match every page.
 */
function queryForKind(normalizedQuery: string, kind: WorkspaceSearchKind): string {
  if (kind !== 'page') return normalizedQuery;
  const stripped = normalizedQuery.replace(DOC_EXTENSION_RE, '');
  return stripped.length > 0 ? stripped : normalizedQuery;
}

export function workspaceSearchBasename(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function workspaceSearchPathSegments(path: string): string {
  return path.split('/').filter(Boolean).join(' ');
}

export function createWorkspaceSearchDocument(input: {
  kind: WorkspaceSearchKind;
  path: string;
  title?: string | null;
  content?: string | null;
  modifiedTs?: number | null;
  /**
   * Alternate paths the same on-disk file is reachable by (symlinks → one inode,
   * multiple paths). Their path segments fold into the searchable `pathSegments`
   * so a partial-path query matches EITHER the canonical or an alias path, while
   * the result still displays the canonical `path`. Only segments not already in
   * the canonical path are appended, so the no-alias case (the overwhelming
   * majority) yields the same `pathSegments` as if no aliases were considered.
   */
  aliases?: readonly string[] | null;
}): WorkspaceSearchDocument {
  const name = workspaceSearchBasename(input.path);
  const title = input.title?.trim() || name;
  const modifiedTs = input.modifiedTs ?? 0;
  const baseSegments = input.path.split('/').filter(Boolean);
  const baseSet = new Set(baseSegments);
  const aliasSegments = [
    ...new Set(
      (input.aliases ?? [])
        .flatMap((alias) => alias.split('/').filter(Boolean))
        .filter((segment) => !baseSet.has(segment)),
    ),
  ];
  return {
    id: `${input.kind}:${input.path}`,
    kind: input.kind,
    path: input.path,
    title,
    name,
    pathSegments: [...baseSegments, ...aliasSegments].join(' '),
    content: input.content ?? '',
    modifiedTs: Number.isFinite(modifiedTs) ? modifiedTs : 0,
  };
}

function createWorkspaceSearchIndex(
  documents: readonly WorkspaceSearchDocument[],
): WorkspaceSearchIndex {
  const db = create({ schema: WORKSPACE_SEARCH_SCHEMA });
  if (documents.length > 0) {
    insertMultiple(db, documents as WorkspaceSearchDocument[]);
  }
  return db;
}

export function createWorkspaceSearchCorpus(
  documents: readonly WorkspaceSearchDocument[],
): WorkspaceSearchCorpus {
  const corpus = {
    documents,
  };
  workspaceSearchIndexes.set(corpus, createWorkspaceSearchIndex(documents));
  return corpus;
}

function getWorkspaceSearchIndex(corpus: WorkspaceSearchCorpus): WorkspaceSearchIndex {
  const existing = workspaceSearchIndexes.get(corpus);
  if (existing) return existing;
  const index = createWorkspaceSearchIndex(corpus.documents);
  workspaceSearchIndexes.set(corpus, index);
  return index;
}

function defaultScopes(intent: WorkspaceSearchIntent): readonly WorkspaceSearchScope[] {
  // Autocomplete stays page-only: it backs the `[[wikilink]]` target picker,
  // whose resolution model is markdown-scoped (the all-files autocomplete target
  // set is a separate follow-up). Omnibar and full_text admit name-only file
  // entries so "search what you can see in the tree" holds.
  if (intent === 'autocomplete') return ['page'];
  if (intent === 'full_text') return ['page', 'content', 'file'];
  return ['page', 'folder', 'file'];
}

function scopeAllows(document: WorkspaceSearchDocument, scopes: ReadonlySet<WorkspaceSearchScope>) {
  if (scopes.has(document.kind)) return true;
  return document.kind === 'page' && scopes.has('content');
}

/**
 * Raw lexical match bracket: the discrete tier a doc earns from WHERE the query
 * hits (exact title/name 700 … path-substring 450; -1 = no lexical match). The
 * bracket values are a stable contract for the combined score and the
 * lexical/body tier split — adjust them together.
 */
function lexicalBracket(document: WorkspaceSearchDocument, query: string): number {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return 0;
  const q = queryForKind(normalizedQuery, document.kind);

  const title = normalize(document.title);
  const name = normalize(document.name);
  const path = normalize(document.path);
  const pathSegments = path.split('/');

  if (title === q || name === q) return 700;
  if (path === q) return 650;
  if (title.startsWith(q) || name.startsWith(q)) return 600;
  if (pathSegments.some((segment) => segment.startsWith(q))) return 550;
  if (title.includes(q) || name.includes(q)) return 500;
  if (path.includes(q)) return 450;
  return -1;
}

/**
 * Multiplier applied to a hidden / dot-path document's lexical bracket. Hidden
 * paths (a leading-dot segment: `.changeset/`, `.github/`, `.cursor/`) are
 * admitted to the search corpus so a user can find what the file tree shows, but
 * are mild-deprioritized so agent-tooling and dotfiles don't crowd canonical
 * content above an equivalent visible match. Halving the bracket keeps a hidden
 * hit one tier softer without burying it. Tunable.
 */
const HIDDEN_DOC_LEXICAL_PENALTY = 0.5;

/**
 * Lexical match score: the raw bracket, with a penalty for hidden / dot-path
 * documents. The no-match sentinel (-1) and the empty-query 0 pass through
 * unpenalized so candidate admission (`>= 0`) is unchanged. A corpus with no
 * hidden documents never triggers the penalty, so markdown-only ranking is
 * byte-identical to the pre-existing path.
 */
function lexicalScore(document: WorkspaceSearchDocument, query: string): number {
  const bracket = lexicalBracket(document, query);
  if (bracket <= 0) return bracket;
  return isHiddenDocName(document.path) ? bracket * HIDDEN_DOC_LEXICAL_PENALTY : bracket;
}

/**
 * Canonical-kind demotion: a non-markdown `file` entry ranks one notch below
 * an equivalent `page`/`folder` on a same-stem collision (e.g. `foo.md` over
 * `foo.ts` when neither body matches). Implemented as a demotion of `file` rather
 * than a boost of `page`, so a markdown-only corpus is byte-identical to the
 * pre-existing ranking (page/folder scores never move). Sized above the maximum
 * recency contribution (`recencyScores` caps at 50) so the page wins even when the
 * file is newer, yet far below the lexical bracket gaps so it only decides ties
 * and never overrides a genuinely stronger match. Tunable.
 */
const FILE_KIND_SCORE_DEMOTION = 60;

function canonicalKindAdjustment(kind: WorkspaceSearchKind): number {
  return kind === 'file' ? -FILE_KIND_SCORE_DEMOTION : 0;
}

/**
 * Tier-dominant gap. Multiplying the lexical bracket by this — far larger than
 * any within-tier secondary can reach — makes the bracket the PRIMARY sort key:
 * a higher bracket always outranks a lower one. The additive
 * `lexical + fullText*20 + …` violated that, because an unbounded body term
 * (0–~6000) swamped the bounded 450–700 bracket band, so a substring match with
 * a strong body score could outrank an exact-name match. Brackets are spaced
 * ≥25 apart (including the hidden-doc ×0.5 tier), so a gap of 1000 leaves a
 * ≥25000 cushion above the secondary's [0, ~2] range — no body/recency
 * combination can cross a tier.
 */
const TIER_DOMINANT_GAP = 1000;

/** Recency normalization divisor — `recencyScores` emits values in 0…this. */
const NAV_RECENCY_CAP = 50;

/**
 * Within-tier weights for the navigation (omnibar/autocomplete) score. Body and
 * recency are each normalized to [0,1] before weighting, so neither can cross a
 * tier; equal weights let a freshly-edited doc rise WITHIN its bracket without
 * ever displacing a higher-bracket match. Calibratable against a labeled query
 * set; the tier-dominant SHAPE is the load-bearing contract, not these values.
 */
const NAV_BODY_WEIGHT = 1;
const NAV_RECENCY_WEIGHT = 1;

/**
 * Smallest within-tier term: on an otherwise-exact tie (same bracket, equal
 * normalized body and recency) a markdown `page`/`folder` edges out a same-stem
 * non-markdown `file`, preserving `canonicalKindAdjustment`'s intent as a pure
 * tiebreaker. Sized below the recency term so an actively-edited file still
 * rises within its tier — a deliberate softening of the old −60 constant, which
 * outweighed recency.
 */
const NAV_KIND_NUDGE = 0.001;

/**
 * Navigation score (omnibar/autocomplete): tier-dominant. The lexical bracket,
 * scaled by {@link TIER_DOMINANT_GAP}, is the primary key; a normalized
 * body+recency secondary (plus a kind nudge) only reorders WITHIN a bracket.
 * `maxFullText` normalizes the body term against the strongest match in the
 * candidate set, so it stays on a [0,1] scale regardless of corpus-wide BM25
 * magnitudes.
 */
function navigationScore(
  lexical: number,
  fullText: number,
  recency: number,
  kind: WorkspaceSearchKind,
  maxFullText: number,
): number {
  const bodyNorm = maxFullText > 0 ? fullText / maxFullText : 0;
  const recencyNorm = NAV_RECENCY_CAP > 0 ? recency / NAV_RECENCY_CAP : 0;
  const kindNudge = kind === 'file' ? -NAV_KIND_NUDGE : 0;
  const secondary = NAV_BODY_WEIGHT * bodyNorm + NAV_RECENCY_WEIGHT * recencyNorm + kindNudge;
  return lexical * TIER_DOMINANT_GAP + secondary;
}

/**
 * Full-text (content-search) score: body-weighted additive. For `full_text`
 * intent the user IS searching content, so a strong body match should beat a
 * weak name match — the opposite priority from navigation. This is the
 * pre-tier-dominant formula, retained for `full_text` only.
 */
function fullTextScore(
  lexical: number,
  fullText: number,
  recency: number,
  kind: WorkspaceSearchKind,
): number {
  return lexical + fullText * 20 + recency + canonicalKindAdjustment(kind);
}

/**
 * Combined score by ranking mode: tier-dominant for `navigation`, body-weighted
 * for `relevance`.
 */
function combinedScore(
  ranking: WorkspaceSearchRanking,
  lexical: number,
  fullText: number,
  recency: number,
  kind: WorkspaceSearchKind,
  maxFullText: number,
): number {
  return ranking === 'relevance'
    ? fullTextScore(lexical, fullText, recency, kind)
    : navigationScore(lexical, fullText, recency, kind, maxFullText);
}

/**
 * Ranking mode for a request: an explicit `ranking` wins; otherwise it derives
 * from intent — `full_text` ranks by relevance, navigation intents
 * (`omnibar`/`autocomplete`) rank tier-dominant. Lets the omnibar pair a
 * `full_text` candidate set with `navigation` ordering.
 */
function resolveRanking(
  intent: WorkspaceSearchIntent,
  ranking: WorkspaceSearchRanking | undefined,
): WorkspaceSearchRanking {
  if (ranking) return ranking;
  return intent === 'full_text' ? 'relevance' : 'navigation';
}

/** Largest body (BM25) score across a candidate set, for navigation-score normalization. */
function maxFullTextScore(
  candidates: Iterable<WorkspaceSearchDocument>,
  fullTextScores: ReadonlyMap<string, number>,
): number {
  let max = 0;
  for (const document of candidates) {
    const value = fullTextScores.get(document.id) ?? 0;
    if (value > max) max = value;
  }
  return max;
}

function recencyScores(documents: readonly WorkspaceSearchDocument[]): Map<string, number> {
  const modifiedValues = documents
    .map((document) => document.modifiedTs)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (modifiedValues.length === 0) return new Map();

  let min = Infinity;
  let max = -Infinity;
  for (const v of modifiedValues) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = Math.max(1, max - min);
  return new Map(
    documents.map((document) => [
      document.id,
      document.modifiedTs > 0 ? ((document.modifiedTs - min) / range) * 50 : 0,
    ]),
  );
}

function searchProperties(intent: WorkspaceSearchIntent): WorkspaceSearchDocumentField[] {
  if (intent === 'full_text') return ['title', 'name', 'path', 'pathSegments', 'content'];
  return ['title', 'name', 'path', 'pathSegments'];
}

function searchBoost(
  intent: WorkspaceSearchIntent,
): Partial<Record<WorkspaceSearchDocumentField, number>> {
  if (intent === 'full_text') {
    return { title: 8, name: 7, path: 5, pathSegments: 4, content: 1 };
  }
  if (intent === 'autocomplete') {
    return { title: 10, name: 9, path: 5, pathSegments: 4 };
  }
  return { title: 8, name: 7, path: 5, pathSegments: 4 };
}

function toleranceFor(intent: WorkspaceSearchIntent, query: string): number {
  const normalizedQuery = normalize(query);
  if (normalizedQuery.length < 4) return 0;
  return intent === 'full_text' ? 1 : 0;
}

type SearchCategory = 'lexical' | 'body' | 'pathOnly';

/**
 * Classify a ranked result into one of the three category buckets by where the
 * query hit. `signals` already carries the lexical bracket and body score, so
 * the split is read off the result without re-deriving the match:
 *   - bracket `>= LEXICAL_BRACKET_FLOOR` → `lexical`
 *   - bracket exactly `PATH_SUBSTRING_BRACKET` with no body match → `pathOnly`
 *   - otherwise (body-only, or a path-substring that ALSO matched body) → `body`
 *
 * The hidden-doc penalty halves the bracket (×0.5), so the floor is compared
 * against the post-penalty `signals.lexical`. A hidden exact-name match lands at
 * 350 and would classify as `body` — acceptable: hidden/dot-path hits are
 * deprioritized by design, so treating them as a softer bucket is consistent.
 */
function categorize(result: WorkspaceSearchResult): SearchCategory {
  const { lexical, fullText } = result.signals;
  if (lexical >= LEXICAL_BRACKET_FLOOR) return 'lexical';
  if (lexical === PATH_SUBSTRING_BRACKET && fullText <= 0) return 'pathOnly';
  return 'body';
}

/**
 * Category-cap phase (navigation ranking only): bucket the ranked list by match
 * provenance, cap each bucket, then re-emit in the merge order lexical → body →
 * pathOnly. Within each bucket the input ranking order is preserved, so the
 * tier-dominant sort is intact — this phase only DROPS the over-cap tail of a
 * dominating class and reorders the surviving buckets into the priority merge.
 *
 * Runs before {@link finalizeResults}, so the per-kind quota still applies to
 * whatever survives the category caps. The two compose: category bounds by WHERE
 * the query hit, kind bounds folders/files within that.
 */
function applyCategoryCaps(ranked: readonly WorkspaceSearchResult[]): WorkspaceSearchResult[] {
  const lexical: WorkspaceSearchResult[] = [];
  const body: WorkspaceSearchResult[] = [];
  const pathOnly: WorkspaceSearchResult[] = [];
  for (const result of ranked) {
    const category = categorize(result);
    if (category === 'lexical') {
      if (lexical.length < DEFAULT_LEXICAL_RESULT_CAP) lexical.push(result);
    } else if (category === 'body') {
      if (body.length < DEFAULT_BODY_RESULT_CAP) body.push(result);
    } else if (pathOnly.length < DEFAULT_PATH_ONLY_RESULT_CAP) {
      pathOnly.push(result);
    }
  }
  return [...lexical, ...body, ...pathOnly];
}

/**
 * Final selection from a fully-ranked candidate list: apply the per-kind quota,
 * then take the top `limit`. Walks the WHOLE ranked list (not a pre-sliced
 * top-N) so pages promoted past capped folders/files are pulled from however
 * deep they rank — e.g. `evidence` is all exact-name folders up front, with the
 * matching pages ranked below them.
 */
function finalizeResults(
  ranked: readonly WorkspaceSearchResult[],
  ranking: WorkspaceSearchRanking,
  limit: number,
): WorkspaceSearchResult[] {
  if (ranking === 'relevance') return ranked.slice(0, limit);
  // Category-cap phase first (navigation only): bound each match-provenance
  // bucket so no single class floods, then the per-kind quota below trims
  // folders/files within the survivors. Relevance returned above is untouched.
  const categorized = applyCategoryCaps(ranked);
  const selected: WorkspaceSearchResult[] = [];
  let folders = 0;
  let files = 0;
  for (const result of categorized) {
    if (result.document.kind === 'folder') {
      if (folders >= DEFAULT_FOLDER_RESULT_CAP) continue;
      folders += 1;
    } else if (result.document.kind === 'file') {
      if (files >= DEFAULT_FILE_RESULT_CAP) continue;
      files += 1;
    }
    selected.push(result);
    if (selected.length >= limit) break;
  }
  return selected;
}

export function searchWorkspaceDocuments(
  documents: readonly WorkspaceSearchDocument[],
  query: string,
  options: WorkspaceSearchOptions = {},
): WorkspaceSearchResult[] {
  return searchWorkspaceCorpus(createWorkspaceSearchCorpus(documents), query, options);
}

export function searchWorkspaceCorpus(
  corpus: WorkspaceSearchCorpus,
  query: string,
  options: WorkspaceSearchOptions = {},
): WorkspaceSearchResult[] {
  const intent = options.intent ?? 'omnibar';
  const ranking = resolveRanking(intent, options.ranking);
  const limit = clampLimit(options.limit);
  const scopes = new Set(options.scopes ?? defaultScopes(intent));
  const scopedDocuments = corpus.documents.filter((document) => scopeAllows(document, scopes));
  const normalizedQuery = normalize(query);

  if (!normalizedQuery) {
    return scopedDocuments
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, limit)
      .map((document) => ({
        document,
        score: 0,
        signals: { lexical: 0, fullText: 0, recency: 0 },
      }));
  }

  const fullTextResults = search(getWorkspaceSearchIndex(corpus), {
    term: normalizedQuery,
    properties: searchProperties(intent),
    boost: searchBoost(intent),
    tolerance: toleranceFor(intent, normalizedQuery),
    limit: Math.max(limit * 4, 40),
  }) as {
    hits: Array<{ score: number; document: WorkspaceSearchDocument }>;
  };
  const fullTextScores = new Map(
    fullTextResults.hits
      .filter((hit) => scopeAllows(hit.document, scopes))
      .map((hit) => [hit.document.id, hit.score] as const),
  );
  const recency = recencyScores(scopedDocuments);
  const candidates = new Map<string, WorkspaceSearchDocument>();

  for (const document of scopedDocuments) {
    if (lexicalScore(document, normalizedQuery) >= 0) {
      candidates.set(document.id, document);
    }
  }
  for (const hit of fullTextResults.hits) {
    if (!scopeAllows(hit.document, scopes)) continue;
    candidates.set(hit.document.id, hit.document);
  }

  if (!options.semantic) {
    // Non-semantic (default) ranking. The parity fixture pins this path's output;
    // regenerate it when this ranking changes intentionally. Do not fold this
    // into the semantic branch — they share candidate selection, not ordering.
    const maxFullText = maxFullTextScore(candidates.values(), fullTextScores);
    const ranked = [...candidates.values()]
      .map((document) => {
        const lexical = Math.max(0, lexicalScore(document, normalizedQuery));
        const fullText = fullTextScores.get(document.id) ?? 0;
        const recencyScore = recency.get(document.id) ?? 0;
        return {
          document,
          score: combinedScore(
            ranking,
            lexical,
            fullText,
            recencyScore,
            document.kind,
            maxFullText,
          ),
          signals: { lexical, fullText, recency: recencyScore },
        };
      })
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return a.document.path.localeCompare(b.document.path);
      });
    return finalizeResults(ranked, ranking, limit);
  }

  return finalizeResults(
    rankWithVector({
      scopedDocuments,
      candidates,
      fullTextScores,
      recency,
      normalizedQuery,
      ranking,
      semantic: options.semantic,
    }),
    ranking,
    limit,
  );
}

interface SemanticRow {
  document: WorkspaceSearchDocument;
  score: number;
  signals: WorkspaceSearchResult['signals'];
  lexical: number;
  fullText: number;
  recency: number;
  cosine: number | undefined;
}

/** Assign 1-based ranks to an already-ordered list of doc ids. */
function denseRank(orderedIds: readonly string[]): Map<string, number> {
  const ranks = new Map<string, number>();
  orderedIds.forEach((id, i) => {
    ranks.set(id, i + 1);
  });
  return ranks;
}

/**
 * Semantic ranking. Two changes over the pre-embeddings path:
 *
 *  1. Candidate SOURCE: the top-K docs by cosine (≥ floor) are unioned into the
 *     candidate pool, so a doc that matches ONLY semantically — sharing a
 *     concept but no tokens with the query — can be retrieved at all. A
 *     re-ranker confined to the lexical∪BM25 union never could.
 *
 *  2. Brackets-outer / RRF-in-body: the lexical bracket tier stays the dominant
 *     sort — any doc with a title/name/path bracket ranks above every
 *     body-only/semantic-only doc, so a strong cosine can never displace an
 *     exact-title match. Within the lexical tier we reuse the flag-OFF combined
 *     score (tier-dominant for navigation ranking, body-weighted for relevance)
 *     so the two flag states agree on lexical ordering; the body tier
 *     (no lexical bracket) is ordered by RRF(BM25 rank, vector rank), which
 *     fuses the two scale-incompatible signals without normalizing BM25 against
 *     cosine.
 *
 * The lexical tier is ordered by the same combined score as the flag-OFF path,
 * rather than re-sorted by discrete bracket — so turning the vector feature on
 * never perturbs the established within-lexical ordering. The eval's
 * lexical-strong regression budget guards this choice.
 *
 * The cosine travels in `signals.vector`. In the body tier the `score` magnitude
 * is not monotonic with rank — that is intended (rank-based fusion), and
 * `signals.vector` explains the ordering.
 */
function rankWithVector(args: {
  scopedDocuments: readonly WorkspaceSearchDocument[];
  candidates: Map<string, WorkspaceSearchDocument>;
  fullTextScores: ReadonlyMap<string, number>;
  recency: ReadonlyMap<string, number>;
  normalizedQuery: string;
  ranking: WorkspaceSearchRanking;
  semantic: WorkspaceSemanticInput;
}): WorkspaceSearchResult[] {
  const {
    scopedDocuments,
    candidates,
    fullTextScores,
    recency,
    normalizedQuery,
    ranking,
    semantic,
  } = args;
  const rrfK = semantic.rrfK ?? DEFAULT_RRF_K;
  const candidateLimit = semantic.candidateLimit ?? DEFAULT_VECTOR_CANDIDATE_LIMIT;
  const floor = semantic.similarityFloor ?? DEFAULT_VECTOR_SIMILARITY_FLOOR;
  const vectorScores = semantic.scores;

  // Union the top-K in-scope docs by cosine (≥ floor) into the candidates.
  const scopedById = new Map(scopedDocuments.map((d) => [d.id, d] as const));
  const topVector = [...vectorScores.entries()]
    .filter(([id, cos]) => cos >= floor && scopedById.has(id))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, candidateLimit);
  for (const [id] of topVector) {
    if (!candidates.has(id)) {
      const doc = scopedById.get(id);
      if (doc) candidates.set(id, doc);
    }
  }

  // Body normalization basis for the lexical tier's navigation score — computed
  // after the vector union so it spans every candidate the body tier can see.
  const maxFullText = maxFullTextScore(candidates.values(), fullTextScores);

  const rows: SemanticRow[] = [...candidates.values()].map((document) => {
    const lexical = Math.max(0, lexicalScore(document, normalizedQuery));
    const fullText = fullTextScores.get(document.id) ?? 0;
    const recencyScore = recency.get(document.id) ?? 0;
    const cosine = vectorScores.get(document.id);
    // Surface `vector` only when the cosine clears the floor — i.e. when it
    // actually qualified as a signal (candidate source / body-tier RRF use the
    // same `>= floor` gate). A sub-floor cosine has zero ranking influence, so
    // reporting it would make `signals.vector` (and the response's `applied`
    // flag derived from it) claim a contribution that never happened. Ranking
    // below uses the local `cosine`, not `signals.vector`, so this is display-only.
    const qualifies = cosine !== undefined && cosine >= floor;
    // Lexical-tier rows score by the intent-aware combined score (tier-dominant
    // for navigation, body-weighted for full_text) — the same value the
    // flag-OFF path uses, so a bracket-700 match outranks a body-heavy partial
    // WITHIN the tier. Body-only rows (lexical 0) keep the body-weighted value;
    // the RRF comparator below — not this score — orders that tier.
    const score =
      lexical > 0
        ? combinedScore(ranking, lexical, fullText, recencyScore, document.kind, maxFullText)
        : fullTextScore(lexical, fullText, recencyScore, document.kind);
    return {
      document,
      score,
      signals: qualifies
        ? { lexical, fullText, recency: recencyScore, vector: cosine }
        : { lexical, fullText, recency: recencyScore },
      lexical,
      fullText,
      recency: recencyScore,
      cosine,
    };
  });

  // Global ranks over the full candidate set, used to order the body tier.
  const bm25Rank = denseRank(
    rows
      .filter((r) => r.fullText > 0)
      .sort((a, b) => b.fullText - a.fullText || a.document.path.localeCompare(b.document.path))
      .map((r) => r.document.id),
  );
  const vecRank = denseRank(
    rows
      // Type predicate (not a bare boolean) so `cosine` narrows to `number`
      // through the sort below — no `as number` cast that a later refactor of
      // the `>= floor` guard could silently turn into NaN comparisons.
      .filter(
        (r): r is SemanticRow & { cosine: number } => r.cosine !== undefined && r.cosine >= floor,
      )
      .sort((a, b) => b.cosine - a.cosine || a.document.path.localeCompare(b.document.path))
      .map((r) => r.document.id),
  );

  const rrfScore = (id: string): number => {
    let s = 0;
    const br = bm25Rank.get(id);
    if (br !== undefined) s += 1 / (rrfK + br);
    const vr = vecRank.get(id);
    if (vr !== undefined) s += 1 / (rrfK + vr);
    return s;
  };

  return rows
    .sort((a, b) => {
      const aLexical = a.lexical > 0 ? 1 : 0;
      const bLexical = b.lexical > 0 ? 1 : 0;
      if (aLexical !== bLexical) return bLexical - aLexical; // lexical tier first
      if (aLexical === 1) {
        if (a.score !== b.score) return b.score - a.score; // within lexical tier: legacy order
        return a.document.path.localeCompare(b.document.path);
      }
      const ar = rrfScore(a.document.id);
      const br = rrfScore(b.document.id);
      if (ar !== br) return br - ar; // body tier: RRF(BM25, vector)
      if (a.recency !== b.recency) return b.recency - a.recency;
      return a.document.path.localeCompare(b.document.path);
    })
    .map(({ document, score, signals }) => ({ document, score, signals }));
}
