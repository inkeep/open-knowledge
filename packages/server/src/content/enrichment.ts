/**
 * Shared `enrichPath()` — single source of truth for per-path metadata
 * assembly used by `exec` and `search`.
 *
 * Returns a **single unified `EnrichedMeta` shape** with nullable fields.
 * Multi-path callers (ls/grep/find enrichment) pass
 * `{ includeRichFields: false }` and get `backlinkCount`, `history`, and
 * `historySource` as `null` to avoid N-amplification. Single-path callers
 * (cat) pass `{ includeRichFields: true }` and get all fields populated.
 *
 * `catalogCategory` is intentionally not surfaced (folder INDEX.md
 * frontmatter is deprecated across OK; catalog is an on-demand view, not
 * a stored artifact).
 */
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { OK_DIR, stripFrontmatter, unwrapFrontmatterFences } from '@inkeep/open-knowledge-core';
import { parse as parseYaml } from 'yaml';
import { resolveWithinRoot } from '../mcp/tools/path-safety.ts';
import { httpGet } from '../mcp/tools/shared.ts';
import { readFolderFrontmatter } from './nested-folder-rules.ts';
import { type GitCommit, type ProjectHistorySource, readProjectGitLog } from './project-log.ts';
import { type HistorySource, readShadowLog, type ShadowCommit } from './shadow-log.ts';
import { resolveTemplatesAvailable, type TemplateEntry } from './templates-resolver.ts';

// Inline frontmatter parser — keeps server-side parsing self-contained
// (no cli-package import). Returns the raw YAML object verbatim so the
// open-shape merge sees every key the file declared. Type narrowing
// for well-known scalars happens downstream. Fence recognition is core's
// contract via stripFrontmatter/unwrapFrontmatterFences.
function parseFrontmatterRaw(content: string): Record<string, unknown> | null {
  const { frontmatter } = stripFrontmatter(content);
  if (frontmatter === '') return null;
  try {
    const parsed = parseYaml(unwrapFrontmatterFences(frontmatter));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid YAML — degrade gracefully to "no frontmatter".
  }
  return null;
}

/** Bound on recursive directory scan when computing `DirectoryMeta`. */
const DIRECTORY_SCAN_CAP = 1000;

/** Dirs skipped when computing DirectoryMeta (same policy as mtime-scan). */
const DIR_SKIP: ReadonlySet<string> = new Set([
  '.git',
  OK_DIR,
  'node_modules',
  '.changeset',
  '.claude',
  '.agents',
  'dist',
  'build',
]);

const WIKI_EXT_RE = /\.(md|mdx)$/i;

/** Full backlink entry surfaced in rich enrichment. */
interface BacklinkEntry {
  /** docName of the source that links to this path. */
  source: string;
  title?: string;
  /** Short excerpt from the source around the link, when the server provides one. */
  snippet?: string | null;
}

interface DocumentForwardLinkEntry {
  kind: 'doc';
  docName: string;
  title?: string;
  snippet?: string | null;
}

interface ExternalForwardLinkEntry {
  kind: 'external';
  url: string;
  title?: string;
  snippet?: string | null;
}

type ForwardLinkEntry = DocumentForwardLinkEntry | ExternalForwardLinkEntry;

/**
 * Directory-level enrichment — what a folder contains. Returned for
 * directory entries in `ls` output so agents get a real folder summary
 * without opening anything.
 *
 * On-demand view of what folder catalogs surface: recursive file count, child
 * dirs, most recent wiki file as a content hint. Computed per call; no
 * storage layer.
 */
