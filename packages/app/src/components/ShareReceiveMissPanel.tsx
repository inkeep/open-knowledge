import { useEffect, useRef } from 'react';
import {
  parentFolderPath,
  ShareReceiveMissContent,
  useShareTargetVerdict,
} from '@/components/share-receive-miss-content';
import { hashFromDocName, hashFromFolderPath } from '@/lib/doc-hash';
import {
  type PendingReceiveNav,
  pendingReceiveNavStore,
} from '@/lib/share/pending-receive-nav-store';

/**
 * In-tab BACKSTOP for a share-receive miss discovered only after navigation —
 * main's pre-nav probe said the target existed, but the receiver's local ref no
 * longer carries it, so the resolver returns `{ kind: 'missing' }` and the
 * editor would otherwise open create-mode (the silent-fork trap). The common
 * case — a target main already knows is absent — is handled BEFORE navigation
 * by `ShareReceiveMissDialog`, so this panel only renders for the residual
 * post-nav miss. Both surfaces share the verdict fetch + rendering.
 */
export function ShareReceiveMissPanel({ nav }: { nav: PendingReceiveNav }) {
  const state = useShareTargetVerdict(nav);
  const containerRef = useRef<HTMLDivElement>(null);
  const branch = nav.branch;

  // Focus the primary action (the first button — the rename redirect where
  // present, else Browse folder) once a verdict resolves, so keyboard users land
  // on an actionable control rather than stranded where the editor used to be.
  useEffect(() => {
    if (state.phase === 'resolved') containerRef.current?.querySelector('button')?.focus();
  }, [state.phase]);

  function browseFolder(): void {
    window.location.hash = hashFromFolderPath(parentFolderPath(nav.path));
  }

  function openRenamed(renamedTo: string): void {
    // Re-arm for the redirect target so, if the rename destination is also
    // missing locally (the receiver's ref is behind), the miss surface renders
    // for it too instead of the create-mode editor.
    pendingReceiveNavStore.arm({ kind: nav.kind, path: renamedTo, branch });
    window.location.hash =
      nav.kind === 'folder' ? hashFromFolderPath(renamedTo) : hashFromDocName(renamedTo);
  }

  // One stable container across the pending → resolved transition — the node
  // must not remount, so the shared content renders inside rather than swapping
  // element types.
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
        // No modal to close for the in-tab backstop; navigate to the parent
        // folder so the recovery action clears the surface (same escape as
        // Browse folder).
        onEnableAutoSync={browseFolder}
      />
    </div>
  );
}
