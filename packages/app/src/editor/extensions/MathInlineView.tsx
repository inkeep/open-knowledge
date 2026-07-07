/**
 * MathInlineView — React NodeView for the `mathInline` PM atom.
 *
 * Renders the formula attr inline-flow via KaTeX (lazy-imported on first
 * mount). Atom node, so PM treats the rendered output as a single
 * indivisible cursor unit — selection lands on the math, Backspace
 * deletes the whole node.
 *
 * ## Editing UX (feature parity with block descriptors)
 *
 * Clicking the rendered atom selects it and opens an inline editor
 * popover anchored to the math span. The popover reuses the same
 * `<PropPanel>` component the block components use (Callout, Math,
 * Mermaid, etc.) — driven by a synthetic `JsxComponentDescriptor` that
 * exposes the `formula` prop. PropPanel's `onChange` writes back to the
 * atom's flat attrs via `tr.setNodeMarkup` (mirroring the block path's
 * "target by position, not selection" pattern that survives focus moves
 * to the portal input).
 *
 * Slash-menu insertion auto-opens the popover via the shared
 * `setPendingAutoOpen` / `consumeAutoOpen` queue used by the
 * descriptor-driven slash entries — same auto-focus sequence as
 * `<Math>` slash-insert.
 *
 * Block math (`<MathView>` in `editor/components/Math.tsx`) and inline
 * math share the same KaTeX dependency — KaTeX JS is lazy and singleton-
 * cached after first import; KaTeX CSS is eager from `main.tsx` so
 * inline-flow rendering doesn't pay per-instance flash-of-unstyled-math.
 *
 * `displayMode: false` is the inline-flow rendering mode (KaTeX wraps
 * output in `<span class="katex">`). `throwOnError: false` keeps
 * malformed LaTeX from crashing the editor — KaTeX renders the error
 * inline with its own red-underline styling.
 */

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

/**
 * Synthetic descriptor used to drive the inline-math PropPanel. `mathInline`
 * is a PM atom (not a registered jsxComponent), but PropPanel is
 * descriptor-shaped — feeding it a 1-prop synthetic gets full UX parity
 * (auto-focus on `formula`, advanced section collapsed, persisted state
 * keyed by descriptor `name`) without lifting the registry's "all-block"
 * invariant or the jsxInline-render-less guarantee.
 *
 * Cast as `JsxComponentDescriptor` because PropPanel only reads
 * `descriptor.props` and `descriptor.name` — the React `Component` and
 * `reactNodePropNames` decoration fields are never accessed in this
 * editing context.
 */
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
      // Defense-in-depth, matching Math.tsx — blocks HTML-injecting LaTeX
      // commands like `\href{javascript:...}`, `\htmlClass`, `\htmlStyle`.
      // KaTeX's documented default is also `false`; explicit declaration
      // keeps the security posture consistent across both renderers and
      // guards against future config mutations.
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

/**
 * Visible empty-state placeholder for atoms with no formula yet (post-
 * slash-insert, pre-edit). Shows a pill with `f(x)` so the user can see
 * the atom landed and click it to open the editor — earlier iterations
 * used a zero-width space which was literally invisible. Italic + muted
 * styling distinguishes it from rendered math without competing for
 * attention.
 */
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

