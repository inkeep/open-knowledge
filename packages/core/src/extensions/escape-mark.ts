import { Mark } from '@tiptap/core';

export const EscapeMark = Mark.create({
  name: 'escapeMark',
  priority: 10,
  excludes: '',
  inclusive: false,

  parseHTML() {
    return [{ tag: 'span[data-escape-mark]' }];
  },

  renderHTML() {
    return ['span', { 'data-escape-mark': '' }, 0];
  },
});
