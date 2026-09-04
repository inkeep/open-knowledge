import { useSyncExternalStore } from 'react';
import {
  parentFolderPath,
  ShareReceiveMissContent,
  useShareTargetVerdict,
} from '@/components/share-receive-miss-content';
import {
  DialogBody,
  DialogContent,
  DialogHeader,
  Dialog as DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog';
import { hashFromDocName, hashFromFolderPath } from '@/lib/doc-hash';
import { missDialogStore } from '@/lib/share/miss-dialog-store';
import {
  type PendingReceiveNav,
  pendingReceiveNavForContentPath,
  pendingReceiveNavStore,
} from '@/lib/share/pending-receive-nav-store';

function targetBasename(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : path;
}

export function ShareReceiveMissDialog() {
  const nav = useSyncExternalStore(
    missDialogStore.subscribe,
    missDialogStore.getSnapshot,
    () => null,
  );
  if (nav === null) return null;
  return <ShareReceiveMissDialogInner key={nav.path} nav={nav} />;
}

function ShareReceiveMissDialogInner({ nav }: { nav: PendingReceiveNav }) {
  const { state, refetch } = useShareTargetVerdict(nav);

  function dismiss(): void {
    missDialogStore.dismiss();
  }

  function browseFolder(): void {
    window.location.hash = hashFromFolderPath(parentFolderPath(nav.path));
    dismiss();
  }

  function navigateWithBackstop(path: string): void {
    pendingReceiveNavStore.arm(pendingReceiveNavForContentPath(nav, path));
    window.location.hash = nav.kind === 'folder' ? hashFromFolderPath(path) : hashFromDocName(path);
    dismiss();
  }

  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        data-testid="share-receive-miss-dialog"
        data-phase={state.phase}
        data-verdict={state.phase === 'resolved' ? state.resolution.verdict : undefined}
      >
        <DialogHeader>
          <DialogTitle className="truncate">{targetBasename(nav.path)}</DialogTitle>
        </DialogHeader>
        <DialogBody
          className={
            state.phase === 'pending'
              ? 'flex flex-col items-center justify-center gap-3 py-6 text-center text-sm text-muted-foreground'
              : 'flex flex-col items-center justify-center gap-6 py-2 text-center'
          }
        >
          <ShareReceiveMissContent
            nav={nav}
            state={state}
            onBrowseFolder={browseFolder}
            onOpenRenamed={navigateWithBackstop}
            onEnableAutoSync={dismiss}
            onSyncCompleted={refetch}
            onPullApplied={() => navigateWithBackstop(nav.path)}
          />
        </DialogBody>
      </DialogContent>
    </DialogRoot>
  );
}
