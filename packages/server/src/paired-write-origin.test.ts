import { describe, test } from 'bun:test';
import type { AGENT_WRITE_ORIGIN } from './agent-sessions.ts';
import type { MANAGED_RENAME_ORIGIN, ROLLBACK_ORIGIN } from './api-extension.ts';
import type { FILE_WATCHER_ORIGIN } from './external-change.ts';
import type { PairedWriteOrigin } from './server-observers.ts';

type Assignable<X, Y> = X extends Y ? true : never;

const _agentWriteIsPaired: Assignable<typeof AGENT_WRITE_ORIGIN, PairedWriteOrigin> = true;
const _fileWatcherIsPaired: Assignable<typeof FILE_WATCHER_ORIGIN, PairedWriteOrigin> = true;
const _rollbackIsPaired: Assignable<typeof ROLLBACK_ORIGIN, PairedWriteOrigin> = true;
const _managedRenameIsPaired: Assignable<typeof MANAGED_RENAME_ORIGIN, PairedWriteOrigin> = true;

void _agentWriteIsPaired;
void _fileWatcherIsPaired;
void _rollbackIsPaired;
void _managedRenameIsPaired;

// These blocks use `@ts-expect-error` — the compiler FAILS the build if the

const _missingPairedFlag = {
  source: 'local' as const,
  skipStoreHooks: false,
  // @ts-expect-error — `context.paired: true` is required by PairedWriteOrigin
  context: { origin: 'forgot-the-marker' },
} as const satisfies PairedWriteOrigin;
void _missingPairedFlag;

const _pairedFalseRejected = {
  source: 'local' as const,
  skipStoreHooks: false,
  // @ts-expect-error — `paired: false` violates `paired: true`
  context: { origin: 'wrong-value', paired: false },
} as const satisfies PairedWriteOrigin;
void _pairedFalseRejected;

describe('PairedWriteOrigin (compile-time assertions)', () => {
  test('all four paired origins carry the type-level brand', () => {});
});
