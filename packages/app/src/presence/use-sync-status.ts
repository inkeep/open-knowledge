import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useEffect, useState } from 'react';

export type SyncStatus = 'connecting' | 'connected' | 'synced' | 'disconnected';

export function useSyncStatus(provider: HocuspocusProvider | null): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>('connecting');

  useEffect(() => {
    if (!provider) {
      setStatus('connecting');
      return;
    }

    const wsStatus = provider.configuration.websocketProvider.status;
    if (provider.isSynced) {
      setStatus('synced');
    } else if (wsStatus === 'connected') {
      setStatus('connected');
    } else if (wsStatus === 'disconnected') {
      setStatus('disconnected');
    } else {
      setStatus('connecting');
    }

    const onStatus = ({ status: s }: { status: string }) => {
      if (s === 'connected') {
        setStatus((prev) => (prev === 'synced' ? 'synced' : 'connected'));
      } else if (s === 'disconnected') {
        setStatus('disconnected');
      } else {
        setStatus('connecting');
      }
    };

    const onSynced = ({ state }: { state: boolean }) => {
      setStatus(state ? 'synced' : 'connected');
    };

    const onDisconnect = () => setStatus('disconnected');

    provider.on('status', onStatus);
    provider.on('synced', onSynced);
    provider.on('disconnect', onDisconnect);

    return () => {
      provider.off('status', onStatus);
      provider.off('synced', onSynced);
      provider.off('disconnect', onDisconnect);
    };
  }, [provider]);

  return status;
}
