import type { OkBugReportCrashDetectedEvent } from '@inkeep/open-knowledge-core';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

export interface CrashInviteStore {
  install(opts: { bridge: OkDesktopBridge | undefined }): (() => void) | undefined;
  getSnapshot(): OkBugReportCrashDetectedEvent | null;
  subscribe(listener: () => void): () => void;
  dismiss(): void;
}

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
      const onCrashDetected = (bridge as { bugReport?: OkDesktopBridge['bugReport'] } | undefined)
        ?.bugReport?.onCrashDetected;
      if (typeof onCrashDetected !== 'function') return undefined;
      if (attached) return unsubscribeFromBridge ?? undefined;
      attached = true;
      unsubscribeFromBridge = onCrashDetected((event) => {
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

export const crashInviteStore: CrashInviteStore = createCrashInviteStore();

export function installCrashInviteListener(opts: {
  bridge: OkDesktopBridge | undefined;
}): (() => void) | undefined {
  return crashInviteStore.install(opts);
}
