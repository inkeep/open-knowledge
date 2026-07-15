import { detectGh } from './gh-detect.ts';
import type { TokenStore } from './token-store.ts';

type AuthTier = 'A' | 'B' | 'C' | 'none';

interface ResolvedAuth {
  tier: AuthTier;
  /**
   * git -c flags to pass for credential injection.
   * Empty array when tier is 'none' or when using token-store relay.
   */
  credentialArgs: string[];
}

interface ResolveAuthOptions {
  /** Skip gh detection even if gh is on PATH */
  skipGhDetect?: boolean;
}

/**
 * Resolve the best available auth method for a given git hostname.
 *
 * Tier A — gh CLI available and authenticated for `host` (detection is
 *   host-scoped via `gh auth token --hostname`):
 *   credentialArgs = ['-c', "credential.helper=!gh auth git-credential"]
 *
 * Tier B/C — token stored in TokenStore (keyring or file):
 *   credentialArgs = ['-c', "credential.helper=!open-knowledge auth git-credential"]
 *
 * none — no auth available:
 *   credentialArgs = []
 *
 * @param _detectGhFn - injectable for testing; defaults to the real detectGh
 */
export async function resolveAuth(
  host: string,
  tokenStore: TokenStore,
  options: ResolveAuthOptions = {},
  _detectGhFn: (host?: string) => ReturnType<typeof detectGh> = detectGh,
): Promise<ResolvedAuth> {
  // Tier A: gh CLI
  if (!options.skipGhDetect) {
    const gh = _detectGhFn(host);
    if (gh.available) {
      return {
        tier: 'A',
        credentialArgs: ['-c', 'credential.helper=!gh auth git-credential'],
      };
    }
  }

  // Tier B/C: stored token
  const entry = await tokenStore.get(host);
  if (entry != null) {
    const tier: AuthTier = entry.gitProtocol === 'ssh' ? 'C' : 'B';
    return {
      tier,
      credentialArgs: ['-c', 'credential.helper=!open-knowledge auth git-credential'],
    };
  }

  // none
  return { tier: 'none', credentialArgs: [] };
}