export interface DirectoryMeta {
  /** Project-root-relative path to the directory (no trailing slash). */
  path: string;
  type: 'directory';
  /**
   * Folder title from this folder's own `.ok/frontmatter.yml` (self-only — no
   * cascade). Absent when the folder sets none.
   */
  title?: string;
  /** Folder description from this folder's own `.ok/frontmatter.yml`. Absent when none. */
  description?: string;
  /**
   * Folder tags from this folder's own `.ok/frontmatter.yml` (self-only).
   * Absent when the folder sets none.
   *
   * Note the type divergence from `EnrichedMeta.tags` (which is always
   * `string[]`, defaulting to `[]`): on `DirectoryMeta`, tags is optional so
   * that folders without a matching rule have no `tags` key at all — matching
   * the behavior of `title` and `description` on this type. EnrichedMeta.tags
   * stays always-present because every file has frontmatter state (even if
   * empty). Consumers of `EnrichedEntry` must handle both cases:
   *   file.tags.length       // always safe — array or []
   *   directory.tags?.length // optional — may be undefined
   */
  tags?: string[];
  /** Number of wiki (.md/.mdx) files directly in this dir (not recursive). */
  directMdCount: number;
  /** Number of wiki (.md/.mdx) files in this dir and all descendants (bounded). */
  recursiveMdCount: number;
  /** Subdirectories directly in this dir (excluding .git, node_modules, etc.). */
  childDirCount: number;
  /** Most recently modified wiki file under this dir — a content hint without opening. */
  mostRecentMd?: {
    path: string;
    title?: string;
    /** ISO mtime. */
    updatedAt: string;
  };
  /** `true` when the recursive scan hit `DIRECTORY_SCAN_CAP`. */
  truncated: boolean;
  /**
   * Templates available when creating a new doc inside this folder. Aggregated
   * leaf → root walk-up (closest-wins on filename collision). Empty array
   * when no nested `.ok/templates/` exists at this level or any ancestor.
   *
   * Each entry carries `name` + optional `title`/`description` (soft contract)
   * + `scope` (`local` | `inherited`) so the agent can pick intelligently.
   * Descendant templates surface only inside `subfolders[].templates_available`
   * and are not addressable from the parent folder's writes.
   *
   * Templates are the single mechanism for "what new docs in this folder
   * start with" — folder frontmatter no longer cascades values into children.
   */
  templates_available?: TemplateEntry[];
  /**
   * Recursive subfolder enrichment. Populated when a caller (e.g.
   * an `exec` recursive listing) asks for subtree visibility — each entry
   * carries its own `title`/`description`/`tags` + `templates_available` so
   * agents can plan navigation without a follow-up call. `depth: 1` (default)
   * leaves this absent.
   */
  subfolders?: DirectoryMeta[];
}

/**
 * Unified enrichment shape. Fields are nullable when unavailable or
 * deliberately omitted (multi-path avoidance of N-amplification).
 */
