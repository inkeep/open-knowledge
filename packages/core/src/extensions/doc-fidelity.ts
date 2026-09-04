import { Extension } from '@tiptap/core';

export const DocFidelity = Extension.create({
  name: 'docFidelity',

  addGlobalAttributes() {
    return [
      {
        types: ['doc'],
        attributes: {
          sourceDocBoundary: { default: null, rendered: false },
        },
      },
    ];
  },
});
