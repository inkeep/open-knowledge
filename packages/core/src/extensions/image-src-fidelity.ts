/**
 * Image extension override for doc-relative source fidelity + desktop origin.
 *
 * Extends @tiptap/extension-image with one source-form attr:
 *   - sourceUrl: string | null
 *       The original doc-relative markdown URL (`../../assets/x.png`),
 *       preserved by the mdast→PM `handlers.image` so the reverse PM→mdast
 *       walker can re-emit byte-identical bytes even though `src` renders the
 *       normalized server-absolute form. `null` means "src was not rewritten"
 *       (already server-absolute, scheme'd, or no `sourcePath` at parse time).
 *       Not user-editable; not emitted to the DOM (`rendered: false`).
 *
 * The `renderHTML` override applies `toDesktopAssetHref` so inline images —
 * which render through TipTap's image NodeView, not the React `Image.tsx`
 * component — land on the Electron utility server's origin in desktop mode.
 *
 * Mirrors the `TableFidelity` wrap-and-add-attr pattern. Swapped in for the
 * bare `Image` in `sharedExtensions` (single source of truth — core/server/app
 * stay in sync automatically).
 */

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
