import { mergeAttributes } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { toDesktopAssetHref } from '../utils/asset-href.ts';
import { renderInlineObjectText } from './input-rule-text.ts';

export const ImageSrcFidelity = Image.extend({
  marks: '_',
  priority: 60,

  renderText: renderInlineObjectText,

  addAttributes() {
    return {
      ...this.parent?.(),
      sourceUrl: { default: null, rendered: false },
    };
  },

  renderHTML({ HTMLAttributes }) {
    const attrs = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes);
    if (typeof attrs.src === 'string') attrs.src = toDesktopAssetHref(attrs.src);
    return ['img', attrs];
  },
});