export interface EnrichedMeta {
  /** Project-root-relative path. */
  path: string;
  /**
   * Well-known typed fields lifted from the merged frontmatter for
   * backward compat with consumers that pre-date arbitrary-key support
   * (search highlighting, sidebar, exec). Mirrors the same scalars that
   * also appear in `frontmatter` below.
   */
  title?: string;
  description?: string;
  tags: string[];
  /**
   * The doc's OWN frontmatter — exactly the keys in the file's `---` YAML
   * region, unmodified by any ancestor folder. A doc's effective frontmatter
   * equals its on-disk frontmatter (no read-time value cascade). Open shape:
   * any key authored in the file's YAML region appears here.
   *
   * Empty `{}` when the file has no frontmatter.
   */
  frontmatter: Record<string, unknown>;
  /**
   * Backlink count. Null on multi-path output or when Hocuspocus is
   * unreachable. Populated on single-path rich enrichment.
   */
  backlinkCount: number | null;
  /**
   * Full backlink list. Null on multi-path output (avoids N-amplification)
   * or when Hocuspocus is unreachable. Populated on single-path rich.
   */
  backlinks: BacklinkEntry[] | null;
  /**
   * Forward-link count. Null on multi-path output or when Hocuspocus is
   * unreachable. Populated on single-path rich enrichment.
   */
  forwardLinkCount: number | null;
  /**
   * Full forward-link list. Null on multi-path output or when Hocuspocus is
   * unreachable. Populated on single-path rich enrichment.
   */
  forwardLinks: ForwardLinkEntry[] | null;
  /**
   * Recent OK-edit activity on this path, merged across shadow-repo's
   * per-writer refs. Null on multi-path output. `[]` when shadow repo is
   * present but has no edits touching the path.
   */
  history: ShadowCommit[] | null;
  /**
   *   - `'shadow-repo'`         — history comes from a live shadow repo (may be `[]`)
   *   - `'shadow-repo-absent'`  — no shadow repo exists for this project
   *   - `null`                  — history field is `null` (multi-path output)
   */
  historySource: HistorySource | null;
  /**
   * Project-git commit history for this path — durable authored commits
   * from the project's own `.git/` (not the shadow repo). Null on
   * multi-path output.
   */
  projectHistory: GitCommit[] | null;
  /**
   *   - `'git'`         — project is a git repo (history may be `[]` for new files)
   *   - `'git-absent'`  — project has no `.git/`
   *   - `null`          — field not populated (multi-path output)
   */
  projectHistorySource: ProjectHistorySource | null;
  /**
   * Coarse graph role from link counts: `orphan` (no links), `hub` (many
   * inbound), `connector` (links in and out), `leaf` (otherwise). Null on
   * multi-path output, where the counts are not fully resolved.
   */
  graphRole: GraphRole | null;
}

/** Coarse classification of a document by its link counts. */
export type GraphRole = 'hub' | 'connector' | 'leaf' | 'orphan';

// Absolute inbound floor for "hub". A relative top-K threshold is the eventual
// refinement; an absolute floor keeps this first cut self-contained.
const HUB_MIN_INBOUND = 5;

/**
 * Classify a doc from its in/out link counts. Null when either count is unknown
 * (multi-path enrichment or a failed fetch), so callers skip the role rather
 * than guess on partial data.
 */
export function computeGraphRole(
  backlinkCount: number | null,
  forwardLinkCount: number | null,
): GraphRole | null {
  // Classify only on complete data: a null count means the fetch failed or was
  // skipped (multi-path), and coalescing unknown to zero would mislabel a doc.
  if (backlinkCount === null || forwardLinkCount === null) return null;
  const inbound = backlinkCount;
  const outbound = forwardLinkCount;
  if (inbound === 0 && outbound === 0) return 'orphan';
  if (inbound >= HUB_MIN_INBOUND) return 'hub';
  if (inbound > 0 && outbound > 0) return 'connector';
  return 'leaf';
}

interface EnrichPathDeps {
  projectDir: string;
  serverUrl?: string | undefined;
  /** History depth for rich mode; defaults to 5. */
  historyDepth?: number;
}

interface EnrichPathOptions {
  /**
   * When `true`, populate `backlinkCount` + `history` + `historySource`
   * (rich mode). When `false` (default), those three fields are `null`
   * regardless of data availability — used on multi-path enrichment to
   * avoid N-amplification of backlink HTTP calls and shadow-log reads.
   */
  includeRichFields?: boolean;
}

export function pathToDocName(relPath: string): string {
  return relPath.replace(/\.md$/, '').replace(/\.mdx$/, '');
}

/**
 * Per-process dedup of operator-facing warnings on EMFILE / EACCES /
 * EISDIR / ENOTDIR — every `enrichPath()` call hits this site, so without
 * dedup a single bad file would spam the terminal once per `cat` / `ls`.
 */
const fmReadWarnedPaths = new Set<string>();

