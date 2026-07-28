import type { Editor, Range } from '@tiptap/react';
import type { SlashCommandItem } from './items';

interface ApplySlashCommandItemArgs {
  editor: Editor;
  item: SlashCommandItem;
  range: Range;
}

/**
 * Run a slash-command item's insert in the same transaction as the
 * trigger-range delete.
 *
 * The composition is the whole point. `.command()` hands the item a chain
 * seeded with the outer transaction, so the item's `.run()` appends steps
 * rather than dispatching; the single `.run()` below is the only dispatch.
 * A second transaction would open a window in which a transaction dispatched
 * re-entrantly during the delete's own dispatch — a plugin `appendTransaction`,
 * a view update, or the collab binding reacting to the just-applied delete —
 * can remap the selection onto an adjacent selectable node, and the item's
 * insert would then replace that node.
 *
 * Two shapes deliberately avoided: handing the item this function's own chain
 * object (its `.run()` would dispatch the shared transaction a second time),
 * and calling `item.command` with an `editor` it can chain off (`editor.chain()`
 * reads `editor.state`, which is still the pre-deleteRange document).
 */
export function applySlashCommandItem({ editor, item, range }: ApplySlashCommandItemArgs): void {
  const deferred: Array<() => void> = [];
  let itemError: unknown;

  try {
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .command((props) => {
        try {
          item.command({
            editor,
            chain: props.chain,
            state: props.state,
            afterCommit: (fn) => deferred.push(fn),
          });
        } catch (err) {
          itemError = err;
        }
        // An item failure must not roll back the trigger-range delete: the
        // chain aborts on a false return and the user's "/query" text would
        // survive with no insert, which is not today's behaviour.
        return true;
      })
      .run();
  } catch (err) {
    console.error(`[slash-command] deleteRange failed for "${item.name}"`, err);
    // A dispatch failure must not swallow an item failure that preceded it —
    // both throws are needed to trace the dual-failure case.
    if (itemError !== undefined) {
      console.error(`[slash-command] command "${item.name}" threw an error`, itemError);
    }
    return;
  }

  if (itemError !== undefined) {
    console.error(`[slash-command] command "${item.name}" threw an error`, itemError);
  }
  for (const fn of deferred) {
    try {
      fn();
    } catch (err) {
      console.error(`[slash-command] afterCommit callback for "${item.name}" threw an error`, err);
    }
  }
}
