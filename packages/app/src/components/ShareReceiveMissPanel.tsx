import { useEffect, useRef } from 'react';
import {
  parentFolderPath,
  ShareReceiveMissContent,
  useShareTargetVerdict,
} from '@/components/share-receive-miss-content';
import { hashFromDocName, hashFromFolderPath } from '@/lib/doc-hash';
import {
  type PendingReceiveNav,
  pendingReceiveNavForContentPath,
  pendingReceiveNavStore,
} from '@/lib/share/pending-receive-nav-store';

export function ShareReceiveMissPanel({ nav }: { nav: PendingReceiveNav }) {
  const { state, refetch } = useShareTargetVerdict(nav);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.phase === 'resolved') containerRef.current?.querySelector('button')?.focus();
  }, [state.phase]);

  function browseFolder(): void {
    window.location.hash = hashFromFolderPath(parentFolderPath(nav.path));
  }

  function openRenamed(renamedTo: string): void {
    pendingReceiveNavStore.arm(pendingReceiveNavForContentPath(nav, renamedTo));
    window.location.hash =
      nav.kind === 'folder' ? hashFromFolderPath(renamedTo) : hashFromDocName(renamedTo);
  }

  return (
    <div
      ref={containerRef}
      role="status"
      aria-live={state.phase === 'pending' ? 'polite' : undefined}
      data-testid="share-receive-miss-panel"
      data-phase={state.phase}
      data-verdict={state.phase === 'resolved' ? state.resolution.verdict : undefined}
      className={
        state.phase === 'pending'
          ? 'flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground'
          : 'flex h-full flex-col items-center justify-center gap-6 p-8 text-center'
      }
    >
      <ShareReceiveMissContent
        nav={nav}
        state={state}
        onBrowseFolder={browseFolder}
        onOpenRenamed={openRenamed}
        onEnableAutoSync={browseFolder}
        onSyncCompleted={refetch}
        onPullApplied={refetch}
      />
    </div>
  );
}