async function readFrontmatter(absPath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(absPath, 'utf-8');
    const fm = parseFrontmatterRaw(content);
    return fm ?? {};
  } catch (err) {
    // ENOENT is expected (caller is enriching paths from a stale listing or a
    // dir that contains non-md children). All other read errors — EMFILE
    // (fd exhaustion), EACCES (permission), EISDIR / ENOTDIR (path race) —
    // are operator-actionable and would otherwise surface as silent
    // "frontmatter looks empty" gaps. Warn once per path and degrade.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT' && !fmReadWarnedPaths.has(absPath)) {
      fmReadWarnedPaths.add(absPath);
      const reason = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console -- ad-hoc operator-facing diagnostic
      console.warn(
        `[ok-enrich] failed to read frontmatter at ${absPath} — enrichment degraded for this file. Reason: ${reason}`,
      );
    }
    return null;
  }
}

/**
 * Fetch the full backlinks list from the Hocuspocus server. Returns `null`
 * when no serverUrl is configured or the request fails — callers treat
 * null as "degrade gracefully".
 */
async function fetchBacklinks(
  serverUrl: string | undefined,
  docName: string,
): Promise<BacklinkEntry[] | null> {
  if (!serverUrl) return null;
  const result = await httpGet(serverUrl, `/api/backlinks?docName=${encodeURIComponent(docName)}`);
  if (!result.ok) return null;
  const raw = (result.backlinks ?? result.results ?? result.links) as unknown;
  if (!Array.isArray(raw)) return [];
  const entries: BacklinkEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const source =
      typeof rec.docName === 'string'
        ? rec.docName
        : typeof rec.source === 'string'
          ? rec.source
          : typeof rec.page === 'string'
            ? rec.page
            : undefined;
    if (!source) continue;
    entries.push({
      source,
      title: typeof rec.title === 'string' ? rec.title : undefined,
      snippet: typeof rec.snippet === 'string' ? rec.snippet : null,
    });
  }
  return entries;
}

/**
 * Chunk size for bulk backlink-count fetches. Keeps each URL comfortably
 * under typical 8KB HTTP URL limits even with long docNames (e.g. 100 x
 * ~70-char paths ≈ 7KB after comma-joining and percent-encoding).
 */
const BACKLINK_COUNT_CHUNK = 100;

/**
 * Bulk backlink-count fetch for slim-enrichment callers (multi-path ls/grep/
 * find/multi-cat). Batches into chunks of ${BACKLINK_COUNT_CHUNK} to keep
 * each request URL well under the 8KB limit; chunks fire in parallel so
 * latency stays close to a single round-trip. Returns `null` when no
 * serverUrl or every chunk fails; otherwise returns a `Map<docName, number>`
 * with entries from all successful chunks (partial chunks are merged —
 * missing docNames ⇒ not in the map).
 *
 * See `/api/backlink-counts` in `api-extension.ts`.
 */
export async function fetchBacklinkCountsBatch(
  serverUrl: string | undefined,
  docNames: string[],
): Promise<Map<string, number> | null> {
  if (!serverUrl || docNames.length === 0) return null;
  const unique = [...new Set(docNames)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += BACKLINK_COUNT_CHUNK) {
    chunks.push(unique.slice(i, i + BACKLINK_COUNT_CHUNK));
  }
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const param = encodeURIComponent(chunk.join(','));
      const result = await httpGet(serverUrl, `/api/backlink-counts?docNames=${param}`);
      if (!result.ok) return null;
      return (result.counts ?? {}) as Record<string, unknown>;
    }),
  );
  const out = new Map<string, number>();
  let anySuccess = false;
  for (const chunkResult of results) {
    if (!chunkResult) continue;
    anySuccess = true;
    for (const [name, val] of Object.entries(chunkResult)) {
      if (typeof val === 'number' && Number.isFinite(val)) out.set(name, val);
    }
  }
  return anySuccess ? out : null;
}

