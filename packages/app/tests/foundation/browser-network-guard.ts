import type { BrowserContext } from 'playwright';
import type { BrowserCommand } from 'vitest/node';
import { isLoopbackHostname } from '../../../../test-support/no-net-connect-loopback';

declare module 'vitest/browser' {
  interface BrowserCommands {
    installNetworkGuard: () => Promise<void>;
    takeBlockedNetworkRequests: () => Promise<string[]>;
  }
}

function leavesLoopback(url: URL): boolean {
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') && !isLoopbackHostname(url.hostname)
  );
}

const guardedContexts = new WeakSet<BrowserContext>();
const blockedBySession = new Map<string, string[]>();

export const installNetworkGuard: BrowserCommand<[]> = async ({ context, sessionId }) => {
  if (guardedContexts.has(context)) return;
  guardedContexts.add(context);
  await context.route(leavesLoopback, async (route) => {
    blockedBySession.set(sessionId, [
      ...(blockedBySession.get(sessionId) ?? []),
      route.request().url(),
    ]);
    await route.abort('blockedbyclient');
  });
};

export const takeBlockedNetworkRequests: BrowserCommand<[]> = ({ sessionId }) => {
  const blocked = blockedBySession.get(sessionId) ?? [];
  blockedBySession.delete(sessionId);
  return blocked;
};
