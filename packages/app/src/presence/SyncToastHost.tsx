import { useDocumentContext } from '@/editor/DocumentContext';
import { useSyncStatus } from './use-sync-status';
import { useSyncToasts } from './use-sync-toasts';

export function SyncToastHost() {
  const { activeProvider, activeDocName } = useDocumentContext();
  const syncStatus = useSyncStatus(activeProvider);
  useSyncToasts(syncStatus, activeDocName);
  return null;
}
