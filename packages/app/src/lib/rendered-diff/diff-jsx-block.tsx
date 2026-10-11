import { useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import {
  NodeViewContent,
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  ReactRenderer,
} from '@tiptap/react';
import type { ReactNode } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { isLiveBoardSrc } from '@/editor/components/ExcalidrawEmbed';
import { JsxComponentHostProvider } from '@/editor/components/jsx-host-context';
import { LiveDocAccessContext } from '@/editor/components/live-doc-pool';
import { getEditorDocName } from '@/editor/extensions/doc-context';
import { JsxComponent } from '@/editor/extensions/jsx-component';
import {
  extractPrimitiveProps,
  JSX_WRAPPER_CLASS,
  jsxChildrenClassName,
  jsxWrapperDataAttributes,
  reportJsxRenderFailure,
  resolveJsxRenderProps,
  resolveJsxSourceDocName,
} from '@/editor/extensions/jsx-render-contract';
import { getDescriptor } from '@/editor/registry';
import {
  resolveDescriptorPlaceholder,
  shouldRenderPlaceholder,
} from '@/editor/registry/resolve-descriptor-placeholder';
import type { JsxComponentDescriptor } from '@/editor/registry/types';
import { reconstructSource } from '@/editor/utils/reconstruct-source';

export interface RenderedJsxBlock {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  destroy: () => void;
}

function nodeProps(node: PMNode): Record<string, unknown> {
  return (node.attrs.props as Record<string, unknown> | null) ?? {};
}

function opensLiveDocument(
  descriptor: JsxComponentDescriptor,
  renderProps: Record<string, unknown>,
): boolean {
  if (descriptor.name === 'Mirror') return true;
  return descriptor.name === 'Excalidraw' && isLiveBoardSrc(renderProps.src);
}

function referenceTarget(renderProps: Record<string, unknown>): string {
  const src = typeof renderProps.src === 'string' ? renderProps.src : '';
  const anchor = typeof renderProps.anchor === 'string' ? renderProps.anchor : '';
  return anchor ? `${src}#${anchor}` : src;
}

function diffRenderProps(
  descriptor: JsxComponentDescriptor,
  renderProps: Record<string, unknown>,
): Record<string, unknown> {
  const propNames = new Set(descriptor.props.map((p) => p.name));
  return {
    ...renderProps,
    ...(propNames.has('defaultOpen') ? { defaultOpen: true } : {}),
    ...(propNames.has('autoplay') ? { autoplay: false } : {}),
    ...(propNames.has('loop') ? { loop: false } : {}),
    ...(propNames.has('controls') ? { controls: true } : {}),
  };
}

function wrapperAttributes(node: PMNode) {
  return {
    className: JSX_WRAPPER_CLASS,
    ...jsxWrapperDataAttributes(getDescriptor(node.attrs.componentName as string), nodeProps(node)),
  };
}

function openingTag(node: PMNode): string {
  const lines = reconstructSource(node).split('\n');
  const end = lines.findIndex((line) => line.trimEnd().endsWith('>'));
  return lines.slice(0, end + 1).join('\n');
}

function FallbackBlock({
  node,
  heading,
  children,
}: {
  node: PMNode;
  heading: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-diff-jsx-source="">
      <div className="flex gap-2 text-xs font-mono text-foreground px-2 py-1">{heading}</div>
      {node.childCount > 0 ? (
        <>
          <code className="block whitespace-pre-wrap px-2 text-xs text-foreground">
            {openingTag(node)}
          </code>
          {children}
        </>
      ) : (
        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-sm">
          <code>{reconstructSource(node)}</code>
        </pre>
      )}
    </div>
  );
}

function DiffJsxBlock({
  node,
  docName,
  children,
}: {
  node: PMNode;
  docName: string | null;
  children: ReactNode;
}) {
  const { t } = useLingui();
  const unregisteredComponentName = String(node.attrs.componentName ?? '');
  const descriptor = getDescriptor(unregisteredComponentName);
  const label = descriptor.displayName ?? descriptor.name;

  if (descriptor.name === '*') {
    return (
      <FallbackBlock node={node} heading={t`Unknown component: ${unregisteredComponentName}`}>
        {children}
      </FallbackBlock>
    );
  }

  const primitiveProps = extractPrimitiveProps(node.attrs, descriptor.reactNodePropNames);
  const renderProps = resolveJsxRenderProps(descriptor, primitiveProps, docName);

  if (
    shouldRenderPlaceholder(descriptor, nodeProps(node)) ||
    opensLiveDocument(descriptor, renderProps)
  ) {
    const { Icon } = resolveDescriptorPlaceholder(descriptor);
    const target = referenceTarget(renderProps);
    return (
      <>
        <div
          data-diff-jsx-reference=""
          className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-foreground"
        >
          <Icon size={16} aria-hidden="true" />
          <span>{label}</span>
          {target ? <code className="truncate">{target}</code> : null}
        </div>
        {node.childCount > 0 ? children : null}
      </>
    );
  }

  const Comp = descriptor.Component;
  return (
    <ErrorBoundary
      onError={(error, info) => {
        reportJsxRenderFailure(descriptor.name, unregisteredComponentName, error, info);
      }}
      fallbackRender={() => (
        <FallbackBlock
          node={node}
          heading={
            <>
              <span>{label}</span>
              <span>{t`render error`}</span>
            </>
          }
        >
          {children}
        </FallbackBlock>
      )}
    >
      <LiveDocAccessContext value={false}>
        <JsxComponentHostProvider value={null}>
          <Comp {...diffRenderProps(descriptor, renderProps)}>{children}</Comp>
        </JsxComponentHostProvider>
      </LiveDocAccessContext>
    </ErrorBoundary>
  );
}

function DiffJsxComponentView({ node, editor, extension }: NodeViewProps) {
  const descriptor = getDescriptor(node.attrs.componentName as string);
  return (
    <NodeViewWrapper {...wrapperAttributes(node)}>
      <DiffJsxBlock node={node} docName={resolveJsxSourceDocName(extension.options, editor)}>
        <NodeViewContent className={jsxChildrenClassName(descriptor, node)} />
      </DiffJsxBlock>
    </NodeViewWrapper>
  );
}

export const DiffJsxComponent = JsxComponent.extend({
  addNodeView() {
    return ReactNodeViewRenderer(DiffJsxComponentView);
  },
});

function DeletedJsxBlock({
  node,
  docName,
  contentDOM,
}: {
  node: PMNode;
  docName: string | null;
  contentDOM: HTMLElement;
}) {
  return (
    <div {...wrapperAttributes(node)}>
      <DiffJsxBlock node={node} docName={docName}>
        <div
          className={jsxChildrenClassName(getDescriptor(node.attrs.componentName as string), node)}
          ref={(host) => {
            if (host && contentDOM.parentNode !== host) host.appendChild(contentDOM);
          }}
        />
      </DiffJsxBlock>
    </div>
  );
}

export function renderDeletedJsxBlock(editor: Editor, node: PMNode): RenderedJsxBlock {
  const contentDOM = document.createElement('div');
  contentDOM.setAttribute('data-node-view-content-react', '');
  const renderer = new ReactRenderer(DeletedJsxBlock, {
    editor,
    props: { node, docName: getEditorDocName(editor), contentDOM },
  });
  return { dom: renderer.element, contentDOM, destroy: () => renderer.destroy() };
}
