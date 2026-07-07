/**
 * First-launch MCP consent — renderer-side module-level store + install.
 *
 * Mirrors the pattern of `update-notices-store.ts`: the bridge subscription
 * is attached at `main.tsx` module-init time (BEFORE React mounts) so an IPC
 * `ok:mcp-wiring:show` arriving before the dialog is mounted isn't dropped.
 * The component reads via `useSyncExternalStore`.
 *
 * Main fires `ok:mcp-wiring:show` exactly once per app-boot when the
 * user-scoped marker is absent (see `packages/desktop/src/main/mcp-wiring.ts`).
 * The consent flow is user-scoped — whichever window opens first
 * (Navigator, editor-via-lastOpenedProject, editor-via-deep-link) will see
 * the dialog, via `McpConsentDialog` rendered at both app shells.
 *
 * Web / CLI distribution: `bridge` is undefined and `install` is a no-op.
 */

import type {
  OkDesktopBridge,
  OkMcpWiringConfirmRequest,
  OkMcpWiringResult,
  OkMcpWiringShowPayload,
} from '@/lib/desktop-bridge-types';

export interface McpConsentStore {
  install(opts: { bridge: OkDesktopBridge | undefined }): (() => void) | undefined;
  getSnapshot(): OkMcpWiringShowPayload | null;
  subscribe(listener: () => void): () => void;
  confirm(request: OkMcpWiringConfirmRequest): Promise<OkMcpWiringResult>;
  skip(): Promise<OkMcpWiringResult>;
  dismiss(): void;
}

/**
 * Factory so each test gets a fresh store instance. Production code uses the
 * singleton `mcpConsentStore` exported below.
 */
export function createMcpConsentStore(): McpConsentStore {
  let currentRequest: OkMcpWiringShowPayload | null = null;
  let bridge: OkDesktopBridge | null = null;
  const listeners = new Set<() => void>();
  let attached = false;
  let unsubscribeFromBridge: (() => void) | null = null;

  function notify(): void {
    for (const l of listeners) l();
  }

  function clearCurrent(): void {
    if (currentRequest === null) return;
    currentRequest = null;
    notify();
  }

  return {
    install({ bridge: b }): (() => void) | undefined {
      if (!b) return undefined;
      if (attached) return unsubscribeFromBridge ?? undefined;
      attached = true;
      bridge = b;
      unsubscribeFromBridge = b.mcpWiring.onShow((payload) => {
        currentRequest = payload;
        notify();
      });
      b.mcpWiring.signalReady();
      return () => {
        unsubscribeFromBridge?.();
        unsubscribeFromBridge = null;
        attached = false;
        bridge = null;
        clearCurrent();
      };
    },

    getSnapshot(): OkMcpWiringShowPayload | null {
      return currentRequest;
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    // Partial-failure recovery contract:
    //   - ok: true  → clearCurrent() unmounts the dialog; user is done.
    //   - ok: false → DO NOT unmount. The main handler resets its `handled`
    //                 flag on failure (see mcp-wiring.ts:confirmHandler) so
    //                 the user can adjust selections and click Add again
    //                 from the SAME open dialog. Without this, partial
    //                 failures (e.g. 1 of 3 editors' config dir unwritable)
    //                 dismiss the dialog; the only signal is a 4s sonner
    //                 toast, and a same-boot retry is impossible until the
    //                 next app launch re-fires the dialog.
    //   - catch     → thrown errors (IPC channel dead, bridge detached)
    //                 keep the dialog mounted too; they're not "user decided"
    //                 outcomes. clearCurrent() only on true success.
    async confirm(request): Promise<OkMcpWiringResult> {
      const b = bridge;
      if (!b) return { ok: false, error: 'Not attached to desktop bridge' };
      try {
        const result = await b.mcpWiring.confirm(request);
        if (result.ok) clearCurrent();
        return result;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
      }
    },

    async skip(): Promise<OkMcpWiringResult> {
      const b = bridge;
      if (!b) return { ok: false, error: 'Not attached to desktop bridge' };
      try {
        const result = await b.mcpWiring.skip();
        if (result.ok) clearCurrent();
        return result;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
      }
    },

    dismiss(): void {
      clearCurrent();
    },
  };
}

/** Module-level singleton — `main.tsx` installs once at boot. */
export const mcpConsentStore: McpConsentStore = createMcpConsentStore();

/**
 * Module-init-time bridge subscription. Idempotent — HMR re-evaluation is a
 * no-op on the second call thanks to the `attached` flag. Mirrors
 * `installUpdateNoticesBridge` + `installDeepLinkListener`.
 */
export function installMcpConsentListener(opts: {
  bridge: OkDesktopBridge | undefined;
}): (() => void) | undefined {
  return mcpConsentStore.install(opts);
}
