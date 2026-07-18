import { shellSingleQuote } from '@inkeep/open-knowledge-core';
import { detectGh } from './gh-detect.ts';
import type { TokenStore } from './token-store.ts';

type AuthTier = 'A' | 'B' | 'C' | 'none';

/**
 * A gh-resolved token to relay to the credential helper via env. gh is resolved
 * HERE (where it is reachable — inside the CLI process, which the caller
 * spawned with the user's env) rather than shelled out to from git's credential
 * subsystem, whose subprocess PATH may not include `gh` at all (the packaged
 * desktop app's stripped `launchd` PATH). Mirrors the sync path's `RelayGhToken`.
 */
interface RelayGhToken {
  token: string;
  /** Host the token authenticates; the helper host-matches before using it. */
  host: string;
}

export interface ResolvedAuth {
  tier: AuthTier;
  /**
   * git `-c` config VALUES to inject (each becomes a `-c <value>` flag, in
   * order). For an authenticated tier this is a two-element list: an empty
   * `credential.helper=` reset followed by OK's self-referential helper. The
   * reset neutralizes any ambient (possibly broken) user-global helper — e.g. a
   * stale `!gh auth git-credential` left by a past `gh auth setup-git` on a
   * machine where `gh` is no longer installed, which git would otherwise try
   * first and fail with "gh: command not found". Empty for tier `none` so a
   * user's own working helper (osxkeychain, a manual PAT) still authenticates an
   * anonymous/public clone.
   */
  gitConfig: string[];
  /** Tier A only: the gh token to relay via OK_GH_TOKEN/OK_GH_TOKEN_HOST env. */
  relayToken?: RelayGhToken;
}

interface ResolveAuthOptions {
  /** Skip gh detection even if gh is on PATH */
  skipGhDetect?: boolean;
  /**
   * argv that re-execs THIS CLI (`[execPath, cliEntry]`), used to build the
   * self-referential credential helper. Defaults to the bare `open-knowledge`
   * PATH binary for the dev / CLI-on-PATH case. Packaged callers MUST pass the
   * real argv, since no `open-knowledge` binary exists on the git subprocess
   * PATH there.
   */
  selfCliArgs?: readonly string[];
}

/**
 * Build the `credential.helper=` config VALUE that re-invokes THIS CLI as a git
 * credential helper. `selfCliArgs` is the argv that re-execs the CLI; each
 * element is shell-quoted so a bundled path with spaces
 * (`/Applications/OpenKnowledge.app/…`) survives git running the `!`-prefixed
 * helper through `sh -c`. Mirrors the sync path's `buildSyncCredentialArgs` —
 * the bare `open-knowledge` form this replaces isn't resolvable in the packaged
 * desktop app (no such binary on the git subprocess PATH).
 */
export function buildCliCredentialHelper(selfCliArgs: readonly string[]): string {
  const prefix = selfCliArgs.map(shellSingleQuote).join(' ');
  return `credential.helper=!${prefix} auth git-credential`;
}

/**
 * Resolve the best available auth method for a given git hostname.
 *
 * All authenticated tiers route through OK's OWN self-referential credential
 * helper (`!<selfCliArgs> auth git-credential`) and prepend a `credential.helper=`
 * reset — so the clone authenticates via the token OK already holds regardless of
 * whether `gh` is installed or what the user's ambient git config points at.
 *
 * Tier A — gh CLI available and authenticated for `host` (detection is
 *   host-scoped via `gh auth token --hostname`): the gh token is relayed via
 *   `relayToken` (env) and the helper returns it (`handleCredentialGet` reads
 *   OK_GH_TOKEN first). No `!gh` shell-out — so it works even when `gh` isn't on
 *   git's subprocess PATH.
 *
 * Tier B/C — token stored in TokenStore (keyring or file): the helper reads it
 *   from the store.
 *
 * none — no OK credential to offer: `gitConfig` empty, ambient config untouched.
 *
 * @param _detectGhFn - injectable for testing; defaults to the real detectGh
 */
export async function resolveAuth(
  host: string,
  tokenStore: TokenStore,
  options: ResolveAuthOptions = {},
  _detectGhFn: (host?: string) => ReturnType<typeof detectGh> = detectGh,
): Promise<ResolvedAuth> {
  const selfHelper = buildCliCredentialHelper(options.selfCliArgs ?? ['open-knowledge']);
  // Empty reset first, then OK's helper — see ResolvedAuth.gitConfig.
  const authenticatedConfig = ['credential.helper=', selfHelper];

  // Tier A: gh CLI — relay the gh-resolved token via env.
  if (!options.skipGhDetect) {
    const gh = _detectGhFn(host);
    if (gh.available && gh.token) {
      return { tier: 'A', gitConfig: authenticatedConfig, relayToken: { token: gh.token, host } };
    }
  }

  // Tier B/C: stored token — the helper reads it from the TokenStore.
  const entry = await tokenStore.get(host);
  if (entry != null) {
    const tier: AuthTier = entry.gitProtocol === 'ssh' ? 'C' : 'B';
    return { tier, gitConfig: authenticatedConfig };
  }

  // none
  return { tier: 'none', gitConfig: [] };
}
