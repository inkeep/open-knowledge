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

const log = getLogger('search');

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
  const snippet = `${prefix}${content.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
  return snippet.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  );
}

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

function entrySearchKey(entry: FileIndexEntry): string {
  return `${entry.modified}\0${entry.size}\0${entry.canonicalPath}\0${entry.inode}\0${entry.aliases.join('\0')}`;
}

interface SemanticResolution {
  input?: WorkspaceSemanticInput;
  status?: SearchSemanticStatus;
  queryEmbedMs: number | null;
  pageTotal: number;
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
  ready?: Promise<unknown>;
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

  async function resolveSemantic(
    query: string,
    intent: WorkspaceSearchIntent,
    semanticParam: boolean | undefined,
    corpus: WorkspaceSearchCorpus,
  ): Promise<SemanticResolution> {
    const embeddableDocs = corpus.documents.filter((d) => !isHiddenDocName(d.path));
    const pageTotal = embeddableDocs.reduce((n, d) => n + (d.kind === 'page' ? 1 : 0), 0);
    if (!semanticSearch?.isEnabled() || semanticParam !== true) {
      return { queryEmbedMs: null, pageTotal, capable: false };
    }

    void semanticSearch.embedCorpus(embeddableDocs);

    let input: WorkspaceSemanticInput | undefined;
    let queryEmbedMs: number | null = null;
    if (intent === 'full_text' && query.trim().length >= SEMANTIC_MIN_QUERY_LENGTH) {
      const startedAt = performance.now();
      const scores = await semanticSearch.queryScores(query, embeddableDocs);
      queryEmbedMs = performance.now() - startedAt;
      if (scores && scores.size > 0) {
        const similarityFloor = getSemanticSimilarityFloor?.();
        input = similarityFloor !== undefined ? { scores, similarityFloor } : { scores };
      }
    }

    const status = semanticSearch.getStatus();
    return {
      input,
      status: {
        capable: status.capable,
        applied: false,
        coverage: { embedded: status.embeddedCount, total: pageTotal },
      },
      queryEmbedMs,
      pageTotal,
      capable: status.capable,
    };
  }

  function enumerateProjectSkillStats(): Array<{
    name: string;
    absolutePath: string;
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
      } catch {}
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
      } catch {}
    }
    return out;
  }

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
      } catch {}
      docs.push(
        createWorkspaceSearchDocument({
          kind: 'page',
          path: skill.docPath,
          title,
          content,
          modifiedTs: skill.mtimeMs,
        }),
      );
    }
    return docs;
  }

  const pageDocCache = new Map<string, { key: string; doc: WorkspaceSearchDocument }>();

  async function buildWorkspaceSearchDocumentsFromIndex(): Promise<{
    documents: WorkspaceSearchDocument[];
    truncated: boolean;
  }> {
    const pages: WorkspaceSearchDocument[] = [];
    const files: WorkspaceSearchDocument[] = [];
    const seenPages: Set<string> = new Set();
    for (const [docName, entry] of getAllFilesIndex()) {
      if (isSystemDoc(docName) || isConfigDoc(docName)) continue;
      if (parseProjectSkillBundleDoc(docName)?.kind === 'skill') continue;
      if (docName.startsWith('.ok/skills/')) continue;
      if (entry.kind === 'file') {
        files.push(
          createWorkspaceSearchDocument({
            kind: 'file',
            path: docName,
            modifiedTs: Date.parse(entry.modified),
            aliases: entry.aliases,
          }),
        );
        continue;
      }
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
        readFailed = true;
        log.warn({ docName, err }, `[search] Failed to read ${docName}`);
      }
      if (!readFailed) {
        try {
          title = extractPageTitle(content, docName);
        } catch (err) {
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
    for (const docName of pageDocCache.keys()) {
      if (!seenPages.has(docName)) pageDocCache.delete(docName);
    }
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
    const documents = [
      ...pages,
      ...buildSkillSearchDocuments(),
      ...admittedFiles,
      ...deriveFolderSearchDocuments([...pages, ...admittedFiles]),
    ];
    return { documents, truncated };
  }

  function skillStatFingerprint(): string {
    return enumerateProjectSkillStats()
      .map((s) => `${s.name} ${s.mtimeMs} ${s.size}`)
      .join('');
  }

  function workspaceSearchFingerprint(): string {
    if (getFileIndexGeneration) {
      return `gen:${getFileIndexGeneration()}|skills${skillStatFingerprint()}`;
    }
    return `${[...getAllFilesIndex()]
      .filter(([docName]) => !isSystemDoc(docName) && !isConfigDoc(docName))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([docName, entry]) => `${docName}\0${entrySearchKey(entry)}`)
      .join('')}|skills${skillStatFingerprint()}`;
  }

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

    const priorCorpus = workspaceSearchCache?.corpus;
    const priorPending = workspaceSearchCache?.pending;
    const pending = (async () => {
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
    async buildSearchResponse(params) {
      const startedAt = performance.now();
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
