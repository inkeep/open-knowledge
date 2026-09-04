import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
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
  if (s.startsWith('file://')) return { kind: 'local', path: s.slice('file://'.length) };
  if (s.startsWith('/') || s.startsWith('.') || s.startsWith('~'))
    return { kind: 'local', path: s };
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
    const dir = resolve(spec.path.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    if (!existsSync(dir)) throw new SkillFetchError(`Local path not found: ${dir}`);
    return { dir, cleanup: () => {} };
  }
  const hasTransportScheme = /^[a-z][a-z0-9+.-]+:/i.test(spec.url);
  if (hasTransportScheme && !ALLOWED_GIT_TRANSPORTS.some((p) => p.test(spec.url))) {
    throw new SkillFetchError(`Unsupported git transport: ${spec.url}`);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'ok-skill-import-'));
  try {
    await execFileAsync(
      'git',
      ['-c', 'core.symlinks=false', 'clone', '-q', '--depth', '1', '--', spec.url, tmp],
      {
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
    );
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    const msg = e instanceof Error ? e.message : String(e);
    throw new SkillFetchError(`git clone failed for ${spec.url}: ${msg}`);
  }
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
