import { nodeInputRule } from '@tiptap/core';
import HorizontalRule from '@tiptap/extension-horizontal-rule';

export const THEMATIC_BREAK_INPUT_RE = /^(?:---|—-|___\s|\*\*\*\s)$/;

function thematicBreakSourceRawFromMatch(match: RegExpMatchArray | string[]): string {
  const matched = String(match[0] ?? '').replace(/\s+$/, '');
  if (matched === '—-') return '---';
  return matched;
}

export { thematicBreakSourceRawFromMatch };

export const ThematicBreakFidelity = HorizontalRule.extend({
  name: 'thematicBreak',
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      sourceRaw: { default: '---' },
    };
  },

  addInputRules() {
    return [
      nodeInputRule({
        find: THEMATIC_BREAK_INPUT_RE,
        type: this.type,
        getAttributes: (match) => ({
          sourceRaw: thematicBreakSourceRawFromMatch(match),
        }),
      }),
    ];
  },
});
