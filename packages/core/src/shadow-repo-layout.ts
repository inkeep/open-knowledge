import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type WriterClassification =
  | 'agent'
  | 'principal'
  | 'classified-file-system'
  | 'classified-git-upstream'
  | 'classified-openknowledge-service'
  | 'unknown';

export interface ParsedWriter {
  id: string;
  classification: WriterClassification;
  isAgent: boolean | null;
}

const WRITER_ID_RE =
  /^(agent-[^/]+|principal-[^/]+|file-system|git-upstream|openknowledge-service)$/;

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

function classifyGitEntry(
  gitPath: string,
  workTreeRoot: string,
  projectRoot: string,
): ResolvedGitDir {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(gitPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    return { kind: 'inaccessible', gitPath, cause: err };
  }
  const projectSubPath = computeProjectSubPath(workTreeRoot, projectRoot);
  if (stat.isDirectory()) return { kind: 'directory', path: gitPath, projectSubPath };
  if (stat.isFile()) {
    let content: string;
    try {
      content = readFileSync(gitPath, 'utf-8').trim();
    } catch (err) {
      return { kind: 'malformed-pointer', gitPath, target: '', cause: err };
    }
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) return { kind: 'malformed-pointer', gitPath, target: '' };
    return {
      kind: 'linked',
      path: resolve(workTreeRoot, match[1]),
      gitPath,
      projectSubPath,
    };
  }
  return { kind: 'absent' };
}

function computeProjectSubPath(workTreeRoot: string, projectRoot: string): string {
  const rel = relative(workTreeRoot, projectRoot);
  if (rel === '' || rel === '.') return '';
  if (rel.startsWith('..') || isAbsolute(rel)) return '';
  return rel;
}

function findAncestorGitEntry(startDir: string): { gitPath: string; workTreeRoot: string } | null {
  const home = homedir();
  let cursor = resolve(startDir);
  const MAX_DEPTH = 64;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (cursor === home) return null;
    const parent = dirname(cursor);
    if (parent === cursor) return null; // reached filesystem root
    if (parent === home) return null; // refuse ~/.git (at-or-above-home policy)
    const candidate = resolve(parent, '.git');
    try {
      const stat = statSync(candidate);
      if (stat.isDirectory() || stat.isFile()) {
        return { gitPath: candidate, workTreeRoot: parent };
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        console.warn(
          `[shadow-repo-layout] Cannot stat ${candidate} (${code ?? 'unknown'}); skipping ancestor`,
        );
      }
    }
    cursor = parent;
  }
  return null;
}

export function resolveGitDirDetailed(projectRoot: string): ResolvedGitDir {
  const projectRootAbs = resolve(projectRoot);
  const direct = classifyGitEntry(resolve(projectRootAbs, '.git'), projectRootAbs, projectRootAbs);
  if (direct.kind !== 'absent') return direct;

  const ancestor = findAncestorGitEntry(projectRootAbs);
  if (ancestor === null) {
    return { kind: 'absent' };
  }
  return classifyGitEntry(ancestor.gitPath, ancestor.workTreeRoot, projectRootAbs);
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

const OK_CHECKPOINT_PREFIX = 'ok-checkpoint-v1: ';

export type AutoConsolidationTrigger = 'dead-chain' | 'session-close' | 'boot' | 'ttl';

export type ParsedCheckpoint =
  | {
      kind: 'bridge-merge-loss';
      docName: string | null;
      size: number | null;
      metadata: { lostSubstrings: string[] };
    }
  | {
      kind: 'external-change-rescue';
      docName: string | null;
      size: number | null;
      metadata: { incomingDiskSha: string };
    }
  | {
      kind: 'auto-consolidation';
      docName: string | null;
      size: number | null;
      metadata: { foldedRefs: number; trigger: string };
    };

export function parseCheckpoint(body: string): ParsedCheckpoint | null {
  if (!body) return null;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(OK_CHECKPOINT_PREFIX)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed.slice(OK_CHECKPOINT_PREFIX.length));
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object') return null;
    const obj = parsed as {
      kind?: unknown;
      metadata?: unknown;
      docName?: unknown;
      size?: unknown;
    };
    const kind = obj.kind;
    const metadata = obj.metadata;
    if (metadata === null || typeof metadata !== 'object') return null;
    const docName = typeof obj.docName === 'string' ? obj.docName : null;
    const size = typeof obj.size === 'number' && Number.isFinite(obj.size) ? obj.size : null;
    if (kind === 'bridge-merge-loss') {
      const m = metadata as { lostSubstrings?: unknown };
      if (Array.isArray(m.lostSubstrings) && m.lostSubstrings.every((s) => typeof s === 'string')) {
        return {
          kind: 'bridge-merge-loss',
          docName,
          size,
          metadata: { lostSubstrings: m.lostSubstrings as string[] },
        };
      }
      return null;
    }
    if (kind === 'external-change-rescue') {
      const m = metadata as { incomingDiskSha?: unknown };
      if (typeof m.incomingDiskSha === 'string') {
        return {
          kind: 'external-change-rescue',
          docName,
          size,
          metadata: { incomingDiskSha: m.incomingDiskSha },
        };
      }
      return null;
    }
    if (kind === 'auto-consolidation') {
      const m = metadata as { foldedRefs?: unknown; trigger?: unknown };
      if (
        typeof m.foldedRefs === 'number' &&
        Number.isFinite(m.foldedRefs) &&
        typeof m.trigger === 'string'
      ) {
        return {
          kind: 'auto-consolidation',
          docName,
          size,
          metadata: { foldedRefs: m.foldedRefs, trigger: m.trigger },
        };
      }
      return null;
    }
    return null;
  }
  return null;
}

export function formatCheckpointBodyLine(parsed: ParsedCheckpoint): string {
  const payload: {
    kind: ParsedCheckpoint['kind'];
    docName?: string;
    size?: number;
    metadata: ParsedCheckpoint['metadata'];
  } = {
    kind: parsed.kind,
    metadata: parsed.metadata,
  };
  if (parsed.docName !== null) payload.docName = parsed.docName;
  if (parsed.size !== null) payload.size = parsed.size;
  return `${OK_CHECKPOINT_PREFIX}${JSON.stringify(payload)}`;
}

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
        : undefined // Drop field on malformed, keep entry
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
  if (rawSummary === undefined) return safeBase; // defensive; length-1 branch guards against this
  const summary = stripLineBreaks(rawSummary);
  const full = `${safeBase} — ${summary}`;
  if (full.length <= COMMIT_SUBJECT_MAX_LEN) return full;
  const prefix = `${safeBase} — `;
  const budget = COMMIT_SUBJECT_MAX_LEN - prefix.length - 1; // reserve one char for the ellipsis
  if (budget <= 0) return full.slice(0, COMMIT_SUBJECT_MAX_LEN); // base already over budget — defensive slice
  return `${prefix}${summary.slice(0, budget)}…`;
}

export function parseWriterId(id: string): ParsedWriter {
  if (!WRITER_ID_RE.test(id)) {
    return { id, classification: 'unknown', isAgent: null };
  }
  if (id.startsWith('agent-')) return { id, classification: 'agent', isAgent: true };
  if (id.startsWith('principal-')) return { id, classification: 'principal', isAgent: false };
  if (id === 'file-system') return { id, classification: 'classified-file-system', isAgent: null };
  if (id === 'git-upstream')
    return { id, classification: 'classified-git-upstream', isAgent: null };
  if (id === 'openknowledge-service')
    return { id, classification: 'classified-openknowledge-service', isAgent: null };
  return { id, classification: 'unknown', isAgent: null };
}
