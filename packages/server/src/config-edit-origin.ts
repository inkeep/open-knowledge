import type { LocalTransactionOrigin } from '@hocuspocus/server';

/**
 * Object reference per precedent #1 — identity-based matching in the `onStoreDocument` config-doc
 * branch's entry-gate (`if (lastTransactionOrigin === CONFIG_VALIDATION_REVERT_ORIGIN) return`).
 */
export const CONFIG_VALIDATION_REVERT_ORIGIN = {
  source: 'local' as const,
  skipStoreHooks: true,
  context: { origin: 'config-validation-revert' },
} as const satisfies LocalTransactionOrigin;

export const CONFIG_FILE_WATCHER_ORIGIN = {
  source: 'local' as const,
  skipStoreHooks: true,
  context: { origin: 'config-file-watcher' },
} as const satisfies LocalTransactionOrigin;