async function fetchForwardLinks(
  serverUrl: string | undefined,
  docName: string,
): Promise<ForwardLinkEntry[] | null> {
  if (!serverUrl) return null;
  const result = await httpGet(
    serverUrl,
    `/api/forward-links?docName=${encodeURIComponent(docName)}`,
  );
  if (!result.ok) return null;
  const raw = (result.forwardLinks ?? result.links ?? result.results) as unknown;
  if (!Array.isArray(raw)) return [];
  const entries: ForwardLinkEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (rec.kind === 'external' && typeof rec.url === 'string') {
      entries.push({
        kind: 'external',
        url: rec.url,
        title: typeof rec.title === 'string' ? rec.title : undefined,
        snippet: typeof rec.snippet === 'string' ? rec.snippet : null,
      });
      continue;
    }
    const docNameValue = typeof rec.docName === 'string' ? rec.docName : undefined;
    if (!docNameValue) continue;
    entries.push({
      kind: 'doc',
      docName: docNameValue,
      title: typeof rec.title === 'string' ? rec.title : undefined,
      snippet: typeof rec.snippet === 'string' ? rec.snippet : null,
    });
  }
  return entries;
}

/**
 * Lift the typed well-known fields from a doc's OWN frontmatter. A doc's
 * effective frontmatter equals its on-disk YAML — there is no folder-cascade
 * overlay. Open shape: every key the file authored flows through unchanged.
 *
 * Returns:
 *   - `frontmatter` — the file's own frontmatter Record, open to any key
 *   - `title` / `description` / `tags` — typed lifts of the well-known three
 *     for backward-compat consumers (search, sidebar, exec)
 */
function liftOwnFrontmatter(fileFm: Record<string, unknown> | null): {
  title?: string;
  description?: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
} {
  const fm = fileFm ?? {};
  const title = typeof fm.title === 'string' ? fm.title : undefined;
  const description = typeof fm.description === 'string' ? fm.description : undefined;
  const tags = Array.isArray(fm.tags)
    ? (fm.tags as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];
  return { title, description, tags, frontmatter: fm };
}

/**
 * Assemble enrichment for a single wiki path. See `EnrichedMeta` for the
 * unified shape and the convention for nullable fields on multi-path output.
 */
export async function enrichPath(
  relPathInput: string,
  deps: EnrichPathDeps,
  options: EnrichPathOptions = {},
): Promise<EnrichedMeta> {
  // Containment is a hard precondition — `enrichPath` reads via `node:fs`
  // and bypasses the bash sandbox, so a `..`-prefixed `relPathInput`
  // would otherwise read frontmatter from arbitrary host paths. Tool
  // surfaces (exec / search) filter callers' inputs
  // upstream; this throw is the defense-in-depth backstop.
  const contained = resolveWithinRoot(deps.projectDir, relPathInput);
  if (!contained.ok) {
    throw new Error(`enrichPath: ${contained.reason}`);
  }
  const relPath = contained.rel;
  const absPath = contained.abs;
  const historyDepth = deps.historyDepth ?? 5;
  const rich = options.includeRichFields === true;

  const fmPromise = readFrontmatter(absPath);

  if (!rich) {
    const fm = await fmPromise;
    const lifted = liftOwnFrontmatter(fm);
    return {
      path: relPath,
      title: lifted.title,
      description: lifted.description,
      tags: lifted.tags,
      frontmatter: lifted.frontmatter,
      backlinkCount: null,
      backlinks: null,
      forwardLinkCount: null,
      forwardLinks: null,
      history: null,
      historySource: null,
      projectHistory: null,
      projectHistorySource: null,
      graphRole: null,
    };
  }

  // Rich mode — fan out all five data sources in parallel.
  const [fm, backlinks, forwardLinks, shadow, project] = await Promise.all([
    fmPromise,
    fetchBacklinks(deps.serverUrl, pathToDocName(relPath)).catch(() => null),
    fetchForwardLinks(deps.serverUrl, pathToDocName(relPath)).catch(() => null),
    readShadowLog(deps.projectDir, relPath, historyDepth).catch(() => ({
      commits: [] as ShadowCommit[],
      source: 'shadow-repo' as HistorySource,
    })),
    readProjectGitLog(deps.projectDir, relPath, historyDepth).catch(() => ({
      commits: [] as GitCommit[],
      source: 'git' as ProjectHistorySource,
    })),
  ]);

  const lifted = liftOwnFrontmatter(fm);
  return {
    path: relPath,
    title: lifted.title,
    description: lifted.description,
    tags: lifted.tags,
    frontmatter: lifted.frontmatter,
    backlinkCount: backlinks?.length ?? null,
    backlinks,
    forwardLinkCount: forwardLinks?.length ?? null,
    forwardLinks,
    history: shadow.commits,
    historySource: shadow.source,
    projectHistory: project.commits,
    projectHistorySource: project.source,
    graphRole: computeGraphRole(backlinks?.length ?? null, forwardLinks?.length ?? null),
  };
}

