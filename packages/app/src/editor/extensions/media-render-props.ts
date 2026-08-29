import { normalizeDocRelativeAssetUrl } from '@inkeep/open-knowledge-core';

export const DOC_RELATIVE_SRC_COMPONENTS = new Set([
  'img',
  'CommonMarkImage',
  'video',
  'audio',
  'Pdf',
  'File',
  'Excalidraw',
]);

export function normalizeDocRelativeMediaRenderProps(
  descriptorName: string,
  renderProps: Record<string, unknown>,
  sourceDocName: string | null | undefined,
): Record<string, unknown> {
  if (!DOC_RELATIVE_SRC_COMPONENTS.has(descriptorName)) return renderProps;
  if (!sourceDocName) return renderProps;

  const src = renderProps.src;
  if (typeof src !== 'string') return renderProps;

  const normalized = normalizeDocRelativeAssetUrl(src, sourceDocName);
  if (normalized === src) return renderProps;

  return { ...renderProps, src: normalized };
}
