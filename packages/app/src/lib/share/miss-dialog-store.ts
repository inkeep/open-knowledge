/**
 * Renderer store for the share-receive MISS DIALOG.
 *
 * When a share deep link targets a doc/folder main's pre-nav probe found absent
 * on the receiver's checked-out branch (`targetMissing`), the deep-link listener
 * arms this store INSTEAD of navigating to the dead path. `ShareReceiveMissDialog`
 * self-gates on it and shows the honest verdict (deleted / renamed / never
 * pushed / behind) as a modal — so the receiver never opens a phantom tab at a
 * path that carries no doc, and never silently forks it in create-mode.
 *
 * Armed at deep-link time (which can fire before React mounts, e.g. cold-start
 * from the link), so the value buffers here until the dialog subscribes — the
 * same module-singleton + `useSyncExternalStore` pattern as `receive-store`.
 * `dismiss()` clears it after the user picks an escape (browse / open-renamed)
 * or closes the dialog.
 */

import type { PendingReceiveNav } from '@/lib/share/pending-receive-nav-store';

export interface MissDialogStore {
  arm(nav: PendingReceiveNav): void;
  dismiss(): void;
  getSnapshot(): PendingReceiveNav | null;
  subscribe(listener: () => void): () => void;
}

function createMissDialogStore(): MissDialogStore {
  let current: PendingReceiveNav | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const l of listeners) l();
  }

  function setCurrent(next: PendingReceiveNav | null): void {
    if (current === next) return;
    current = next;
    notify();
  }

  return {
    arm(nav): void {
      setCurrent(nav);
    },
    dismiss(): void {
      setCurrent(null);
    },
    getSnapshot(): PendingReceiveNav | null {
      return current;
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Module-level singleton — the deep-link listener arms it, the dialog reads it. */
export const missDialogStore: MissDialogStore = createMissDialogStore();
