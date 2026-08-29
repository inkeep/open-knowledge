/**
 * Fragment-derive demand: who still needs the WYSIWYG replica kept fresh.
 *
 * Observer B rebuilds `Y.XmlFragment('default')` from `Y.Text('source')` on
 * every source-mode keystroke, unconditionally — a full markdown re-parse plus
 * a fragment rebuild, synchronously on the main thread, whether or not any
 * consumer will ever read the result. On a large document that parse dominates
 * the keystroke; the fragment it produces is discarded unread when nobody is
 * looking at the WYSIWYG.
 *
 * This module carries the two pieces of state that let the observer skip that
 * work and still be honest about having skipped it:
 *
 *   1. A per-doc SUSPENSION flag. While set, the fragment is knowingly stale.
 *      The bridge-invariant watchdog reads it so a by-design divergence is
 *      reported through its own channel instead of being counted as a
 *      violation (and, in dev/test, thrown). Without this the watchdog cannot
 *      tell a suspended derive from a broken bridge — and a watchdog that
 *      cries wolf on normal operation is a watchdog nobody reads.
 *
 *   2. A per-doc RESUMER. Demand can return with no Y.Text edit to ride in on:
 *      a reader opens the WYSIWYG on a document that has been quiet for
 *      minutes, and the next drain that would repair the fragment may never
 *      come. The resumer is the observer's own catch-up derive, callable from
 *      the demand-transition site.
 *
 * Both are keyed by live Y.Doc object identity — two servers in one process
 * hold distinct docs, so entries never collide — and both follow the
 * `preDrainControllers` lifecycle in `server-observers.ts`: set when the
 * observer attaches, deleted on detach. A doc with no entry (system/config
 * docs, unloaded docs, unit tests that never opt in) reads as "not suspended"
 * and has no resumer, which is exactly the pre-existing always-derive
 * behaviour.
 *
 * SAFETY INVARIANT — suspension must always be BOUNDED by a real check.
 * Suppressing the watchdog is only defensible because every suspension ends in
 * a catch-up derive that re-asserts the invariant normally. A code path that
 * suspends without a resume is a permanently-blinded watchdog, which is a
 * strictly worse failure than the cost it saves.
 */
import type * as Y from 'yjs';

/**
 * Docs whose fragment derive is currently suspended, i.e. whose fragment is
 * knowingly behind `Y.Text`. Absent === not suspended.
 */
const suspendedDocs = new WeakSet<Y.Doc>();

/**
 * Mark (or clear) a document's derive-suspended state.
 *
 * Called by Observer B only: the observer is the single writer for this flag
 * because it is the only site that knows whether a derive was actually
 * skipped. A second writer could clear the flag while a derive is still owed,
 * re-arming the watchdog against a divergence the bridge has not yet repaired.
 */
export function setFragmentDeriveSuspended(doc: Y.Doc, suspended: boolean): void {
  if (suspended) suspendedDocs.add(doc);
  else suspendedDocs.delete(doc);
}

/**
 * True while this document's fragment is knowingly stale by design.
 *
 * Consumers must treat this as "divergence here is expected, do not alarm" —
 * NOT as "divergence here is fine to act on". Y.Text remains the source of
 * truth either way, so a reader that needs real content must read `Y.Text`
 * rather than trusting a suspended fragment.
 */
export function isFragmentDeriveSuspended(doc: Y.Doc): boolean {
  return suspendedDocs.has(doc);
}

/** Per-document catch-up derive, published by the observer while attached. */
const resumers = new WeakMap<Y.Doc, () => void>();

/**
 * Publish this document's catch-up derive. Returns a disposer that removes the
 * registration; the observer's cleanup calls it on detach so a destroyed doc's
 * closure cannot be invoked afterwards.
 */
export function registerFragmentDeriveResumer(doc: Y.Doc, resume: () => void): () => void {
  resumers.set(doc, resume);
  return () => {
    // Identity-checked delete: a re-attach between registration and disposal
    // would otherwise let the STALE disposer evict the LIVE resumer, silently
    // leaving the doc with no catch-up path.
    if (resumers.get(doc) === resume) resumers.delete(doc);
  };
}

/**
 * Run this document's catch-up derive if one is registered and a derive is
 * owed. No-op for a doc with no observers attached (system/config docs) — such
 * a doc never suspended, so there is nothing to repair.
 *
 * Safe to call unconditionally on a demand transition: the observer's resumer
 * itself decides whether work is owed, so a spurious call costs a boolean
 * check rather than a parse.
 */
export function resumeFragmentDerive(doc: Y.Doc): void {
  resumers.get(doc)?.();
}
