import { incrementJsxRenderFailure } from '@inkeep/open-knowledge-core/metrics/parse-health';
import { Trans } from '@lingui/react/macro';
import type { NodeViewProps } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { Button } from '../../components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.tsx';
import { ViewInSourceBubbleButton } from '../bubble-menu/ViewInSourceBubbleButton.tsx';
import { OPT_OUT_ATTR } from '../clipboard/index.ts';
import { PropPanel } from '../components/PropPanel.tsx';
import { getDescriptor } from '../registry/index.ts';
import { attrsWithChangedProp, getElementJsxAttrs, stableHash } from './JsxComponentView.tsx';
import { resolveJsxActionTarget } from './jsx-node-action.ts';
import { prepareJsxProps, resolveJsxSourceDocName } from './jsx-render-contract.ts';
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

  const { props: primitiveProps, error: propsError } = prepareJsxProps(
    node.attrs,
    descriptor,
    true,
  );
  const renderProps = normalizeDocRelativeMediaRenderProps(
    descriptor.name,
    primitiveProps,
    resolveJsxSourceDocName(extension.options, editor),
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

  const { children: _body, ...panelValues } = primitiveProps;

  if (propsError) {
    return (
      <NodeViewWrapper as="span" data-jsx-inline="" data-jsx-props-error="">
        <span
          className="inline-flex flex-wrap items-center gap-1 text-xs text-warning"
          contentEditable={false}
          {...{ [OPT_OUT_ATTR]: 'true' }}
        >
          <span role="status">
            <Trans>This component is too large to render.</Trans>
          </span>
          <ViewInSourceBubbleButton
            editor={editor}
            getTargetPosition={() =>
              resolveJsxActionTarget(
                { editor, getPos, node, descriptorName: descriptor.name },
                'edit-source',
              )?.pos
            }
          />
        </span>
      </NodeViewWrapper>
    );
  }

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
              if (curNode?.type.name !== 'jsxInline') return;
              const elementAttrs = getElementJsxAttrs(curNode.attrs);
              if (!elementAttrs) return;
              const tr = editor.state.tr.setNodeMarkup(
                p,
                null,
                attrsWithChangedProp(elementAttrs, descriptor, propName, value),
              );
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
