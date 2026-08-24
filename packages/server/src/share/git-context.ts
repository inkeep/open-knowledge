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
  | {
      kind: 'ok';
      host: string;
      owner: string;
      repo: string;
      transport: OriginTransport;
    }
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
export interface ParsedOriginRepo {
  host: string;
  owner: string;
  repo: string;
  transport: OriginTransport;
  /**
   * Account declared in the URL's userinfo, absent when the URL declares
   * none. URL-declared ONLY — identity decisions must go through the
   * `github-account.ts` resolvers, which also consult
   * `credential.<url>.username`; reading this field directly yields an
   * account that can disagree with what the push path authenticates as.
   */
  login?: string;
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
 * Values that mark a transport or a token-auth convention, never an account —
 * whether declared as URL userinfo or as a `credential.<url>.username`
 * entry: `git` is SSH's conventional user (and a reserved name on GitHub,
 * so it can't be anyone's login on https either), and the rest are the
 * conventional usernames tooling writes next to an embedded token
 * (`x-access-token:<token>@`, `oauth2:<token>@`, …) — OK's own publish path
 * mints the `x-access-token` form. All of them pass the login grammar below,
 * so they need their own set.
 */
const USERINFO_PLACEHOLDER_USERS = new Set([
  'git',
  'x-access-token',
  'x-oauth-basic',
  'oauth2',
  'token',
]);

/**
 * GitHub credential prefixes (classic + fine-grained PATs, OAuth, app
 * installation, user-to-server, and refresh tokens) — the same family the
 * diagnostic-bundle scrubber redacts. A userinfo carrying one is a leaked
 * credential, never an account name. Every current format is also ≥40 chars,
 * so the login grammar's length cap independently rejects them; this check is
 * belt-and-braces for any future shorter format.
 */
const GITHUB_TOKEN_PREFIX = /^(?:gh[opsur]_|github_pat_)/;

/**
 * GitHub login grammar: 1–39 chars, alphanumeric with single internal
 * separators, no leading/trailing separator. Hyphens per github.com signup
 * rules; underscores appear in Enterprise Managed User logins
 * (`mona_shortcode`). Anything outside this grammar cannot be a GitHub
 * account, so treating it as one would put an arbitrary string — possibly a
 * credential — into subprocess argv, log fields, the sync-status wire, and
 * UI copy.
 */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|[-_](?=[A-Za-z0-9])){0,38}$/;

/**
 * The shared half of the two userinfo predicates below: not credential-shaped
 * (no GitHub token prefix) and inside the login grammar. Kept in one place so
 * the declared-account tier and the redaction tier cannot drift on what a
 * login looks like; the predicates differ only on the placeholder set and on
 * who percent-decodes.
 */
function isGitHubLoginShaped(value: string): boolean {
  return !GITHUB_TOKEN_PREFIX.test(value) && GITHUB_LOGIN.test(value);
}

/**
 * Whether two values name the same GitHub account. GitHub logins are unique
 * and comparable case-insensitively (the API canonicalizes casing; users
 * hand-write remote URLs in whatever casing they remember), so a casing
 * difference is the same person and must not read as an account mismatch.
 * False when either side is absent — an unattributed credential is never
 * "the same account" as a named one. Note this governs COMPARISON only:
 * `gh auth token --user` itself matches its stored login exactly (a plain
 * keyring/config-key lookup, verified against gh's config code), so a
 * casing-mismatched declaration still falls back to the active account.
 */
export function sameGitHubLogin(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

/**
 * Reduce a URL's userinfo to the GitHub account it declares.
 *
 * Git forwards this half of the URL to credential helpers as `username=`, so
 * it is the user's own statement of which account owns the remote. The
 * password half of `user:pass@` is dropped here and never returned — it must
 * not reach a log line, a UI label, or a browse URL. The username half gets
 * the same protection when it is itself credential-shaped: GitHub's canonical
 * PAT-in-URL form is `https://<token>@github.com/o/r`, so anything that fails
 * the GitHub login grammar (or carries a GitHub token prefix, or is a known
 * transport placeholder like `git` or `x-access-token`) reads as "no account
 * declared" rather than becoming a value the resolver would echo into argv,
 * logs, and the sync popover.
 */
function loginFromUserinfo(userinfo: string | undefined): string | undefined {
  if (!userinfo) return undefined;
  const colon = userinfo.indexOf(':');
  const user = colon === -1 ? userinfo : userinfo.slice(0, colon);
  if (!user) return undefined;
  return asDeclaredGitHubLogin(decodeUserinfo(user));
}

/**
 * Reduce an already-decoded value to the GitHub account it declares, or
 * undefined when it cannot be one: transport/token-convention placeholders
 * (`git`, `x-access-token`, …), values carrying a GitHub token prefix, and
 * anything outside the login grammar all read as "no account declared". One
 * home for the policy so the URL-userinfo tier and the
 * `credential.<url>.username` tier cannot drift — an unvalidated value would
 * otherwise flow into subprocess argv, log fields, the sync-status wire, and
 * UI copy. Percent-decoding and the `user:pass` split are userinfo grammar
 * and stay in `loginFromUserinfo`; a git-config value is passed as written.
 */
export function asDeclaredGitHubLogin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (USERINFO_PLACEHOLDER_USERS.has(raw)) return undefined;
  return isGitHubLoginShaped(raw) ? raw : undefined;
}

