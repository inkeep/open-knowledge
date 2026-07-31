/**
 * Resolve an import source to a local directory to read a skill-dir from.
 *
 * v1 sources: a local / `file://` path, a `github owner/repo[/subpath]`
 * shorthand, a raw git URL, and a website's well-known skill index. (Adopt-local
 * is handled by the server straight from an enumerated skill's `home` — no
 * fetch.) `skills.sh` references are resolved before this fetcher either clones
 * their repository or materializes their declared website bundle.
 *
 * Network fetch is a shallow `git clone --depth 1` (git is already a dependency
 * via the shadow repo). The caller is responsible for `cleanup()`.
 */

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

/**
 * Classify a raw source string. Local paths (`/`, `.`, `~`, `file://`) and
 * explicit git URLs (`://`, `git@`, `.git`) are taken verbatim; a bare
 * `owner/repo[/subpath]` (optionally `github `-prefixed) becomes a GitHub HTTPS
 * clone. Returns `null` when nothing matches.
 */
/**
 * Safe git-clone transports. Anything else — notably `ext::` and `fd::`, which
 * execute arbitrary commands — is rejected before it can reach `git clone`.
 *
 * Exported because the server enforces the same gate on its own path. This was
 * two byte-identical copies kept in step by a comment, which is one edit away
 * from reopening the transport hole on whichever side was missed.
 */
export const ALLOWED_GIT_TRANSPORTS: readonly RegExp[] = [
  /^https?:\/\//i,
  /^ssh:\/\//i,
  /^git:\/\//i,
  /^git@[^:]+:/, // SCP-style: git@github.com:owner/repo
];

export function parseSource(raw: string): SourceSpec | null {
  const s = raw.trim();
  if (s === '') return null;
  if (s.startsWith('file://')) return { kind: 'local', path: s.slice('file://'.length) };
  if (s.startsWith('/') || s.startsWith('.') || s.startsWith('~'))
    return { kind: 'local', path: s };
  if (s.startsWith('git@') || s.includes('://')) {
    // Only real remote transports reach `git clone`. `includes('://')` alone
    // would admit `ext::sh -c '…' x://y` — git's `ext::`/`fd::` transports run
    // arbitrary commands (RCE). Allowlist the safe schemes (mirrors the server's
    // isAllowedGitUrl in local-op-security.ts) so every clone caller — the skill
    // preview/discover/import routes, the CLI, and the MCP tool — is guarded at
    // this one shared chokepoint. Raw git URL: no subpath parsing (opaque).
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

/**
 * Parse direct skills.sh references without changing bare `owner/repo`
 * semantics. Supported forms:
 *
 * - `https://www.skills.sh/<owner>/<repo>/<skill>` (what `skillsShSkillLinks`
 *   emits, and what the site uses — `<repo>` is literally `skills` only for
 *   publishers who named their repo that)
 * - `https://www.skills.sh/site/<hostname>/<skill>`
 * - `skills.sh <owner>/<skill>`
 */
export function parseSkillsShSource(raw: string): SkillsShSourceRef | null {
  const s = raw.trim();
  if (s === '') return null;

  const fromPath = (path: string): SkillsShSourceRef | null => {
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.length !== 3) return null;
    const [first, middle, last] = parts;
    // The middle segment is the REPO, not a fixed `skills` literal. Requiring
    // the literal meant OK could not parse the very URL it renders in the
    // preview header — it happened to work only because the popular publishers
    // (anthropics, vercel-labs) name their repo `skills`. Owner-matching in
    // `resolveSkillsShImportSource` is what actually narrows this.
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
  /** Directory to read the skill-dir(s) from. */
  readonly dir: string;
  /** Resolved commit sha for a git clone; `undefined` for local sources. */
  readonly ref?: string;
  /** Remove any temp clone. No-op for local sources. */
  readonly cleanup: () => void;
}

/**
 * Fetch a source to a local directory. Local sources are read in place,
 * repositories are shallow-cloned, and website bundles are materialized from
 * their well-known index. The caller always owns `cleanup()`.
 */
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
  // Defense-in-depth: parseSource is the intended chokepoint (it allowlists
  // remote transports and routes local paths to `kind: 'local'`), but SourceSpec
  // is a public type — reject git's command-executing helper transports here too
  // so a caller that hand-builds `{ kind: 'git', url }` can't smuggle an
  // `ext::`/`fd::` RCE into `git clone`. A bare local path stays cloneable.
  // Enforce the POSITIVE allowlist, not a two-entry denylist: a hand-built
  // `{ kind: 'git', url: 'file:///…' }` slipped past an `ext|fd` check and
  // reached `git clone`, even though `parseSource` routes `file://` to
  // `kind: 'local'` and the server's `isAllowedGitUrl` rejects it outright.
  // A scheme needs 2+ characters so a Windows drive letter (`C:\…`) is read as
  // a path, and a bare filesystem path stays cloneable — that is how the CLI
  // clones a local repo.
  const hasTransportScheme = /^[a-z][a-z0-9+.-]+:/i.test(spec.url);
  if (hasTransportScheme && !ALLOWED_GIT_TRANSPORTS.some((p) => p.test(spec.url))) {
    throw new SkillFetchError(`Unsupported git transport: ${spec.url}`);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'ok-skill-import-'));
  try {
    // `--` terminates option parsing so a URL beginning with `-` can never be
    // read as a git flag (defense-in-depth — execFileSync already runs no shell).
    // `-q` keeps clone progress off stderr (would otherwise risk the maxBuffer);
    // `timeout` bounds a dead host or a private-repo credential prompt that would
    // otherwise hang the import handler indefinitely.
    // Async (not execFileSync) so a slow clone doesn't block the whole Node
    // event loop — every HTTP route + the collab websocket would otherwise
    // freeze for up to the 60s timeout on the preview/discover/import paths.
    // `-c core.symlinks=false`: a malicious source can commit SKILL.md (or a
    // scripts/references file) as a symlink to a host file; with symlinks off,
    // git writes them as plain text holding the link path, so the reader never
    // follows the escape (defense-in-depth — the read is on the server's host).
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
  } catch {
    // Non-fatal — the clone succeeded; we just couldn't read the sha.
  }
  const dir = spec.subpath ? resolve(tmp, spec.subpath) : tmp;
  // Containment via `relative` (not a string prefix): a prefix check would admit
  // a sibling like `<tmp>-extra`. An escaping subpath yields a `..`-leading or
  // absolute relative path.
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
