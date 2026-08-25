/**
 * Preview-tab promotion.
 *
 * A preview tab (single-click from the sidebar, italic label) is provisional:
 * opening another target reuses its slot. Committing to the document makes the
 * tab permanent. Without that the bytes survive — they are CRDT state,
 * persisted independently of the tab — but the tab vanishes on the next sidebar
 * click, which reads as lost work.
 *
 * What counts as committing:
 *
 *   - editing the body, in WYSIWYG or source mode
 *   - editing frontmatter through the property panel (see
 *     {@link withPreviewTabPromotion})
 *   - switching the doc between source and WYSIWYG
 *   - double-clicking its row in the sidebar, or its tab
 *
 * The last two change no bytes, which is why this is named for its EFFECT
 * rather than for an edit — callers request a promotion, they don't report a
 * mutation. Anything the user does that says "I mean to keep working here"
 * belongs on that list; anything else does not.
 *
 * Agent and remote-peer writes deliberately do NOT promote. A tab you are only
 * reading must not become permanent because something else wrote to the
 * document.
 *
 * The listener indirection exists because both editor views outlive the React
 * components that mount them — the editor cache reparents a cached view across
 * Activity flips rather than destroying it, so a closure over a context method
 * captured at construction goes stale. Module-level state that survives React
 * remounts is the shared shape with `active-editor.ts` and the other
 * `subscribe*` registries; the slot here is single-consumer rather than a
 * listener set (see `subscribePreviewTabPromotion`).
 */

import { Transaction as CMTransaction } from '@codemirror/state';
import type { ViewUpdate } from '@codemirror/view';
import type { FrontmatterBinding } from '@inkeep/open-knowledge-core';
import type { Transaction as PMTransaction } from '@tiptap/pm/state';
import { docTabId } from './editor-tabs';
import { isUserIntentOrigin } from './extensions/autonomous-fragment-edit';

type PreviewTabPromotionListener = (tabId: string) => void;

let listener: PreviewTabPromotionListener | null = null;

/**
 * Register the single consumer of promotion requests (DocumentContext); the
 * returned function unregisters it, so a React caller can return it straight
 * from `useEffect`.
 *
 * Single-slot rather than a listener set: there is one DocumentContext per
 * window and one workspace for it to mutate, so a second consumer would mean
 * two writers racing on the same pane state. Unsubscribing only clears the slot
 * when it still holds THIS listener, which keeps a late cleanup from a
 * StrictMode double-mount from tearing down the live registration.
 */
export function subscribePreviewTabPromotion(next: PreviewTabPromotionListener): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}

/**
 * Ask for a tab to become permanent, by tab id. A no-op unless that tab is
 * currently its pane's preview, so callers don't have to know the tab state —
 * only that the user committed to what the tab holds.
 *
 * Keyed by tab id rather than document name because not every promotable tab
 * IS a document: the sidebar can preview an asset, whose tab id is its path
 * under a distinct prefix.
 */
export function requestPreviewTabPromotionForTab(tabId: string): void {
  if (!tabId) return;
  listener?.(tabId);
}

/**
 * Promote a document's tab. The form the editors use — an editor only ever
 * hosts a document, so it has a docName and no reason to know about tab ids.
 */
export function requestPreviewTabPromotion(docName: string): void {
  if (!docName) return;
  requestPreviewTabPromotionForTab(docTabId(docName));
}

/**
 * The binding methods that only read. Everything else on a
 * {@link FrontmatterBinding} mutates the YAML region and so must announce.
 * Named as the complement of the mutating set because that is the safe
 * direction to be wrong in: a method missing from the wrapper below is caught
 * by the coverage test, whereas a method wrongly listed here is not.
 */
export const READ_ONLY_BINDING_METHODS = ['current', 'subscribe', 'dispose'] as const;

/** The mutating surface, wrapped one-for-one below. */
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

/**
 * Wrap a frontmatter binding so every successful mutation promotes the
 * document's preview tab.
 *
 * Property-panel writes edit the YAML region of `Y.Text('source')`, which
 * reaches both editors as a sync-origin change — neither editor's origin guard
 * sees them as user input, so the promotion has to come from the write side.
 *
 * Wrapping the binding rather than each call site is what makes this hold: the
 * panel mutates through eight methods reached from three trees (the panel
 * itself, and nested object/array widgets via `FrontmatterBindingContext`), and
 * a per-call-site notification would have covered only the routes someone
 * remembered. `frontmatter-binding-promotion.test.ts` fails if the binding
 * grows a mutator this misses.
 *
 * Failed patches announce nothing — a rejected write is not an edit.
 */
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

/**
 * Whether a ProseMirror transaction is a content change the user made.
 *
 * Origin is `isUserIntentOrigin`'s call, not this module's — sharing it is what
 * keeps a tab from going permanent on something the user did not do. Both arms
 * matter here: a CRDT-origin transaction means someone else wrote, and an
 * autonomous representation swap means nobody wrote at all. A document holding
 * an unregistered JSX component auto-converts it on open, so without the second
 * arm merely reading such a document promotes its preview tab.
 *
 * `docChanged` is this module's own condition: arrow keys, Escape and Cmd+C all
 * produce user-origin transactions that leave the document untouched, and a tab
 * the user only navigated around is still provisional.
 */
export function isUserIntentPmTransaction(transaction: PMTransaction): boolean {
  if (!transaction.docChanged) return false;
  return isUserIntentOrigin(transaction);
}

/**
 * Whether a CodeMirror update carries a content change the user made.
 *
 * y-codemirror.next dispatches CRDT-origin changes with no `userEvent`
 * annotation, so requiring one admits typing / paste / delete / drop and
 * excludes sync. `ySyncAnnotation` would be the more direct test but the
 * package's exports map does not expose it.
 *
 * Undo/redo in source mode is routed to the Y.UndoManager, whose changes come
 * back through the sync path and so do not promote. Harmless: an undo on a tab
 * the user never edited is a no-op, and once they have edited it the tab is
 * already permanent.
 */
export function isUserIntentCmUpdate(update: ViewUpdate): boolean {
  if (!update.docChanged) return false;
  return update.transactions.some(
    (transaction) => transaction.annotation(CMTransaction.userEvent) !== undefined,
  );
}
