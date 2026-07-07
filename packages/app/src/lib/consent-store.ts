/**
 * Per-project onboarding consent — renderer-side module-level store + install.
 *
 * Mirrors `mcp-consent-store.ts`: the bridge subscription is attached at
 * `main.tsx` module-init time (BEFORE React mounts) so an IPC
 * `ok:onboarding:show` arriving before the dialog is mounted isn't dropped.
 * Component reads via `useSyncExternalStore`.
 *
 * Each Navigator folder-pick that resolves to a fresh kind from a
 * dialog-path entry point (`pick-existing` / `recents` / `deep-link` /
 * `drag-drop`) fires a fresh show event. Multiple sequential picks within
 * one Navigator boot are expected — the store replaces the current request
 * on each new show.
 *
 * Web / CLI distribution: `bridge` is undefined and `install` is a no-op.
 */

import type {
  OkDesktopBridge,
  OkOnboardingConfirmRequest,
  OkOnboardingResult,
  OkOnboardingShowPayload,
} from '@/lib/desktop-bridge-types';

export interface ConsentStore {
  install(opts: { bridge: OkDesktopBridge | undefined }): (() => void) | undefined;
  getSnapshot(): OkOnboardingShowPayload | null;
  subscribe(listener: () => void): () => void;
  confirm(request: OkOnboardingConfirmRequest): Promise<OkOnboardingResult>;
  cancel(): Promise<OkOnboardingResult>;
  dismiss(): void;
}

export function createConsentStore(): ConsentStore {
  let currentRequest: OkOnboardingShowPayload | null = null;
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
      // Tolerate bridges without an `onboarding` namespace (e.g. e2e fake
      // bridges that pre-date the per-project consent flow). Without this
      // guard, calling `b.onboarding.onShow(...)` against such a stub
      // throws synchronously during module-init in main.tsx, crashing the
      // React tree before mount — leaving every downstream renderer
      // assertion (file tree, tabs, sidebar) silently unrendered.
      if (!b.onboarding) return undefined;
      if (attached) return unsubscribeFromBridge ?? undefined;
      attached = true;
      bridge = b;
      unsubscribeFromBridge = b.onboarding.onShow((payload) => {
        currentRequest = payload;
        notify();
      });
      b.onboarding.signalReady();
      return () => {
        unsubscribeFromBridge?.();
        unsubscribeFromBridge = null;
        attached = false;
        bridge = null;
        clearCurrent();
      };
    },

    getSnapshot(): OkOnboardingShowPayload | null {
      return currentRequest;
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    // Recovery contract mirrors mcp-consent-store: ok:true → clearCurrent
    // unmounts the dialog; ok:false keeps it mounted so the user can adjust
    // selections and retry from the same open dialog.
    async confirm(request): Promise<OkOnboardingResult> {
      const b = bridge;
      if (!b) return { ok: false, error: 'Not attached to desktop bridge' };
      try {
        const result = await b.onboarding.confirm(request);
        if (result.ok) clearCurrent();
        return result;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
      }
    },

    async cancel(): Promise<OkOnboardingResult> {
      const b = bridge;
      if (!b) return { ok: false, error: 'Not attached to desktop bridge' };
      try {
        const result = await b.onboarding.cancel();
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

export const consentStore: ConsentStore = createConsentStore();

export function installConsentListener(opts: {
  bridge: OkDesktopBridge | undefined;
}): (() => void) | undefined {
  return consentStore.install(opts);
}
