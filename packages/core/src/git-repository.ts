import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const MAX_DISCOVERY_DEPTH = 64;

/**
 * Node-only, read-only Git facts shared by CLI, Desktop, and server adapters.
 * HEAD belongs to the per-worktree git dir; config and refs belong to the
 * common dir. Path admission, forge classification, and user-facing failure
 * policy deliberately stay with each caller.
 */

export type GitHeadResult =
  | { readonly kind: 'branch'; readonly branch: string; readonly ref: string }
  | { readonly kind: 'detached'; readonly oid: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed'; readonly raw: string }
  | { readonly kind: 'unreadable'; readonly cause: unknown };

export type GitRemoteUrlResult =
  | { readonly kind: 'configured'; readonly url: string }
  | { readonly kind: 'absent'; readonly reason: 'config-missing' | 'remote-missing' }
  | { readonly kind: 'unreadable'; readonly cause: unknown };

export type GitCommonDirResult =
  | { readonly kind: 'resolved'; readonly path: string }
  | { readonly kind: 'unreadable'; readonly cause: unknown };

export type GitRefValue =
  | { readonly kind: 'oid'; readonly oid: string }
  | { readonly kind: 'symbolic'; readonly target: string };

export type GitRefResult =
  | {
      readonly kind: 'present';
      readonly storage: 'loose' | 'packed';
      readonly value: GitRefValue;
    }
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'malformed'; readonly raw: string }
  | { readonly kind: 'unreadable'; readonly cause: unknown };

export interface GitRepository {
  readonly kind: 'directory' | 'linked';
  readonly projectRoot: string;
  readonly projectSubPath: string;
  readonly gitPath: string;
  readonly gitDir: string;
  readCommonDir(): GitCommonDirResult;
  readHead(): GitHeadResult;
  readRemoteUrl(remote: string): GitRemoteUrlResult;
  readRef(ref: string): GitRefResult;
}

export type GitRepositoryResult =
  | { readonly kind: 'repository'; readonly repository: GitRepository }
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'malformed-pointer';
      readonly gitPath: string;
      readonly target: string;
      readonly cause?: unknown;
    }
  | { readonly kind: 'inaccessible'; readonly gitPath: string; readonly cause: unknown };

class LocalGitRepository implements GitRepository {
  readonly kind: 'directory' | 'linked';
  readonly projectRoot: string;
  readonly projectSubPath: string;
  readonly gitPath: string;
  readonly gitDir: string;

  private cachedCommonDir: string | undefined;

  constructor(
    kind: 'directory' | 'linked',
    projectRoot: string,
    projectSubPath: string,
    gitPath: string,
    gitDir: string,
  ) {
    this.kind = kind;
    this.projectRoot = projectRoot;
    this.projectSubPath = projectSubPath;
    this.gitPath = gitPath;
    this.gitDir = gitDir;
  }

  readCommonDir(): GitCommonDirResult {
    if (this.cachedCommonDir !== undefined) {
      return { kind: 'resolved', path: this.cachedCommonDir };
    }

    let commonDir = this.gitDir;
    try {
      const pointer = readFileSync(join(this.gitDir, 'commondir'), 'utf-8').trim();
      if (pointer.length > 0) {
        commonDir = isAbsolute(pointer) ? pointer : resolve(this.gitDir, pointer);
      }
    } catch (cause) {
      if (!isMissing(cause)) return { kind: 'unreadable', cause };
      // Main worktrees and gitfile-based repositories without a separate
      // common dir use their git dir directly.
    }
    this.cachedCommonDir = commonDir;
    return { kind: 'resolved', path: commonDir };
  }

  readHead(): GitHeadResult {
    let raw: string;
    try {
      raw = readFileSync(join(this.gitDir, 'HEAD'), 'utf-8').trim();
    } catch (cause) {
      if (isMissing(cause)) return { kind: 'absent' };
      return { kind: 'unreadable', cause };
    }

    const symbolic = /^ref:[ \t]*(refs\/heads\/(.+))$/.exec(raw);
    if (symbolic?.[2]) {
      return { kind: 'branch', branch: symbolic[2], ref: symbolic[1] };
    }
    if (isObjectId(raw)) return { kind: 'detached', oid: raw };
    return { kind: 'malformed', raw };
  }

  readRemoteUrl(remote: string): GitRemoteUrlResult {
    const commonDir = this.readCommonDir();
    if (commonDir.kind === 'unreadable') return commonDir;

    let config: string;
    try {
      config = readFileSync(join(commonDir.path, 'config'), 'utf-8');
    } catch (cause) {
      if (isMissing(cause)) return { kind: 'absent', reason: 'config-missing' };
      return { kind: 'unreadable', cause };
    }

    const url = extractRemoteUrl(config, remote);
    return url === null
      ? { kind: 'absent', reason: 'remote-missing' }
      : { kind: 'configured', url };
  }

