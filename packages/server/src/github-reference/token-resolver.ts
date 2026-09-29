import type { IncomingHttpHeaders } from 'node:http';
import { createGhTokenSource } from '../gh-token-source.ts';
import type { DetectGhFn, ProbeTokenStore } from '../github-permissions.ts';
import { hasForwardingHeaders } from '../ingress-policy.ts';
import { getLogger } from '../logger.ts';
import { isLoopbackAddress } from '../loopback.ts';

const log = getLogger('github-reference');

export function mayUseGitHubToken(req: {
  readonly socket?: { readonly remoteAddress?: string | undefined } | undefined;
  readonly headers: IncomingHttpHeaders;
}): boolean {
  return isLoopbackAddress(req.socket?.remoteAddress) && !hasForwardingHeaders(req);
}

export function createGitHubTokenResolver(
  detectGh: DetectGhFn | undefined,
  tokenStore: ProbeTokenStore | null | undefined,
): (host: string) => Promise<string | null> {
  const ghTokens = createGhTokenSource(detectGh);
  return async (host) => {
    const gh = ghTokens.get(host);
    if (gh !== null) return gh.token;
    if (!tokenStore) return null;
    try {
      const entry = await tokenStore.get(host);
      return entry?.token ? entry.token : null;
    } catch (err) {
      log.warn({ err, host }, '[github-reference] token store lookup failed; reading anonymously');
      return null;
    }
  };
}
