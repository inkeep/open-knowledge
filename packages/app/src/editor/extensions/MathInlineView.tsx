import { incrementJsxRenderFailure } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import type { NodeViewProps } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { NodeViewWrapper } from '@tiptap/react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.tsx';
import { PropPanel } from '../components/PropPanel.tsx';
import type { JsxComponentDescriptor } from '../registry/types.ts';
import { consumeAutoOpen } from '../slash-command/component-items.tsx';

const inlineMathDescriptor = {
  name: 'InlineMath',
  surface: 'canonical',
  hasChildren: false,
  isSelfClosing: true,
  category: 'content',
  description: 'Inline math',
  props: [
    {
      name: 'formula',
      type: 'string',
      required: true,
      autoFocus: true,
      description: 'LaTeX inline math source',
    },
  ],
} as unknown as JsxComponentDescriptor;

const KatexInlineRender = lazy(async () => {
  const { default: katex } = await import('katex');

  function KatexInlineInner(props: { formula: string }) {
    const html = katex.renderToString(props.formula, {
      displayMode: false,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
    });
    return (
      <span
        className="math math-inline"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX renderToString returns a strict HTML-allowlist string with no script execution; this is the documented integration path.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return { default: KatexInlineInner };
});

function EmptyInlineMathPlaceholder() {
  return (
    <span
      className="math math-inline math-placeholder math-placeholder-empty inline-flex items-center gap-1 rounded-sm border border-dashed border-muted-foreground/40 bg-muted/30 px-1.5 py-0.5 text-xs italic text-muted-foreground hover:bg-muted/60 cursor-pointer"
      data-component-type="math-inline"
    >
      f(x)
    </span>
  );
}

function InlineLoadingPlaceholder(props: { formula: string }) {
  return (
    <span className="math math-inline math-placeholder" data-component-type="math-inline">
      {props.formula}
    </span>
  );
}

export function MathInlineView({ node, selected, getPos, editor }: NodeViewProps) {
  const formula = typeof node.attrs.formula === 'string' ? node.attrs.formula : '';
  const id = typeof node.attrs.id === 'string' ? node.attrs.id : undefined;
  const [popoverOpen, setPopoverOpen] = useState(false);
  const wasSelected = useRef(false);

  useEffect(() => {
    const isSoleSelection = selected && editor.state.selection instanceof NodeSelection;

    if (isSoleSelection && !wasSelected.current) {
      const pos = typeof getPos === 'function' ? (getPos() ?? 0) : 0;
      consumeAutoOpen(pos);
      setPopoverOpen(true);
    } else if (!isSoleSelection && wasSelected.current) {
      setPopoverOpen(false);
    }
    wasSelected.current = isSoleSelection;
  }, [selected, getPos, editor]);

  return (
    <NodeViewWrapper as="span" className={selected ? 'math-inline-selected' : undefined}>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        {/* PopoverTrigger asChild needs a single ref-able element. Wrap the
            conditional render in a stable <span> so Radix can attach its
            trigger ref (Suspense doesn't forward refs reliably across the
            fallback/rendered boundary). The wrapper also gives us a single
            place to hang `id` for deep-link anchors and the
            data-component-type attribute consistently across all states. */}
        <PopoverTrigger asChild>
          <span
            className="math-inline-trigger"
            data-component-type="math-inline"
            data-formula={formula}
            {...(id ? { id } : {})}
          >
            {formula ? (
              <ErrorBoundary
                resetKeys={[formula]}
                onError={(error, info) => {
                  const err = error instanceof Error ? error : new Error(String(error));
                  console.warn(
                    JSON.stringify({
                      event: 'jsx-render-failure',
                      component: 'mathInline',
                      rawComponentName: 'mathInline',
                      error: String(err),
                      stack: info.componentStack,
                    }),
                  );
                  incrementJsxRenderFailure('mathInline');
                }}
                fallbackRender={() => (
                  <span className="math math-inline math-error">{formula}</span>
                )}
              >
                <Suspense fallback={<InlineLoadingPlaceholder formula={formula} />}>
                  <KatexInlineRender formula={formula} />
                </Suspense>
              </ErrorBoundary>
            ) : (
              <EmptyInlineMathPlaceholder />
            )}
          </span>
        </PopoverTrigger>
        <PopoverContent
          className="z-[60] w-72 p-0"
          side="bottom"
          align="start"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            editor.view.focus();
          }}
        >
          <div className="text-xs font-medium text-muted-foreground px-3 pt-2">
            <Trans>Inline Math Properties</Trans>
          </div>
          <PropPanel
            descriptor={inlineMathDescriptor}
            values={{ formula }}
            onChange={(propName, value) => {
              const p = typeof getPos === 'function' ? getPos() : undefined;
              if (typeof p !== 'number') return;
              const curNode = editor.state.doc.nodeAt(p);
              if (!curNode || curNode.type.name !== 'mathInline') return;
              const tr = editor.state.tr.setNodeMarkup(p, null, {
                ...curNode.attrs,
                [propName]: value ?? '',
              });
              tr.setSelection(NodeSelection.create(tr.doc, p));
              editor.view.dispatch(tr);
            }}
          />
        </PopoverContent>
      </Popover>
    </NodeViewWrapper>
  );
}
