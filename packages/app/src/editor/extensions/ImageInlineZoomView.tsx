
import { normalizeDocRelativeAssetUrl, toDesktopAssetHref } from '@inkeep/open-knowledge-core';
import type { NodeViewProps } from '@tiptap/core';
import { NodeViewWrapper } from '@tiptap/react';
import Zoom from 'react-medium-image-zoom';
import { getEditorDocName } from './doc-context.ts';

export function ImageInlineZoomView({ node, editor }: NodeViewProps) {
  const rawSrc = node.attrs.src;
  const rawAlt = node.attrs.alt;
  const rawTitle = node.attrs.title;
  const sourceDocName = editor ? (getEditorDocName(editor) ?? undefined) : undefined;
  const src =
    typeof rawSrc === 'string'
      ? toDesktopAssetHref(normalizeDocRelativeAssetUrl(rawSrc, sourceDocName))
      : undefined;
  const alt = typeof rawAlt === 'string' ? rawAlt : '';
  const title = typeof rawTitle === 'string' ? rawTitle : undefined;
  return (
    <NodeViewWrapper as="span" data-image-inline-zoom data-clipboard-inline-leaf="image">
      <Zoom wrapElement="span" zoomMargin={20} zoomImg={{ sizes: undefined }}>
        <img src={src} alt={alt} title={title} />
      </Zoom>
    </NodeViewWrapper>
  );
}
