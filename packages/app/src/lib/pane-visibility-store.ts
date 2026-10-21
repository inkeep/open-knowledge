import type { PaneId } from '@inkeep/open-knowledge-core/terminal-layout';

export type { PaneId } from '@inkeep/open-knowledge-core/terminal-layout';

export function assertNeverPaneId(pane: never): never {
  throw new Error(`unhandled pane: ${String(pane)}`);
}

export type PaneVisibility = {
  readonly open: boolean;
  readonly onScreen: boolean;
};

export type PaneVisibilitySnapshot = {
  readonly [P in PaneId]: PaneVisibility | null;
};

export type PaneVisibilityRequest = {
  readonly pane: PaneId;
  readonly open: boolean;
  readonly reason?: 'user';
};

export interface PaneVisibilityStore {
  getSnapshot(): PaneVisibilitySnapshot;
  isExclusive(): boolean;
  subscribe(listener: () => void): () => void;
  publish(next: PaneVisibilitySnapshot, exclusive?: boolean): void;
  request(pane: PaneId, open: boolean, reason?: 'user'): void;
  subscribeRequests(handler: (request: PaneVisibilityRequest) => void): () => void;
}

const NO_PANES: PaneVisibilitySnapshot = Object.freeze({
  editor: null,
  agents: null,
  terminal: null,
});

const PANE_IDS = Object.keys(NO_PANES) as readonly PaneId[];

export function isPaneId(value: unknown): value is PaneId {
  return typeof value === 'string' && Object.hasOwn(NO_PANES, value);
}

function samePane(a: PaneVisibility | null, b: PaneVisibility | null): boolean {
  if (a === null || b === null) return a === b;
  return a.open === b.open && a.onScreen === b.onScreen;
}

function sameSnapshot(a: PaneVisibilitySnapshot, b: PaneVisibilitySnapshot): boolean {
  return PANE_IDS.every((pane) => samePane(a[pane], b[pane]));
}

function createPaneVisibilityStore(): PaneVisibilityStore & { reset(): void } {
  let snapshot: PaneVisibilitySnapshot = NO_PANES;
  let exclusive = false;
  const listeners = new Set<() => void>();
  const requestHandlers = new Set<(request: PaneVisibilityRequest) => void>();
  const waitingRequests = new Map<PaneId, PaneVisibilityRequest>();

  return {
    getSnapshot(): PaneVisibilitySnapshot {
      return snapshot;
    },
    isExclusive(): boolean {
      return exclusive;
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(next, nextExclusive = false): void {
      if (sameSnapshot(snapshot, next) && exclusive === nextExclusive) return;
      snapshot = next;
      exclusive = nextExclusive;
      for (const l of listeners) l();
    },
    request(pane, open, reason): void {
      const request: PaneVisibilityRequest = {
        pane,
        open,
        ...(reason === 'user' ? { reason } : {}),
      };
      if (requestHandlers.size === 0) {
        waitingRequests.set(pane, request);
        return;
      }
      for (const h of requestHandlers) h(request);
    },
    subscribeRequests(handler): () => void {
      requestHandlers.add(handler);
      const waiting = [...waitingRequests.values()];
      waitingRequests.clear();
      for (const request of waiting) handler(request);
      return () => {
        requestHandlers.delete(handler);
      };
    },
    reset(): void {
      snapshot = NO_PANES;
      exclusive = false;
      listeners.clear();
      requestHandlers.clear();
      waitingRequests.clear();
    },
  };
}

const store = createPaneVisibilityStore();

export const paneVisibilityStore: PaneVisibilityStore = store;

export function __resetPaneVisibilityStoreForTests(): void {
  store.reset();
}
