import { incrementJsxRenderFailure } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import type { NodeViewProps } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { Button } from '../../components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.tsx';
import { PropPanel } from '../components/PropPanel.tsx';
import { getDescriptor } from '../registry/index.ts';
import { getEditorDocName } from './doc-context.ts';
import { extractPrimitiveProps, stableHash } from './JsxComponentView.tsx';
import { normalizeDocRelativeMediaRenderProps } from './media-render-props.ts';

export function JsxInlineView(viewProps: NodeViewProps) {
  const { node } = viewProps;
  const name = (node.attrs.componentName as string) || '';

  if (!name) {
    return (
      <NodeViewWrapper as="span" data-jsx-inline="">
        <NodeViewContent<'span'> as="span" />
      </NodeViewWrapper>
    );
  }

  return <RegisteredInlineView {...viewProps} name={name} />;
}

function RegisteredInlineView({
  node,
  selected,
  editor,
  getPos,
  extension,
  name,
}: NodeViewProps & { name: string }) {
  const descriptor = getDescriptor(name);
  const { Component } = descriptor;
  const [popoverOpen, setPopoverOpen] = useState(false);
  const wasSelected = useRef(false);

  const primitiveProps = extractPrimitiveProps(node.attrs, descriptor.reactNodePropNames);
  const bodyText = (node.attrs.props as Record<string, unknown> | undefined)?.children;
  if (typeof bodyText === 'string' && bodyText !== '') {
    (primitiveProps as Record<string, unknown>).children = bodyText;
  }
  const configuredDocName = (extension.options as { docName?: unknown }).docName;
  const sourceDocName =
    typeof configuredDocName === 'string' && configuredDocName
      ? configuredDocName
      : getEditorDocName(editor);
  const renderProps = normalizeDocRelativeMediaRenderProps(
    descriptor.name,
    primitiveProps,
    sourceDocName,
  );
  const resetKey = `${descriptor.name}::${stableHash(primitiveProps)}`;

  useEffect(() => {
    const sync = () => {
      const p = typeof getPos === 'function' ? getPos() : undefined;
      const sel = editor.state.selection;
      const mine = sel instanceof NodeSelection && typeof p === 'number' && sel.from === p;
      if (mine && !wasSelected.current) setPopoverOpen(true);
      else if (!mine && wasSelected.current) setPopoverOpen(false);
      wasSelected.current = mine;
    };
    editor.on('selectionUpdate', sync);
    sync();
    return () => {
      editor.off('selectionUpdate', sync);
    };
  }, [editor, getPos]);

  const structuredProps = (node.attrs.props ?? {}) as Record<string, unknown>;
  const { children: _body, ...panelValues } = structuredProps;

  return (
    <NodeViewWrapper
      as="span"
      data-jsx-inline=""
      data-component-name={name}
      contentEditable={false}
      className={selected ? 'jsx-inline-selected' : undefined}
    >
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          {}
          <span data-jsx-inline-widget="">
            <ErrorBoundary
              resetKeys={[resetKey]}
              onError={(error, info) => {
                const err = error instanceof Error ? error : new Error(String(error));
                console.warn(
                  JSON.stringify({
                    event: 'jsx-render-failure',
                    component: descriptor.name === '*' ? 'wildcard' : descriptor.name,
                    rawComponentName: name.slice(0, 200),
                    error: String(err),
                    stack: info.componentStack,
                  }),
                );
                incrementJsxRenderFailure(descriptor.name);
              }}
              fallbackRender={() => (
                <span className="text-xs font-mono text-destructive">[{name}]</span>
              )}
            >
              <Component {...renderProps} />
            </ErrorBoundary>
          </span>
        </PopoverTrigger>
        <PopoverContent
          className="z-[60] w-72 p-3"
          side="bottom"
          align="start"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (editor.isDestroyed) return;
            const p = typeof getPos === 'function' ? getPos() : undefined;
            if (typeof p === 'number') {
              const state = editor.state;
              const widget = state.doc.nodeAt(p);
              if (widget?.type.name === 'jsxInline') {
                const after = p + widget.nodeSize;
                if (after <= state.doc.content.size) {
                  editor.view.dispatch(
                    state.tr.setSelection(TextSelection.create(state.doc, after)),
                  );
                }
              }
            }
            editor.view.focus();
          }}
        >
          <div className="text-xs font-medium text-muted-foreground mb-2">
            <Trans>{descriptor.displayName ?? name} Properties</Trans>
          </div>
          <PropPanel
            descriptor={descriptor}
            values={panelValues}
            onChange={(propName, value) => {
              const p = typeof getPos === 'function' ? getPos() : undefined;
              if (typeof p !== 'number') return;
              const curNode = editor.state.doc.nodeAt(p);
              if (!curNode || curNode.type.name !== 'jsxInline') return;
              const nextProps = { ...curNode.attrs.props, [propName]: value };
              const tr = editor.state.tr.setNodeMarkup(p, null, {
                ...curNode.attrs,
                props: nextProps,
                sourceDirty: true,
              });
              tr.setSelection(NodeSelection.create(tr.doc, p));
              editor.view.dispatch(tr);
            }}
            onDismiss={() => setPopoverOpen(false)}
          />
          <Button
            variant="secondary"
            size="sm"
            className="mt-2 w-full"
            onClick={() => setPopoverOpen(false)}
          >
            <Trans>Done</Trans>
          </Button>
        </PopoverContent>
      </Popover>
    </NodeViewWrapper>
  );
}
