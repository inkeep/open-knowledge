/**
 * Renderer-side module-level store for the share-receive payload.
 *
 * Mirrors the `mcp-consent-store` pattern: the bridge subscription is attached
 * at `main.tsx` module-init time (BEFORE React mounts) so an `ok:share:received`
 * arriving before the dialog is mounted isn't dropped. The component reads via
 * `useSyncExternalStore`.
 *
 * Web / CLI distribution: `bridge` is undefined and `install` is a no-op.
 */

import type { OkDesktopBridge, OkShareReceivedPayload } from '@/lib/desktop-bridge-types';

export interface ShareReceiveStore {
  install(opts: { bridge: OkDesktopBridge | undefined }): (() => void) | undefined;
  getSnapshot(): OkShareReceivedPayload | null;
  subscribe(listener: () => void): () => void;
  dismiss(): void;
}

/**
 * Factory so each test gets a fresh store instance. Production code uses the
 * singleton `shareReceiveStore` exported below.
 */
export function createShareReceiveStore(): ShareReceiveStore {
  let current: OkShareReceivedPayload | null = null;
  const listeners = new Set<() => void>();
  let attached = false;
  let unsubscribeFromBridge: (() => void) | null = null;

  function notify(): void {
    for (const l of listeners) l();
  }

  function clearCurrent(): void {
    if (current === null) return;
    current = null;
    notify();
  }

  return {
    install({ bridge }): (() => void) | undefined {
      if (!bridge) return undefined;
      if (attached) return unsubscribeFromBridge ?? undefined;
      attached = true;
      unsubscribeFromBridge = bridge.onShareReceived((payload) => {
        current = payload;
        notify();
      });
      return () => {
        unsubscribeFromBridge?.();
        unsubscribeFromBridge = null;
        attached = false;
        clearCurrent();
      };
    },

    getSnapshot(): OkShareReceivedPayload | null {
      return current;
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dismiss(): void {
      clearCurrent();
    },
  };
}

/** Module-level singleton — `main.tsx` installs once at boot. */
export const shareReceiveStore: ShareReceiveStore = createShareReceiveStore();

/**
 * Module-init-time bridge subscription. Idempotent — HMR re-evaluation is a
 * no-op on the second call thanks to the `attached` flag.
 */
export function installShareReceivedListener(opts: {
  bridge: OkDesktopBridge | undefined;
}): (() => void) | undefined {
  return shareReceiveStore.install(opts);
}
