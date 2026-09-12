/**
 * Materializes `markIdentityPlugin`'s stable IDs as PM inline decorations carrying
 * `data-mark-id`, because the IDs are assigned in `appendTransaction` after `renderHTML` has run.
 * Precedent #9 add-only schema holds: the IDs live in PluginState, not in the schema.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { markIdentityKey } from './mark-identity';

export const markIdentityDecorationKey = new PluginKey('markIdentityDecoration');

export const MARK_ID_DATA_ATTR = 'data-mark-id';

export function markIdentityDecorationPlugin(): Plugin {
  return new Plugin({
    key: markIdentityDecorationKey,
    props: {
      decorations(state) {
        const identity = markIdentityKey.getState(state);
        if (!identity || identity.byId.size === 0) return null;

        const decos: Decoration[] = [];
        for (const info of identity.byId.values()) {
          decos.push(
            Decoration.inline(info.from, info.to, {
              [MARK_ID_DATA_ATTR]: info.id,
            }),
          );
        }
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}
