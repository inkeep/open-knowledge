import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fnv1aDigest } from './bridge/hash-util.ts';
import { discoverGitRepository } from './git-repository.ts';

/**
 * Writer-ID taxonomy (precedent #25). Classified system writers are non-attributable
 * actions written under a fixed writer-id. Legacy values ('human-', 'upstream',
 * 'server') are classified 'unknown' so the allowlist sweep can
 * identify and GC them without confusing them with valid attributed refs.
 *
 * Full writer-ID table:
 *   agent-<connectionId>       → 'agent'                           (MCP session)
 *   principal-<UUID>           → 'principal'                        (browser tab)
 *   git-author-<hash>          → 'classified-git-author'            (upstream commit author)
 *   file-system                → 'classified-file-system'           (disk reconcile)
 *   git-upstream               → 'classified-git-upstream'          (HEAD-move import boundary)
 *   openknowledge-service      → 'classified-openknowledge-service' (park / service)
 *   ok-generator               → 'classified-ok-generator'          (OK-authored artifacts)
 *   server, human-*, upstream  → 'unknown'                          (legacy, swept on GC)
 *
 * `ok-generator` is distinct from `openknowledge-service` on purpose: the service
 * writer is the no-contributor fallback for housekeeping, while a generated
 * artifact is a deliberate authoring action that simply has no human behind it.
 * Folding the two would put generated content under the id this precedent
 * reserves for unattributable work.
 *
 * `git-author-<hash>` gives each distinct upstream commit author their own WIP
 * ref so the per-doc Timeline query (which diffs each ref's chain) attributes a
 * pulled change to the right author. The `<hash>` is `fnv1aDigest(email)` — one
 * ref per author, not per pull. Display name / real email travel on the commit's
 * `ok-actor` line, not in the id.
 */
export type WriterClassification =
  | 'agent'
  | 'principal'
  | 'classified-git-author'
  | 'classified-file-system'
  | 'classified-git-upstream'
  | 'classified-openknowledge-service'
  | 'classified-ok-generator'
  | 'unknown';

export const GIT_AUTHOR_WRITER_PREFIX = 'git-author-';

export const OK_GENERATOR_WRITER_ID = 'ok-generator';

export function gitAuthorWriterId(email: string): string {
  return `${GIT_AUTHOR_WRITER_PREFIX}${fnv1aDigest(email.trim().toLowerCase())}`;
}

export interface ParsedWriter {
  id: string;
  classification: WriterClassification;
  isAgent: boolean | null;
}

const WRITER_ID_RE =
  /^(agent-[^/]+|principal-[^/]+|git-author-[^/]+|file-system|git-upstream|openknowledge-service|ok-generator)$/;

export type ResolvedGitDir =
  | {
      kind: 'directory';
      path: string;
      projectSubPath: string;
    }
  | {
      kind: 'linked';
      path: string;
      gitPath: string;
      projectSubPath: string;
    }
  | { kind: 'absent' }
  | { kind: 'malformed-pointer'; gitPath: string; target: string; cause?: unknown }
  | { kind: 'inaccessible'; gitPath: string; cause: unknown };

export function resolveGitDirDetailed(projectRoot: string): ResolvedGitDir {
  const result = discoverGitRepository(projectRoot);
  if (result.kind !== 'repository') return result;

  const { repository } = result;
  if (repository.kind === 'directory') {
    return {
      kind: 'directory',
      path: repository.gitDir,
      projectSubPath: repository.projectSubPath,
    };
  }
  return {
    kind: 'linked',
    path: repository.gitDir,
    gitPath: repository.gitPath,
    projectSubPath: repository.projectSubPath,
  };
}

export function resolveGitDir(projectRoot: string): string | null {
  const result = resolveGitDirDetailed(projectRoot);
  if (result.kind === 'directory' || result.kind === 'linked') return result.path;
  return null;
}

export function resolveShadowDir(projectRoot: string): string {
  const result = resolveGitDirDetailed(projectRoot);
  switch (result.kind) {
    case 'directory':
      return resolve(result.path, shadowSubdirName(result.projectSubPath));
    case 'linked':
      if (!existsSync(result.path)) {
        throw new MalformedGitPointerError(result.gitPath, result.path);
      }
      return resolve(result.path, shadowSubdirName(result.projectSubPath));
    case 'malformed-pointer':
      throw new MalformedGitPointerError(result.gitPath, result.target, { cause: result.cause });
    case 'inaccessible':
      throw new GitDirAccessError(result.gitPath, { cause: result.cause });
    case 'absent':
      return resolve(projectRoot, '.git/ok');
  }
}

