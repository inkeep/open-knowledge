
import { Mark } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    comment: {
      setComment: () => ReturnType;
      toggleComment: () => ReturnType;
      unsetComment: () => ReturnType;
    };
  }
}

export const CommentMark = Mark.create({
  name: 'comment',
  priority: 10,
  excludes: '',
  inclusive: false,

  addAttributes() {
    return {
      sourceForm: {
        default: 'percent',
        parseHTML: (element: HTMLElement) =>
          element.getAttribute('data-source-form') === 'html' ? 'html' : 'percent',
        renderHTML: (attrs: { sourceForm?: string }) =>
          attrs.sourceForm === 'html' ? { 'data-source-form': 'html' } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-comment-mark]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      {
        'data-comment-mark': '',
        'data-clipboard-omit': 'true',
        class: 'comment-mark',
        style: 'display: none;',
        ...HTMLAttributes,
      },
      0,
    ];
  },

  addCommands() {
    return {
      setComment:
        () =>
        ({ commands }) =>
          commands.setMark(this.name),
      toggleComment:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetComment:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});
