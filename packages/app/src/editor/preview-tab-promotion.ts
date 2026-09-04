import { Transaction as CMTransaction } from '@codemirror/state';
import type { ViewUpdate } from '@codemirror/view';
import type { FrontmatterBinding } from '@inkeep/open-knowledge-core';
import type { Transaction as PMTransaction } from '@tiptap/pm/state';
import { docTabId } from './editor-tabs';
import { isUserIntentOrigin } from './extensions/autonomous-fragment-edit';

type PreviewTabPromotionListener = (tabId: string) => void;

let listener: PreviewTabPromotionListener | null = null;

export function subscribePreviewTabPromotion(next: PreviewTabPromotionListener): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}

export function requestPreviewTabPromotionForTab(tabId: string): void {
  if (!tabId) return;
  listener?.(tabId);
}

export function requestPreviewTabPromotion(docName: string): void {
  if (!docName) return;
  requestPreviewTabPromotionForTab(docTabId(docName));
}

export const READ_ONLY_BINDING_METHODS = ['current', 'subscribe', 'dispose'] as const;

export const MUTATING_BINDING_METHODS = [
  'patch',
  'rename',
  'reorder',
  'patchPath',
  'deletePath',
  'renamePath',
  'reorderPath',
  'reorderSeqPath',
] as const;

export function withPreviewTabPromotion(
  binding: FrontmatterBinding,
  docName: string,
): FrontmatterBinding {
  const announceOnSuccess = <R extends { ok: boolean }>(result: R): R => {
    if (result.ok) requestPreviewTabPromotion(docName);
    return result;
  };
  return {
    ...binding,
    current: () => binding.current(),
    subscribe: (fn) => binding.subscribe(fn),
    dispose: () => binding.dispose(),
    patch: (patch) => announceOnSuccess(binding.patch(patch)),
    rename: (oldKey, newKey, options) => announceOnSuccess(binding.rename(oldKey, newKey, options)),
    reorder: (orderedKeys) => announceOnSuccess(binding.reorder(orderedKeys)),
    patchPath: (path, value) => announceOnSuccess(binding.patchPath(path, value)),
    deletePath: (path) => announceOnSuccess(binding.deletePath(path)),
    renamePath: (path, newKey, options) =>
      announceOnSuccess(binding.renamePath(path, newKey, options)),
    reorderPath: (path, orderedKeys) => announceOnSuccess(binding.reorderPath(path, orderedKeys)),
    reorderSeqPath: (path, oldIndicesInNewOrder) =>
      announceOnSuccess(binding.reorderSeqPath(path, oldIndicesInNewOrder)),
  };
}

export function isUserIntentPmTransaction(transaction: PMTransaction): boolean {
  if (!transaction.docChanged) return false;
  return isUserIntentOrigin(transaction);
}

export function isUserIntentCmUpdate(update: ViewUpdate): boolean {
  if (!update.docChanged) return false;
  return update.transactions.some(
    (transaction) => transaction.annotation(CMTransaction.userEvent) !== undefined,
  );
}
