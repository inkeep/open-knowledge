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

export const missDialogStore: MissDialogStore = createMissDialogStore();
