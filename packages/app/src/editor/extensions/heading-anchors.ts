/**
 * HeadingAnchors — app-only ProseMirror decoration plugin that adds a slug-based
 * `id` attribute to every heading element in the WYSIWYG editor DOM.
 *
 * IDs are derived with the same `toWikiLinkSlug` function used to write anchor
 * values in wiki links, so `[[page#my-heading]]` navigates to the heading
 * whose rendered text slugifies to "my-heading".
 *
 * Duplicate heading texts are disambiguated with a numeric suffix (-1, -2, …)
 * so every ID in the document remains unique.
 *
 * This is deliberately kept out of core/shared extensions because:
 *   - The server doesn't render interactive HTML (IDs serve no purpose there).
 *   - Decorations don't mutate the ProseMirror document or serialised markdown.
 */
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { getHeadingSlug } from './wiki-link-helpers';

export const HeadingAnchors = Extension.create({
  name: 'headingAnchors',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const decos: Decoration[] = [];
            const slugCounts = new Map<string, number>();

            state.doc.descendants((node, pos) => {
              if (node.type.name === 'heading') {
                const id = getHeadingSlug(node.textContent, slugCounts);
                if (!id) return;

                decos.push(Decoration.node(pos, pos + node.nodeSize, { id }));
              }
            });

            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});