/** Union type surfaced to callers that enrich a mixed list of files and dirs. */
export type EnrichedEntry = EnrichedMeta | DirectoryMeta;

interface DirScanResult {
  directMdCount: number;
  recursiveMdCount: number;
  childDirCount: number;
  mostRecent: { absPath: string; relPath: string; mtimeMs: number } | null;
  truncated: boolean;
}

async function scanDirectory(absDir: string, projectDir: string): Promise<DirScanResult> {
  const result: DirScanResult = {
    directMdCount: 0,
    recursiveMdCount: 0,
    childDirCount: 0,
    mostRecent: null,
    truncated: false,
  };
  let visited = 0;
  const queue: { path: string; depth: number }[] = [{ path: absDir, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (visited >= DIRECTORY_SCAN_CAP) {
      result.truncated = true;
      break;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited >= DIRECTORY_SCAN_CAP) {
        result.truncated = true;
        break;
      }
      visited++;
      const name = entry.name;
      if (entry.isDirectory()) {
        if (DIR_SKIP.has(name) || name.startsWith('.')) continue;
        if (current.depth === 0) result.childDirCount++;
        queue.push({ path: `${current.path}/${name}`, depth: current.depth + 1 });
      } else if (entry.isFile() && WIKI_EXT_RE.test(name)) {
        result.recursiveMdCount++;
        if (current.depth === 0) result.directMdCount++;
        const absFile = `${current.path}/${name}`;
        try {
          const st = await stat(absFile);
          if (!result.mostRecent || st.mtimeMs > result.mostRecent.mtimeMs) {
            const rel = relative(projectDir, absFile);
            // Normalize to forward-slashes — project-root-relative paths in
            // EnrichedMeta are always POSIX-form (agents and bash consume them).
            const relPath = rel.split(/[\\/]/).filter(Boolean).join('/');
            result.mostRecent = { absPath: absFile, relPath, mtimeMs: st.mtimeMs };
          }
        } catch {}
      }
    }
  }
  return result;
}

/**
 * Assemble enrichment for a directory path. Returns folder-shape metadata
 * (counts + most-recent wiki file hint) — the on-demand equivalent of the
 * persisted INDEX.md catalogs.
 *
 * A folder's own frontmatter (open-shape, like a doc's) comes from its
 * `.ok/frontmatter.yml` (self-only — no inheritance from ancestors).
 * `scanDirectory` semantics (recursive/direct/childDirCount) are unaffected
 * — counts remain raw-count.
 */
