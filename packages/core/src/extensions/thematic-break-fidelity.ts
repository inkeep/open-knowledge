/**
 * ThematicBreak extension override for source-text fidelity.
 *
 * Extends @tiptap/extension-horizontal-rule (preserving setHorizontalRule
 * command and input rules for ---, ___, ***) and adds the sourceRaw
 * attribute to preserve the exact source form of the thematic break.
 *
 * Schema name is mdast-canonical: 'thematicBreak' (not 'horizontalRule').
 * Markdown parsing/serialization is handled by the unified pipeline
 * (packages/core/src/markdown/).
 *
 * Input rule overrides the upstream default to thread the user's chosen
 * delimiter form into `sourceRaw` via `getAttributes`. WYSIWYG-typed
 * `___ ` lands with `sourceRaw='___'`; the to-markdown handler emits the
 * same form (modulo the doc-start `---` → `***` rewrite). Without the
 * override, the node inherits the schema default `'---'` and the user's
 * typed form is silently canonicalized.
 *
 * Em-dash quirk: `—-` (auto-corrected from `--`) is not valid CommonMark
 * thematic break syntax, so it canonicalizes to `'---'` rather than being
 * captured verbatim — emitting `—-` as markdown would not re-parse as
 * a thematic break.
 */

import { nodeInputRule } from '@tiptap/core';
import HorizontalRule from '@tiptap/extension-horizontal-rule';

export const THEMATIC_BREAK_INPUT_RE = /^(?:---|—-|___\s|\*\*\*\s)$/;

function thematicBreakSourceRawFromMatch(match: RegExpMatchArray | string[]): string {
  const matched = String(match[0] ?? '').replace(/\s+$/, '');
  if (matched === '—-') return '---';
  return matched;
}

// Exposed so unit tests can exercise the same logic the input rule applies
// without spinning up a full Editor instance.
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