/**
 * The username half of a URL userinfo when it is shaped like a GitHub login,
 * undefined when it is credential-shaped (a GitHub token prefix, or anything
 * outside the login grammar). Redaction call sites use this to decide whether
 * a username may be echoed back: a login-shaped one survives — including
 * transport placeholders like `git` or `x-access-token`, which are
 * diagnostically useful and never secrets, so unlike
 * {@link asDeclaredGitHubLogin} this keeps the placeholder set — while a
 * token-as-username must be dropped.
 */
export function loginShapedUserinfoUser(user: string): string | undefined {
  if (!user) return undefined;
  const decoded = decodeUserinfo(user);
  return isGitHubLoginShaped(decoded) ? decoded : undefined;
}

/**
 * Percent-decode a userinfo half; a malformed escape (`%zz` in a hand-edited
 * `.git/config`) keeps the raw form, which then faces the same login-grammar
 * validation as any other value.
 */
function decodeUserinfo(user: string): string {
  if (!user.includes('%')) return user;
  try {
    return decodeURIComponent(user);
  } catch {
    return user;
  }
}

/**
 * Match a GitHub-host origin URL (github.com or GHES) and return
 * `{host, owner, repo, transport}` plus any account the URL declares in its
 * userinfo. Returns null for known non-GitHub forges
 * (`KNOWN_NON_GITHUB_GIT_HOSTS`) and unparseable strings. Unknown hosts are
 * presumed GitHub; the downstream probe/token paths degrade gracefully when
 * one turns out not to be.
 */
export function parseGitHubOriginUrl(originUrl: string): ParsedOriginRepo | null {
  const raw = originUrl.trim();
  if (!raw) return null;

  const classify = (
    host: string,
    owner: string,
    repo: string,
    transport: OriginTransport,
    userinfo?: string,
  ): ParsedOriginRepo | null => {
    const normalized = normalizeGitHost(host);
    if (KNOWN_NON_GITHUB_GIT_HOSTS.has(normalized)) return null;
    const login = loginFromUserinfo(userinfo);
    return login === undefined
      ? { host: normalized, owner, repo, transport }
      : { host: normalized, owner, repo, transport, login };
  };

  // https://[<userinfo>@]<host>[:port]/<owner>/<repo>(.git)?
  // The userinfo group is greedy so a `@` inside the password half
  // (`user:p@ss`) is consumed by it rather than read as the host delimiter.
  let m =
    /^https?:\/\/(?:([^/]*)@)?([\w.-]+(?::\d+)?)\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(
      raw,
    );
  if (m) return classify(m[2], m[3], m[4], 'https', m[1]);

  // ssh://[<userinfo>@]<host>[:port]/<owner>/<repo>(.git)?
  m = /^ssh:\/\/(?:([^/]*)@)?([\w.-]+)(?::\d+)?\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(
    raw,
  );
  if (m) return classify(m[2], m[3], m[4], 'ssh', m[1]);

  // <userinfo>@<host>:<owner>/<repo>(.git)?  (scp-style; `@` is required, so
  // Windows drive paths like `C:\x` can never match)
  m = /^([\w.\-~%]+)@([\w.-]+):([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?$/.exec(raw);
  if (m) return classify(m[2], m[3], m[4], 'ssh', m[1]);

  // git://<host>[:port]/<owner>/<repo>(.git)?
  m = /^git:\/\/([\w.-]+(?::\d+)?)\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(raw);
  if (m) return classify(m[1], m[2], m[3], 'git');

  return null;
}

/**
 * The raw `origin` URL exactly as `.git/config` spells it, or null when no
 * origin is configured. Callers that resolve credentials need the unparsed
 * string: git matches `credential.<url>.*` entries against the URL as written.
 */
export function readOriginRemoteUrl(projectDir: string): string | null {
  const origin = readRepository(projectDir)?.readRemoteUrl('origin');
  return origin?.kind === 'configured' ? origin.url : null;
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
 * configured. The URL-declared login is deliberately not surfaced here:
 * identity decisions go through the `github-account.ts` resolvers, which
 * also consult `credential.<url>.username` — a second reader of the raw
 * userinfo could disagree with what the push path authenticates as.
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
 * Whether OK should clear the inherited credential-helper chain for git spawns
 * against this project's origin.
 *
 * OK can only produce a credential for GitHub hosts: sign-in rejects known
 * non-GitHub forges outright (`validateGitHubHost`), and the relayed gh token
 * is host-scoped, so neither tier can answer for e.g. gitlab.com. Clearing the
 * chain there can only subtract — it removes the ambient credential the user is
 * actually syncing with and leaves nothing in its place, and the in-app "Sign
 * in" affordance cannot help because it only ever yields a GitHub token. Those
 * origins keep their inherited chain.
 */
export function shouldResetAmbientCredentials(projectDir: string): boolean {
  return readOriginGitHubRepo(projectDir).kind !== 'non-github';
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
