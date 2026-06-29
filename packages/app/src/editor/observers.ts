
import type { LocalTransactionOrigin } from '@hocuspocus/server';
import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import type { Schema } from '@tiptap/pm/model';
import type * as Y from 'yjs';

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


interface ObserverDeps {
  doc: Y.Doc;
  xmlFragment: Y.XmlFragment;
  ytext: Y.Text;
  mdManager: MarkdownManager;
  schema?: Schema;
  onSyncError?: (direction: 'tree-to-text' | 'text-to-tree', error: Error) => void;
}

export function setupObservers(deps: ObserverDeps): () => void {
  const { xmlFragment, ytext } = deps;

  const observerA = (_events: Y.YEvent<Y.XmlFragment>[], _transaction: Y.Transaction): void => {
  };

  const observerB = (_event: Y.YTextEvent, _transaction: Y.Transaction): void => {
  };

  xmlFragment.observeDeep(observerA);
  ytext.observe(observerB);

  return () => {
    xmlFragment.unobserveDeep(observerA);
    ytext.unobserve(observerB);
  };
}
