/**
 * Read-only inspector for the local git state required by
 * `POST /api/share/construct-url`: HEAD branch, origin URL, and the
 * `refs/remotes/origin/<branch>` ref existence.
 *
 * All reads target `.git/` directly via filesystem APIs rather than spawning
 * `git` subprocesses — the share button has a sub-100ms p95 budget and a
 * three-subprocess hop would dominate on slower machines. Branch-existence is
 * local-only against `refs/remotes/origin/<branch>` (loose form) with a
 * packed-refs fallback; no `git ls-remote`.
 *
 * The github-origin parser here is intentionally narrower than
 * `parseGitUrl` in `packages/cli/src/github/url.ts` — it covers only the four
 * URL forms produced by real GitHub/GHES clones (https, ssh://, scp-style,
 * git://), not the cli grammar's shorthand forms. It stays a server-local
 * parser because the cli depends on `@inkeep/open-knowledge-server` — importing
 * the cli's parser here would create a cycle.
 *
 * Host classification follows the cli's `validateGitHubHost` philosophy:
 * GHES hostnames are arbitrary, so any parseable origin whose host is not a
 * known non-GitHub forge (`KNOWN_NON_GITHUB_GIT_HOSTS`) is treated as a
 * GitHub host and carries its `host` in the result. Known forges (gitlab,
 * bitbucket, …) classify as `non-github` so callers surface the matching
 * toast.
 */

import { KNOWN_NON_GITHUB_GIT_HOSTS } from '@inkeep/open-knowledge-core';
import {
  type GitRepository,
  inspectGitRepository,
} from '@inkeep/open-knowledge-core/git-repository';
import { getLogger } from '../logger.ts';

const log = getLogger('git-context');

/**
 * Which URL form the origin was written in. Determines how a push would
 * authenticate: `https` pushes auth with tokens; `ssh` (both `ssh://` and
 * scp-style) auths with SSH keys; `git://` is unauthenticated. The
 * push-permission probe keys leniency off this — token absence proves nothing
 * about push ability for a non-token transport.
 */
export type OriginTransport = 'https' | 'ssh' | 'git';

/** Outcome of `readOriginGitHubRepo`. */
export type OriginResult =
  | { kind: 'ok'; host: string; owner: string; repo: string; transport: OriginTransport }
  | { kind: 'no-remote' }
  | { kind: 'non-github' };

function readRepository(projectDir: string): GitRepository | null {
  const result = inspectGitRepository(projectDir);
  return result.kind === 'repository' ? result.repository : null;
}

/**
 * Read `.git/HEAD` and return the symbolic-ref branch name. Returns null for
 * a detached HEAD (raw SHA), a missing HEAD file, or any read failure.
 */
export function readGitHeadBranch(projectDir: string): string | null {
  const head = readRepository(projectDir)?.readHead();
  return head?.kind === 'branch' ? head.branch : null;
}

/** Parsed origin repo: normalized host + owner/repo path segments. */
interface ParsedOriginRepo {
  host: string;
  owner: string;
  repo: string;
  transport: OriginTransport;
}

/**
 * Lowercase, strip a trailing `:port`, and fold `www.github.com` →
 * `github.com`. Ports are dropped because every downstream consumer (token
 * relay via `gh auth token --hostname`, the `/api/v3` probe base, browse
 * URLs) addresses the host by name.
 */
function normalizeGitHost(rawHost: string): string {
  const host = rawHost.toLowerCase().replace(/:\d+$/, '');
  return host === 'www.github.com' ? 'github.com' : host;
}

/**
 * Match a GitHub-host origin URL (github.com or GHES) and return
 * `{host, owner, repo}`. Returns null for known non-GitHub forges
 * (`KNOWN_NON_GITHUB_GIT_HOSTS`) and unparseable strings. Unknown hosts are
 * presumed GitHub; the downstream probe/token paths degrade gracefully when
 * one turns out not to be.
 */