function shadowSubdirName(projectSubPath: string): string {
  if (projectSubPath === '') return 'ok';
  return `ok-${slugifyShadowSubPath(projectSubPath)}`;
}

function slugifyShadowSubPath(rel: string): string {
  const flat = rel.split(sep).join('-').replace(/\/+/g, '-');
  const sanitized = flat.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  const MAX = 64;
  if (sanitized.length <= MAX) return sanitized || 'sub';
  const hash = djb2(rel).toString(16).padStart(8, '0');
  return `${sanitized.slice(0, MAX - 9)}-${hash}`;
}

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

export class MalformedGitPointerError extends Error {
  readonly gitPointerPath: string;
  readonly resolvedTarget: string;
  constructor(gitPointerPath: string, resolvedTarget: string, options?: { cause?: unknown }) {
    const targetClause = resolvedTarget
      ? `references a missing or unreadable gitdir at ${resolvedTarget}`
      : 'is unreadable or has no valid gitdir: pointer';
    super(
      `\`.git\` pointer at ${gitPointerPath} ${targetClause}. Run \`git worktree prune\` from the source repo and try again.`,
      options,
    );
    this.name = 'MalformedGitPointerError';
    this.gitPointerPath = gitPointerPath;
    this.resolvedTarget = resolvedTarget;
  }
}

export class GitDirAccessError extends Error {
  readonly gitPath: string;
  constructor(gitPath: string, options?: { cause?: unknown }) {
    const codeClause =
      options?.cause !== undefined &&
      options.cause !== null &&
      typeof options.cause === 'object' &&
      'code' in options.cause &&
      typeof (options.cause as { code: unknown }).code === 'string'
        ? ` (${(options.cause as { code: string }).code})`
        : '';
    super(
      `Cannot access \`.git\` at ${gitPath}${codeClause}. Check filesystem permissions and that the volume is mounted.`,
      options,
    );
    this.name = 'GitDirAccessError';
    this.gitPath = gitPath;
  }
}

export function getShadowRepoPath(projectRoot: string): string | null {
  let path: string;
  try {
    path = resolveShadowDir(projectRoot);
  } catch (err) {
    if (err instanceof MalformedGitPointerError) return null;
    if (err instanceof GitDirAccessError) return null;
    throw err;
  }
  return existsSync(resolve(path, 'HEAD')) ? path : null;
}

export function getWipRefPattern(branch: string): string {
  return `refs/wip/${branch}/`;
}

export interface ShadowContributor {
  v?: number;
  id: string;
  name: string;
  colorSeed?: string;
  docs: string[];
  summaries?: string[];
}

const OK_CONTRIBUTORS_PREFIX = 'ok-contributors: ';

export function parseContributors(body: string): ShadowContributor[] {
  if (!body) return [];
  const contributors: ShadowContributor[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(OK_CONTRIBUTORS_PREFIX)) continue;
    try {
      const parsed = JSON.parse(trimmed.slice(OK_CONTRIBUTORS_PREFIX.length)) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'id' in parsed &&
        typeof (parsed as Record<string, unknown>).id === 'string' &&
        'name' in parsed &&
        typeof (parsed as Record<string, unknown>).name === 'string' &&
        'docs' in parsed &&
        Array.isArray((parsed as Record<string, unknown>).docs) &&
        ((parsed as Record<string, unknown>).docs as unknown[]).every(
          (d) => typeof d === 'string',
        ) &&
        (!('colorSeed' in parsed) ||
          typeof (parsed as Record<string, unknown>).colorSeed === 'string')
      ) {
        const raw = parsed as Record<string, unknown>;
        if ('summaries' in raw) {
          const s = raw.summaries;
          if (!Array.isArray(s) || !s.every((x) => typeof x === 'string')) {
            delete raw.summaries;
          }
        }
        contributors.push(parsed as ShadowContributor);
      }
    } catch {}
  }
  return contributors;
}

export type {
  AutoConsolidationTrigger,
  CheckpointBundleExposure,
  CheckpointKind,
  CheckpointKindAttributes,
  CheckpointVisibility,
  ParsedCheckpoint,
} from './checkpoint-kinds.ts';
export {
  CHECKPOINT_KIND_REGISTRY,
  CHECKPOINT_KINDS,
  CHECKPOINT_SAMPLE_BY_KIND,
  formatCheckpointBodyLine,
  isChainAnchorCheckpointKind,
  isSurfacedCheckpointKind,
  parseCheckpoint,
} from './checkpoint-kinds.ts';

