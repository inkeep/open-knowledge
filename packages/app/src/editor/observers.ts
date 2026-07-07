/**
 * Client-side observer shell for Y.XmlFragment and Y.Text.
 *
 * Cross-CRDT sync writes run exclusively on the server observer module at
 * `packages/server/src/server-observers.ts` (precedent #14). The
 * historical client-side debounce + per-doc `TypingState` machinery was
 * deleted. Precedent #13(b) — no wall-clock `setTimeout` in bridge
 * observer files; the grep gate at
 * `packages/server/src/bridge-no-wallclock.test.ts` pins this.
 *
 * The shell's surface reduces to:
 *   1. Own the `ORIGIN_TREE_TO_TEXT` / `ORIGIN_TEXT_TO_TREE` object
 *      identities required by the bridge-invariant watcher's enforcing
 *      set (precedent #1 identity match).
 *   2. Record keystroke timestamps via `markUserTyping` for the
 *      `SystemDocSubscriber` agent-presence typing guard (global wall-clock
 *      timestamp, not per-doc state).
 *
 * The observer callbacks themselves are intentionally empty: the server
 * owns cross-CRDT propagation (precedent #14), and the server's Observer
 * B already performs parse validation with the same `MarkdownManager`
 * and the same transient-error classification. A redundant client-side
 * parse per Y.Text transaction was blocking the main thread on every
 * source-mode keystroke and on every chunk of `chunkedYTextInsert` —
 * the rAF yields in `chunked-insert.ts` intended to keep a >500 KB paste
 * at 60fps were ineffective because the observer callback ran
 * synchronously inside each `ydoc.transact()` before the yield. Deleting
 * the client-side parse restores the intended responsiveness. Errors
 * still surface via the server-side path (`serverObserverErrorsB`
 * counter + structured logs) with a ~5-10 ms WebSocket RTT delay.
 */

import type { LocalTransactionOrigin } from '@hocuspocus/server';
import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import type { Schema } from '@tiptap/pm/model';
import type * as Y from 'yjs';

/**
 * Transaction origin for Observer A (historical tree → text direction).
 *
 * Precedent #1 (CLAUDE.md): all Y.Doc transaction origins are
 * `LocalTransactionOrigin` OBJECT references, never raw strings.
 * `Set.has()` matching in `trackedOrigins` or the bridge-invariant
 * watcher's `BRIDGE_ENFORCING_ORIGINS` set is identity-based — a string
 * literal would silently fail to match the production tx.origin object.
 *
 * `as const satisfies` (Matt Pocock's "deeply read-only config" pattern)
 * produces a `Readonly<...>` sentinel whose field types are all narrow
 * literals — makes the singleton-immutability intent explicit at the type
 * level alongside the identity-match guarantee.
 *
 * Kept for identity-stable membership in the enforcing set even though
 * client observers no longer write the derived CRDT (precedent #14).
 */
export const ORIGIN_TREE_TO_TEXT = {
  source: 'local',
  skipStoreHooks: false,
  context: { origin: 'sync-from-tree' },
} as const satisfies LocalTransactionOrigin;

/**
 * Transaction origin for Observer B (historical text → tree direction).
 * See `ORIGIN_TREE_TO_TEXT` JSDoc for the identity rationale.
 */
export const ORIGIN_TEXT_TO_TREE = {
  source: 'local',
  skipStoreHooks: false,
  context: { origin: 'sync-from-text' },
} as const satisfies LocalTransactionOrigin;

// ─────────────────────────────────────────────────────────────
// Typing state (agent-presence guard consumer — SystemDocSubscriber)
// ─────────────────────────────────────────────────────────────

/**
 * Module-level keystroke timestamp — shared across all docs so nav
 * suppression in `SystemDocSubscriber` can react to typing anywhere in the
 * editor. Global by design because the nav decision is global. Always
 * tracks `Date.now()` because `SystemDocSubscriber` compares against the
 * real wall clock.
 */
let lastGlobalUserKeystrokeMs = 0;

/** Read the most-recent global user-keystroke timestamp (0 if never typed). */
export function getLastUserKeystroke(): number {
  return lastGlobalUserKeystrokeMs;
}

/**
 * Mark that the local user just typed. Call from the editor's DOM event
 * handlers (keydown, paste, drop, etc.). Updates the global keystroke
 * timestamp consumed by `SystemDocSubscriber`'s agent-presence typing guard.
 *
 * Previous iterations accepted a `Y.Doc` parameter that drove per-doc
 * typing-defer state; that state was deleted under server-authoritative
 * bridge + settlement dispatch (precedent #14). The
 * zero-arg shape pins the reduced surface so callers don't hold onto
 * `provider.document` unnecessarily.
 */
export function markUserTyping(): void {
  lastGlobalUserKeystrokeMs = Date.now();
}

// ─────────────────────────────────────────────────────────────
// Observer shell
// ─────────────────────────────────────────────────────────────

interface ObserverDeps {
  doc: Y.Doc;
  xmlFragment: Y.XmlFragment;
  ytext: Y.Text;
  mdManager: MarkdownManager;
  /**
   * ProseMirror schema — retained in the interface for call-site
   * compatibility with the prior client-observer signature. No longer
   * used by the observer body under precedent #14; the server observer
   * owns all schema-involving mutations.
   */
  schema?: Schema;
  onSyncError?: (direction: 'tree-to-text' | 'text-to-tree', error: Error) => void;
}

/**
 * Attach the client observer shell to a Y.Doc.
 *
 * Both callbacks are intentionally empty — the server owns cross-CRDT
 * propagation (precedent #14) and also runs parse validation on Y.Text
 * via its own Observer B (`packages/server/src/server-observers.ts`).
 * Subscribing here keeps the callback slots wired for future read-side
 * instrumentation and makes the teardown path symmetric.
 *
 * Returns a cleanup function that detaches both callbacks. No timers to
 * clear — precedent #13(b) forbids wall-clock `setTimeout` here.
 */
export function setupObservers(deps: ObserverDeps): () => void {
  const { xmlFragment, ytext } = deps;

  const observerA = (_events: Y.YEvent<Y.XmlFragment>[], _transaction: Y.Transaction): void => {
    // Intentionally empty under server-authoritative bridge (precedent #14).
    // The server observer (`server-observers.ts`) owns XmlFragment → Y.Text
    // propagation on its own copy of the Y.Doc. The client observer
    // subscribes only to keep the callback slot wired for future read-side
    // instrumentation without breaking call-site signatures.
  };

  const observerB = (_event: Y.YTextEvent, _transaction: Y.Transaction): void => {
    // Intentionally empty. The prior iteration ran `mdManager.parse(body)`
    // here for diagnostic error surfacing via `onSyncError`, but that parse
    // fired synchronously inside every local `ydoc.transact()` drain —
    // including every keystroke in source mode AND every chunk of
    // `chunkedYTextInsert`. For docs >10 KB this added per-keystroke lag
    // and defeated the rAF yields that large-paste chunking relies on
    // (the yield happens after the observer callback, so the parse
    // blocked the frame regardless). The server's Observer B runs the
    // same parse with the same transient-error classification; real
    // failures surface via the `serverObserverErrorsB` counter and the
    // structured `bridge-merge-content-loss` logs.
  };

  xmlFragment.observeDeep(observerA);
  ytext.observe(observerB);

  return () => {
    xmlFragment.unobserveDeep(observerA);
    ytext.unobserve(observerB);
  };
}
