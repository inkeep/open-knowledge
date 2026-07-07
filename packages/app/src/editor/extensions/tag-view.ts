/**
 * App-specific Tag extension — extends core's `Tag` atom with:
 *   - The React `TagView` NodeView (filled chip vs empty-placeholder
 *     inline-input states; no popover panel).
 *   - The `#`-typeahead suggestion plugin (`tag-suggestion.ts`).
 *   - Adjacent-atom Backspace/Delete handlers (single-keystroke chip
 *     removal — matches @-mention UX in Slack / Discord / Notion).
 *
 * Two insertion paths land at the same filled-chip shape:
 *   - `#` typeahead — user types `#`, picks/creates → suggestion's
 *     command inserts a pre-filled atom.
 *   - Slash-menu "Tag" — inserts an empty `tag` atom; the NodeView's
 *     placeholder state takes over with an auto-focused inline input,
 *     committing on Enter/Space/blur and deleting on Escape/empty-blur.
 *
 * The `<a class="tag" data-tag>` shape stays load-bearing for filled
 * chips so `tag-click-plugin.ts` still routes clicks to the read-side
 * `<TagDialog>` membership view.
 *
 * Backspace / Delete next to a tag atom — when an atom sits adjacent to
 * the empty cursor and the suggestion plugin is NOT active, swallow the
 * keystroke and delete the whole atom in a single step. Without this,
 * the default behavior deletes the atom in two steps (first selects it,
 * then deletes on the second press), which surprises authors used to
 * text editors. Mirrors the wiki-link extension override.
 */
import { Tag as BaseTag } from '@inkeep/open-knowledge-core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { TagView } from '../components/TagView.tsx';
import { configureTagSuggestion, tagSuggestionKey } from './tag-suggestion.ts';

export const Tag = BaseTag.extend({
  // Higher priority ensures the suggestion plugin's handleKeyDown
  // fires before TipTap's base keymap (Enter → split block, Backspace
  // → joinBackward), so Enter completes a `#` suggestion and
  // Backspace/Delete can target adjacent tag atoms via the handlers
  // below. Mirrors the priority bump on the wiki-link app-side
  // override (`./wiki-link.ts`).
  priority: 200,

  addNodeView() {
    return ReactNodeViewRenderer(TagView);
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        // WARN: Reads @tiptap/suggestion internal state — verify
        // shape on upgrades. Same pattern wiki-link uses to avoid
        // swallowing Backspace while the typeahead is open.
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
