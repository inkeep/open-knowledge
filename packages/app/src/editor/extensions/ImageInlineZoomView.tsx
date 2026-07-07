/**
 * React NodeView for inline PM `image` atoms (`![alt](src)` mid-prose).
 * Wraps the leaf `<img>` in `react-medium-image-zoom`'s `<Zoom>` so
 * click-to-enlarge works the same way it does on block-context
 * descriptor-rendered images.
 *
 * `<NodeViewWrapper as="span">` and `<Zoom wrapElement="span">` are
 * load-bearing: HTML spec forbids `<div>` inside `<p>`, and inline
 * images live inside paragraphs.
 *
 * `zoomImg={{ sizes: undefined }}` clears any inherited thumbnail-scoped
 * `sizes` so the lightbox renders at the image's natural breakpoints,
 * not the thumbnail's — same fix `Image.tsx` applies on the descriptor
 * side.
 *
 * `data-clipboard-inline-leaf` opts this wrapper out of clipboard's
 * `findDescriptorRoot` (see `clipboard/serialize.ts`): the PM node IS
 * the bare `<img>` atom, not a descriptor, so position resolution must
 * stay on the direct-leaf `posAtDOM(<img>, 0)` path that the un-wrapped
 * image used.
 *
 * Doc-relative `src` is resolved against the document's folder here, the
 * same render-time normalization the block path applies in
 * `media-render-props` (the descriptor `<Image>` render). Without it, a
 * raw `./assets/x.jpg` reaches the DOM and the browser resolves it against
 * the hash-routed SPA root (`location.pathname === '/'`) → `/assets/x.jpg`
 * → 404. Server-baked nodes already carry a server-absolute `src`, so this
 * is a no-op there (idempotent); it backstops nodes holding a raw
 * doc-relative `src` (client-authored / pasted inline images, or any
 * non-server-baked path).
 */

import { normalizeDocRelativeAssetUrl, toDesktopAssetHref } from '@inkeep/open-knowledge-core';
import type { NodeViewProps } from '@tiptap/core';
import { NodeViewWrapper } from '@tiptap/react';
import Zoom from 'react-medium-image-zoom';
import { getEditorDocName } from './doc-context.ts';

export function ImageInlineZoomView({ node, editor }: NodeViewProps) {
  // `node.attrs` is typed `Record<string, unknown>` by tiptap (no per-
  // extension attr types ship). Narrow each field via `typeof` checks —
  // matches the sibling `MathInlineView` pattern and stays honest about
  // the schema (mdast can carry `null` URLs for malformed image refs,
  // and a cast to `{ src?: string }` would silently lie about that).
  const rawSrc = node.attrs.src;
  const rawAlt = node.attrs.alt;
  const rawTitle = node.attrs.title;
  // Resolve against the doc folder before the desktop-origin wrap.
  // `getEditorDocName` reads the per-editor WeakMap (set from
  // `provider.configuration.name` on mount); when absent the resolver
  // returns the raw URL unchanged, so a missing docName degrades to the
  // prior behavior rather than emitting a wrong base.
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
