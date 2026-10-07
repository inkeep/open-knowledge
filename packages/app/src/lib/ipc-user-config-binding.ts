import {
  bindConfigDoc,
  type ConfigBinding,
  type ConfigDocProvider,
} from '@inkeep/open-knowledge-core/config/bind-config-doc';
import type { ConfigValidationError } from '@inkeep/open-knowledge-core/config/errors';
import type { OkUserConfigBridge } from '@inkeep/open-knowledge-core/desktop-bridge';
import * as Y from 'yjs';

const IPC_USER_CONFIG_FILE_ORIGIN = Symbol('ipc-user-config-file');
const DEFAULT_READ_RETRY_MS = 2_000;

interface IpcUserConfigBindingOptions {
  onRemoteRejected?: (error: ConfigValidationError) => void;
  onLoadFailedChange?: (failed: boolean) => void;
  readRetryMs?: number;
}

function logTransportFailure(event: string, err: unknown): void {
  console.warn(JSON.stringify({ event, error: err instanceof Error ? err.message : String(err) }));
}

export function createIpcUserConfigBinding(
  transport: OkUserConfigBridge,
  options: IpcUserConfigBindingOptions = {},
): ConfigBinding {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('source');
  const syncedListeners = new Set<() => void>();
  const provider: ConfigDocProvider = {
    document: ydoc,
    on: (_event, listener) => {
      syncedListeners.add(listener);
    },
    off: (_event, listener) => {
      syncedListeners.delete(listener);
    },
  };
  const inner = bindConfigDoc(provider, 'user');
  let disposed = false;
  let synced = false;
  let latestPatch = 0;
  let inFlight = 0;
  let missed = false;
  let loadFailed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let resyncTimer: ReturnType<typeof setTimeout> | null = null;
  let resyncFailing = false;

  function adoptFileText(text: string): void {
    if (disposed || ytext.toString() === text) return;
    ydoc.transact(() => {
      if (ytext.length > 0) ytext.delete(0, ytext.length);
      ytext.insert(0, text);
    }, IPC_USER_CONFIG_FILE_ORIGIN);
  }

  function setLoadFailed(next: boolean): void {
    if (loadFailed === next) return;
    loadFailed = next;
    options.onLoadFailedChange?.(next);
  }

  function markSynced(): void {
    if (disposed || synced) return;
    synced = true;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    setLoadFailed(false);
    for (const listener of syncedListeners) listener();
  }

  function settle(): void {
    if (!disposed && inFlight === 0 && missed) resyncFromFile();
  }

  function scheduleResyncRetry(): void {
    if (disposed || resyncTimer !== null) return;
    resyncTimer = setTimeout(() => {
      resyncTimer = null;
      settle();
    }, options.readRetryMs ?? DEFAULT_READ_RETRY_MS);
  }

  function resyncFromFile(): void {
    missed = false;
    const issuedAt = latestPatch;
    transport.read().then(
      ({ text }) => {
        resyncFailing = false;
        if (inFlight === 0 && issuedAt === latestPatch) {
          adoptFileText(text);
          return;
        }
        missed = true;
        settle();
      },
      (err: unknown) => {
        missed = true;
        if (!resyncFailing) logTransportFailure('ok-user-config-resync-failed', err);
        resyncFailing = true;
        scheduleResyncRetry();
      },
    );
  }

  function loadInitial(): void {
    transport.read().then(
      ({ text }) => {
        if (disposed || synced) return;
        adoptFileText(text);
        markSynced();
      },
      (err: unknown) => {
        if (disposed || synced) return;
        if (!loadFailed) logTransportFailure('ok-user-config-read-failed', err);
        setLoadFailed(true);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          loadInitial();
        }, options.readRetryMs ?? DEFAULT_READ_RETRY_MS);
      },
    );
  }

  const unsubscribeChanged = transport.onChanged(({ text }) => {
    if (inFlight > 0) {
      missed = true;
      return;
    }
    adoptFileText(text);
    markSynced();
  });

  loadInitial();

  return {
    current: () => inner.current(),
    subscribe: (listener) => inner.subscribe(listener),
    hasSynced: () => inner.hasSynced(),
    subscribeSynced: (listener) => inner.subscribeSynced(listener),

    patch(patch) {
      const result = inner.patch(patch);
      if (!result.ok) return result;
      latestPatch += 1;
      const token = latestPatch;
      inFlight += 1;
      transport.patch(patch).then(
        (response) => {
          inFlight -= 1;
          if (response.ok) {
            if (token === latestPatch) adoptFileText(response.text);
          } else {
            options.onRemoteRejected?.(response.error);
            missed = true;
          }
          settle();
        },
        (err: unknown) => {
          inFlight -= 1;
          logTransportFailure('ok-user-config-patch-failed', err);
          options.onRemoteRejected?.({
            code: 'WRITE_ERROR',
            detail: err instanceof Error ? err.message : String(err),
          });
          missed = true;
          settle();
        },
      );
      return result;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (resyncTimer !== null) clearTimeout(resyncTimer);
      unsubscribeChanged();
      inner.dispose();
      syncedListeners.clear();
      ydoc.destroy();
    },
  };
}
