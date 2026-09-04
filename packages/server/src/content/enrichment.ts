import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import {
  compileAppliesTo,
  type FrontmatterSchemaMapping,
  OK_DIR,
  parseFrontmatterRecord,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import { getLogger } from '../logger.ts';
import { resolveWithinRoot } from '../mcp/tools/path-safety.ts';
import { httpGet } from '../mcp/tools/shared.ts';
import { extractFirstHeading } from '../page-identity.ts';
import { readFolderFrontmatter } from './nested-folder-rules.ts';
import { type GitCommit, type ProjectHistorySource, readProjectGitLog } from './project-log.ts';
import { type HistorySource, readShadowLog, type ShadowCommit } from './shadow-log.ts';
import { resolveTemplatesAvailable, type TemplateEntry } from './templates-resolver.ts';

const DIRECTORY_SCAN_CAP = 1000;

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

interface BacklinkEntry {
  source: string;
  title?: string;
  snippet?: string | null;
}

interface CommentSummary {
  threadId: string;
  body: string;
  quote: string;
  state: 'anchored' | 'orphaned';
  queued: boolean;
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

export interface DirectoryMeta {
  path: string;
  type: 'directory';
  title?: string;
  description?: string;
  tags?: string[];
  directMdCount: number;
  recursiveMdCount: number;
  childDirCount: number;
  mostRecentMd?: {
    path: string;
    title?: string;
    updatedAt: string;
  };
  truncated: boolean;
  commentCount?: number;
  commentedDocs?: { docName: string; count: number }[];
  templates_available?: TemplateEntry[];
  schemas_applicable?: string[];
  subfolders?: DirectoryMeta[];
}

export interface EnrichedMeta {
  path: string;
  title?: string;
  description?: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  backlinkCount: number | null;
  backlinks: BacklinkEntry[] | null;
  forwardLinkCount: number | null;
  forwardLinks: ForwardLinkEntry[] | null;
  history: ShadowCommit[] | null;
  historySource: HistorySource | null;
  projectHistory: GitCommit[] | null;
  projectHistorySource: ProjectHistorySource | null;
  graphRole: GraphRole | null;
  commentCount: number | null;
  comments: CommentSummary[] | null;
  schemas_applicable?: string[];
}

export type GraphRole = 'hub' | 'connector' | 'leaf' | 'orphan';

const HUB_MIN_INBOUND = 5;

export function computeGraphRole(
  backlinkCount: number | null,
  forwardLinkCount: number | null,
): GraphRole | null {
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
  historyDepth?: number;
  contentDir?: string;
  frontmatterSchemas?: FrontmatterSchemaMapping[];
}

function schemasApplicableToDoc(
  deps: Pick<EnrichPathDeps, 'projectDir' | 'contentDir' | 'frontmatterSchemas'>,
  relPath: string,
): string[] {
  const mappings = deps.frontmatterSchemas;
  if (!mappings || mappings.length === 0) return [];
  const contentDir = deps.contentDir ?? deps.projectDir;
  const contentRel = relative(contentDir, resolve(deps.projectDir, relPath));
  if (contentRel.startsWith('..')) return [];
  const files: string[] = [];
  for (const mapping of mappings) {
    if (mapping.enabled === false) continue;
    if (!compileAppliesTo(mapping.appliesTo).matches(contentRel)) continue;
    if (!files.includes(mapping.file)) files.push(mapping.file);
  }
  return files;
}

function schemasApplicableToFolder(
  deps: Pick<EnrichPathDeps, 'projectDir' | 'contentDir' | 'frontmatterSchemas'>,
  relPath: string,
): string[] {
  const placeholder = '⁂';
  const probe = relPath === '' ? placeholder : `${relPath}/${placeholder}`;
  return schemasApplicableToDoc(deps, probe);
}

interface EnrichPathOptions {
  includeRichFields?: boolean;
}

export function pathToDocName(relPath: string): string {
  return relPath.replace(/\.md$/, '').replace(/\.mdx$/, '');
}

const fmReadWarnedPaths = new Set<string>();

interface FileHead {
  frontmatter: Record<string, unknown>;
  firstHeading: string | undefined;
}

async function readFrontmatter(absPath: string): Promise<FileHead | null> {
  try {
    const content = await readFile(absPath, 'utf-8');
    const fm = parseFrontmatterRecord(content);
    return {
      frontmatter: fm ?? {},
      firstHeading: extractFirstHeading(stripFrontmatter(content).body),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT' && !fmReadWarnedPaths.has(absPath)) {
      fmReadWarnedPaths.add(absPath);
      const reason = err instanceof Error ? err.message : String(err);
      getLogger('enrichment').warn(
        { path: absPath, reason },
        `failed to read frontmatter at ${absPath} — enrichment degraded for this file. Reason: ${reason}`,
      );
    }
    return null;
  }
}

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

async function fetchComments(
  serverUrl: string | undefined,
  docName: string,
): Promise<CommentSummary[] | null> {
  if (!serverUrl) return null;
  const result = await httpGet(serverUrl, `/api/comments?doc=${encodeURIComponent(docName)}`);
  if (!result.ok) return null;
  return parseCommentThreads(result.threads);
}

export function parseCommentThreads(raw: unknown): CommentSummary[] {
  if (!Array.isArray(raw)) return [];
  const entries: CommentSummary[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const state = rec.state;
    if (state !== 'anchored' && state !== 'orphaned') continue;
    if (typeof rec.threadId !== 'string' || rec.threadId === '') continue;
    const anchor = typeof rec.anchor === 'object' && rec.anchor !== null ? rec.anchor : {};
    const quote = (anchor as Record<string, unknown>).exact;
    entries.push({
      threadId: rec.threadId,
      body: typeof rec.latestComment === 'string' ? rec.latestComment : '',
      quote: typeof quote === 'string' ? quote : '',
      state,
      queued: rec.queued === true,
    });
  }
  return entries;
}

const BACKLINK_COUNT_CHUNK = 100;

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

export async function fetchCommentCountsBatch(
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
      const result = await httpGet(serverUrl, `/api/comment-counts?docNames=${param}`);
      if (!result.ok) return null;
      return (result.counts ?? {}) as Record<string, unknown>;
    }),
  );
  return mergeCountChunks(results);
}

