
import type {
  OkDesktopBridge,
  OkMcpWiringEditorId,
  OkMcpWiringResult,
  OkMcpWiringShowPayload,
} from '@/lib/desktop-bridge-types';

export interface McpConsentStore {
  install(opts: { bridge: OkDesktopBridge | undefined }): (() => void) | undefined;
  getSnapshot(): OkMcpWiringShowPayload | null;
  subscribe(listener: () => void): () => void;
  confirm(editorIds: readonly OkMcpWiringEditorId[]): Promise<OkMcpWiringResult>;
  skip(): Promise<OkMcpWiringResult>;
  dismiss(): void;
}

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

    async confirm(editorIds): Promise<OkMcpWiringResult> {
      const b = bridge;
      if (!b) return { ok: false, error: 'Not attached to desktop bridge' };
      try {
        const result = await b.mcpWiring.confirm(editorIds);
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

export const mcpConsentStore: McpConsentStore = createMcpConsentStore();

export function installMcpConsentListener(opts: {
  bridge: OkDesktopBridge | undefined;
}): (() => void) | undefined {
  return mcpConsentStore.install(opts);
}
