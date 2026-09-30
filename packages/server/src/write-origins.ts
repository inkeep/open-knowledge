import type { LocalTransactionOrigin } from '@hocuspocus/server';

/* STOP: matched by object identity in Set.has and Y.UndoManager.trackedOrigins, so every
   write must pass this exact module-level reference. A structurally equal literal built at
   the call site compares unequal and silently defeats the self-write guards that read it.
   skipStoreHooks keeps the write out of persistence, closing the store to file-watcher
   feedback loop. */
export const OBSERVER_SYNC_ORIGIN = {
  source: 'local',
  skipStoreHooks: true,
  context: { origin: 'observer-sync' },
} as const satisfies LocalTransactionOrigin;

/* STOP: the authoring-site gate for paired writes. An origin literal opts in by asserting
   `satisfies PairedWriteOrigin` at its definition, which forces context.paired and rejects
   a typo there rather than at the read site. Adding a paired origin needs that annotation
   and nothing else — there is no registry to update. */
export type PairedWriteOrigin = LocalTransactionOrigin & {
  readonly context: {
    readonly origin: string;
    readonly paired: true;
  };
};

/* WARN: structural on purpose, never an identity or instanceof check. Yjs reconstructs the
   origin object for a remote-arriving transaction, so an identity test passes locally and
   fails across the wire — where the failure is a missed paired-write short-circuit, not an
   error. */
export const isPairedWriteOrigin = (origin: unknown): origin is PairedWriteOrigin => {
  if (origin == null || typeof origin !== 'object') return false;
  const ctx = (origin as { context?: { paired?: boolean } }).context;
  return ctx?.paired === true;
};