async function fetchCommentCountsUnderPrefix(
  serverUrl: string | undefined,
  prefix: string,
): Promise<Map<string, number> | null> {
  if (!serverUrl) return null;
  const result = await httpGet(
    serverUrl,
    `/api/comment-counts?prefix=${encodeURIComponent(prefix)}`,
  );
  if (!result.ok) return null;
  return mergeCountChunks([(result.counts ?? {}) as Record<string, unknown>]);
}

function mergeCountChunks(chunks: (Record<string, unknown> | null)[]): Map<string, number> | null {
  const out = new Map<string, number>();
  let anySuccess = false;
  for (const chunk of chunks) {
    if (!chunk) continue;
    anySuccess = true;
    for (const [name, val] of Object.entries(chunk)) {
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

function ownTitle(
  fm: Record<string, unknown> | null | undefined,
  firstHeading: string | undefined,
): string | undefined {
  const raw = fm?.title;
  if (typeof raw !== 'string') return firstHeading;
  const trimmed = raw.trim();
  return trimmed === '' ? firstHeading : trimmed;
}

function liftOwnFrontmatter(
  fileFm: Record<string, unknown> | null,
  firstHeading?: string,
): {
  title?: string;
  description?: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
} {
  const fm = fileFm ?? {};
  const title = ownTitle(fm, firstHeading);
  const description = typeof fm.description === 'string' ? fm.description : undefined;
  const tags = Array.isArray(fm.tags)
    ? (fm.tags as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];
  return { title, description, tags, frontmatter: fm };
}

export async function enrichPath(
  relPathInput: string,
  deps: EnrichPathDeps,
  options: EnrichPathOptions = {},
): Promise<EnrichedMeta> {
  const contained = resolveWithinRoot(deps.projectDir, relPathInput);
  if (!contained.ok) {
    throw new Error(`enrichPath: ${contained.reason}`);
  }
  const relPath = contained.rel;
  const absPath = contained.abs;
  const historyDepth = deps.historyDepth ?? 5;
  const rich = options.includeRichFields === true;

  const fmPromise = readFrontmatter(absPath);
  const applicableSchemas = schemasApplicableToDoc(deps, relPath);
  const schemasField =
    applicableSchemas.length > 0 ? { schemas_applicable: applicableSchemas } : {};

  if (!rich) {
    const head = await fmPromise;
    const lifted = liftOwnFrontmatter(head?.frontmatter ?? null, head?.firstHeading);
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
      commentCount: null,
      comments: null,
      ...schemasField,
    };
  }

  const [head, backlinks, forwardLinks, shadow, project, comments] = await Promise.all([
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
    fetchComments(deps.serverUrl, pathToDocName(relPath)).catch(() => null),
  ]);

  const lifted = liftOwnFrontmatter(head?.frontmatter ?? null, head?.firstHeading);
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
    commentCount: comments?.length ?? null,
    comments,
    ...schemasField,
  };
}

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
            const relPath = rel.split(/[\\/]/).filter(Boolean).join('/');
            result.mostRecent = { absPath: absFile, relPath, mtimeMs: st.mtimeMs };
          }
        } catch {}
      }
    }
  }
  return result;
}

