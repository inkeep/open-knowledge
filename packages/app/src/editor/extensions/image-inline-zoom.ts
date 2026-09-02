import { ImageSrcFidelity } from '@inkeep/open-knowledge-core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ImageInlineZoomView } from './ImageInlineZoomView';

export const ImageInlineZoom = ImageSrcFidelity.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ImageInlineZoomView);
  },
});
