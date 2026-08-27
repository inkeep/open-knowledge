/**
 * Binds the resolved collab URL onto the module-scope agent-thread client (swapping
 * `/collab` → `/collab/thread`). Mounted once in EditorPane so the client connects,
 * lists, and replays regardless of whether the sessions dock is open — thread
 * liveness is independent of the dock's visibility.
 *
 * Lifted out of the retired `AgentThreadRegion`, which used to own this binding
 * alongside the standalone agent dock. Renders nothing.
 */

import { useEffect } from 'react';
import { getAgentThreadClient, threadUrlFromCollabUrl } from '@/lib/acp/thread-client';
import { useCollabUrl } from '@/lib/use-collab-url';

/**
 * Fetch the development-only thread-injection harness installer.
 *
 * Deliberately a module-scope function rather than inline in the effect below:
 * React Compiler cannot lower an `import()` expression inside a component and
 * fails the build outright, while a plain function is left alone. Keeping the
 * only caller inside an `import.meta.env.DEV` branch is what lets the bundler
 * drop this function, the dynamic import, and the harness chunk together.
 *
 * Resolves to the installer rather than calling it, so a caller that has since
 * unmounted can decline without ever having published a harness.
 */
async function loadDevThreadHarnessInstaller(): Promise<
  typeof import('@/lib/acp/dev-thread-harness').installAcpThreadHarness
> {
  const mod = await import('@/lib/acp/dev-thread-harness');
  return mod.installAcpThreadHarness;
}

export function AgentThreadClientBinder(): null {
  const { collabUrl } = useCollabUrl();

  // The client reconnects when the URL changes and replays any missed events per
  // thread, so a mid-session project switch (Electron) or a reconnect is transparent.
  useEffect(() => {
    getAgentThreadClient().setUrl(threadUrlFromCollabUrl(collabUrl));
  }, [collabUrl]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let uninstall: (() => void) | null = null;
    let unmounted = false;
    loadDevThreadHarnessInstaller()
      .then((install) => {
        // Declining after unmount is what makes this safe under StrictMode's
        // remount: installing and then withdrawing would clobber the harness the
        // second mount had already published in the meantime.
        if (unmounted) return;
        uninstall = install(getAgentThreadClient());
      })
      .catch((err: unknown) => {
        // A stale chunk after a dev-server restart rejects here. Unhandled, the
        // only symptom downstream is a browser test waiting out its timeout on
        // a global that never appears, with the real cause in a rejection
        // nothing is listening for.
        console.warn(
          '[acp] dev thread harness unavailable; window.__acpThreadHarness will not be published',
          err,
        );
      });
    return () => {
      unmounted = true;
      uninstall?.();
    };
  }, []);

  return null;
}
