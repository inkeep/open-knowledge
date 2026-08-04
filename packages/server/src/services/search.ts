import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  isHiddenDocName,
  LEGACY_SKILL_STORE_ROOT,
  parseProjectSkillBundleDoc,
  type SearchSemanticStatus,
  type SearchSource,
  type SearchSuccess,
  SKILL_NAME_REGEX,
  searchWorkspaceCorpus,
  updateWorkspaceSearchCorpus,
  type WorkspaceSearchCorpus,
  type WorkspaceSearchDocument,
  type WorkspaceSearchIntent,
  type WorkspaceSearchRanking,
  type WorkspaceSearchResult,
  type WorkspaceSearchScope,
  type WorkspaceSemanticInput,
} from '@inkeep/open-knowledge-core';
import { isConfigDoc, isSystemDoc } from '../cc1-broadcast.ts';
import {
  recordSemanticQuery,
  type SemanticQueryOutcome,
} from '../embeddings/embeddings-telemetry.ts';
import { SEMANTIC_MIN_QUERY_LENGTH, type SemanticSearchService } from '../embeddings/index.ts';
import type { FileIndexEntry } from '../file-watcher.ts';
import { scanInPlaceSkills } from '../in-place-skills.ts';
import { getLogger } from '../logger.ts';
import { extractPageTitle } from '../page-identity.ts';
import { getMeter } from '../telemetry.ts';

/**
 * Workspace search: corpus build (page + skill + name-only file + folder
 * tiers), fingerprint-keyed caching with incremental index updates, the
 * cold-start warming gate, and the opt-in semantic blend. The transport
 * parses params and maps `SearchSuccess` onto the wire; everything between
 * lives here so GET and POST cannot drift in ranking, snippets, or the
 * semantic gate.
 */

const log = getLogger('search');

// Count of workspace search corpus builds, by mode: `cold` (first build),
// `incremental` (in-place index patch of only the changed documents), or
// `rebuild` (incremental path fell back to a from-scratch build; the bounded
// `reason` attribute says why). A steady stream of `rebuild` where
// `incremental` is expected is the drift signal worth alerting on.
let _searchCorpusUpdateCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null =
  null;
function searchCorpusUpdateCounter(): ReturnType<ReturnType<typeof getMeter>['createCounter']> {
  _searchCorpusUpdateCounter ||= getMeter().createCounter('ok.search.corpus_update_total', {
    description:
      'Count of workspace search corpus builds, by mode (cold | incremental | rebuild) and, for rebuilds, the bounded fallback reason.',
  });
  return _searchCorpusUpdateCounter;
}

let _searchCorpusTruncatedCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null =
  null;
function searchCorpusTruncatedCounter(): ReturnType<ReturnType<typeof getMeter>['createCounter']> {
  _searchCorpusTruncatedCounter ||= getMeter().createCounter('ok.search.corpus_truncated_total', {
    description:
      'Count of corpus builds whose name-only file tier was truncated at OK_SEARCH_MAX_ENTRIES.',
  });
  return _searchCorpusTruncatedCounter;
}

interface WorkspaceSearchCacheEntry {
  fingerprint: string;
  corpus?: WorkspaceSearchCorpus;
  truncated?: boolean;
  pending?: Promise<{ corpus: WorkspaceSearchCorpus; truncated: boolean }>;
}

const workspaceSearchCaches = new Map<string, WorkspaceSearchCacheEntry>();

function deriveFolderSearchDocuments(
  pages: readonly WorkspaceSearchDocument[],
): WorkspaceSearchDocument[] {
  const folderModified = new Map<string, number>();
  for (const page of pages) {
    const segments = page.path.split('/').filter(Boolean);
    segments.pop();
    for (let i = 1; i <= segments.length; i++) {
      const folderPath = segments.slice(0, i).join('/');
      folderModified.set(
        folderPath,
        Math.max(folderModified.get(folderPath) ?? 0, page.modifiedTs),
      );
    }
  }
  return [...folderModified.entries()].map(([path, modifiedTs]) =>
    createWorkspaceSearchDocument({ kind: 'folder', path, modifiedTs }),
  );
}

