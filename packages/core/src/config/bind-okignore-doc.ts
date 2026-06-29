
import type * as Y from 'yjs';
import type { ConfigValidationError } from './errors.ts';
import type { Err, Ok, Result } from './result.ts';

const DEFAULT_YTEXT_KEY = 'source';

const DEFAULT_ACCEPTANCE_DELAY_MS = 800;

export interface OkignoreDocProvider {
  document: Y.Doc;
  on(event: 'synced', listener: () => void): void;
  off(event: 'synced', listener: () => void): void;
}

export type OkignoreBindingStatus = 'idle' | 'pending' | 'accepted' | 'rejected';

export interface OkignoreBindingPatchSuccess {
  text: string;
}

export type OkignoreBindingPatchResult = Result<OkignoreBindingPatchSuccess, ConfigValidationError>;

export interface OkignoreBindingRejection {
  error: ConfigValidationError;
  text: string;
}

export type OkignoreUnsubscribe = () => void;

export interface OkignoreBinding {
  current(): string;
  patch(newText: string): OkignoreBindingPatchResult;
  subscribe(listener: (text: string) => void): OkignoreUnsubscribe;
  subscribeRejection(listener: (rejection: OkignoreBindingRejection) => void): OkignoreUnsubscribe;
  subscribeStatus(listener: (status: OkignoreBindingStatus) => void): OkignoreUnsubscribe;
  status(): OkignoreBindingStatus;
  notifyRejection(error: ConfigValidationError): void;
  dispose(): void;
}

export interface BindOkignoreDocOptions {
  ytextKey?: string;
  acceptanceDelayMs?: number;
}

function err(error: ConfigValidationError): Err<ConfigValidationError> {
  return { ok: false, error };
}

function ok(value: OkignoreBindingPatchSuccess): Ok<OkignoreBindingPatchSuccess> {
  return { ok: true, ...value };
}

export function bindOkignoreDoc(
  provider: OkignoreDocProvider,
  options: BindOkignoreDocOptions = {},
): OkignoreBinding {
  const { ytextKey = DEFAULT_YTEXT_KEY, acceptanceDelayMs = DEFAULT_ACCEPTANCE_DELAY_MS } = options;
  const ydoc = provider.document;
  const ytext = ydoc.getText(ytextKey);

  const textListeners = new Set<(text: string) => void>();
  const rejectionListeners = new Set<(rejection: OkignoreBindingRejection) => void>();
  const statusListeners = new Set<(status: OkignoreBindingStatus) => void>();
  let disposed = false;
  let currentStatus: OkignoreBindingStatus = 'idle';
  let acceptanceTimer: ReturnType<typeof setTimeout> | null = null;

  function clearAcceptanceTimer(): void {
    if (acceptanceTimer !== null) {
      clearTimeout(acceptanceTimer);
      acceptanceTimer = null;
    }
  }

  function setStatus(next: OkignoreBindingStatus): void {
    if (disposed) return;
    if (currentStatus === next) return;
    currentStatus = next;
    for (const listener of statusListeners) {
      try {
        listener(next);
      } catch (e) {
        console.warn('[bindOkignoreDoc] status listener threw:', e);
      }
    }
  }

  function fireTextListeners(): void {
    if (disposed) return;
    const text = ytext.toString();
    for (const listener of textListeners) {
      try {
        listener(text);
      } catch (e) {
        console.warn('[bindOkignoreDoc] text listener threw:', e);
      }
    }
  }

  function fireRejectionListeners(rejection: OkignoreBindingRejection): void {
    if (disposed) return;
    for (const listener of rejectionListeners) {
      try {
        listener(rejection);
      } catch (e) {
        console.warn('[bindOkignoreDoc] rejection listener threw:', e);
      }
    }
  }

  ytext.observe(fireTextListeners);
  provider.on('synced', fireTextListeners);

  return {
    current(): string {
      return ytext.toString();
    },

    patch(newText: string): OkignoreBindingPatchResult {
      if (disposed) {
        return err({
          code: 'WRITE_ERROR',
          detail: 'OkignoreBinding has been disposed',
        });
      }
      ydoc.transact(() => {
        if (ytext.length > 0) ytext.delete(0, ytext.length);
        if (newText.length > 0) ytext.insert(0, newText);
      });
      clearAcceptanceTimer();
      setStatus('pending');
      acceptanceTimer = setTimeout(() => {
        acceptanceTimer = null;
        if (disposed) return;
        if (currentStatus === 'pending') setStatus('accepted');
      }, acceptanceDelayMs);
      return ok({ text: newText });
    },

    subscribe(listener: (text: string) => void): OkignoreUnsubscribe {
      textListeners.add(listener);
      return () => {
        textListeners.delete(listener);
      };
    },

    subscribeRejection(
      listener: (rejection: OkignoreBindingRejection) => void,
    ): OkignoreUnsubscribe {
      rejectionListeners.add(listener);
      return () => {
        rejectionListeners.delete(listener);
      };
    },

    subscribeStatus(listener: (status: OkignoreBindingStatus) => void): OkignoreUnsubscribe {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },

    status(): OkignoreBindingStatus {
      return currentStatus;
    },

    notifyRejection(error: ConfigValidationError): void {
      if (disposed) return;
      clearAcceptanceTimer();
      setStatus('rejected');
      fireRejectionListeners({ error, text: ytext.toString() });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearAcceptanceTimer();
      ytext.unobserve(fireTextListeners);
      provider.off('synced', fireTextListeners);
      textListeners.clear();
      rejectionListeners.clear();
      statusListeners.clear();
    },
  };
}
