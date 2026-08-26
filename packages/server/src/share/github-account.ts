/**
 * Resolve which GitHub account a remote belongs to, from identity the user has
 * already declared through standard git mechanisms.
 *
 * The chain mirrors how git itself picks a username for a credential request:
 *
 *   1. the remote URL's userinfo (`https://alice@github.com/o/r`)
 *   2. `credential.<url>.username` at any config scope
 *   3. neither — the caller keeps today's behavior and uses gh's active account
 *
 * Step 1 beats step 2 even when a `credential.<url>.username` entry is the more
 * specific of the two: git resolves the URL's userinfo first, so any other
 * order would make OpenKnowledge disagree with what plain `git push` does in
 * the user's terminal on identical config.
 *
 * Step 3 is a floor, never a cliff. A URL that names no account, an unparseable
 * origin, a missing `git` binary, and a non-GitHub forge all land on `active`
 * with no login — never on "no account at all", which would turn a
 * wrong-identity failure into a total auth failure.
 *
 * This is a sibling of `git-context.ts` rather than part of it because step 2
 * spawns `git`, which that module deliberately avoids for its sub-100ms budget.
 * Callers on a hot path must cache the result rather than resolving per
 * operation — `createCachedGitHubAccountResolver` is that cache.
 */

import { spawnSync } from 'node:child_process';
import { withHiddenWindowsConsole } from '../child-process-windows-hide.ts';
import { getLogger } from '../logger.ts';
import { asDeclaredGitHubLogin, parseGitHubOriginUrl, readOriginRemoteUrl } from './git-context.ts';
import { redactShareSubprocessStderr } from './publish.ts';

const log = getLogger('github-account');

/** Which of the three declaration sites produced the account, in chain order. */
export type GitHubAccountSource = 'remote-url' | 'credential-config' | 'active';

/**
 * A resolved GitHub identity for one remote.
 *
 * `host` is parsed out of the URL and never accepted from the caller — two
 * sources for the same fact is how the probe and the push end up authenticating
 * as different accounts. It is absent only when no GitHub host could be parsed.
 *
 * A discriminated union so the prose invariant is a compile error instead:
 * a declared source always carries both `host` and `login`, and `'active'`
 * never carries a login — the caller's signal to resolve a token the way it
 * always has.
 */
export type GitHubAccount =
  | { source: 'active'; host?: string; login?: undefined }
  | { source: Exclude<GitHubAccountSource, 'active'>; host: string; login: string };

/**
 * Reads `git config --get-urlmatch credential <url>`, returning raw stdout or
 * null when git exits non-zero, is absent, or produces nothing.
 *
 * Injectable so callers that must not spawn (hot paths under test, spawn
 * accounting) can supply their own; the default is the real subprocess.
 */
export type CredentialUrlMatchReader = (url: string, cwd: string) => string | null;

export interface ResolveGitHubAccountOptions {
  /**
   * Directory the `git config` lookup runs in, defaulting to the process cwd.
   * Every config scope git resolves from that directory applies — including
   * the LOCAL scope of whatever repository encloses it. A pre-clone resolution
   * run from inside an unrelated checkout therefore sees that checkout's
   * `credential.<url>.*` entries too, not just global/system scope; callers
   * that must not inherit an enclosing repo's declarations should pass a cwd
   * outside any repository.
   */
  cwd?: string;
  _readCredentialUrlMatch?: CredentialUrlMatchReader;
}

const defaultCredentialUrlMatchReader: CredentialUrlMatchReader = (url, cwd) => {
  const result = spawnSync(
    'git',
    ['config', '--get-urlmatch', 'credential', url],
    withHiddenWindowsConsole({ cwd, encoding: 'utf-8', timeout: 5_000 }),
  );
  // rc=0 and rc=1 are both benign, and neither one answers "was a username
  // declared?" — git exits 0 whenever ANY `credential.*` key matches the URL
  // (it prints `credential.helper` on its own when no username is set) and 1
  // only when nothing in the section matches at all, so the parse below is
  // what decides. Everything else — a failed or timed-out spawn
  // (`error`/`signal`), or git rejecting the invocation (rc=128, e.g. a
  // broken gitconfig) — is a lookup FAILURE, not an absence of declaration.
  // Both degrade to the chain's floor (a resolver error must never take auth
  // down), but the failure class gets a log line so a user whose
  // `credential.<url>.username` declaration silently stops applying has a
  // trace to find.
  if (result.error || result.status === null || (result.status !== 0 && result.status !== 1)) {
    log.warn(
      {
        status: result.status,
        signal: result.signal,
        err: result.error,
        // Redacted before it lands in a pino field: the failure classes that
        // reach this branch (rc=128 on a broken gitconfig) are exactly the ones
        // where git echoes config content back, and pino output is persisted to
        // disk and collected into diagnostic bundles.
        stderr:
          typeof result.stderr === 'string'
            ? redactShareSubprocessStderr(result.stderr).slice(0, 200)
            : undefined,
      },
      '[github-account] git config --get-urlmatch failed — treating the URL as declaring no account',
    );
    return null;
  }
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout;
};