  readRef(ref: string): GitRefResult {
    if (!isSafeRef(ref)) return { kind: 'invalid' };

    const commonDir = this.readCommonDir();
    if (commonDir.kind === 'unreadable') return commonDir;

    const loosePath = resolve(commonDir.path, ref);
    const relativePath = relative(commonDir.path, loosePath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) return { kind: 'invalid' };
    try {
      const raw = readFileSync(loosePath, 'utf-8').trim();
      const value = parseRefValue(raw);
      return value === null
        ? { kind: 'malformed', raw }
        : { kind: 'present', storage: 'loose', value };
    } catch (cause) {
      if (!isMissing(cause)) return { kind: 'unreadable', cause };
    }

    let packedRefs: string;
    try {
      packedRefs = readFileSync(join(commonDir.path, 'packed-refs'), 'utf-8');
    } catch (cause) {
      if (isMissing(cause)) return { kind: 'absent' };
      return { kind: 'unreadable', cause };
    }
    for (const rawLine of packedRefs.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('#') || line.startsWith('^')) continue;
      const fields = line.split(/\s+/);
      if (fields.length === 2 && fields[1] === ref) {
        if (!isObjectId(fields[0])) return { kind: 'malformed', raw: line };
        return {
          kind: 'present',
          storage: 'packed',
          value: { kind: 'oid', oid: fields[0] },
        };
      }
    }
    return { kind: 'absent' };
  }
}

export function inspectGitRepository(projectRoot: string): GitRepositoryResult {
  const root = resolve(projectRoot);
  return inspectRepositoryAt(root, '');
}

/** Find the nearest enclosing repository without treating `~/.git` as a project. */
export function discoverGitRepository(projectRoot: string): GitRepositoryResult {
  const start = resolve(projectRoot);
  const home = resolve(homedir());
  if (start === home) return { kind: 'absent' };

  const direct = inspectRepositoryAt(start, '');
  if (direct.kind !== 'absent') return direct;

  let cursor = start;
  for (let depth = 0; depth < MAX_DISCOVERY_DEPTH; depth++) {
    if (cursor === home) return { kind: 'absent' };
    const parent = dirname(cursor);
    if (parent === cursor || parent === home) return { kind: 'absent' };

    const result = inspectRepositoryAt(parent, relative(parent, start));
    if (result.kind !== 'absent') return result;
    cursor = parent;
  }
  return { kind: 'absent' };
}

function inspectRepositoryAt(root: string, projectSubPath: string): GitRepositoryResult {
  const gitPath = join(root, '.git');
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(gitPath);
  } catch (cause) {
    if (isMissing(cause)) return { kind: 'absent' };
    return { kind: 'inaccessible', gitPath, cause };
  }

  if (stat.isDirectory()) {
    return {
      kind: 'repository',
      repository: new LocalGitRepository('directory', root, projectSubPath, gitPath, gitPath),
    };
  }
  if (!stat.isFile()) return { kind: 'absent' };

  let pointer: string;
  try {
    pointer = readFileSync(gitPath, 'utf-8').trim();
  } catch (cause) {
    return { kind: 'malformed-pointer', gitPath, target: '', cause };
  }
  const match = /^gitdir:[ \t]*(.+)$/.exec(pointer);
  if (!match) return { kind: 'malformed-pointer', gitPath, target: '' };

  const rawTarget = match[1].trim();
  const target = isAbsolute(rawTarget) ? rawTarget : resolve(root, rawTarget);
  try {
    if (!statSync(target).isDirectory()) {
      return { kind: 'malformed-pointer', gitPath, target };
    }
  } catch (cause) {
    return { kind: 'malformed-pointer', gitPath, target, cause };
  }

  return {
    kind: 'repository',
    repository: new LocalGitRepository('linked', root, projectSubPath, gitPath, target),
  };
}

function extractRemoteUrl(config: string, remote: string): string | null {
  let inRemote = false;
  for (const rawLine of config.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (line.length === 0) continue;
    if (line.startsWith('[')) {
      const section = /^\[\s*remote\s+["'](.+)["']\s*\]$/.exec(line);
      inRemote = section?.[1] === remote;
      continue;
    }
    if (!inRemote) continue;
    const match = /^url\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = unquote(match[1]);
    if (value.length > 0) return value;
  }
  return null;
}

function stripComment(line: string): string {
  const commentIndex = line.search(/[;#]/);
  return (commentIndex === -1 ? line : line.slice(0, commentIndex)).trim();
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isMissing(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  // ENOENT means the artifact is absent. ENOTDIR means a path component cannot
  // contain it; both classifications let loose-ref reads fall through to packed refs.
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isSafeRef(ref: string): boolean {
  return (
    ref.startsWith('refs/') &&
    !ref.includes('\0') &&
    !ref.includes('\\') &&
    !ref.includes('..') &&
    !ref.includes('//') &&
    !ref.endsWith('/')
  );
}

function parseRefValue(raw: string): GitRefValue | null {
  if (raw.length === 0) return null;
  const symbolic = /^ref:[ \t]*(refs\/.+)$/.exec(raw);
  if (symbolic) {
    return isSafeRef(symbolic[1]) ? { kind: 'symbolic', target: symbolic[1] } : null;
  }
  return isObjectId(raw) ? { kind: 'oid', oid: raw } : null;
}

function isObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}
