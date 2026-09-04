import type { Editor, Range } from '@tiptap/react';
import type { SlashCommandItem } from './items';

interface ApplySlashCommandItemArgs {
  editor: Editor;
  item: SlashCommandItem;
  range: Range;
}

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
        return true;
      })
      .run();
  } catch (err) {
    console.error(`[slash-command] deleteRange failed for "${item.name}"`, err);
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
