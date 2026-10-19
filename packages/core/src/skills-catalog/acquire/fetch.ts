import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { isLocalSkillSource } from '../source-fields.ts';
import { SkillFetchError, SkillSubpathNotFoundError } from './errors.ts';
import {
  fetchWellKnownSkill,
  type WellKnownFetchOptions,
  type WellKnownSourceSpec,
} from './well-known.ts';

const execFileAsync = promisify(execFile);

export type SourceSpec =
  | { kind: 'local'; path: string }
  | { kind: 'git'; url: string; subpath?: string }
  | WellKnownSourceSpec;

export interface SkillsShSourceRef {
  owner: string;
  skill: string;
}

export { SkillFetchError, SkillSubpathNotFoundError } from './errors.ts';

const GIT_FETCH_BUDGET_MS = 60_000;

const GITHUB_SHORTHAND = /^(?:github\s+)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(.+))?$/;

export const ALLOWED_GIT_TRANSPORTS: readonly RegExp[] = [
  /^https?:\/\//i,
  /^ssh:\/\//i,
  /^git:\/\//i,
  /^git@[^:]+:/,
];

export function parseSource(raw: string): SourceSpec | null {
  const s = raw.trim();
  if (s === '') return null;
  if (s.startsWith('file://')) {
    const path = s.slice('file://'.length);
    return { kind: 'local', path: /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path };
  }
  if (isLocalSkillSource(s)) return { kind: 'local', path: s };
  if (s.startsWith('git@') || s.includes('://')) {
    if (!ALLOWED_GIT_TRANSPORTS.some((p) => p.test(s))) return null;
    return { kind: 'git', url: s };
  }
  const m = GITHUB_SHORTHAND.exec(s);
  if (m) {
    const [, owner, repo, subpath] = m;
    return { kind: 'git', url: `https://github.com/${owner}/${repo}.git`, subpath };
  }
  return null;
}

export function parseSkillsShSource(raw: string): SkillsShSourceRef | null {
  const s = raw.trim();
  if (s === '') return null;

  const fromPath = (path: string): SkillsShSourceRef | null => {
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.length !== 3) return null;
    const [first, middle, last] = parts;
    const owner = first === 'site' ? middle : first;
    const skill = last;
    return owner && skill ? { owner, skill } : null;
  };

  if (/^https?:\/\//i.test(s)) {
    try {
      const url = new URL(s);
      const host = url.hostname.toLowerCase();
      if (host !== 'skills.sh' && host !== 'www.skills.sh') return null;
      return fromPath(url.pathname);
    } catch {
      return null;
    }
  }

  const prefixedPath = /^skills\.sh\/(.+)$/i.exec(s);
  if (prefixedPath) return fromPath(prefixedPath[1] ?? '');

  const prefixedHandle = /^skills\.sh\s+([\w.-]+)\/([\w.-]+)$/i.exec(s);
  if (prefixedHandle) {
    const [, owner, skill] = prefixedHandle;
    return owner && skill ? { owner, skill } : null;
  }

  return null;
}

export interface Fetched {
  readonly dir: string;
  readonly ref?: string;
  readonly cleanup: () => void;
}

