/**
 * markIdentityDecorationPlugin — materializes `markIdentityPlugin`'s stable IDs
 * as PM inline decorations carrying `data-mark-id="m${n}"` attributes.
 *
 * Why a separate plugin? `markIdentityPlugin` assigns IDs in `appendTransaction`
 * — which runs AFTER a mark's `renderHTML` has already emitted DOM. There is
 * no transform that lets `renderHTML` read the post-appendTransaction ID at
 * render time. PM's decoration system is the canonical escape hatch: a plugin
 * returning `Decoration.inline(from, to, attrs)` attaches `attrs` to the DOM
 * for the decorated range on every view update, bypassing the render cycle
 * that produced the mark's initial DOM.
 *
 * Pairs with:
 *   - `markIdentityPlugin` — owner of the ID assignment state
 *   - InteractionLayer — event delegation reads `data-mark-id`
 *     via `closest('[data-mark-id]')` to resolve click/hover targets
 *
 * Consumers (InternalLink, WikiLink-if-mark) register BOTH plugins:
 *
 *   addProseMirrorPlugins() {
 *     return [
 *       markIdentityPlugin({ markTypes: ['link'], onRegister, onDeregister }),
 *       markIdentityDecorationPlugin(),
 *     ];
 *   }
 *
 * precedent #9 (add-only schema): IDs live in PluginState only;
 * the schema is not mutated. Decoration attributes are a view-layer concern,
 * not schema state.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { markIdentityKey } from './mark-identity';

export const markIdentityDecorationKey = new PluginKey('markIdentityDecoration');

/** Attribute name the plugin writes to decorated ranges. */
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
