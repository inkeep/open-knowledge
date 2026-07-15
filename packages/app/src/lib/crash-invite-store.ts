/**
 * Renderer-side module-level store for the crash-invite event.
 *
 * Mirrors the `receive-store` pattern: the bridge subscription is attached at
 * `main.tsx` module-init time (BEFORE React mounts) because main delivers a
 * boot-time `ok:bug-report:crash-detected` on the window's first
 * `did-finish-load`, which can beat React's effect flush — a component-mounted
 * subscription would drop it. The `ReportBugCrashInviteTrigger` component
 * reads via `useSyncExternalStore`.
 *
 * Web / CLI distribution: `bridge` is undefined and `install` is a no-op.
 */

import type { OkBugReportCrashDetectedEvent } from '@inkeep/open-knowledge-core';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

export interface CrashInviteStore {
  install(opts: { bridge: OkDesktopBridge | undefined }): (() => void) | undefined;
  getSnapshot(): OkBugReportCrashDetectedEvent | null;
  subscribe(listener: () => void): () => void;
  /** Drop the current invitation (the trigger clears after acking it). */
  dismiss(): void;
}

/**
 * Factory so each test gets a fresh store instance. Production code uses the
 * singleton `crashInviteStore` exported below.
 */
export function createCrashInviteStore(): CrashInviteStore {
  let current: OkBugReportCrashDetectedEvent | null = null;
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
      // A partial bridge — a test/preview mock, or a renderer paired with a
      // main process predating the bug-report IPC — may omit the `bugReport`
      // surface (which the type declares required). This runs at module-init
      // OUTSIDE any error boundary, so throwing on a missing surface would take
      // down the whole renderer; no-op on absence instead, exactly like an
      // undefined bridge.
      const onCrashDetected = (bridge as { bugReport?: OkDesktopBridge['bugReport'] } | undefined)
        ?.bugReport?.onCrashDetected;
      if (typeof onCrashDetected !== 'function') return undefined;
      if (attached) return unsubscribeFromBridge ?? undefined;
      attached = true;
      unsubscribeFromBridge = onCrashDetected((event) => {
        // Main arms at most one invitation at a time, so last-wins is exact.
        current = event;
        notify();
      });
      return () => {
        unsubscribeFromBridge?.();
        unsubscribeFromBridge = null;
        attached = false;
        clearCurrent();
      };
    },

    getSnapshot(): OkBugReportCrashDetectedEvent | null {
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
export const crashInviteStore: CrashInviteStore = createCrashInviteStore();

/**
 * Module-init-time bridge subscription. Idempotent — HMR re-evaluation is a
 * no-op on the second call thanks to the `attached` flag.
 */
export function installCrashInviteListener(opts: {
  bridge: OkDesktopBridge | undefined;
}): (() => void) | undefined {
  return crashInviteStore.install(opts);
}
