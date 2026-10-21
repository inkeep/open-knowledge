import type { Extension } from '@hocuspocus/server';
import { isConfigDoc, isSystemDoc } from './cc1-broadcast.ts';
import { getLogger } from './logger.ts';
import type { WatcherClock } from './watcher-clock.ts';

const log = getLogger('document-refresh');

const RECONNECT_REFRESH_COALESCE_MS = 1_000;

const isRefreshable = (documentName: string): boolean =>
  !isSystemDoc(documentName) && !isConfigDoc(documentName);

export type DocumentRefreshTrigger = 'focus' | 'reconnect';

export interface DocumentRefreshResult {
  checked: number;
  found: number;
}

export type RefreshDocumentsFromDisk = (
  docNames: readonly string[],
  trigger: DocumentRefreshTrigger,
) => Promise<DocumentRefreshResult>;

export function createReconnectRefreshExtension(deps: {
  clock: WatcherClock;
  refresh: RefreshDocumentsFromDisk;
}): Extension {
  const lastReadAt = new Map<string, number>();
  return {
    async afterLoadDocument({ documentName }) {
      if (!isRefreshable(documentName)) return;
      lastReadAt.set(documentName, deps.clock.now());
    },
    async connected({ documentName }) {
      if (!isRefreshable(documentName)) return;
      const now = deps.clock.now();
      const last = lastReadAt.get(documentName);
      if (last !== undefined && now - last < RECONNECT_REFRESH_COALESCE_MS) return;
      lastReadAt.set(documentName, now);
      void deps.refresh([documentName], 'reconnect').catch((err: unknown) => {
        log.warn({ err, docName: documentName }, 'the re-read on reconnect failed');
      });
    },
    async afterUnloadDocument({ documentName }) {
      lastReadAt.delete(documentName);
    },
  };
}
