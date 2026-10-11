import { incrementJsxRenderFailure } from '@inkeep/open-knowledge-core/metrics/parse-health';
import type { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { ErrorInfo } from 'react';
import type { JsxComponentDescriptor } from '../registry/types.ts';
import { ALIGNABLE_DESCRIPTOR_NAMES } from '../utils/alignable-descriptors.ts';
import { sanitizeComponentProps } from '../utils/sanitize-url.ts';
import { getEditorDocName } from './doc-context.ts';
import { normalizeDocRelativeMediaRenderProps } from './media-render-props.ts';

export const JSX_WRAPPER_CLASS = 'jsx-component-wrapper my-2';

export function extractPrimitiveProps(
  attrs: Record<string, unknown>,
  reactNodeNames: ReadonlySet<string>,
): Record<string, unknown> {
  const propsObj = (attrs.props ?? {}) as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(propsObj)) {
    if (reactNodeNames.has(key)) continue;
    result[key] = value;
  }
  return sanitizeComponentProps(result);
}

export function resolveJsxSourceDocName(extensionOptions: unknown, editor: Editor): string | null {
  const configuredDocName = (extensionOptions as { docName?: unknown }).docName;
  return typeof configuredDocName === 'string' && configuredDocName
    ? configuredDocName
    : getEditorDocName(editor);
}

export function resolveJsxRenderProps(
  descriptor: JsxComponentDescriptor,
  primitiveProps: Record<string, unknown>,
  sourceDocName: string | null,
): Record<string, unknown> {
  const translatedProps =
    descriptor.surface === 'compat' ? descriptor.translateProps(primitiveProps) : primitiveProps;
  return normalizeDocRelativeMediaRenderProps(descriptor.name, translatedProps, sourceDocName);
}

function resolveJsxAlign(
  descriptor: JsxComponentDescriptor,
  props: Record<string, unknown>,
): 'left' | 'right' | 'center' | undefined {
  const rawAlign = props.align;
  if (rawAlign === 'left' || rawAlign === 'right' || rawAlign === 'center') return rawAlign;
  return ALIGNABLE_DESCRIPTOR_NAMES.has(descriptor.name) ? 'center' : undefined;
}

export function jsxWrapperDataAttributes(
  descriptor: JsxComponentDescriptor,
  props: Record<string, unknown>,
) {
  return {
    'data-jsx-component': '',
    'data-component-type': descriptor.name.toLowerCase(),
    'data-component-name': descriptor.name,
    'data-align': resolveJsxAlign(descriptor, props),
  };
}

export function jsxChildrenClassName(descriptor: JsxComponentDescriptor, node: PmNode): string {
  return !descriptor.hasChildren && node.childCount === 0
    ? 'component-children min-h-0 m-0 p-0'
    : 'component-children';
}

export function reportJsxRenderFailure(
  descriptorName: string,
  rawComponentName: unknown,
  error: unknown,
  info: ErrorInfo,
): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  console.warn(
    JSON.stringify({
      event: 'jsx-render-failure',
      component: descriptorName,
      rawComponentName: String(rawComponentName ?? '').slice(0, 200),
      error: String(err),
      stack: info.componentStack,
    }),
  );
  incrementJsxRenderFailure(descriptorName);
  return err;
}