export async function fetchSource(
  spec: SourceSpec,
  opts: WellKnownFetchOptions = {},
): Promise<Fetched> {
  if (spec.kind === 'well-known') return fetchWellKnownSkill(spec, opts);
  if (spec.kind === 'local') {
    const dir = resolve(spec.path.replace(/^~(?=[\\/]|$)/, homedir()));
    if (!existsSync(dir)) throw new SkillFetchError(`Local path not found: ${dir}`);
    return { dir, cleanup: () => {} };
  }
  assertAllowedGitTransport(spec.url);
  const deadline = performance.now() + GIT_FETCH_BUDGET_MS;
  const tmp = await cloneFolders(spec.url, spec.subpath ? [spec.subpath] : [], deadline);
  const ref = headRef(tmp);
  const dir = spec.subpath ? resolve(tmp, spec.subpath) : tmp;
  const containment = relative(tmp, dir);
  if (containment.startsWith('..') || isAbsolute(containment)) {
    rmSync(tmp, { recursive: true, force: true });
    throw new SkillFetchError(`subpath escapes the clone: ${spec.subpath}`);
  }
  if (!existsSync(dir)) {
    rmSync(tmp, { recursive: true, force: true });
    throw new SkillSubpathNotFoundError(`subpath not found in repo: ${spec.subpath}`);
  }
  return { dir, ref, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

export interface FetchedListing extends Fetched {
  readonly fetchFolders?: (folders: readonly string[]) => Promise<Fetched>;
}

export async function fetchSourceListing(
  spec: SourceSpec,
  opts: WellKnownFetchOptions = {},
): Promise<FetchedListing> {
  if (spec.kind !== 'git' || spec.subpath) return fetchSource(spec, opts);
  const { url } = spec;
  assertAllowedGitTransport(url);
  const deadline = performance.now() + GIT_FETCH_BUDGET_MS;
  const listed = await cloneSkillFilesOnly(url, deadline);
  const tmp =
    typeof listed === 'string' ? listed : await cloneWholeRepository(url, deadline, listed.failure);
  const fetched = {
    dir: tmp,
    ref: headRef(tmp),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
  if (typeof listed !== 'string') return fetched;
  return {
    ...fetched,
    fetchFolders: async (folders) => {
      const escaping = folders.find((folder) => {
        const inside = relative(tmp, resolve(tmp, folder));
        return inside.startsWith('..') || isAbsolute(inside);
      });
      if (escaping !== undefined) {
        throw new SkillFetchError(`subpath escapes the clone: ${escaping}`);
      }
      const dir = await cloneFolders(url, folders, deadline);
      const missing = folders.find((folder) => !existsSync(resolve(dir, folder)));
      if (missing !== undefined) {
        rmSync(dir, { recursive: true, force: true });
        throw new SkillSubpathNotFoundError(`subpath not found in repo: ${missing}`);
      }
      return {
        dir,
        ref: headRef(dir),
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
      };
    },
  };
}

function assertAllowedGitTransport(url: string): void {
  const hasTransportScheme = /^[a-z][a-z0-9+.-]+:/i.test(url);
  if (hasTransportScheme && !ALLOWED_GIT_TRANSPORTS.some((p) => p.test(url))) {
    throw new SkillFetchError(`Unsupported git transport: ${url}`);
  }
}

function headRef(repo: string): string | undefined {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { stdio: 'pipe' })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

function runGit(args: readonly string[], deadline: number, stdin?: string): Promise<unknown> {
  const timeout = Math.floor(deadline - performance.now());
  if (timeout <= 0) {
    return Promise.reject(
      new Error(`git ${args.join(' ')} not started: the ${GIT_FETCH_BUDGET_MS}ms budget is spent`),
    );
  }
  const run = execFileAsync('git', ['-c', 'core.symlinks=false', ...args], {
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (stdin !== undefined) {
    run.child.stdin?.on('error', () => {});
    run.child.stdin?.end(stdin);
  }
  return run;
}

function withoutUrlCredentials(text: string): string {
  return text.replace(/(\bhttps?:\/\/)[^\s/@]+@/gi, '$1***@');
}

function gitFailureReason(e: unknown): string {
  const stderr =
    e instanceof Error && 'stderr' in e && typeof e.stderr === 'string' ? e.stderr.trim() : '';
  return withoutUrlCredentials(stderr !== '' ? stderr : e instanceof Error ? e.message : String(e));
}

function gitCloneFailed(url: string, e: unknown, earlierFailure?: string): SkillFetchError {
  const reason = gitFailureReason(e);
  const earlier =
    earlierFailure === undefined || earlierFailure === reason
      ? ''
      : `. Fetching only part of the repository had failed first: ${earlierFailure}`;
  return new SkillFetchError(
    withoutUrlCredentials(`git clone failed for ${url}: ${reason}${earlier}`),
  );
}

function gitFetchTimedOut(url: string): SkillFetchError {
  return new SkillFetchError(
    withoutUrlCredentials(`Fetching ${url} hit the ${GIT_FETCH_BUDGET_MS / 1000}-second limit.`),
  );
}

async function cloneWholeRepository(
  url: string,
  deadline: number,
  earlierFailure?: string,
): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), 'ok-skill-import-'));
  try {
    await runGit(['clone', '-q', '--depth', '1', '--', url, tmp], deadline);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw budgetSpent(e, deadline) ? gitFetchTimedOut(url) : gitCloneFailed(url, e, earlierFailure);
  }
  return tmp;
}

async function cloneFolders(
  url: string,
  folders: readonly string[],
  deadline: number,
): Promise<string> {
  const sparse = folders.length > 0 ? await cloneOnlyFolders(url, folders, deadline) : {};
  return typeof sparse === 'string' ? sparse : cloneWholeRepository(url, deadline, sparse.failure);
}

async function cloneOnlyFolders(
  url: string,
  folders: readonly string[],
  deadline: number,
): Promise<string | { failure?: string }> {
  const tmp = mkdtempSync(join(tmpdir(), 'ok-skill-import-'));
  const inside = folders.map((folder) => relative(tmp, resolve(tmp, folder)));
  if (inside.some((p) => p === '' || p.startsWith('..') || isAbsolute(p))) {
    rmSync(tmp, { recursive: true, force: true });
    return {};
  }
  const sparsePaths = inside.map((p) => p.split(sep).join('/'));
  const subpath = folders.join(', ');
  try {
    await runGit(
      ['clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', '--', url, tmp],
      deadline,
    );
    await runGit(
      ['-C', tmp, 'sparse-checkout', 'set', '--skip-checks', '--stdin'],
      deadline,
      sparsePaths.map((p) => `${p}\n`).join(''),
    );
    const unselected = folders.filter(
      (_, i) =>
        !existsSync(join(tmp, inside[i] as string)) &&
        !headCommitLacks(tmp, sparsePaths[i] as string),
    );
    if (unselected.length === 0) return tmp;
    console.warn(
      '[skills-catalog] sparse checkout left the subpath unselected, cloning the whole repository',
      { url: withoutUrlCredentials(url), subpath: unselected.join(', ') },
    );
    rmSync(tmp, { recursive: true, force: true });
    return { failure: `sparse checkout left ${unselected.join(', ')} unselected` };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (budgetSpent(e, deadline)) throw gitFetchTimedOut(url);
    const failure = gitFailureReason(e);
    console.warn('[skills-catalog] sparse clone failed, cloning the whole repository', {
      url: withoutUrlCredentials(url),
      subpath,
      err: new Error(failure),
    });
    return { failure };
  }
}

async function cloneSkillFilesOnly(
  url: string,
  deadline: number,
): Promise<string | { failure: string }> {
  const tmp = mkdtempSync(join(tmpdir(), 'ok-skill-import-'));
  try {
    await runGit(
      ['clone', '-q', '--depth', '1', '--filter=blob:none', '--no-checkout', '--', url, tmp],
      deadline,
    );
    mkdirSync(join(tmp, '.git', 'info'), { recursive: true });
    writeFileSync(join(tmp, '.git', 'info', 'sparse-checkout'), 'SKILL.md\n');
    await runGit(
      [
        '-c',
        'core.sparseCheckout=true',
        '-c',
        'core.sparseCheckoutCone=false',
        '-C',
        tmp,
        'read-tree',
        '-mu',
        'HEAD',
      ],
      deadline,
    );
    return tmp;
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (budgetSpent(e, deadline)) throw gitFetchTimedOut(url);
    const failure = gitFailureReason(e);
    console.warn('[skills-catalog] skill listing clone failed, cloning the whole repository', {
      url: withoutUrlCredentials(url),
      err: new Error(failure),
    });
    return { failure };
  }
}

function budgetSpent(e: unknown, deadline: number): boolean {
  return (
    performance.now() >= deadline || (e instanceof Error && 'killed' in e && e.killed === true)
  );
}

function headCommitLacks(repo: string, path: string): boolean {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `HEAD:${path}`], {
      stdio: 'pipe',
    });
    return false;
  } catch (e) {
    return e instanceof Error && 'status' in e && e.status === 1;
  }
}
