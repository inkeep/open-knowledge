/**
 * JsxInlineView — descriptor-dispatched inline NodeView.
 *
 * Two branches:
 *  - `componentName` set → registered inline descriptor. Renders the
 *    descriptor's React component with sanitized structured props (paired
 *    bodies arrive as `props.children`). Widget is atomic
 *    (contentEditable={false}) so users can't drift the body from sourceRaw.
 *    Click selects the node (NodeSelection) and opens a PropPanel popover —
 *    the same selection-sync + position-targeted-commit contract as
 *    MathInlineView, with `sourceDirty: true` on every prop write so the
 *    serializer reconstructs from the edit instead of re-emitting stale
 *    sourceRaw. Wrapped in an ErrorBoundary that emits the shared
 *    `jsx-render-failure` telemetry event, matching the block
 *    `JsxComponentView` contract.
 *  - `componentName === ''` → thin shape. The text children carry the raw
 *    source; surface them via a plain span so unregistered inline JSX still
 *    round-trips as visible source text.
 */
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

  // Route props through the shared extractor so URL-schemes / dangerous
  // handlers / `dangerouslySetInnerHTML` get stripped before render — same
  // sanitization contract as JsxComponentView.
  const primitiveProps = extractPrimitiveProps(node.attrs, descriptor.reactNodePropNames);
  // The paired body is captured as a plain STRING in `props.children`; the
  // extractor strips reactNode-classified props, so re-attach it — a string
  // child is inert (no elements, no handlers) and is exactly what the
  // source `<Name>body</Name>` said.
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
  // `stableHash` sorts keys recursively so a props re-serialization that
  // reorders insertion order doesn't remount the ErrorBoundary mid-render.
  const resetKey = `${descriptor.name}::${stableHash(primitiveProps)}`;

  // Popover follows a NodeSelection at THIS widget's position, driven off
  // the editor's selectionUpdate event. MathInlineView gates on TipTap's
  // `selected` prop instead; that prop is true for any range selection
  // crossing the widget (drag-select, Cmd+A) and its delivery is unreliable
  // for jsxInline nested inside a jsxComponent's children — the
  // position-exact check covers both, hence the deliberate divergence. Open on select, close on
  // navigate-away; Radix handles Escape/outside-click on its own.
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
  // `children` is the captured paired body, not a PropDef — PropPanel only
  // renders descriptor-declared props, so it never surfaces; keep it out of
  // the values map anyway so a future PropDef named `children` can't
  // accidentally bind to it.
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
          {/* Click → NodeSelection is handled PM-natively by the extension's
              handleClickOn plugin (see jsx-inline.ts) — a React handler here
              loses the race against PM's own mousedown handling. */}
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
            // Let PropPanel's autoFocus land on its first input.
            e.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            // Hand focus back to the editor with the caret AFTER the widget
            // so the author keeps typing — MathInlineView's dismiss contract.
            e.preventDefault();
            // Radix fires this async on unmount too — after teardown the
            // editor is destroyed and `editor.view` is the throwing proxy.
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
              // Target by position, not selection — the popover input holds
              // DOM focus, so selection-based updateAttributes would no-op.
              // Re-apply the NodeSelection after the markup change so the
              // selection-sync effect doesn't dismiss the popover on the
              // first keystroke (MathInlineView's commit contract).
              const p = typeof getPos === 'function' ? getPos() : undefined;
              if (typeof p !== 'number') return;
              const curNode = editor.state.doc.nodeAt(p);
              if (!curNode || curNode.type.name !== 'jsxInline') return;
              const nextProps = { ...curNode.attrs.props, [propName]: value };
              // `sourceDirty: true` routes the serializer onto the
              // reconstruct-from-props path — without it the stale
              // sourceRaw would be re-emitted and the edit silently lost.
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
