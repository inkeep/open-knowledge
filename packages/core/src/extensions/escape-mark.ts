/**
 * escapeMark — PM-level mark for structurally-ambiguous backslash escapes.
 *
 * Applied to text runs whose source contained a backslash escape of a
 * CommonMark §2.4 character (# * _ [ ] \ ` + - . ! ( ) < > | ~ : etc.).
 * The mark carries no attributes — its presence alone signals that the text
 * was preceded by a backslash in the source, which the serialize handler
 * uses to re-emit the backslash on round-trip.
 *
 * Non-ambiguous escapes (e.g., \foo) lose the backslash on round-trip.
 */

import { Mark } from '@tiptap/core';

export const EscapeMark = Mark.create({
  name: 'escapeMark',
  // Low priority so it composes inside other marks (strong, emphasis)
  priority: 10,
  // No attributes
  excludes: '',
  // Can coexist with any other mark
  inclusive: false,

  parseHTML() {
    return [{ tag: 'span[data-escape-mark]' }];
  },

  renderHTML() {
    return ['span', { 'data-escape-mark': '' }, 0];
  },
});
