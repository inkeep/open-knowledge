/**
 * App-specific ImageInline override — extends core's `ImageSrcFidelity`
 * with a React NodeView that wraps the inline `<img>` in
 * `react-medium-image-zoom`'s `<Zoom>` for click-to-enlarge.
 *
 * Same split as `MathInline` (core owns schema + commands; app adds the
 * React render). `.configure({ inline: true })` MUST be re-applied at
 * the swap site — `configure()` is instance-scoped and lost across
 * `.extend()`, and the PM image node group depends on it.
 */
import { ImageSrcFidelity } from '@inkeep/open-knowledge-core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ImageInlineZoomView } from './ImageInlineZoomView';

export const ImageInlineZoom = ImageSrcFidelity.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ImageInlineZoomView);
  },
});
