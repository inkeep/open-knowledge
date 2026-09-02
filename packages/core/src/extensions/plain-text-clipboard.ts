import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export const PlainTextClipboard = Extension.create({
  name: 'plainTextClipboard',
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('okPlainTextClipboard'),
        props: {
          clipboardTextSerializer: (slice) =>
            slice.content.textBetween(0, slice.content.size, '\n\n'),
        },
      }),
    ];
  },
});