function buildSearchSnippet(content: string, query: string): string | undefined {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery || !content) return undefined;
  const normalizedContent = content.toLowerCase();
  const index = normalizedContent.indexOf(normalizedQuery);
  if (index < 0) return undefined;
  const start = Math.max(0, index - 80);
  const end = Math.min(content.length, index + normalizedQuery.length + 120);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  // slice() cuts on UTF-16 code units, so a boundary landing mid-emoji leaves a
  // lone surrogate. Replace any unpaired surrogate with U+FFFD so strict JSON-RPC
  // clients (Rust / pydantic parsers) don't reject the response as invalid UTF-8.
  // (String.toWellFormed() would do this but needs the es2024 lib in every consumer.)
  const snippet = `${prefix}${content.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
  return snippet.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  );
}

/** Map a search result to the wire entry, carrying `vector` only when present. */
function toSearchResultEntry(
  result: ReturnType<typeof searchWorkspaceCorpus>[number],
  query: string,
): {
  kind: WorkspaceSearchScope;
  path: string;
  title: string;
  score: number;
  signals: WorkspaceSearchResult['signals'];
  snippet?: string;
} {
  return {
    kind: result.document.kind,
    path: result.document.path,
    title: result.document.title,
    score: result.score,
    signals: result.signals,
    snippet:
      result.document.kind === 'page'
        ? buildSearchSnippet(result.document.content, query)
        : undefined,
  };
}

// Per-entry change-detection key: the fields whose change should re-read a
// page (modified / size / canonical path / inode / aliases), NUL-separated so
// a path containing spaces can't merge fields and collide. `workspaceSearchFingerprint`'s
// fallback prefixes this with the docName; the page-doc cache keys on it
// directly (its Map is already docName-keyed). One definition keeps the two in
// lockstep — drift would silently break cache invalidation (stale reuse or
// needless re-reads).
function entrySearchKey(entry: FileIndexEntry): string {
  // NUL between fields AND between aliases: a path/alias containing a comma
  // (rare but valid on macOS/Linux) must not collide with a different alias set.
  return `${entry.modified}\0${entry.size}\0${entry.canonicalPath}\0${entry.inode}\0${entry.aliases.join('\0')}`;
}

interface SemanticResolution {
  /** Vector input for `searchWorkspaceCorpus`, or undefined for pure-lexical. */
  input?: WorkspaceSemanticInput;
  /** Non-content coverage status block to attach to the response. */
  status?: SearchSemanticStatus;
  /** Per-query embed latency (ms), or null when no query embed ran. */
  queryEmbedMs: number | null;
  /** Total embeddable pages (coverage denominator). */
  pageTotal: number;
  /** Whether the embedder is loaded + keyed + warm. */
  capable: boolean;
}

export interface SearchServiceDeps {
  contentDir: string;
  projectDir?: string;
  getAllFilesIndex: () => ReadonlyMap<string, FileIndexEntry>;
  getFileIndexGeneration?: () => number;
  getSearchMaxEntries: () => number;
  semanticSearch?: SemanticSearchService;
  getSemanticSimilarityFloor?: () => number | undefined;
  /** Boot index seed gate; absent (test harnesses) means ready immediately. */
  ready?: Promise<unknown>;
  /** The project-scope legacy skill-store root. */
  getProjectSkillsRoot: () => string;
  parseFrontmatterDoc: (raw: string) => { frontmatter: Record<string, unknown>; body: string };
}

export interface SearchService {
  buildSearchResponse(params: {
    query: string;
    intent: WorkspaceSearchIntent;
    ranking: WorkspaceSearchRanking | undefined;
    scopes: WorkspaceSearchScope[] | undefined;
    limit: number | undefined;
    semanticParam: boolean | undefined;
    source: SearchSource;
  }): Promise<SearchSuccess>;
  prewarm(): void;
}

export function createSearchService(deps: SearchServiceDeps): SearchService {
  const {
    contentDir,
    projectDir,
    getAllFilesIndex,
    getFileIndexGeneration,
    semanticSearch,
    getSemanticSimilarityFloor,
    ready,
  } = deps;

  /**
   * Resolve the per-query vector signal + coverage status for a search.
   *
   * Returns a pure-lexical resolution (no `input`, no `status`) — byte-identical
   * to the pre-embeddings path — unless the feature flag is ON **and** the caller
   * opted in (`semantic: true`). The omnibar and `semantic: false` never opt in,
   * so they stay lexical and carry no status block. When opted-in, fires the lazy
   * background corpus embed (no-op when incapable) and embeds only the query.
   */
  async function resolveSemantic(
    query: string,
    intent: WorkspaceSearchIntent,
    semanticParam: boolean | undefined,
    corpus: WorkspaceSearchCorpus,
  ): Promise<SemanticResolution> {
    // Predicate split: hidden / dot-path docs are searchable (admitted to the
    // corpus) but NEVER embedded — no semantic egress for agent-tooling/dotfiles.
    // The embeddable set is the corpus minus hidden paths, and it also drives the
    // coverage denominator so a searchable dot-path page is never counted as
    // "embeddable" (which would make coverage under-report forever).
    const embeddableDocs = corpus.documents.filter((d) => !isHiddenDocName(d.path));
    const pageTotal = embeddableDocs.reduce((n, d) => n + (d.kind === 'page' ? 1 : 0), 0);
    // Flag OFF, or the caller did not opt in → no status block, lexical path.
    if (!semanticSearch?.isEnabled() || semanticParam !== true) {
      return { queryEmbedMs: null, pageTotal, capable: false };
    }

    // Opted in + enabled: lazily (re-)embed the corpus in the background. Cheap
    // for unchanged docs; no-op when no key. This is the only embed trigger —
    // nothing embeds until an agent actually searches (no proactive egress).
    void semanticSearch.embedCorpus(embeddableDocs);

    // Semantic fuses into the body blend only, and skips trivially short queries.
    let input: WorkspaceSemanticInput | undefined;
    let queryEmbedMs: number | null = null;
    if (intent === 'full_text' && query.trim().length >= SEMANTIC_MIN_QUERY_LENGTH) {
      const startedAt = performance.now();
      const scores = await semanticSearch.queryScores(query, embeddableDocs);
      queryEmbedMs = performance.now() - startedAt;
      if (scores && scores.size > 0) {
        // Carry the project-local similarity floor when set so a model whose
        // cosine scale differs from the default can be retuned without a code
        // change; undefined leaves core on its model-calibrated default.
        const similarityFloor = getSemanticSimilarityFloor?.();
        input = similarityFloor !== undefined ? { scores, similarityFloor } : { scores };
      }
    }

    const status = semanticSearch.getStatus();
    return {
      input,
      status: {
        capable: status.capable,
        applied: false, // finalized post-ranking (did any result carry a vector)
        coverage: { embedded: status.embeddedCount, total: pageTotal },
      },
      queryEmbedMs,
      pageTotal,
      capable: status.capable,
    };
  }

  /**
   * Project skills (`<root>/.ok/skills/<name>/SKILL.md`) as cheap stat records —
   * readdir + stat only, no content read — so the per-search corpus fingerprint
   * can detect skill changes without paying a content read on every request.
   * Skills are tree-excluded from `getFileIndex()`, so search enumerates them
   * from disk. The corpus doc builder reuses this list and reads each matched
   * file's content.
   */
  function enumerateProjectSkillStats(): Array<{
    name: string;
    absolutePath: string;
    /** The skill's LIVE content-doc path (`<real dir>/SKILL`) — what search
     *  hits open. In-place skills carry their editor-dir path; only a legacy
     *  store resident still carries the `.ok/skills` shape. */
    docPath: string;
    mtimeMs: number;
    size: number;
  }> {
    const out: Array<{
      name: string;
      absolutePath: string;
      docPath: string;
      mtimeMs: number;
      size: number;
    }> = [];
    const seen = new Set<string>();
    // In-place skills FIRST (they win a name collision with a store resident,
    // mirroring the list/read rules). Enumerating only the store root here was
    // a store-retirement fossil: in-place skills vanished from search entirely,
    // and the ones indexed opened phantom `.ok/skills` tabs.
    for (const skill of scanInPlaceSkills(contentDir)) {
      const skillMd = resolve(contentDir, skill.dir, 'SKILL.md');
      try {
        const st = statSync(skillMd);
        out.push({
          name: skill.name,
          absolutePath: skillMd,
          docPath: `${skill.dir}/SKILL`,
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
        seen.add(skill.name);
      } catch {
        // Vanished between scan and stat — skip.
      }
    }
    const root = deps.getProjectSkillsRoot();
    if (!existsSync(root)) return out;
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !SKILL_NAME_REGEX.test(entry.name)) continue;
      if (seen.has(entry.name)) continue;
      const skillMd = resolve(root, entry.name, 'SKILL.md');
      try {
        const st = statSync(skillMd);
        out.push({
          name: entry.name,
          absolutePath: skillMd,
          docPath: `${LEGACY_SKILL_STORE_ROOT}/${entry.name}/SKILL`,
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      } catch {
        // Missing/unreadable SKILL.md — skip (a draft dir with no manifest).
      }
    }
    return out;
  }

  /**
   * Project skills as search documents (keyword + semantic — `embedCorpus`
   * embeds every corpus doc). Indexed under their managed-artifact doc path so a
   * hit opens the skill tab via the shared nav resolution. Title is the skill's
   * frontmatter name; content is its description + body, so a skill is findable
   * by what it does, not just its slug.
   */
  function buildSkillSearchDocuments(): WorkspaceSearchDocument[] {
    const docs: WorkspaceSearchDocument[] = [];
    for (const skill of enumerateProjectSkillStats()) {
      let title = skill.name;
      let content = '';
      try {
        const { frontmatter, body } = deps.parseFrontmatterDoc(
          readFileSync(skill.absolutePath, 'utf-8'),
        );
        if (typeof frontmatter.name === 'string' && frontmatter.name) title = frontmatter.name;
        const desc = typeof frontmatter.description === 'string' ? frontmatter.description : '';
        content = `${desc}\n\n${body}`.trim();
      } catch {
        // Malformed/unreadable — index by name only so it is still findable.
      }
      docs.push(
        createWorkspaceSearchDocument({
          kind: 'page',
          // Index under the skill's LIVE content-doc path (real dir), never a
          // minted shape — a minted `__skill__/project/<name>` OR `.ok/skills`
          // path both made a search hit open a blank phantom tab.
          path: skill.docPath,
          title,
          content,
          modifiedTs: skill.mtimeMs,
        }),
      );
    }
    return docs;
  }

  // Per-page parsed-document cache. Building the corpus re-reads every markdown
  // file from disk, but a rebuild is triggered by ANY file-index change (one
  // edit, a rename, a new sibling), so without this every keystroke-after-an-edit
  // would re-read and re-parse the whole workspace. Reuse a page's search
  // document across rebuilds when its own entry is unchanged — re-reading only
  // the delta. Invariant direction: a change that busts THIS page's `entrySearchKey`
  // also bumps the generation counter that invalidates the corpus — but NOT the
  // converse: a rebuild triggered by a sibling change reuses this page's cached
  // doc when its own entry is unchanged (the whole point). Only successful reads
  // are cached, so a transient read failure self-heals on the next rebuild rather
  // than pinning empty content. Pruned to the live index each build, so it stays
  // bounded by the workspace size. The name-only `file` tier and derived folder
  // docs are metadata-only (no disk read), so they are rebuilt each time.
  const pageDocCache = new Map<string, { key: string; doc: WorkspaceSearchDocument }>();

  async function buildWorkspaceSearchDocumentsFromIndex(): Promise<{
    documents: WorkspaceSearchDocument[];
    truncated: boolean;
  }> {
    const pages: WorkspaceSearchDocument[] = [];
    const files: WorkspaceSearchDocument[] = [];
    const seenPages: Set<string> = new Set();
    for (const [docName, entry] of getAllFilesIndex()) {
      // System + config synthetic docs never enter search. Hidden / dot-prefixed
      // paths (`.changeset/`, `.github/`, `.cursor/`) DO — they are searchable by
      // name/path (rank-deprioritized in core) so "search what the tree shows"
      // holds. They stay out of the embedding/egress path, which keeps the
      // `isHiddenDocName` filter where the corpus is handed to the embedder.
      if (isSystemDoc(docName) || isConfigDoc(docName)) continue;
      // Project-skill SKILL docs ARE in the index (skills-as-content), and this
      // loop iterates the all-files view — but `buildSkillSearchDocuments()`
      // already indexes each skill with skill-aware title/content under the same
      // path. Skip ANY project SKILL-doc shape (in-place editor dirs AND the
      // legacy store) so one isn't added twice (a duplicate corpus id throws and
      // 500s the whole search). Bundle reference docs stay — they index as
      // ordinary pages.
      if (parseProjectSkillBundleDoc(docName)?.kind === 'skill') continue;
      if (docName.startsWith('.ok/skills/')) continue;
      if (entry.kind === 'file') {
        // Name-only tier: a non-markdown file is searchable by name / path /
        // folder, but its body is NEVER read (content stays markdown-only).
        // `pathToDocName` keeps the extension for non-markdown, so `data.csv`
        // is findable by both `data` and `data.csv`; the basename is the title.
        files.push(
          createWorkspaceSearchDocument({
            kind: 'file',
            path: docName,
            modifiedTs: Date.parse(entry.modified),
            // Symlink alias paths fold into searchable pathSegments (inode-dedup
            // already gives one entry per file via the canonical-keyed index).
            aliases: entry.aliases,
          }),
        );
        continue;
      }
      // Markdown page: reuse the cached parse when its entry is unchanged (same
      // fingerprint components), else re-read and re-cache.
      seenPages.add(docName);
      const entryKey = entrySearchKey(entry);
      const cached = pageDocCache.get(docName);
      if (cached && cached.key === entryKey) {
        pages.push(cached.doc);
        continue;
      }
      let content = '';
      let title = docName;
      let readFailed = false;
      try {
        content = await readFile(entry.canonicalPath, 'utf-8');
      } catch (err) {
        // A transient read (external editor mid-save, EBUSY, NFS blip, a
        // watcher-vs-disk race) must NOT be cached — the entry fingerprint does
        // not change just because the read failed, so a cached empty-content doc
        // would persist and silently hide the page from body search until its
        // mtime/size/inode shifts. Skip the cache write so the next rebuild
        // retries, preserving the pre-cache self-healing behavior.
        readFailed = true;
        log.warn({ docName, err }, `[search] Failed to read ${docName}`);
      }
      if (!readFailed) {
        try {
          title = extractPageTitle(content, docName);
        } catch (err) {
          // Title extraction is pure string work, so a throw here is a
          // deterministic parse fault, not transient I/O. Fall back to the
          // docName as title but still cache (the read succeeded) — caching it
          // avoids re-parsing the same failing content on every rebuild, the
          // opposite of the read-failure path's deliberate retry.
          log.warn({ docName, err }, `[search] Failed to extract title for ${docName}`);
        }
      }
      const doc = createWorkspaceSearchDocument({
        kind: 'page',
        path: docName,
        title,
        content,
        modifiedTs: Date.parse(entry.modified),
        aliases: entry.aliases,
      });
      if (!readFailed) pageDocCache.set(docName, { key: entryKey, doc });
      pages.push(doc);
    }
    // Prune cache entries for pages no longer in the index (deleted / renamed)
    // so the cache tracks the live workspace rather than growing unbounded.
    // Unconditional: a failed read adds to `seenPages` but not to the cache, so
    // a `size`-comparison guard could read equal and skip a genuinely-needed
    // prune. The loop is O(cache) — same order as the build it follows.
    for (const docName of pageDocCache.keys()) {
      if (!seenPages.has(docName)) pageDocCache.delete(docName);
    }
    // Cap the name-only file tier (markdown pages are never dropped). Over the
    // ceiling, drop DEEPEST paths first (level-order): the shallowest entries are
    // the most navigationally useful, and dropping the deep tail mirrors the
    // show-all truncation BFS. The dogfood repo (~16k) is far under the
    // 50k default; this is a pathological-repo backstop.
    const maxFiles = deps.getSearchMaxEntries();
    let admittedFiles = files;
    let truncated = false;
    if (files.length > maxFiles) {
      truncated = true;
      admittedFiles = [...files]
        .sort((a, b) => {
          const depthA = a.path.split('/').length;
          const depthB = b.path.split('/').length;
          return depthA - depthB || a.path.localeCompare(b.path);
        })
        .slice(0, maxFiles);
      // Surface the cap-fire to operators: a structured warn log + a meter
      // counter. Without these the cap is silent — operators see "search
      // missing some files" with no signal pointing at `OK_SEARCH_MAX_ENTRIES`.
      // One emission per corpus rebuild (the cache then absorbs subsequent
      // queries until the fingerprint changes).
      log.warn(
        {
          dropped: files.length - admittedFiles.length,
          retained: admittedFiles.length,
          limit: maxFiles,
        },
        '[search] corpus name-only file tier truncated at OK_SEARCH_MAX_ENTRIES',
      );
      searchCorpusTruncatedCounter().add(1);
    }
    // Folders are synthesized from ALL admitted paths (markdown pages + name-only
    // file entries), so a folder containing only non-markdown files is still a
    // search result and a partial-path query (e.g. `server/src`) resolves even
    // when the folder holds no markdown.
    const documents = [
      ...pages,
      ...buildSkillSearchDocuments(),
      ...admittedFiles,
      ...deriveFolderSearchDocuments([...pages, ...admittedFiles]),
    ];
    return { documents, truncated };
  }

  // Stat-only skill fingerprint (name + mtime + size per project skill). A
  // named helper, not a local `const`, so the getAllFilesIndex caller-coverage
  // meta-test attributes the call in `workspaceSearchFingerprint` to that
  // allowlisted function rather than to an intermediate binding.
  function skillStatFingerprint(): string {
    return enumerateProjectSkillStats()
      .map((s) => `${s.name} ${s.mtimeMs} ${s.size}`)
      .join('');
  }

  function workspaceSearchFingerprint(): string {
    // Skills are tree-excluded from the file index, so neither the generation
    // counter nor getAllFilesIndex reflects a skill add/edit/remove. Fold the
    // stat-only skill fingerprint into BOTH paths so the corpus rebuilds on a
    // skill change (no content read on the per-search fingerprint path).
    // Fast path: the watcher's monotonic generation counter bumps on every
    // file-index mutation (the same counter that memoizes the markdown-only
    // view), so a generation match proves the corpus is still valid in O(1).
    if (getFileIndexGeneration) {
      return `gen:${getFileIndexGeneration()}|skills${skillStatFingerprint()}`;
    }
    // Fallback for harnesses that wire only the index accessors. Admission
    // predicate MUST match `buildWorkspaceSearchDocumentsFromIndex` so a
    // change to a now-searchable dot-path busts the corpus cache.
    return `${[...getAllFilesIndex()]
      .filter(([docName]) => !isSystemDoc(docName) && !isConfigDoc(docName))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        // Shares `entrySearchKey` with the page-doc cache so the two never drift.
        ([docName, entry]) => `${docName}\0${entrySearchKey(entry)}`,
      )
      .join('')}|skills${skillStatFingerprint()}`;
  }

  // Cold-start search readiness. While the boot index seed is still walking the
  // content dir, `/api/search` must not block on it nor return a false-empty
  // result: an agent (MCP `search`) or any consumer hitting search right after
  // `ok start` would otherwise get zero hits that read as complete. We answer
  // fast with `ready: false` instead and let the caller retry. The command
  // palette gates its own fetch on the page-list cold-load signal, so this
  // primarily protects non-UI consumers and is defense-in-depth for the UI.
  //
  // `bootIndexReady` mirrors the same boot gate `handleDocumentList` awaits: an
  // absent gate (test harnesses) is ready immediately, and a rejected gate still
  // flips ready (logged, like the sibling document-list gate) so a degraded boot
  // serves whatever index exists rather than warming forever.
  let bootIndexReady = ready === undefined;
  ready?.then(
    () => {
      bootIndexReady = true;
    },
    (err: unknown) => {
      bootIndexReady = true;
      log.warn(
        { err, handler: 'search' },
        '[api] ready gate rejected — search serves the partial index',
      );
    },
  );

  // Warming = the boot seed has not finished. Once it has, search awaits the
  // corpus build and returns results as before (the lazy first build is fast and
  // prewarmed; a slow first build on a very large workspace is the documented
  // residual). Scoping warming to the seed window keeps steady-state behavior —
  // and every consumer that does not pass a boot gate — unchanged.
  function isSearchCorpusWarming(): boolean {
    return !bootIndexReady;
  }

  async function getWorkspaceSearchCorpus(): Promise<{
    corpus: WorkspaceSearchCorpus;
    truncated: boolean;
  }> {
    const cacheKey = `${contentDir} ${projectDir ?? ''}`;
    const fingerprint = workspaceSearchFingerprint();
    const workspaceSearchCache = workspaceSearchCaches.get(cacheKey);
    if (workspaceSearchCache?.fingerprint === fingerprint && workspaceSearchCache.corpus) {
      return {
        corpus: workspaceSearchCache.corpus,
        truncated: workspaceSearchCache.truncated ?? false,
      };
    }
    if (workspaceSearchCache?.fingerprint === fingerprint && workspaceSearchCache.pending) {
      return workspaceSearchCache.pending;
    }

    // Stale-but-live corpus (or the build about to produce one): the base for
    // an incremental index patch, so one write re-indexes one document instead
    // of re-tokenizing the whole workspace on the event loop.
    const priorCorpus = workspaceSearchCache?.corpus;
    const priorPending = workspaceSearchCache?.pending;
    const pending = (async () => {
      // Serialize behind any in-flight build: an incremental diff is only valid
      // against the corpus it was computed from, and the in-flight build owns
      // the shared index right now. Chaining keeps updates linear (each build
      // bases on its predecessor's output) without coalescing away freshness —
      // the document snapshot below is read AFTER this fingerprint was seen.
      const base = priorPending
        ? await priorPending.then(
            (result) => result.corpus,
            () => undefined,
          )
        : priorCorpus;
      const { documents, truncated } = await buildWorkspaceSearchDocumentsFromIndex();
      if (!base) {
        searchCorpusUpdateCounter().add(1, { mode: 'cold' });
        return { corpus: createWorkspaceSearchCorpus(documents), truncated };
      }
      const update = updateWorkspaceSearchCorpus(base, documents);
      if (update.rebuilt) {
        searchCorpusUpdateCounter().add(1, { mode: 'rebuild', reason: update.rebuildReason });
        // `mutation-failed` means the patched index diverged from the document
        // set (or a mutation threw) — recovered by the rebuild, but worth an
        // operator-visible signal; the elective reasons are routine.
        const logLevel = update.rebuildReason === 'mutation-failed' ? 'warn' : 'debug';
        log[logLevel](
          { reason: update.rebuildReason, documents: documents.length },
          '[search] corpus update fell back to a full index rebuild',
        );
      } else {
        searchCorpusUpdateCounter().add(1, { mode: 'incremental' });
        log.debug(
          { inserted: update.inserted, updated: update.updated, removed: update.removed },
          '[search] corpus updated incrementally',
        );
      }
      return { corpus: update.corpus, truncated };
    })();
    workspaceSearchCaches.set(cacheKey, { fingerprint, pending });
    try {
      const result = await pending;
      if (workspaceSearchCaches.get(cacheKey)?.pending === pending) {
        workspaceSearchCaches.set(cacheKey, {
          fingerprint,
          corpus: result.corpus,
          truncated: result.truncated,
        });
      }
      return result;
    } catch (err) {
      if (workspaceSearchCaches.get(cacheKey)?.pending === pending) {
        workspaceSearchCaches.delete(cacheKey);
      }
      throw err;
    }
  }

  return {
    /**
     * Shared core for `GET` + `POST /api/search`: build the corpus, resolve the
     * (opt-in) vector signal, rank, and assemble the `SearchSuccess` body. One
     * implementation so GET and POST cannot drift in ranking, snippets, or the
     * semantic gate.
     */
    async buildSearchResponse(params) {
      const startedAt = performance.now();
      // Cold start: while the boot seed is still walking the content dir, do not
      // block on it and do not serve a partial/empty index as if it were complete.
      // Answer fast with `ready: false` so the caller (MCP `search`, palette, any
      // consumer) retries instead of trusting an empty result. The seed populates
      // the file index, so a retry after it resolves takes the normal path below.
      if (isSearchCorpusWarming()) {
        return {
          query: params.query,
          intent: params.intent,
          results: [],
          elapsedMs: Math.max(0, performance.now() - startedAt),
          ready: false,
        };
      }
      const { corpus, truncated } = await getWorkspaceSearchCorpus();
      const semantic = await resolveSemantic(
        params.query,
        params.intent,
        params.semanticParam,
        corpus,
      );
      const results = searchWorkspaceCorpus(corpus, params.query, {
        intent: params.intent,
        ranking: params.ranking,
        scopes: params.scopes,
        limit: params.limit,
        semantic: semantic.input,
      });
      const entries = results.map((r) => toSearchResultEntry(r, params.query));

      let semanticStatus: SearchSemanticStatus | undefined;
      if (semantic.status) {
        const vectorContributors = entries.reduce(
          (n, e) => n + (e.signals.vector !== undefined ? 1 : 0),
          0,
        );
        const applied = vectorContributors > 0;
        semanticStatus = { ...semantic.status, applied };
        const outcome: SemanticQueryOutcome = !semantic.capable
          ? 'incapable'
          : applied
            ? 'applied'
            : semantic.status.coverage.embedded === 0
              ? 'warming'
              : 'no_match';
        recordSemanticQuery({
          outcome,
          source: params.source,
          capable: semantic.capable,
          embedded: semantic.status.coverage.embedded,
          total: semantic.pageTotal,
          queryEmbedMs: semantic.queryEmbedMs,
          vectorContributors,
        });
      }

      return {
        query: params.query,
        intent: params.intent,
        results: entries,
        elapsedMs: Math.max(0, performance.now() - startedAt),
        ready: true,
        ...(semanticStatus ? { semantic: semanticStatus } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
    },

    prewarm() {
      if (process.env.NODE_ENV === 'test') return;
      for (const delayMs of [0, 1000, 3000]) {
        setTimeout(() => {
          void getWorkspaceSearchCorpus().catch((err) => {
            log.warn({ err }, '[search] Failed to prewarm workspace search cache');
          });
        }, delayMs);
      }
    },
  };
}
