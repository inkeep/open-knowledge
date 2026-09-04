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
