import { shellSingleQuote } from '@inkeep/open-knowledge-core';
import { detectGh } from './gh-detect.ts';
import type { TokenStore } from './token-store.ts';

type AuthTier = 'A' | 'B' | 'C' | 'none';

interface RelayGhToken {
  token: string;
  host: string;
  login?: string;
}

export interface ResolvedAuth {
  tier: AuthTier;
  gitConfig: string[];
  relayToken?: RelayGhToken;
}

interface ResolveAuthOptions {
  skipGhDetect?: boolean;
  login?: string;
  selfCliArgs?: readonly string[];
}

export function buildCliCredentialHelper(selfCliArgs: readonly string[]): string {
  const prefix = selfCliArgs.map(shellSingleQuote).join(' ');
  return `credential.helper=!${prefix} auth git-credential`;
}

export async function resolveAuth(
  host: string,
  tokenStore: TokenStore,
  options: ResolveAuthOptions = {},
  _detectGhFn: (
    host?: string,
    options?: { login?: string },
  ) => ReturnType<typeof detectGh> = detectGh,
): Promise<ResolvedAuth> {
  const selfHelper = buildCliCredentialHelper(options.selfCliArgs ?? ['open-knowledge']);
  const authenticatedConfig = ['credential.helper=', selfHelper];

  if (!options.skipGhDetect) {
    const gh = _detectGhFn(host, { login: options.login });
    if (gh.available && gh.token) {
      return {
        tier: 'A',
        gitConfig: authenticatedConfig,
        relayToken: {
          token: gh.token,
          host,
          ...(gh.resolvedLogin ? { login: gh.resolvedLogin } : {}),
        },
      };
    }
  }

  const entry = await tokenStore.get(host);
  if (entry != null) {
    const tier: AuthTier = entry.gitProtocol === 'ssh' ? 'C' : 'B';
    return { tier, gitConfig: authenticatedConfig };
  }

  return { tier: 'none', gitConfig: [] };
}
