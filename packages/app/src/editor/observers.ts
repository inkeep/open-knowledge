/**
 * Client-side observer shell. Cross-CRDT sync writes run exclusively on the server observer
 * module (precedent #14), so the callbacks here are intentionally empty; the shell owns only the
 * `ORIGIN_TREE_TO_TEXT` / `ORIGIN_TEXT_TO_TREE` identities the bridge watcher matches (#1).
 */

import type { LocalTransactionOrigin } from '@hocuspocus/server';
import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import type { Schema } from '@tiptap/pm/model';
import type * as Y from 'yjs';

/**
 * Precedent #1 (CLAUDE.md): all Y.Doc transaction origins are `LocalTransactionOrigin` OBJECT
 * references, never raw strings. Kept for identity-stable membership in the enforcing set even
 * though client observers no longer write the derived CRDT (precedent #14).
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

/**
 * Previous iterations accepted a `Y.Doc` parameter that drove per-doc typing-defer state; that
 * state was deleted under server-authoritative bridge + settlement dispatch (precedent #14).
 */
export function markUserTyping(): void {
  lastGlobalUserKeystrokeMs = Date.now();
}

interface ObserverDeps {
  doc: Y.Doc;
  xmlFragment: Y.XmlFragment;
  ytext: Y.Text;
  mdManager: MarkdownManager;
  /**
   * No longer used by the observer body under precedent #14; the server observer owns all
   * schema-involving mutations.
   */
  schema?: Schema;
  onSyncError?: (direction: 'tree-to-text' | 'text-to-tree', error: Error) => void;
}

/**
 * Attaches the client observer shell to a Y.Doc. Both callbacks are intentionally empty because
 * the server owns cross-CRDT propagation (precedent #14); the returned cleanup detaches them and
 * has no timers to clear, since precedent #13(b) forbids wall-clock `setTimeout` here.
 */
export function setupObservers(deps: ObserverDeps): () => void {
  const { xmlFragment, ytext } = deps;

  const observerA = (_events: Y.YEvent<Y.XmlFragment>[], _transaction: Y.Transaction): void => {
    // Intentionally empty under server-authoritative bridge (precedent #14).
  };

  const observerB = (_event: Y.YTextEvent, _transaction: Y.Transaction): void => {};

  xmlFragment.observeDeep(observerA);
  ytext.observe(observerB);

  return () => {
    xmlFragment.unobserveDeep(observerA);
    ytext.unobserve(observerB);
  };
}
