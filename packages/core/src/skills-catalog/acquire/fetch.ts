import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { isLocalSkillSource } from '../source-fields.ts';
import { SkillFetchError } from './errors.ts';
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

export { SkillFetchError } from './errors.ts';

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
  const hasTransportScheme = /^[a-z][a-z0-9+.-]+:/i.test(spec.url);
  if (hasTransportScheme && !ALLOWED_GIT_TRANSPORTS.some((p) => p.test(spec.url))) {
    throw new SkillFetchError(`Unsupported git transport: ${spec.url}`);
  }
  const deadline = performance.now() + GIT_FETCH_BUDGET_MS;
  const tmp =
    (spec.subpath ? await cloneSubpathOnly(spec.url, spec.subpath, deadline) : undefined) ??
    (await cloneWholeRepository(spec.url, deadline));
  let ref: string | undefined;
  try {
    ref = execFileSync('git', ['-C', tmp, 'rev-parse', 'HEAD'], { stdio: 'pipe' })
      .toString()
      .trim();
  } catch {}
  const dir = spec.subpath ? resolve(tmp, spec.subpath) : tmp;
  const containment = relative(tmp, dir);
  if (containment.startsWith('..') || isAbsolute(containment)) {
    rmSync(tmp, { recursive: true, force: true });
    throw new SkillFetchError(`subpath escapes the clone: ${spec.subpath}`);
  }
  if (!existsSync(dir)) {
    rmSync(tmp, { recursive: true, force: true });
    throw new SkillFetchError(`subpath not found in repo: ${spec.subpath}`);
  }
  return { dir, ref, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
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

function gitCloneFailed(url: string, e: unknown): SkillFetchError {
  const msg = e instanceof Error ? e.message : String(e);
  return new SkillFetchError(`git clone failed for ${url}: ${msg}`);
}

async function cloneWholeRepository(url: string, deadline: number): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), 'ok-skill-import-'));
  try {
    await runGit(['clone', '-q', '--depth', '1', '--', url, tmp], deadline);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw gitCloneFailed(url, e);
  }
  return tmp;
}

async function cloneSubpathOnly(
  url: string,
  subpath: string,
  deadline: number,
): Promise<string | undefined> {
  const tmp = mkdtempSync(join(tmpdir(), 'ok-skill-import-'));
  const inside = relative(tmp, resolve(tmp, subpath));
  if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) {
    const sparsePath = inside.split(sep).join('/');
    try {
      await runGit(
        ['clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', '--', url, tmp],
        deadline,
      );
      await runGit(
        ['-C', tmp, 'sparse-checkout', 'set', '--skip-checks', '--stdin'],
        deadline,
        `${sparsePath}\n`,
      );
      if (existsSync(join(tmp, inside)) || headCommitLacks(tmp, sparsePath)) return tmp;
      console.warn(
        '[skills-catalog] sparse checkout left the subpath unselected, cloning the whole repository',
        { url, subpath },
      );
    } catch (e) {
      if (budgetSpent(e, deadline)) {
        rmSync(tmp, { recursive: true, force: true });
        throw gitCloneFailed(url, e);
      }
      console.warn('[skills-catalog] sparse clone failed, cloning the whole repository', {
        url,
        subpath,
        err: e,
      });
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  return undefined;
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