/**
 * Strip any `user[:password]@` half out of a URL before it becomes a
 * subprocess argument. Only reached when the userinfo declared no usable
 * account (absent, a transport placeholder, or credential-shaped), so nothing
 * of matching value is lost — and an embedded token must never ride into
 * argv, which is world-readable on Linux. Host- and path-scoped
 * `credential.<url>.*` matching is unaffected; only a config key scoped to
 * that exact userinfo (pathological for a placeholder) would stop matching.
 */
function stripUserinfoForLookup(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1');
}

/**
 * Pick the username out of `--get-urlmatch` output, which prints one
 * `credential.<key> <value>` line per matched key. Later lines win, matching
 * git's own last-value-wins resolution.
 */
function credentialUsernameFrom(stdout: string): string | undefined {
  let username: string | undefined;
  for (const line of stdout.split('\n')) {
    const value = line.startsWith('credential.username ')
      ? line.slice('credential.username '.length).trim()
      : undefined;
    if (value) username = value;
  }
  return username;
}

/**
 * Resolve the account declared for a remote URL. Works before the repository
 * exists: the userinfo needs only the URL, and `--get-urlmatch` resolves
 * every config scope reachable from `cwd` — global and system always, plus
 * the local scope of any repository that encloses `cwd`.
 */
export function resolveGitHubAccountFromUrl(
  url: string,
  options: ResolveGitHubAccountOptions = {},
): GitHubAccount {
  const parsed = parseGitHubOriginUrl(url);
  // A known non-GitHub forge or an unparseable URL has no GitHub account to
  // name, and asking gh about it would be meaningless.
  if (!parsed) return { source: 'active' };

  const host = parsed.host;
  if (parsed.login) return { host, login: parsed.login, source: 'remote-url' };

  // Credential config is an HTTPS-transport concept: git consults credential
  // helpers only for http(s) remotes, and `--get-urlmatch` exits 128 outright
  // on the scp form (no scheme). SSH/git origins go straight to the floor —
  // no spawn, and no per-TTL fatal for a class of origins the lookup can
  // never answer for.
  if (parsed.transport !== 'https') return { host, source: 'active' };

  const read = options._readCredentialUrlMatch ?? defaultCredentialUrlMatchReader;
  const stdout = read(stripUserinfoForLookup(url), options.cwd ?? process.cwd());
  // The same declared-account policy the URL-userinfo tier applies: a config
  // value that cannot be a GitHub login (an email, a pasted token, a
  // transport placeholder like `x-access-token`) reads as no declaration and
  // falls to the active-account floor instead of reaching argv, logs, the
  // wire, and UI copy.
  const login = stdout ? asDeclaredGitHubLogin(credentialUsernameFrom(stdout)) : undefined;
  return login ? { host, login, source: 'credential-config' } : { host, source: 'active' };
}

export interface CachedGitHubAccountResolverOptions {
  /** Cache lifetime for a resolved account per project + origin URL. Default 60s. */
  ttlMs?: number;
  /** Injectable clock for tests. Default `Date.now`. */
  now?: () => number;
  _readCredentialUrlMatch?: CredentialUrlMatchReader;
}

export interface CachedGitHubAccountResolver {
  /** Resolve the account declared for the project's `origin`, cached. */
  resolve(projectDir: string): GitHubAccount;
  /**
   * Drop the cached resolution so the next `resolve` re-runs the chain.
   * Called at the same credential-change points that flush the token cache —
   * after an auth failure or a fresh sign-in, re-requesting a token for a
   * possibly-stale account choice would defeat the flush.
   */
  invalidate(): void;
}

const DEFAULT_RESOLUTION_TTL_MS = 60_000;

/**
 * The project-shaped resolver, cached for hot paths: the origin URL is re-read from
 * `.git/config` on every call — cheap, and what lets an origin edit (a remote
 * swap, a userinfo change) take effect on the very next resolution — while the
 * `git config --get-urlmatch` spawn behind the credential-config step runs at
 * most once per project + URL per TTL window. A config edit that does not
 * change the URL is picked up when the window rolls over, or immediately via
 * `invalidate()`.
 *
 * The entry is keyed by project as well as URL because repo-local
 * `credential.<url>.*` entries make the answer project-specific. It is a
 * single slot, sized for the one-resolver-per-engine (one project) wiring —
 * a future multi-project caller sharing one resolver would thrash it to a 0%
 * hit rate and should switch the slot to a Map first.
 */
export function createCachedGitHubAccountResolver(
  options: CachedGitHubAccountResolverOptions = {},
): CachedGitHubAccountResolver {
  const ttlMs = options.ttlMs ?? DEFAULT_RESOLUTION_TTL_MS;
  const now = options.now ?? Date.now;
  let cached:
    | { projectDir: string; url: string; account: GitHubAccount; expiresAt: number }
    | undefined;

  return {
    resolve(projectDir: string): GitHubAccount {
      const url = readOriginRemoteUrl(projectDir);
      if (!url) return { source: 'active' };
      const t = now();
      if (
        cached &&
        cached.projectDir === projectDir &&
        cached.url === url &&
        cached.expiresAt > t
      ) {
        return cached.account;
      }
      const account = resolveGitHubAccountFromUrl(url, {
        cwd: projectDir,
        _readCredentialUrlMatch: options._readCredentialUrlMatch,
      });
      cached = { projectDir, url, account, expiresAt: t + ttlMs };
      return account;
    },

    invalidate(): void {
      cached = undefined;
    },
  };
}
