import { Extension } from '@tiptap/core';

export const TabFocusTrap = Extension.create({
  name: 'tabFocusTrap',
  priority: 1,

  addKeyboardShortcuts() {
    return {
      Tab: () => true,
      'Shift-Tab': () => true,
    };
  },
});