export async function enrichDirectory(
  relPathInput: string,
  deps: Pick<EnrichPathDeps, 'projectDir' | 'contentDir' | 'frontmatterSchemas' | 'serverUrl'>,
): Promise<DirectoryMeta> {
  const contained = resolveWithinRoot(deps.projectDir, relPathInput);
  if (!contained.ok) {
    throw new Error(`enrichDirectory: ${contained.reason}`);
  }
  const relPath = contained.rel;
  const absDir = contained.abs;
  const scan = await scanDirectory(absDir, deps.projectDir);

  let mostRecentMd: DirectoryMeta['mostRecentMd'];
  if (scan.mostRecent) {
    const head = await readFrontmatter(scan.mostRecent.absPath);
    mostRecentMd = {
      path: scan.mostRecent.relPath,
      title: ownTitle(head?.frontmatter, head?.firstHeading) ?? basename(scan.mostRecent.relPath),
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

  const own = readFolderFrontmatter(deps.projectDir, relPath);
  if (own.title !== undefined) result.title = own.title;
  if (own.description !== undefined) result.description = own.description;
  if ((own.tags?.length ?? 0) > 0) result.tags = own.tags;

  const templates = resolveTemplatesAvailable(deps.projectDir, relPath);
  if (templates.length > 0) result.templates_available = templates;

  const folderSchemas = schemasApplicableToFolder(deps, relPath);
  if (folderSchemas.length > 0) result.schemas_applicable = folderSchemas;

  const commentCounts = await fetchCommentCountsUnderPrefix(deps.serverUrl, relPath).catch(
    () => null,
  );
  if (commentCounts && commentCounts.size > 0) {
    let total = 0;
    for (const count of commentCounts.values()) total += count;
    result.commentCount = total;
    result.commentedDocs = [...commentCounts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, FOLDER_COMMENTED_DOCS_CAP)
      .map(([docName, count]) => ({ docName, count }));
  }

  return result;
}

const FOLDER_COMMENTED_DOCS_CAP = 5;

export async function enrichDirectoryRecursive(
  relPathInput: string,
  depth: number,
  deps: Pick<EnrichPathDeps, 'projectDir' | 'contentDir' | 'frontmatterSchemas' | 'serverUrl'>,
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
    if (RECURSIVE_LISTING_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    const child = await enrichDirectoryRecursive(childRel, depth - 1, deps);
    subfolders.push(child);
  }

  if (subfolders.length > 0) top.subfolders = subfolders;
  return top;
}

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
