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
