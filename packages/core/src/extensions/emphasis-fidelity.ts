/**
 * Emphasis (strong/emphasis) mark overrides for source-text fidelity.
 *
 * Extends @tiptap/extension-italic and @tiptap/extension-bold (preserving
 * toggleItalic/toggleBold commands, Cmd+I/Cmd+B shortcuts, and input rules)
 * and adds delimiter-choice attributes.
 *
 * Schema names are mdast-canonical: 'emphasis' (not 'italic'), 'strong'
 * (not 'bold'). Markdown parsing/serialization is handled by the unified
 * pipeline (packages/core/src/markdown/).
 *
 * Input rules override the upstream defaults to thread the user's chosen
 * delimiter form into the resulting mark via `getAttributes`. WYSIWYG-typed
 * `__foo__` lands as strong with `sourceDelimiter='__'`; the to-markdown
 * handler reads that attr and emits `__foo__`. Without the override,
 * `getAttributes` is undefined upstream and the mark inherits the schema
 * default (`'**'`/`'*'`), erasing the user's choice.
 */

import { markInputRule } from '@tiptap/core';
import Bold, {
  starInputRegex as boldStarRe,
  underscoreInputRegex as boldUnderRe,
} from '@tiptap/extension-bold';
import Italic, {
  starInputRegex as italicStarRe,
  underscoreInputRegex as italicUnderRe,
} from '@tiptap/extension-italic';

export const EMPHASIS_STAR_INPUT_RE = italicStarRe;
export const EMPHASIS_UNDERSCORE_INPUT_RE = italicUnderRe;
export const STRONG_STAR_INPUT_RE = boldStarRe;
export const STRONG_UNDERSCORE_INPUT_RE = boldUnderRe;

export const EmphasisFidelity = Italic.extend({
  name: 'emphasis',
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      sourceDelimiter: { default: '*' },
    };
  },

  addInputRules() {
    return [
      markInputRule({
        find: italicStarRe,
        type: this.type,
        getAttributes: { sourceDelimiter: '*' },
      }),
      markInputRule({
        find: italicUnderRe,
        type: this.type,
        getAttributes: { sourceDelimiter: '_' },
      }),
    ];
  },
});

export const StrongFidelity = Bold.extend({
  name: 'strong',
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      sourceDelimiter: { default: '**' },
    };
  },

  addInputRules() {
    return [
      markInputRule({
        find: boldStarRe,
        type: this.type,
        getAttributes: { sourceDelimiter: '**' },
      }),
      markInputRule({
        find: boldUnderRe,
        type: this.type,
        getAttributes: { sourceDelimiter: '__' },
      }),
    ];
  },
});
