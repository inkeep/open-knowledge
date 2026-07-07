/**
 * Primary surface for a share-receive miss: a modal shown WITHOUT navigating to
 * the dead path. When a share deep link targets a doc/folder main's pre-nav
 * probe found absent on the receiver's branch, the deep-link listener arms
 * `missDialogStore` (instead of setting the hash), and this dialog renders the
 * honest verdict — deleted / renamed / never pushed / behind — over whatever the
 * receiver was already looking at. Because navigation never happens, no phantom
 * tab is opened at the missing path and the create-mode fork trap can't fire.
 *
 * Self-gates on the store (renders null until armed), mirroring
 * `ShareBranchSwitchDialog`. Mounted in the editor shell and lazy-loaded, so its
 * verdict-fetch code stays out of the main bundle until a miss actually occurs.
 */
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
  pendingReceiveNavStore,
} from '@/lib/share/pending-receive-nav-store';

/** Last path segment — what the receiver tried to open, for the dialog title. */
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
  // Key on the target so re-arming for a different miss (e.g. a chained rename
  // whose destination is also absent) remounts with a fresh verdict fetch.
  return <ShareReceiveMissDialogInner key={nav.path} nav={nav} />;
}

function ShareReceiveMissDialogInner({ nav }: { nav: PendingReceiveNav }) {
  const state = useShareTargetVerdict(nav);

  function dismiss(): void {
    missDialogStore.dismiss();
  }

  function browseFolder(): void {
    window.location.hash = hashFromFolderPath(parentFolderPath(nav.path));
    dismiss();
  }

  function openRenamed(renamedTo: string): void {
    // Arm the in-tab backstop before navigating: if the rename destination is
    // also missing locally (the receiver's ref is behind), the miss surface
    // renders for it too instead of the create-mode editor.
    pendingReceiveNavStore.arm({ kind: nav.kind, path: renamedTo, branch: nav.branch });
    window.location.hash =
      nav.kind === 'folder' ? hashFromFolderPath(renamedTo) : hashFromDocName(renamedTo);
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
            onOpenRenamed={openRenamed}
            onEnableAutoSync={dismiss}
          />
        </DialogBody>
      </DialogContent>
    </DialogRoot>
  );
}
