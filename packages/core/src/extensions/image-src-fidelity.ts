import { mergeAttributes } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { toDesktopAssetHref } from '../utils/asset-href.ts';

export const ImageSrcFidelity = Image.extend({
  priority: 60,

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