function parseGitHubOriginUrl(originUrl: string): ParsedOriginRepo | null {
  const raw = originUrl.trim();
  if (!raw) return null;

  const classify = (
    host: string,
    owner: string,
    repo: string,
    transport: OriginTransport,
  ): ParsedOriginRepo | null => {
    const normalized = normalizeGitHost(host);
    if (KNOWN_NON_GITHUB_GIT_HOSTS.has(normalized)) return null;
    return { host: normalized, owner, repo, transport };
  };

  // https://<host>[:port]/<owner>/<repo>(.git)?
  let m = /^https?:\/\/([\w.-]+(?::\d+)?)\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(raw);
  if (m) return classify(m[1], m[2], m[3], 'https');

  // ssh://[user@]<host>[:port]/<owner>/<repo>(.git)?
  m = /^ssh:\/\/(?:[\w.-]+@)?([\w.-]+)(?::\d+)?\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(
    raw,
  );
  if (m) return classify(m[1], m[2], m[3], 'ssh');

  // <user>@<host>:<owner>/<repo>(.git)?  (scp-style; `@` is required, so
  // Windows drive paths like `C:\x` can never match)
  m = /^[\w.-]+@([\w.-]+):([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?$/.exec(raw);
  if (m) return classify(m[1], m[2], m[3], 'ssh');

  // git://<host>[:port]/<owner>/<repo>(.git)?
  m = /^git:\/\/([\w.-]+(?::\d+)?)\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(raw);
  if (m) return classify(m[1], m[2], m[3], 'git');

  return null;
}

/** Read and classify the configured origin shared by the two public readers. */
function readParsedOrigin(
  projectDir: string,
): { originUrl: string; github: ParsedOriginRepo | null } | null {
  const origin = readRepository(projectDir)?.readRemoteUrl('origin');
  if (origin?.kind !== 'configured') return null;
  const originUrl = origin.url;
  return { originUrl, github: parseGitHubOriginUrl(originUrl) };
}

/**
 * Read `.git/config`, locate `[remote "origin"]`, and classify the URL.
 * Returns `ok` (with the origin `host` — `github.com` or a GHES hostname)
 * for GitHub-host origins, `non-github` for known non-GitHub forges (gitlab,
 * bitbucket, ...) and unparseable URLs, `no-remote` when no origin URL is
 * configured.
 */
export function readOriginGitHubRepo(projectDir: string): OriginResult {
  const parsed = readParsedOrigin(projectDir);
  if (!parsed) return { kind: 'no-remote' };
  if (parsed.github) {
    const { host, owner, repo, transport } = parsed.github;
    return { kind: 'ok', host, owner, repo, transport };
  }
  // Origin URL present but a known non-GitHub forge or unparseable — surface
  // as `non-github` so the caller renders the matching toast.
  return { kind: 'non-github' };
}

/**
 * The workspace origin's GitHub host (github.com or GHES), falling back to
 * github.com when there is no parseable GitHub origin. Single source of the
 * "which host do auth surfaces target by default" rule — the local-op auth
 * relay and the CLI `--host` defaults both call this. Never throws (all
 * `.git` reads underneath are individually guarded): the CLI evaluates it
 * at command registration, where a throw would break every invocation.
 */
export function originGitHubHost(projectDir: string): string {
  const origin = readOriginGitHubRepo(projectDir);
  if (origin.kind === 'ok') return origin.host;
  log.debug(
    { kind: origin.kind },
    '[git-context] origin is not a GitHub host — falling back to github.com',
  );
  return 'github.com';
}

/**
 * UI-facing summary of the origin remote for the sync-status payload.
 * `webUrl` is non-null for GitHub-host origins — github.com AND GHES (the
 * Sync UI renders it as a link); known non-GitHub forges yield a readable
 * `label` with no link.
 */
export interface SyncRemoteInfo {
  label: string;
  webUrl: string | null;
}

/**
 * Resolve the origin remote into a display label + optional browse URL.
 * Reads `.git/config` directly (no subprocess), so it is safe to call from
 * the synchronous sync-status path. Returns null when no origin URL is set.
 */
export function readSyncRemoteInfo(projectDir: string): SyncRemoteInfo | null {
  const parsed = readParsedOrigin(projectDir);
  if (!parsed) return null;
  if (parsed.github) {
    const { host, owner, repo } = parsed.github;
    return {
      // Enterprise hosts keep the host in the label; github.com stays terse.
      label: host === 'github.com' ? `${owner}/${repo}` : `${host}/${owner}/${repo}`,
      webUrl: `https://${host}/${owner}/${repo}`,
    };
  }
  // Non-github origin: show a readable host/path label, never linkified.
  return { label: labelFromNonGitHubUrl(parsed.originUrl), webUrl: null };
}

/**
 * Best-effort readable label for a non-github origin URL: strip credentials,
 * scheme, and a trailing `.git`, leaving `host/path` (scp-like
 * `git@host:group/repo` becomes `host/group/repo`). Display-only.
 */
function labelFromNonGitHubUrl(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, '');
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(trimmed);
  if (scp) return `${scp[1]}/${scp[2]}`;
  // `*` (not `?`) so multiple `@`-terminated userinfo segments are all
  // stripped — e.g. `https://user:p@ss@host/...` won't leak `ss@host`.
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)*(.+)$/i.exec(trimmed);
  if (scheme) return scheme[1];
  return trimmed;
}

/**
 * Return true if `<projectDir>/.git/refs/remotes/origin/<branch>` exists
 * (loose ref) OR `packed-refs` contains an entry for
 * `refs/remotes/origin/<branch>`. Local-only — no network call.
 *
 * False-negative window: the user's last `git fetch` ran before they pushed
 * the branch. The toast prompts them to push, they push, fetch isn't
 * required for share (the local ref is updated as a side effect of `push`),
 * the retry succeeds. Acceptable by contract.
 */
export function branchExistsOnOrigin(projectDir: string, branch: string): boolean {
  return readRepository(projectDir)?.readRef(`refs/remotes/origin/${branch}`).kind === 'present';
}
