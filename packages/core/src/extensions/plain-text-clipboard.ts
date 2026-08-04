/**
 * Keeps the input-rule placeholder out of the plain-text clipboard.
 *
 * `renderText` (see `input-rule-text.ts`) exists so the input-rule runner can
 * compute replacement ranges correctly, which requires every inline node to
 * contribute exactly as many characters as it occupies positions. `@tiptap/core`
 * files that function on the NodeSpec as `toText`, and reads `toText` from a
 * SECOND place with an incompatible contract: `getTextSerializersFromSchema`,
 * which feeds the built-in `clipboardTextSerializer`. There, `getTextBetween`
 * substitutes the serializer's output for the node AND stops descending into it,
 * so plain-text copy would emit the placeholder for a leaf and would replace a
 * node's visible text with it entirely.
 *
 * One hook, two contracts: position-faithful for range arithmetic, human-readable
 * for the clipboard. This restores the second by serializing plain text the way
 * ProseMirror does natively — `textBetween`, which consults `leafText` and never
 * `toText`.
 *
 * Registered in `sharedExtensions` rather than at each editor's call site so an
 * editor added later inherits it; a mounted-editor test asserts a bare roster
 * (no `editorProps` overrides) still copies clean text. The document editor's
 * own `editorProps.clipboardTextSerializer` continues to win over this: a view
 * prop is consulted before any plugin's.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export const PlainTextClipboard = Extension.create({
  name: 'plainTextClipboard',
  // Above the default so this plugin precedes the built-in serializer's, which
  // is the one whose output has to lose.
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
