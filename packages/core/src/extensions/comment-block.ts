
import { Node } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    commentBlock: {
      setCommentBlock: () => ReturnType;
      toggleCommentBlock: () => ReturnType;
      unsetCommentBlock: () => ReturnType;
    };
  }
}

export const CommentBlock = Node.create({
  name: 'commentBlock',
  group: 'block',
  content: 'block+',
  defining: true,
  priority: 60,

  addAttributes() {
    return {
      sourceForm: {
        default: 'percent',
        parseHTML: (element: HTMLElement) =>
          element.getAttribute('data-source-form') === 'html' ? 'html' : 'percent',
        renderHTML: (attrs: { sourceForm?: string }) =>
          attrs.sourceForm === 'html' ? { 'data-source-form': 'html' } : {},
      },
      sourceLayout: {
        default: 'block',
        parseHTML: (element: HTMLElement) =>
          element.getAttribute('data-source-layout') === 'inline' ? 'inline' : 'block',
        renderHTML: (attrs: { sourceLayout?: string }) =>
          attrs.sourceLayout === 'inline' ? { 'data-source-layout': 'inline' } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'aside[data-comment-block]' }, { tag: 'aside.comment-block' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'aside',
      {
        'data-comment-block': '',
        'data-clipboard-omit': 'true',
        class: 'comment-block',
        style: 'display: none;',
        ...HTMLAttributes,
      },
      0,
    ];
  },

  addCommands() {
    return {
      setCommentBlock:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name),
      toggleCommentBlock:
        () =>
        ({ commands }) =>
          commands.toggleWrap(this.name),
      unsetCommentBlock:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },
});