export interface OkActorEntry {
  v: 1;
  writer_id: string;
  principal: string | null;
  agent_session: string | null;
  agent_type: string | null;
  client_name: string | null;
  client_version: string | null;
  label: string | null;
  display_name: string;
  color_seed: string;
  docs: string[];
  summaries?: string[];
  previous_paths?: Array<{ from: string; to: string }>;
}

const OK_ACTOR_PREFIX = 'ok-actor: ';

export function formatOkActor(entry: OkActorEntry): string {
  const { summaries, previous_paths, ...rest } = entry;
  const payload: Record<string, unknown> = { ...rest };
  if (summaries && summaries.length > 0) payload.summaries = summaries;
  if (previous_paths && previous_paths.length > 0) payload.previous_paths = previous_paths;
  return `${OK_ACTOR_PREFIX}${JSON.stringify(payload)}`;
}

function parseOkActorObject(obj: Record<string, unknown>): OkActorEntry | null {
  if (obj.v !== 1) return null;
  if (!('display_name' in obj) || typeof obj.display_name !== 'string') return null;
  if (!('docs' in obj) || !Array.isArray(obj.docs)) return null;
  const principal = typeof obj.principal === 'string' ? obj.principal : null;
  const agent_session = typeof obj.agent_session === 'string' ? obj.agent_session : null;
  let writer_id: string;
  if (typeof obj.writer_id === 'string' && obj.writer_id.length > 0) {
    writer_id = obj.writer_id;
  } else if (agent_session) {
    writer_id = `agent-${agent_session}`;
  } else if (principal) {
    writer_id = principal;
  } else {
    switch (obj.display_name) {
      case 'File System':
        writer_id = 'file-system';
        break;
      case 'Git (upstream)':
        writer_id = 'git-upstream';
        break;
      default:
        writer_id = 'openknowledge-service';
    }
  }
  const summaries =
    'summaries' in obj && Array.isArray(obj.summaries)
      ? (obj.summaries as unknown[]).every((s) => typeof s === 'string')
        ? (obj.summaries as string[])
        : undefined
      : undefined;
  const previous_paths = parsePreviousPaths(obj);
  return {
    v: 1,
    writer_id,
    principal,
    agent_session,
    agent_type: typeof obj.agent_type === 'string' ? obj.agent_type : null,
    client_name: typeof obj.client_name === 'string' ? obj.client_name : null,
    client_version: typeof obj.client_version === 'string' ? obj.client_version : null,
    label: typeof obj.label === 'string' ? obj.label : null,
    display_name: obj.display_name,
    color_seed: typeof obj.color_seed === 'string' ? obj.color_seed : 'unknown',
    docs: (obj.docs as unknown[]).filter((d): d is string => typeof d === 'string'),
    ...(summaries && summaries.length > 0 ? { summaries } : {}),
    ...(previous_paths && previous_paths.length > 0 ? { previous_paths } : {}),
  };
}

function parsePreviousPaths(
  obj: Record<string, unknown>,
): Array<{ from: string; to: string }> | undefined {
  if (!('previous_paths' in obj)) return undefined;
  if (!Array.isArray(obj.previous_paths)) return undefined;
  const out: Array<{ from: string; to: string }> = [];
  for (const raw of obj.previous_paths as unknown[]) {
    if (raw === null || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.from !== 'string' || typeof candidate.to !== 'string') continue;
    out.push({ from: candidate.from, to: candidate.to });
  }
  return out;
}

export function parseOkActor(body: string): OkActorEntry | null {
  if (!body) return null;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(OK_ACTOR_PREFIX)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed.slice(OK_ACTOR_PREFIX.length));
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object') return null;
    return parseOkActorObject(parsed as Record<string, unknown>);
  }
  return null;
}

export function parseOkActors(body: string): OkActorEntry[] {
  if (!body) return [];
  const out: OkActorEntry[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(OK_ACTOR_PREFIX)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed.slice(OK_ACTOR_PREFIX.length));
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const entry = parseOkActorObject(parsed as Record<string, unknown>);
    if (entry) out.push(entry);
  }
  return out;
}

