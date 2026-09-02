import { HocuspocusProvider } from '@hocuspocus/provider';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { useDocumentContext } from '@/editor/DocumentContext';
import { emitLintConfigChanged } from '@/editor/lint-config-client';
import { dispatchCC1Stateless, SYSTEM_DOC_NAME } from '@/lib/cc1';
import { emitConfigIgnoreNestedError } from '@/lib/config-ignore-nested-error-events';
import { emitConfigValidationRejected } from '@/lib/config-validation-events';
import {
  emitDocPersisted,
  emitDocumentsChanged,
  subscribeToDocumentsChanged,
} from '@/lib/documents-events';
import { createSyncedReconnectGate } from '@/lib/server-info-refresh';

export function SystemDocSubscriber() {
  const queryClient = useQueryClient();
  const {
    collabUrl,
    setSystemProvider,
    updateServerInstanceId,
    onBranchSwitched,
    observeBranch,
    observeDiskAck,
    refreshServerInfo,
  } = useDocumentContext();

  const handlersRef = useRef({
    updateServerInstanceId,
    onBranchSwitched,
    observeBranch,
    observeDiskAck,
    refreshServerInfo,
  });
  useEffect(() => {
    handlersRef.current = {
      updateServerInstanceId,
      onBranchSwitched,
      observeBranch,
      observeDiskAck,
      refreshServerInfo,
    };
  });

  useEffect(() => {
    if (collabUrl === null) return;
    const doc = new Y.Doc();
    /*
     * STOP: this provider must stay token-less. It is the only channel by
     * which a live client learns that the server rotated its instance id,
     * and it can only be that channel because it carries no epoch claim for
     * the server to reject. Giving it a claim-bearing token makes it fail
     * authentication after every restart; it has no `authenticationFailed`
     * handler and this effect does not re-run, so `refreshServerInfo` would
     * never fire and the pool would never learn the new epoch — turning an
     * intermittent single-doc stall into a deterministic total one.
     */
    const provider = new HocuspocusProvider({
      url: collabUrl,
      name: SYSTEM_DOC_NAME,
      document: doc,
      onStateless: ({ payload }: { payload: string }) => {
        dispatchCC1Stateless(payload, {
          onServerInfo: (info) => {
            handlersRef.current.updateServerInstanceId(info.serverInstanceId);
            if (info.currentBranch !== undefined) {
              void handlersRef.current.observeBranch(info.currentBranch);
            }
          },
          onBranchSwitched: (p) => {
            void handlersRef.current.onBranchSwitched(p.branch);
          },
          onDiskAck: (p) => {
            handlersRef.current.observeDiskAck(p.docName, p.sv);
            emitDocPersisted(p.docName);
          },
          onDerivedView: (p) => {
            emitDocumentsChanged([p.ch]);
          },
          onConfigValidationRejected: (p) => {
            emitConfigValidationRejected(p);
          },
          onConfigIgnoreNestedError: (p) => {
            emitConfigIgnoreNestedError(p);
          },
          onUnknown: (raw) => {
            console.warn('[CC1] Unparseable stateless payload, skipping:', raw.slice(0, 100));
          },
        });
      },
      onClose: ({ event }) => {
        console.warn('[CC1] __system__ connection closed:', event.code, event.reason);
      },
      onDisconnect: () => {
        console.warn('[CC1] __system__ disconnected - derived views may be stale');
      },
    });

    const unsubscribe = subscribeToDocumentsChanged((channels) => {
      if (
        channels.includes('files') ||
        channels.includes('backlinks') ||
        channels.includes('local-targets')
      ) {
        void queryClient.invalidateQueries({ queryKey: ['backlinks'] });
        void queryClient.invalidateQueries({ queryKey: ['forward-links'] });
      }
      if (channels.includes('files') || channels.includes('graph')) {
        void queryClient.invalidateQueries({ queryKey: ['orphans'] });
        void queryClient.invalidateQueries({ queryKey: ['hubs'] });
      }
      if (channels.includes('lint-config')) {
        emitLintConfigChanged();
      }
    });

    const onReconnectSynced = createSyncedReconnectGate(() => {
      void handlersRef.current.refreshServerInfo();
    });
    provider.on('synced', () => {
      emitDocumentsChanged(['files', 'backlinks', 'graph', 'local-targets']);
      onReconnectSynced();
    });

    const warnedStaleAgentClients = new Set<number>();
    const handleAwarenessChange = (): void => {
      if (process.env.NODE_ENV === 'test' || !provider.awareness) return;
      for (const [clientId, state] of provider.awareness.getStates().entries()) {
        if (warnedStaleAgentClients.has(clientId)) continue;
        const user = (state as { user?: { type?: string } }).user;
        if (user?.type === 'agent') {
          warnedStaleAgentClients.add(clientId);
          console.warn(
            `[agent-presence] observed stale AwarenessUser.type === 'agent' from clientID ${clientId} — probably a stale bundled client`,
          );
        }
      }
    };
    provider.awareness?.on('change', handleAwarenessChange);
    setSystemProvider(provider);

    return () => {
      unsubscribe();
      provider.awareness?.off('change', handleAwarenessChange);
      setSystemProvider(null);
      provider.destroy();
      doc.destroy();
    };
  }, [queryClient, collabUrl, setSystemProvider]);

  return null;
}
