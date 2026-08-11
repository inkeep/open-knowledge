import { normalizeDocRelativeAssetUrl, normalizeReferenceLabel } from '@inkeep/open-knowledge-core';
import type { NodeViewProps } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeViewWrapper, useEditorState } from '@tiptap/react';
import Zoom from 'react-medium-image-zoom';
import { BareImg } from '../components/Image';
import { getEditorDocName } from './doc-context.ts';

/**
 * CommonMark label matching collapses internal markdown whitespace
 * (`[\t\n\r ]`, not `\s`) and folds case. The shared core helper keeps the
 * editor aligned with the parser and server.
 */
export function resolveImageReferenceHref(
  doc: ProseMirrorNode,
  identifier: string,
): string | undefined {
  const normalizedIdentifier = normalizeReferenceLabel(identifier);
  let href: string | undefined;

  doc.descendants((candidate) => {
    // Once resolved, prune the rest of the walk (`false` stops descent).
    if (href !== undefined) return false;
    if (candidate.type.name !== 'linkRefDef') return;
    const label = candidate.attrs.label;
    const candidateHref = candidate.attrs.href;
    if (
      typeof label === 'string' &&
      typeof candidateHref === 'string' &&
      normalizeReferenceLabel(label) === normalizedIdentifier
    ) {
      href = candidateHref;
    }
  });

  return href;
}

export interface ImageReferenceLeafProps {
  /** Absent when no definition resolves the reference; the failure placeholder renders instead. */
  src?: string;
  alt: string;
}

export function ImageReferenceLeaf({ src, alt }: ImageReferenceLeafProps) {
  return <BareImg src={src} alt={alt} />;
}

export function ImageReferenceView({ node, editor, extension }: NodeViewProps) {
  const rawIdentifier = node.attrs.identifier;
  const identifier = typeof rawIdentifier === 'string' ? rawIdentifier : '';
  const rawAlt = node.attrs.alt;
  const rawLabel = node.attrs.label;
  const alt =
    typeof rawAlt === 'string' && rawAlt.length > 0
      ? rawAlt
      : typeof rawLabel === 'string'
        ? rawLabel
        : '';
  const href = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) =>
      resolveImageReferenceHref(currentEditor.state.doc, identifier),
  });
  const configuredDocName = (extension.options as { docName?: unknown }).docName;
  const sourceDocName =
    typeof configuredDocName === 'string' && configuredDocName
      ? configuredDocName
      : (getEditorDocName(editor) ?? undefined);
  const src = href === undefined ? undefined : normalizeDocRelativeAssetUrl(href, sourceDocName);

  return (
    <NodeViewWrapper
      as="span"
      data-image-reference-view
      data-clipboard-inline-leaf="imageReference"
    >
      <Zoom wrapElement="span" zoomMargin={20} zoomImg={{ sizes: undefined }}>
        <ImageReferenceLeaf src={src} alt={alt} />
      </Zoom>
    </NodeViewWrapper>
  );
}
