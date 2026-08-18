import { invertedEffects } from '@codemirror/commands';
import { getOriginalDoc, updateOriginalDoc } from '@codemirror/merge';
import type { ChangeSet, Extension } from '@codemirror/state';

/**
 * Makes `@codemirror/merge`'s "accept hunk" undoable.
 *
 * `acceptChunk` dispatches an EFFECT-ONLY transaction: it advances the merge
 * view's ORIGINAL side via `updateOriginalDoc` and never touches the editor
 * document. `rejectChunk` dispatches a real document change instead. CodeMirror's
 * history only records document changes unless an effect opts in through
 * `invertedEffects`, and the merge package registers none — so without this
 * extension Undo is a no-op after Accept, and a mixed reject-then-accept
 * sequence undoes the older reject out of order.
 *
 * The inverse restores the pre-transaction original document. Both payload
 * fields are load-bearing: the `originalDoc` field reads `doc`, while the chunk
 * field feeds `changes` to `Chunk.updateA` to recompute hunks incrementally, so
 * an inverse carrying a stale changeset would desync the hunk list from the text.
 */
export function mergeAcceptHistory(): Extension {
  return invertedEffects.of((tr) => {
    // Compose rather than emit one inverse per effect: a single transaction
    // carrying several original-doc updates must undo as one step, and the
    // composed changeset is the only correct `changes` for that step.
    let forward: ChangeSet | null = null;
    for (const effect of tr.effects) {
      if (!effect.is(updateOriginalDoc)) continue;
      forward = forward === null ? effect.value.changes : forward.compose(effect.value.changes);
    }
    if (forward === null) return [];

    const before = getOriginalDoc(tr.startState);
    return [updateOriginalDoc.of({ doc: before, changes: forward.invert(before) })];
  });
}