export function okActorToShadowContributor(a: OkActorEntry): ShadowContributor {
  const shadow: ShadowContributor = {
    v: 1,
    id: a.writer_id,
    name: a.display_name,
    colorSeed: a.color_seed,
    docs: a.docs,
  };
  if (a.summaries && a.summaries.length > 0) shadow.summaries = a.summaries;
  return shadow;
}

export function readContributors(body: string): ShadowContributor[] {
  const actors = parseOkActors(body);
  if (actors.length > 0) return actors.map(okActorToShadowContributor);
  return parseContributors(body);
}

export function formatWipSubject(docs: string[]): string {
  if (docs.length === 0) return 'wip: auto-save';
  if (docs.length === 1) return `wip: ${docs[0]}`;
  return `wip: ${docs.length} docs`;
}

export function formatReconcileSubject(docName: string): string {
  return `reconcile: ${docName}`;
}

export function formatRollbackSubject(docName: string, sha: string): string {
  return `rollback: ${docName} to ${sha.slice(0, 7)}`;
}

export function formatParkSubject(oldBranch: string, newBranch: string): string {
  return `park: ${oldBranch} -> ${newBranch}`;
}

export function formatRenameSubject(oldName: string, newName: string): string {
  return `rename: ${oldName} -> ${newName}`;
}

export function formatCheckpointSubject(message: string): string {
  return `checkpoint: ${message}`;
}

export function formatImportSubject(oldHead: string | null, newHead: string): string {
  return oldHead
    ? `import: from ${oldHead.slice(0, 8)}..${newHead.slice(0, 8)}`
    : `import: initial at ${newHead.slice(0, 8)}`;
}

export const COMMIT_SUBJECT_MAX_LEN = 72;

// biome-ignore lint/complexity/useRegexLiterals: see docblock above for the constraint that forces `new RegExp`.
const SUBJECT_LINE_BREAK_RE = new RegExp('[\\r\\n\\v\\f\\u0085\\u2028\\u2029]', 'g');

function stripLineBreaks(s: string): string {
  return s.replace(SUBJECT_LINE_BREAK_RE, ' ');
}

export function composeCommitSubject(base: string, summaries: readonly string[]): string {
  const safeBase = stripLineBreaks(base);
  if (summaries.length === 0) return safeBase;
  if (summaries.length >= 2) return `${safeBase} (${summaries.length} edits)`;
  const [rawSummary] = summaries;
  if (rawSummary === undefined) return safeBase;
  const summary = stripLineBreaks(rawSummary);
  const full = `${safeBase} — ${summary}`;
  if (full.length <= COMMIT_SUBJECT_MAX_LEN) return full;
  const prefix = `${safeBase} — `;
  const budget = COMMIT_SUBJECT_MAX_LEN - prefix.length - 1;
  if (budget <= 0) return full.slice(0, COMMIT_SUBJECT_MAX_LEN);
  return `${prefix}${summary.slice(0, budget)}…`;
}

export function parseWriterId(id: string): ParsedWriter {
  if (!WRITER_ID_RE.test(id)) {
    return { id, classification: 'unknown', isAgent: null };
  }
  if (id.startsWith('agent-')) return { id, classification: 'agent', isAgent: true };
  if (id.startsWith('principal-')) return { id, classification: 'principal', isAgent: false };
  if (id.startsWith(GIT_AUTHOR_WRITER_PREFIX))
    return { id, classification: 'classified-git-author', isAgent: null };
  if (id === 'file-system') return { id, classification: 'classified-file-system', isAgent: null };
  if (id === 'git-upstream')
    return { id, classification: 'classified-git-upstream', isAgent: null };
  if (id === 'openknowledge-service')
    return { id, classification: 'classified-openknowledge-service', isAgent: null };
  if (id === OK_GENERATOR_WRITER_ID)
    return { id, classification: 'classified-ok-generator', isAgent: null };
  return { id, classification: 'unknown', isAgent: null };
}

export function resolveProjectIdentity(projectDir: string): string {
  const detail = resolveGitDirDetailed(projectDir);
  if (detail.kind !== 'linked') return resolve(projectDir);
  try {
    const commondir = readFileSync(join(detail.path, 'commondir'), 'utf-8').trim();
    if (commondir === '') return resolve(projectDir);
    const mainRoot = dirname(resolve(detail.path, commondir));
    return resolve(mainRoot, detail.projectSubPath);
  } catch {
    return resolve(projectDir);
  }
}
