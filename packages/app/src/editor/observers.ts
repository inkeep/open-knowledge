/**
 * Client-side transaction-origin identities and the keystroke clock.
 *
 * Cross-CRDT sync writes ran exclusively on the server observer module
 * (precedent #14) and are gone with the fragment; what remains here is:
 *   1. The `ORIGIN_TREE_TO_TEXT` / `ORIGIN_TEXT_TO_TREE` object
 *      identities (precedent #1 identity match).
 *   2. Keystroke timestamps via `markUserTyping` for the agent-presence
 *      typing guard (global wall-clock timestamp, not per-doc state).
 */

import type { LocalTransactionOrigin } from '@hocuspocus/server';

/**
 * Precedent #1 (CLAUDE.md): all Y.Doc transaction origins are
 * `LocalTransactionOrigin` OBJECT references, never raw strings.
 * `Set.has()` matching in `trackedOrigins` is identity-based — a string
 * literal would silently fail to match the production tx.origin object.
 *
 * `as const satisfies` produces a `Readonly<...>` sentinel whose field
 * types are all narrow literals — makes the singleton-immutability
 * intent explicit at the type level alongside the identity-match
 * guarantee.
 */
export const ORIGIN_TREE_TO_TEXT = {
  source: 'local',
  skipStoreHooks: false,
  context: { origin: 'sync-from-tree' },
} as const satisfies LocalTransactionOrigin;

export const ORIGIN_TEXT_TO_TREE = {
  source: 'local',
  skipStoreHooks: false,
  context: { origin: 'sync-from-text' },
} as const satisfies LocalTransactionOrigin;

let lastGlobalUserKeystrokeMs = 0;

export function getLastUserKeystroke(): number {
  return lastGlobalUserKeystrokeMs;
}

export function markUserTyping(): void {
  lastGlobalUserKeystrokeMs = Date.now();
}
