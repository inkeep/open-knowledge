/**
 * Compile-time type assertions for `PairedWriteOrigin` (bridge-correctness
 * precedent #1 extension).
 *
 * Purpose: pin the four paired-write origins at the type level so the
 * regression class — "a paired-write origin written without `context.paired: true`
 * silently amplifies RGA-level content loss" — is impossible to reintroduce.
 * The authoring site's `as const satisfies PairedWriteOrigin` annotation forces
 * the literal to carry the marker; this file's `@ts-expect-error` tests prove
 * that omitting the marker or getting the paired flag wrong IS a compile
 * error, not just a runtime check the reviewer might miss.
 *
 * Runs as a regular unit file under `bunx tsc --noEmit` — Bun's test runner
 * executes the body as an empty test, and `turbo run typecheck` validates
 * the negative `@ts-expect-error` cases.
 */

import { describe, test } from 'bun:test';
import type { AGENT_WRITE_ORIGIN } from './agent-sessions.ts';
import type { MANAGED_RENAME_ORIGIN, ROLLBACK_ORIGIN } from './api-extension.ts';
import type { FILE_WATCHER_ORIGIN } from './external-change.ts';
import type { PairedWriteOrigin } from './server-observers.ts';

// ─── Positive: the four shipped paired origins satisfy the brand ───────────
//
// `Assignable<X, Y>` resolves to `never` at the type level unless `X` is
// assignable to `Y`. Assigning `never` to a `true` position forces a
// compile error, so a failed narrowing surfaces as a tsc error at this
// call site.

type Assignable<X, Y> = X extends Y ? true : never;

const _agentWriteIsPaired: Assignable<typeof AGENT_WRITE_ORIGIN, PairedWriteOrigin> = true;
const _fileWatcherIsPaired: Assignable<typeof FILE_WATCHER_ORIGIN, PairedWriteOrigin> = true;
const _rollbackIsPaired: Assignable<typeof ROLLBACK_ORIGIN, PairedWriteOrigin> = true;
const _managedRenameIsPaired: Assignable<typeof MANAGED_RENAME_ORIGIN, PairedWriteOrigin> = true;

void _agentWriteIsPaired;
void _fileWatcherIsPaired;
void _rollbackIsPaired;
void _managedRenameIsPaired;

// ─── Negative: omitting `paired: true` is a compile error ──────────────────
//
// These blocks use `@ts-expect-error` — the compiler FAILS the build if the
// error does NOT occur, which is exactly what we want: a future paired
// origin that forgets the marker trips this assertion at authoring time.

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

// ─── Smoke test placeholder so Bun registers the file ──────────────────────
describe('PairedWriteOrigin (compile-time assertions)', () => {
  test('all four paired origins carry the type-level brand', () => {
    // Body is empty — the real assertions are the module-scope const
    // declarations above. Failure shows up as a tsc error in
    // `turbo run typecheck`, not as a runtime `expect` mismatch.
  });
});
