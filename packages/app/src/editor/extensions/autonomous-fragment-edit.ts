/**
 * Which ProseMirror transactions the user is responsible for, and when a
 * NodeView is allowed to issue one they are not.
 *
 * DISPATCH GATE. An autonomous (non-user-initiated) structural fragment rewrite
 * issued from a source-mode-hidden WYSIWYG editor races Observer B's
 * per-keystroke re-derive and double-materializes the span at the
 * Y.XmlFragment CRDT level (precedent #14: Observer B is the sole fragment
 * writer during source typing). Gate every autonomous structural dispatch on
 * the editor being the visible/authoritative surface — in source mode the
 * WYSIWYG is hidden, so its structural rewrites serve no user and only create
 * the double-write race.
 *
 * Checked at DISPATCH time (not effect entry): the mode can flip between
 * scheduling a rAF/timeout and its firing, and a stale-scheduled dispatch is
 * exactly the hazard.
 *
 * ORIGIN CLASSIFICATION. `isUserIntentOrigin` is where "did the user do this?"
 * is answered, so a consumer asking it does not carry its own copy of the
 * origin taxonomy. See that function for the canonical enumeration, and
 * `markAutonomousFragmentEdit` for what the second arm is and why it exists.
 */
import type { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
// Sourced from `@tiptap/y-tiptap` (TipTap v3 official path), never
// `y-prosemirror` directly: the origin test below compares against the
// PluginKey identity the y-prosemirror sync plugin used when it stamped the
// meta. A second PluginKey instance matches nothing, silently classifying
// every CRDT-origin transaction as a user edit. Aligns with
// bridge-id-plugin.ts and editor-cache.ts.
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { getEditorSourceMode } from './editor-mode-context.ts';

export function autonomousFragmentEditAllowed(editor: Editor): boolean {
  return !getEditorSourceMode(editor);
}

/**
 * Transaction meta stamped on an autonomous fragment edit. Namespaced because
 * ProseMirror's string metas share one flat namespace across every plugin.
 */
const AUTONOMOUS_FRAGMENT_EDIT_META = 'autonomousFragmentEdit/swap';

/**
 * Stamp a NodeView's own representation swap so origin classification declines
 * it.
 *
 * CALLER OBLIGATION, two rules:
 *
 *   1. Stamp only a transaction that changes how a block is SPELLED, never one
 *      carrying bytes the user authored. The stamp suppresses dirty-marking, so
 *      applying it to a real edit leaves the enclosing container emitting its
 *      stale `sourceRaw` over that edit — a drop, not a respell. The nested-CM
 *      `forwardUpdate` path must never be stamped; the on-blur upgrade routes
 *      through `markSwapIfByteNeutral` rather than deciding for itself.
 *   2. Never stamp a transaction returned from an `appendTransaction` hook. The
 *      autolink guard fails closed over the WHOLE batch, so one stamped member
 *      suppresses linkification for every transaction dispatched with it.
 *
 * The two stamped surfaces are the wildcard/render-error auto-convert and that
 * on-blur re-parse upgrade. Both carry no y-prosemirror sync meta, so without
 * the stamp they read as keystrokes. Two of the consumers act on that visibly:
 *
 *   - `SourceDirtyObserver` marks every enclosing `jsxComponent` dirty. A dirty
 *     container stops emitting its verbatim `sourceRaw` and is re-derived
 *     instead, which re-spells the container boundary the user authored;
 *     Observer A then persists that re-spelling over source they never touched,
 *     and a write landing beside a live keystroke merges two spellings of one
 *     span.
 *   - preview-tab promotion makes a tab permanent for a document the user only
 *     opened to read.
 */
export function markAutonomousFragmentEdit(tr: Transaction): Transaction {
  return tr.setMeta(AUTONOMOUS_FRAGMENT_EDIT_META, true);
}

/**
 * Stamp `tr` only if `nextSource` is byte-identical to what `replaced` already
 * holds. The whole decision lives here rather than as a predicate the caller
 * branches on, so the branch itself is reachable from a test: collapsing it to
 * an unconditional stamp is the natural "simplify this" edit, and it silently
 * reintroduces the byte drop the CALLER OBLIGATION above forbids.
 */
export function markSwapIfByteNeutral(
  tr: Transaction,
  replaced: PmNode,
  nextSource: string,
): Transaction {
  return nextSource === replaced.textContent ? markAutonomousFragmentEdit(tr) : tr;
}

/** True for a transaction that `markAutonomousFragmentEdit` stamped. Module-
 *  private: the stamp is only ever read through `isUserIntentOrigin`, so a
 *  consumer cannot check one arm of the taxonomy and miss the other. */
function isAutonomousFragmentEdit(tr: Transaction): boolean {
  return tr.getMeta(AUTONOMOUS_FRAGMENT_EDIT_META) === true;
}

/**
 * True when the user is responsible for this transaction. This is the canonical
 * origin taxonomy; a consumer points here rather than re-enumerating it.
 *
 * Deny-listed, in the sense that a transaction is the user's only by carrying
 * NEITHER marker:
 *
 *   - `ySyncPluginKey` meta, which y-prosemirror stamps on everything it
 *     injects from the CRDT: remote peers, agent writes, rollback-apply, disk
 *     loads, and both server observer directions.
 *   - the `markAutonomousFragmentEdit` stamp, on the editor's own
 *     representation swaps.
 *
 * What is left is the user: typing, paste, drag-drop, and the NodeView commits
 * that carry an edit they made.
 *
 * Says nothing about whether the document changed — a caller that cares tests
 * `tr.docChanged` alongside this, because the two questions have different
 * answers for a selection-only transaction.
 *
 * Sites that read `ySyncPluginKey` directly instead of calling this
 * (`TiptapEditor`'s agent-write flash, `cell-insertion-gate`,
 * `binding-staleness-guard`) are asking the inverse and narrower question, "is
 * this specifically CRDT-origin?"; an autonomous swap is correctly not
 * CRDT-origin to them.
 */
export function isUserIntentOrigin(tr: Transaction): boolean {
  return !tr.getMeta(ySyncPluginKey) && !isAutonomousFragmentEdit(tr);
}
