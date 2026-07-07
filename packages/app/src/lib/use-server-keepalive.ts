/**
 * Web-app `/collab/keepalive` WS — keeps an open browser tab's `ok start`
 * server alive regardless of per-document connection state.
 *
 * `ok start` (CLI) servers arm a 30-minute idle-shutdown that counts ONLY
 * `/collab*` WebSocket upgrades (`packages/server/src/idle-shutdown.ts`). The
 * app's only such signal is its per-document `HocuspocusProvider` connections
 * — so with no doc open, or during a transient disconnect, the count can hit
 * zero and the server idles out from under the tab, breaking every subsequent
 * editor/tool call until reload. Desktop and the MCP shim already hold a
 * persistent, presence-invisible keepalive via the shared `startKeepalive`
 * primitive; this gives the web app the same coverage.
 *
 * One keepalive per app/tab lifetime — independent of any open document. The
 * socket carries no traffic; its sole purpose is to register as an active
 * `/collab*` client. Closing the tab drops it automatically.
 */

import { startKeepalive as defaultStartKeepalive } from '@inkeep/open-knowledge-core/keepalive';
import { useEffect, useRef } from 'react';
import { tryElectronBridge } from '@/lib/use-collab-url';

/**
 * Transform the resolved collab URL (`ws://host:port/collab`) into the
 * keepalive base (`ws://host:port`). `startKeepalive` re-appends
 * `/collab/keepalive`, so the trailing `/collab` is stripped to avoid
 * `/collab/collab/keepalive`. Returns `undefined` while `collabUrl` is
 * unresolved so the primitive backs off and retries instead of building a
 * bogus URL.
 */
export function keepaliveBaseFromCollabUrl(collabUrl: string | null): string | undefined {
  if (!collabUrl) return undefined;
  return collabUrl.replace(/\/collab\/?$/, '');
}

export interface UseServerKeepaliveOptions {
  /** Override the keepalive primitive (tests inject a controllable fake). */
  startKeepalive?: typeof defaultStartKeepalive;
  /** Override the Electron-host detector (tests exercise the gate without `window`). */
  isElectronHost?: () => boolean;
}

/**
 * `useEffect` already runs client-side, so `window` is defined here — passing
 * it straight to `tryElectronBridge` avoids the `typeof window` guard that the
 * in-effect lint rule forbids.
 */
function defaultIsElectronHost(): boolean {
  return tryElectronBridge(window) !== null;
}

/**
 * Hold a single, app-lifetime, presence-invisible `/collab/keepalive` WS.
 * Mount once near the app root (see `ConfigProviderHost` in `App.tsx`) with the
 * resolved `collabUrl` from `useCollabUrl()`.
 */
export function useServerKeepalive(
  collabUrl: string | null,
  options?: UseServerKeepaliveOptions,
): void {
  const collabUrlRef = useRef(collabUrl);
  // Mount-time config (DI for tests; `undefined` in production). The start/stop
  // effect reads the initial value — these never change across a tab's life.
  const optionsRef = useRef(options);

  // Keep the resolver reading the freshest collabUrl WITHOUT restarting the
  // keepalive: a server that respawns on a new port (collabUrl changes after
  // `useCollabUrl` re-resolves) is picked up on the primitive's next reconnect,
  // with no socket churn from tearing the effect down.
  useEffect(() => {
    collabUrlRef.current = collabUrl;
  }, [collabUrl]);

  useEffect(() => {
    const start = optionsRef.current?.startKeepalive ?? defaultStartKeepalive;
    const isElectronHost = optionsRef.current?.isElectronHost ?? defaultIsElectronHost;
    // Desktop already holds a main-process keepalive and boots its server with
    // idleShutdownMs: null, so a renderer keepalive there is redundant.
    if (isElectronHost()) return;
    const handle = start({
      resolveWsUrl: async () => keepaliveBaseFromCollabUrl(collabUrlRef.current),
      // Presence-invisible: omit connectionId + the identity triplet. The
      // browser user is already represented by their real `/collab` provider
      // awareness, so the keepalive must not add a phantom presence entry; and
      // `pid` is omitted because `process` is undefined in the browser.
    });
    return () => handle.close();
    // App-lifetime singleton: start once, tear down on unmount. Reactive inputs
    // are read through refs above, so this effect intentionally has no deps.
  }, []);
}