/**
 * Loading-state placeholder shown while KaTeX is lazy-importing or
 * before the dynamic import resolves. Renders the formula source
 * verbatim so a network-stalled lazy import still shows the user's
 * input rather than a blank gap.
 */
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

  // Sync popover open state to selection. Two paths in:
  //   1. Slash-insert auto-open — `consumeAutoOpen(pos)` drains the
  //      pending flag set by the slash-menu command on the first
  //      sole-selection→true transition.
  //   2. Click-to-edit — PM produces a NodeSelection on click; the
  //      atom's sole-selection state flips true; we open the popover.
  //
  // And one path out:
  //   3. Close on sole-selection→false — covers genuine navigation
  //      away (arrow keys moving cursor off the atom, programmatic
  //      `setTextSelection`, collaborative edits). Safe to reinstate
  //      because the PropPanel `onChange` re-applies NodeSelection on
  //      every keystroke (see `tr.setSelection(NodeSelection.create…)`
  //      below), so editing-driven selection rebuilds no longer flicker
  //      sole-selection to false. Outside-click and Escape are still
  //      handled by Radix's defaults; this branch covers selection-only
  //      changes that bypass those.
  //
  // Gate on `editor.state.selection instanceof NodeSelection` not the
  // raw `selected` prop. TipTap's `selected` is `true` for any inline
  // atom whose position falls inside the editor's current selection
  // range — including TextSelection (drag-select across the atom) and
  // AllSelection (Cmd+A). Without the NodeSelection gate, every math
  // atom in the doc opens its popover on every Cmd+A, hijacking focus
  // away from the user's text-selection drag. The popover is only
  // intended to open as the result of an explicit single-atom click or
  // the slash-insert programmatic NodeSelection — both of which are
  // NodeSelection events.
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
            // Surface the formula as a DOM attribute so the clipboard
            // walker's post-clone pass can replace this span with a
            // source-fallback `<span class="mdx-inline">$$formula$$</span>`
            // in the cross-app paste payload. The KaTeX-rendered span
            // tree underneath isn't portable across destinations (paste
            // as garbage in plain-text apps; broken styling in some rich
            // apps); the source-fallback shape is universally readable.
            // Sister site: `clipboard-walker.ts:applyNonPortableInlineAtomReplacement`.
            data-formula={formula}
            {...(id ? { id } : {})}
          >
            {formula ? (
              // Block math goes through `JsxComponentView`'s
              // `ComponentErrorBoundary`; inline math is its own NodeView
              // and bypasses that path. Without this boundary, a failed
              // KaTeX dynamic import (CDN 404, CSP violation, transient
              // network) would propagate up to `DocumentErrorBoundary` and
              // crash the entire document — block math would degrade
              // gracefully, inline math would not. `resetKeys={[formula]}`
              // lets a follow-up edit retry the lazy import without an
              // editor restart. Fallback shows the formula source so the
              // author still sees what they typed.
              <ErrorBoundary
                resetKeys={[formula]}
                onError={(error, info) => {
                  // Mirror JsxComponentView's `ComponentErrorBoundary`
                  // telemetry shape so block + inline math failures share
                  // one log search + one counter, instead of inline math
                  // failing silently while block math is fully observable.
                  const err = error instanceof Error ? error : new Error(String(error));
                  console.warn(
                    JSON.stringify({
                      event: 'jsx-render-failure',
                      component: 'mathInline',
                      // Match `JsxComponentView.ComponentErrorBoundary`'s
                      // log shape exactly so a single log query (or alert
                      // rule) covers both block + inline math failures.
                      // mathInline isn't a JSX component, so component +
                      // rawComponentName collapse to the same value.
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
          // Keep the content inside the editor's React tree so PM
          // selection events from inside the input don't bubble back into
          // the editor as a deselect.
          onOpenAutoFocus={(e) => {
            // Let PropPanel's `autoFocus` propagate to the formula input
            // — don't steal focus to the popover container.
            e.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            // Mirror JsxComponentView's leaf-descriptor pattern: hand
            // focus back to the editor view on dismiss so subsequent
            // keystrokes don't disappear into the popover's restore
            // target. `e.preventDefault()` blocks Radix's default focus
            // restore (which would target the trigger span and leave PM
            // unfocused on Escape / outside-click).
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
              // Mirror JsxComponentView's "target by position, not
              // selection" pattern. The popover input has DOM focus, so
              // PM's selection has moved off the atom; selection-based
              // `updateAttributes` would no-op. `setNodeMarkup(pos, …)`
              // targets the atom regardless of where selection is now.
              //
              // After setNodeMarkup, explicitly re-apply the NodeSelection
              // on the freshly-marked atom. Without this, PM rebuilds the
              // selection in the new doc and may default to a TextSelection
              // — flipping our `selected` prop to false on every keystroke.
              // The popover-open effect would then dismiss the popover
              // after the first character, breaking the editor.
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
