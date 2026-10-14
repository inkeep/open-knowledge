import { type Editor, Extension, escapeForRegEx } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { SuggestionMatch, Trigger } from '@tiptap/suggestion';

export const IDEOGRAPHIC_SPACE = '\u3000';

export const SUGGESTION_TRIGGER_PREFIXES: readonly string[] = [' ', IDEOGRAPHIC_SPACE];

export const MENTION_TRIGGER_CHARS: readonly string[] = ['@', '\uff20'];

export const SLASH_TRIGGER_CHARS: readonly string[] = ['/', '\uff0f'];

export function createTriggerMatcher(
  triggerChars: readonly string[],
): (config: Trigger) => SuggestionMatch {
  const chars = triggerChars.map(escapeForRegEx).join('');
  const pattern = new RegExp(`[${chars}][^\\s${chars}]*`, 'g');
  return ({ allowedPrefixes, $position }) => {
    const text = $position.nodeBefore?.isText ? $position.nodeBefore.text : undefined;
    if (!text) return null;
    const match = Array.from(text.matchAll(pattern)).pop();
    if (match === undefined) return null;
    const prefix = text.slice(Math.max(0, match.index - 1), match.index);
    if (allowedPrefixes !== null && prefix !== '' && !allowedPrefixes.includes(prefix)) {
      return null;
    }
    const from = $position.pos - text.length + match.index;
    const to = from + match[0].length;
    if (from >= $position.pos || to < $position.pos) return null;
    return { range: { from, to }, query: match[0].slice(1), text: match[0] };
  };
}

export function allowOutsideComposition({
  editor,
  isActive,
}: {
  editor: Editor;
  isActive?: boolean;
}): boolean {
  return isActive === true || !editor.view.composing;
}

const suggestionCompositionEndKey = new PluginKey('suggestionCompositionEnd');

export const SuggestionCompositionEnd = Extension.create({
  name: 'suggestionCompositionEnd',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: suggestionCompositionEndKey,
        props: {
          handleDOMEvents: {
            compositionend(view) {
              const committed = view.state;
              setTimeout(() => {
                if (view.isDestroyed || view.composing || view.state !== committed) return;
                view.dispatch(view.state.tr.setMeta('addToHistory', false));
              }, 0);
              return false;
            },
          },
        },
      }),
    ];
  },
});
