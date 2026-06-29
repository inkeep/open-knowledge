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
