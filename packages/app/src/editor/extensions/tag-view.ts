import { Tag as BaseTag } from '@inkeep/open-knowledge-core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { TagView } from '../components/TagView.tsx';
import { configureTagSuggestion, tagSuggestionKey } from './tag-suggestion.ts';

export const Tag = BaseTag.extend({
  priority: 200,

  addNodeView() {
    return ReactNodeViewRenderer(TagView);
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        /*
         * WARN: Reads @tiptap/suggestion internal state — verify
         * shape on upgrades. Same pattern wiki-link uses to avoid
         * swallowing Backspace while the typeahead is open.
         */
        const pluginState = tagSuggestionKey.getState(this.editor.state) as
          | { active: boolean }
          | undefined;
        if (pluginState?.active) return false;

        const { selection } = this.editor.state;
        if (!selection.empty) return false;

        const nodeBefore = selection.$from.nodeBefore;
        if (nodeBefore?.type.name === 'tag') {
          const { state, view } = this.editor;
          view.dispatch(state.tr.delete(selection.from - nodeBefore.nodeSize, selection.from));
          return true;
        }
        return false;
      },
      Delete: () => {
        const pluginState = tagSuggestionKey.getState(this.editor.state) as
          | { active: boolean }
          | undefined;
        if (pluginState?.active) return false;

        const { selection } = this.editor.state;
        if (!selection.empty) return false;

        const nodeAfter = selection.$from.nodeAfter;
        if (nodeAfter?.type.name === 'tag') {
          const { state, view } = this.editor;
          view.dispatch(state.tr.delete(selection.from, selection.from + nodeAfter.nodeSize));
          return true;
        }
        return false;
      },
    };
  },

  addProseMirrorPlugins() {
    return [configureTagSuggestion(this.editor)];
  },
});
