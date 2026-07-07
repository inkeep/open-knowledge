/**
 * Decision logic for the `EditorArea.tsx` `useDeferredValue` skeleton
 * overlay. Extracted to a pure, testable function so the 4-state truth
 * table for the warm-reopen bypass is unit-tested in isolation — the
 * load-bearing piece is the AND conjunction between mount-promise and
 * sync-promise resolution; if a future refactor flips it to OR, the
 * overlay would skip on partially-resolved state and the user would see
 * a brief stale-content flash before sync completes.
 */

interface OverlayDecisionInput {
  /** Urgent `activeDocName` from `useDocumentContext()`. */
  activeDocName: string | null;
  /** Deferred mirror via `useDeferredValue(activeDocName)`. */
  deferredActiveDocName: string | null;
  /** Whether `mountTiptapEditorPromise` for `activeDocName` has resolved. */
  mountResolved: boolean;
  /** Whether `syncPromise` for `activeDocName` has resolved. */
  syncResolved: boolean;
}

/**
 * Returns `true` when the overlay should paint EditorSkeleton over the
 * editor pool during a navigation in flight.
 *
 * The overlay paints when ALL of:
 *   1. There IS an active document (otherwise the empty state owns the
 *      surface).
 *   2. The deferred-value gap is open (`activeDocName !==
 *      deferredActiveDocName`) — shell snapped but the editor subtree's
 *      deferred commit hasn't landed yet.
 *   3. The upcoming commit will pay a real Suspense suspension — i.e.,
 *      EITHER mount-promise OR sync-promise has not resolved for the
 *      target doc.
 *
 * The third condition is the AND-of-resolved branch you'd want to read
 * carefully: it's `!(mountResolved && syncResolved)`, equivalent to
 * `!mountResolved || !syncResolved`. Both conditions must be true to
 * skip the overlay; either being unresolved means the overlay paints.
 *
 * Truth table (with active != deferred, i.e. condition 2 satisfied):
 *
 *   mountResolved | syncResolved | overlay paints?
 *   ------------- | ------------ | ---------------
 *   true          | true         | NO  (warm-reopen bypass)
 *   true          | false        | YES (sync still pending)
 *   false         | true         | YES (mount still pending)
 *   false         | false        | YES (both pending)
 */
export function shouldPaintOverlay(input: OverlayDecisionInput): boolean {
  const { activeDocName, deferredActiveDocName, mountResolved, syncResolved } = input;
  if (activeDocName === null) return false;
  if (activeDocName === deferredActiveDocName) return false;
  return !(mountResolved && syncResolved);
}