export async function enrichDirectory(
  relPathInput: string,
  deps: Pick<EnrichPathDeps, 'projectDir'>,
): Promise<DirectoryMeta> {
  // See `enrichPath` for the rationale — same `..`/absolute-path escape
  // class via `node:fs`-direct readdir / stat.
  const contained = resolveWithinRoot(deps.projectDir, relPathInput);
  if (!contained.ok) {
    throw new Error(`enrichDirectory: ${contained.reason}`);
  }
  const relPath = contained.rel;
  const absDir = contained.abs;
  const scan = await scanDirectory(absDir, deps.projectDir);

  let mostRecentMd: DirectoryMeta['mostRecentMd'];
  if (scan.mostRecent) {
    const fm = await readFrontmatter(scan.mostRecent.absPath);
    const fmTitle = typeof fm?.title === 'string' ? fm.title : undefined;
    mostRecentMd = {
      path: scan.mostRecent.relPath,
      title: fmTitle ?? basename(scan.mostRecent.relPath),
      updatedAt: new Date(scan.mostRecent.mtimeMs).toISOString(),
    };
  }

  const result: DirectoryMeta = {
    path: relPath,
    type: 'directory',
    directMdCount: scan.directMdCount,
    recursiveMdCount: scan.recursiveMdCount,
    childDirCount: scan.childDirCount,
    mostRecentMd,
    truncated: scan.truncated,
  };

  // Folder frontmatter is SELF-ONLY — read this folder's own
  // `.ok/frontmatter.yml`, with no inheritance from ancestor folders.
  // Folder frontmatter is open-shape, but only the well-known keys are lifted
  // onto the typed `DirectoryMeta` surface that `exec ls` returns; any other
  // keys are stored on disk and served by `GET /api/folder-config`
  // (`frontmatter_local`), not promoted to the listing entry.
  const own = readFolderFrontmatter(deps.projectDir, relPath);
  if (own.title !== undefined) result.title = own.title;
  if (own.description !== undefined) result.description = own.description;
  if ((own.tags?.length ?? 0) > 0) result.tags = own.tags;

  // Templates available for creating a new doc in this folder.
  // Default depth=1 — local + walk-up ancestors only. Callers wanting
  // descendant visibility pass depth via the `exec` ls enrichment.
  const templates = resolveTemplatesAvailable(deps.projectDir, relPath);
  if (templates.length > 0) result.templates_available = templates;

  return result;
}

/**
 * Recursively enrich a directory + its subfolders up to `depth` levels.
 *
 * Mirrors `find -maxdepth N` semantics: `depth=1` is just the target
 * folder (equivalent to `enrichDirectory`); `depth=2` adds direct children's
 * folder metadata; `depth=Infinity` walks the full subtree. Honors the same
 * `BUILTIN_SKIP_DIRS`-style skip list that `templates-resolver.ts` uses to
 * keep listings clean (no node_modules, no `.git`, no `.ok` directory entries
 * — `.ok/` contents are surfaced as structured fields, not as children).
 */
export async function enrichDirectoryRecursive(
  relPathInput: string,
  depth: number,
  deps: Pick<EnrichPathDeps, 'projectDir'>,
): Promise<DirectoryMeta> {
  const top = await enrichDirectory(relPathInput, deps);
  if (depth <= 1) return top;

  const relPath = top.path;
  const absDir = resolve(deps.projectDir, relPath);

  let entries: Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return top;
  }

  const subfolders: DirectoryMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip named build/vendor dirs AND any dot-prefixed dir, matching
    // `scanDirectory`'s policy. Without the dot-prefix guard, `.foo`
    // surfaced here but not from the leaf-folder scan, leaving the UI
    // showing children that vanish when you navigate into them.
    if (RECURSIVE_LISTING_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    const child = await enrichDirectoryRecursive(childRel, depth - 1, deps);
    subfolders.push(child);
  }

  if (subfolders.length > 0) top.subfolders = subfolders;
  return top;
}

/**
 * Skip dirs for the recursive listing surface. Mirrors content-filter's
 * BUILTIN_SKIP_DIRS spirit + adds `.ok` (its contents are structured
 * fields, not directory entries).
 */
const RECURSIVE_LISTING_SKIP_DIRS = new Set<string>([
  '.git',
  '.ok',
  'node_modules',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  'vendor',
  'dist',
  'build',
  'out',
  'output',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'coverage',
]);
