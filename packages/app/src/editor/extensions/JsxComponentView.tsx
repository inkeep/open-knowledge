/**
 * JsxComponentView — overlay-based descriptor-dispatch NodeView.
 *
 * **Design principle:** Zero permanent chrome in document flow. Components
 * render exactly like production. All editor affordances are hover-revealed
 * overlays at top-right (move up/down, delete, settings gear) plus an
 * "add child" pill at the bottom edge of container descriptors.
 *
 * A persistent component-name chip was proposed (SPEC §7a.BS01) but dropped
 * in commit `252bce2b` — the "zero permanent chrome" principle won. The
 * descriptor identity is surfaced through: (a) the rendered fumadocs
 * component's own visual style (every built-in has a distinct shape), (b)
 * the `SelectionAnnouncer` aria-live region announcing the block name on
 * selection change, (c) the `aria-label` group summary announced to AT on
 * focus.
 *
 * Three render branches:
 *   Branch 1 (Wildcard `'*'`): does NOT render a persistent chip — the
 *     NodeView immediately schedules a rAF-auto-convert into an editable
 *     `rawMdxFallback` (nested CodeMirror source editor, Precedent #28
 *     direct PM dispatch + #30 all user content visible). A transient
 *     "Unknown component: X — source editable below"
 *     placeholder flashes for at most one frame while the conversion
 *     dispatch lands.
 *   Branch 2 (Registered healthy): live React component + hover chrome
 *     (move/delete/gear→Popover PropPanel, add-child pill) + NodeViewContent.
 *   Branch 3 (Invalid-state / render error): same rAF-auto-convert into
 *     `rawMdxFallback` — the error boundary catches, logs a structured
 *     `jsx-render-failure` event, and the NodeView replaces itself with
 *     the source editor. Identical UX shape to Branch 1 by design
 *     (Precedent #28: parse failures AND render failures surface the same
 *     embedded source editor).
 *
 * Per Precedent #30: NodeViewContent is ALWAYS rendered, never display:none.
 */

import {
  incrementJsxAutoConvertFailed,
  incrementJsxAutoConvertSucceeded,
  incrementJsxKeyboardDeleteFailed,
  incrementJsxMoveFailed,
  incrementJsxPopoverCloseRestoreFailed,
  incrementJsxRenderFailure,
  incrementJsxStuckCopyFailed,
  incrementJsxStuckDeleteFailed,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import type { NodeViewProps } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import { ArrowDown, ArrowUp, ExternalLink, Pencil, Settings2, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
import { Button } from '@/components/ui/button';
import { hashFromDocName } from '@/lib/doc-hash';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from '../../components/ui/popover.tsx';
import { OPT_OUT_ATTR } from '../clipboard/index.ts';
import { CodePreviewEditModal } from '../components/CodePreviewEditModal';
import { DescriptorPlaceholder } from '../components/DescriptorPlaceholder.tsx';
import { JsxComponentHostProvider } from '../components/jsx-host-context.tsx';
import { PropPanel } from '../components/PropPanel.tsx';
import { getEditorDocName } from '../extensions/doc-context.ts';
import { normalizeDocRelativeMediaRenderProps } from '../extensions/media-render-props.ts';
import { getWrapperBridgeId } from '../extensions/selection-state-plugin.ts';
import { useBlockSelection } from '../hooks/use-block-selection.ts';
import { markUserTyping } from '../observers.ts';
import { getDescriptor } from '../registry/index.ts';
import {
  resolveDescriptorPlaceholder,
  shouldRenderPlaceholder,
} from '../registry/resolve-descriptor-placeholder.ts';
import {
  consumeAutoOpen,
  createChildNode,
  focusInsertedComponent,
} from '../slash-command/component-items.tsx';
import { ALIGNABLE_DESCRIPTOR_NAMES } from '../utils/alignable-descriptors.ts';
import { formatContainerAriaLabel } from '../utils/editor-strings.ts';
import { reconstructSource } from '../utils/reconstruct-source.ts';
import { sanitizeComponentProps } from '../utils/sanitize-url.ts';


interface ComponentErrorBoundaryProps {
  children: ReactNode;
  /** Flips when we want to force a retry (prop change, node-name change,
   *  post-auto-convert reset). Threaded into `resetKeys`. */
  resetKey: string;
  /** Escalates errored state out to the NodeView so the chrome can react
   *  (show "failed to render" hint, offer copy-source / delete affordances
   *  via the stuck-state UI). */
  onError: (error: Error) => void;
  /** Registered descriptor name ('Callout', 'img', 'video', 'audio',
   *  'Accordion', or 'wildcard'). Low-cardinality label — safe for
   *  telemetry aggregation. */
  descriptorName: string;
  /** Raw user-authored component name; may be arbitrary MDX text. Kept in
   *  a separate field (not a label) so telemetry aggregation does not
   *  explode cardinality across tenants. Capped at 200 chars inside the
   *  onError handler before emission (MDX permits arbitrarily-long
   *  dotted-namespace tags that would otherwise produce multi-KB log
   *  entries per error). */
  rawComponentName: string;
}

function ComponentErrorFallback({ children }: FallbackProps & { children?: ReactNode }) {
  return <div className="jsx-component-error-fallback">{children}</div>;
}

function ComponentErrorBoundary(props: ComponentErrorBoundaryProps) {
  const { children, resetKey, onError, descriptorName, rawComponentName } = props;
  return (
    <ErrorBoundary
      resetKeys={[resetKey]}
      onError={(error, info) => {
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
        onError(err);
      }}
      fallbackRender={(fbProps) => (
        <ComponentErrorFallback {...fbProps}>{children}</ComponentErrorFallback>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}


export function stableHash(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableHash).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableHash(v)}`).join(',')}}`;
}

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

interface ElementJsxAttrs extends Record<string, unknown> {
  kind: 'element';
  props: Record<string, unknown>;
}

export function getElementJsxAttrs(attrs: Record<string, unknown>): ElementJsxAttrs | null {
  return attrs.kind === 'element' ? (attrs as ElementJsxAttrs) : null;
}


const MAX_AUTO_CONVERT_RETRIES = 3;

export function JsxComponentView({ node, editor, extension, getPos, selected }: NodeViewProps) {
  const { t } = useLingui();
  const descriptor = getDescriptor(node.attrs.componentName as string);
  const [renderError, setRenderError] = useState<Error | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const wasSelected = useRef(false);

  const pos = typeof getPos === 'function' ? getPos() : undefined;

  let isChildOfComponent = false;
  let siblingIndex = 0;
  let siblingCount = 1;
  try {
    if (pos !== undefined) {
      const $pos = editor.state.doc.resolve(pos);
      if ($pos.depth > 0 && $pos.parent.type.name === 'jsxComponent') {
        isChildOfComponent = true;
        siblingIndex = $pos.index($pos.depth);
        siblingCount = $pos.parent.childCount;
      }
    }
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
  }
  const canMoveUp = isChildOfComponent && siblingIndex > 0;
  const canMoveDown = isChildOfComponent && siblingIndex < siblingCount - 1;

  const blockSelection = useBlockSelection(editor);
  const wrapperBridgeId = typeof pos === 'number' ? getWrapperBridgeId(editor.state, pos) : null;
  const isRangeEncompassed =
    wrapperBridgeId !== null &&
    (blockSelection?.rangeEncompassedBlockIds.has(wrapperBridgeId) ?? false);
  const chainLeafBridgeId = blockSelection?.ancestorChain.at(-1)?.bridgeId ?? null;
  const isInnermostInChain = wrapperBridgeId !== null && chainLeafBridgeId === wrapperBridgeId;
  const isInnermostSelected = selected && !isRangeEncompassed && isInnermostInChain;
  const hasChildSelected =
    wrapperBridgeId !== null &&
    !isInnermostInChain &&
    (blockSelection?.ancestorChain.some((entry) => entry.bridgeId === wrapperBridgeId) ?? false);
  const selectionOrigin =
    isInnermostSelected && blockSelection ? blockSelection.selectionOrigin : undefined;
  const isDraggingSelf = isInnermostSelected && (blockSelection?.isDragging ?? false);

  const hasEditableProps = descriptor.props.some(
    (p) => !('hidden' in p && p.hidden) && p.type !== 'reactnode',
  );

  const currentProps = (node.attrs.props as Record<string, unknown>) ?? {};
  const needsConfig =
    hasEditableProps &&
    descriptor.props.some((p) => {
      if (p.type !== 'string') return false;
      if (!p.required) return false;
      if ('hidden' in p && p.hidden) return false;
      return !Object.hasOwn(currentProps, p.name);
    });

  const showPlaceholder = shouldRenderPlaceholder(descriptor, currentProps);
  const resolvedPlaceholder = showPlaceholder ? resolveDescriptorPlaceholder(descriptor) : null;

  const isSelfClosingLeaf = !descriptor.hasChildren || !!descriptor.isSelfClosing;

  const isAlignable = ALIGNABLE_DESCRIPTOR_NAMES.has(descriptor.name);

  const editableSource: { propName: string; language: 'mermaid' | 'latex' } | null =
    descriptor.name === 'MermaidFence'
      ? { propName: 'chart', language: 'mermaid' }
      : descriptor.name === 'Math' ||
          descriptor.name === 'DollarMath' ||
          descriptor.name === 'MathFence'
        ? { propName: 'formula', language: 'latex' }
        : null;
  const [editModalOpen, setEditModalOpen] = useState(false);

  useEffect(() => {
    if (selected && !wasSelected.current && hasEditableProps && consumeAutoOpen(pos)) {
      setPopoverOpen(true);
    }
    wasSelected.current = selected;
  }, [selected, hasEditableProps, pos]);

  const primitiveProps = extractPrimitiveProps(node.attrs, descriptor.reactNodePropNames);
  const translatedProps =
    descriptor.surface === 'compat' ? descriptor.translateProps(primitiveProps) : primitiveProps;
  const configuredDocName = (extension.options as { docName?: unknown }).docName;
  const sourceDocName =
    typeof configuredDocName === 'string' && configuredDocName
      ? configuredDocName
      : getEditorDocName(editor);
  const renderProps = normalizeDocRelativeMediaRenderProps(
    descriptor.name,
    translatedProps,
    sourceDocName,
  );
  const resetKey = `${descriptor.name}::${stableHash(primitiveProps)}`;

  const insertChildAt = () => {
    const p = typeof getPos === 'function' ? (getPos() ?? 0) : 0;
    return p + 1 + node.content.size;
  };

  const needsConversion = descriptor.name === '*' || renderError !== null;
  const convertedRef = useRef(false);
  const retryCountRef = useRef(0);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!needsConversion || convertedRef.current || stuck) return;

    const p = typeof getPos === 'function' ? getPos() : undefined;
    if (typeof p !== 'number') return;

    const source = reconstructSource(node);
    const reason =
      descriptor.name === '*'
        ? `Unregistered component: ${node.attrs.componentName as string}`
        : `Render error in <${descriptor.displayName ?? descriptor.name}>: ${renderError?.message ?? 'unknown'}`;

    const fallbackNode = node.type.schema.nodes.rawMdxFallback.create(
      { reason },
      node.type.schema.text(source),
    );

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const dispatchOnce = () => {
      if (cancelled) return;
      try {
        editor.view.dispatch(editor.state.tr.replaceWith(p, p + node.nodeSize, fallbackNode));
        convertedRef.current = true;
        const clampedComponent = descriptor.name === '*' ? 'wildcard' : descriptor.name;
        incrementJsxAutoConvertSucceeded(clampedComponent);
      } catch (err) {
        const clampedComponent = descriptor.name === '*' ? 'wildcard' : descriptor.name;
        console.warn(
          JSON.stringify({
            event: 'jsx-component-auto-convert-failed',
            component: clampedComponent,
            rawComponentName: String(node.attrs.componentName ?? '').slice(0, 200),
            reason: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
            retry: retryCountRef.current,
          }),
        );
        incrementJsxAutoConvertFailed(clampedComponent);

        retryCountRef.current += 1;
        if (retryCountRef.current < MAX_AUTO_CONVERT_RETRIES) {
          const delay = 50 * (2 ** retryCountRef.current - 1);
          timeoutId = setTimeout(() => {
            if (cancelled) return;
            dispatchOnce();
          }, delay);
        } else {
          if (!cancelled) setStuck(true);
        }
      }
    };

    const frameId = requestAnimationFrame(dispatchOnce);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [needsConversion, node, editor, getPos, descriptor, renderError, stuck]);

  if (stuck) {
    const componentName = node.attrs.componentName as string;
    const descriptorLabel = descriptor.displayName ?? descriptor.name;
    const label =
      descriptor.name === '*'
        ? t`<${componentName}> isn't a known component. Copy the source to use it elsewhere, or delete the block.`
        : t`<${descriptorLabel}> failed to render (likely a bad prop). Copy the source to see what went wrong, or delete the block.`;
    const copySource = () => {
      try {
        const src = reconstructSource(node);
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(src);
        }
      } catch (err) {
        incrementJsxStuckCopyFailed(descriptor.name);
        console.warn(
          JSON.stringify({
            event: 'jsx-component-stuck-copy-failed',
            component: descriptor.name,
            rawComponentName: String(node.attrs.componentName ?? '').slice(0, 200),
            reason: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
          }),
        );
      }
    };
    const deleteNode = () => {
      const p = typeof getPos === 'function' ? getPos() : undefined;
      if (typeof p !== 'number') return;
      try {
        editor.chain().focus().setNodeSelection(p).deleteSelection().run();
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        incrementJsxStuckDeleteFailed(descriptor.name);
        console.warn(
          JSON.stringify({
            event: 'jsx-component-stuck-delete-failed',
            component: descriptor.name,
            rawComponentName: String(node.attrs.componentName ?? '').slice(0, 200),
            reason: err.message.slice(0, 500),
          }),
        );
      }
    };
    return (
      <NodeViewWrapper className="jsx-component-wrapper my-2">
        <div
          className="text-xs font-mono text-muted-foreground px-2 py-2 border border-destructive/40 rounded bg-destructive/5 flex items-center gap-2"
          contentEditable={false}
          {...{ [OPT_OUT_ATTR]: 'true' }}
        >
          <span className="flex-1">{label}</span>
          <button
            type="button"
            className="text-xs underline hover:no-underline"
            onClick={copySource}
          >
            {t`Copy source`}
          </button>
          <button
            type="button"
            className="text-xs underline hover:no-underline"
            onClick={deleteNode}
          >
            {t`Delete`}
          </button>
        </div>
        <NodeViewContent className="component-children" />
      </NodeViewWrapper>
    );
  }

  if (needsConversion) {
    const componentName = node.attrs.componentName as string;
    const descriptorLabel = descriptor.displayName ?? descriptor.name;
    const label =
      descriptor.name === '*'
        ? t`Unknown component: ${componentName} — source editable below`
        : t`${descriptorLabel} — render error, source editable below`;
    return (
      <NodeViewWrapper className="jsx-component-wrapper my-2">
        <div className="text-xs font-mono text-muted-foreground px-2 py-1" contentEditable={false}>
          {label}
        </div>
        <NodeViewContent className="component-children" />
      </NodeViewWrapper>
    );
  }

  const Comp = descriptor.Component;
  const deleteDescriptorLabel = descriptor.displayName ?? descriptor.name;
  const settingsDescriptorLabel = descriptor.displayName ?? descriptor.name;
  const propPanelDescriptorLabel = descriptor.displayName ?? descriptor.name;

  const handleBodyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (showPlaceholder) return;
    if (!isSelfClosingLeaf) return;
    const target = e.target as HTMLElement;
    if (!e.currentTarget.contains(target)) return;
    if (target.closest('.jsx-component-chrome')) return;
    if (target.closest('.jsx-add-child-pill, .jsx-empty-child-placeholder')) return;
    if (target.closest('a[href]')) return;
    if (typeof pos !== 'number') return;
    const curNode = editor.state.doc.nodeAt(pos);
    if (!curNode) return;
    const nodeEnd = pos + curNode.nodeSize;
    const selFrom = editor.state.selection.from;
    if (selFrom < pos || selFrom >= nodeEnd) return;
    editor.chain().focus().setNodeSelection(pos).run();
  };

  const openPanel = () => {
    const p = typeof getPos === 'function' ? getPos() : undefined;
    if (typeof p !== 'number') return;
    editor.chain().focus().setNodeSelection(p).run();
    setPopoverOpen(true);
  };

  const componentLabel = descriptor.displayName ?? descriptor.name;
  const isGroupContainer = Boolean(descriptor.emptyChildName);
  const groupAriaLabel = isGroupContainer
    ? formatContainerAriaLabel(componentLabel, descriptor.emptyChildName, node.childCount)
    : undefined;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;

    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (!isInnermostSelected) return;
      if (!e.currentTarget.contains(target)) return;
      if (target.matches('input, textarea')) return;
      const p = typeof getPos === 'function' ? getPos() : undefined;
      if (typeof p !== 'number') return;
      e.preventDefault();
      try {
        const dispatched = editor.chain().focus().setNodeSelection(p).deleteSelection().run();
        if (!dispatched) {
          incrementJsxKeyboardDeleteFailed(descriptor.name);
          console.warn(
            JSON.stringify({
              event: 'jsx-component-keyboard-delete-failed',
              component: descriptor.name,
              rawComponentName: String(node.attrs.componentName ?? '').slice(0, 200),
              reason: 'chain-dispatch-returned-false',
            }),
          );
        }
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        incrementJsxKeyboardDeleteFailed(descriptor.name);
        console.warn(
          JSON.stringify({
            event: 'jsx-component-keyboard-delete-failed',
            component: descriptor.name,
            rawComponentName: String(node.attrs.componentName ?? '').slice(0, 200),
            reason: err.message.slice(0, 500),
          }),
        );
      }
      return;
    }

    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (!selected) return;
    if (!hasEditableProps) return;
    if (target.closest('.jsx-component-chrome')) return;
    if (target.closest('input, textarea, select, button')) return;
    e.preventDefault();
    setPopoverOpen(true);
  };

  const handleOpenChange = (open: boolean) => {
    setPopoverOpen(open);
    if (open) return;
    requestAnimationFrame(() => {
      const p = typeof getPos === 'function' ? getPos() : undefined;
      if (typeof p !== 'number') return;
      try {
        const curNode = editor.state.doc.nodeAt(p);
        if (!curNode) return;
        const nodeEnd = p + curNode.nodeSize;
        const selFrom = editor.state.selection.from;
        if (selFrom < p || selFrom >= nodeEnd) return;
        if (isSelfClosingLeaf) {
          const $end = editor.state.doc.resolve(Math.min(nodeEnd, editor.state.doc.content.size));
          const nextSel = TextSelection.near($end, 1);
          editor.view.dispatch(editor.state.tr.setSelection(nextSel).scrollIntoView());
        } else {
          editor.chain().setNodeSelection(p).run();
        }
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        incrementJsxPopoverCloseRestoreFailed(descriptor.name);
        console.warn(
          JSON.stringify({
            event: 'jsx-component-popover-close-restore-failed',
            component: descriptor.name,
            rawComponentName: String(node.attrs.componentName ?? '').slice(0, 200),
            reason: err.message.slice(0, 500),
          }),
        );
      }
    });
  };

  return (
    <Popover open={popoverOpen} onOpenChange={handleOpenChange}>
      <NodeViewWrapper
        className="jsx-component-wrapper my-2"
        data-jsx-component=""
        data-component-type={descriptor.name.toLowerCase()}
        data-align={(() => {
          const rawAlign = currentProps.align;
          if (rawAlign === 'left' || rawAlign === 'right' || rawAlign === 'center') {
            return rawAlign;
          }
          if (isAlignable) {
            return 'center';
          }
          return undefined;
        })()}
        data-selected={isInnermostSelected ? 'true' : undefined}
        data-has-child-selected={hasChildSelected ? 'true' : undefined}
        data-range-selected={isRangeEncompassed ? 'true' : undefined}
        data-selection-origin={selectionOrigin}
        data-dragging={isDraggingSelf ? 'true' : undefined}
        data-needs-config={needsConfig ? 'true' : undefined}
        role={isGroupContainer ? 'group' : undefined}
        aria-label={groupAriaLabel}
        tabIndex={isInnermostSelected ? 0 : -1}
        {...(!isChildOfComponent
          ? { 'data-drag-handle': '', draggable: 'true' }
          : { draggable: 'false', onDragStart: (e: React.DragEvent) => e.preventDefault() })}
        data-component-name={descriptor.name}
        onClick={handleBodyClick}
        onKeyDown={handleKeyDown}
      >
        {/* Hover-revealed action icons: [↑] [↓] [⚙️] [🗑] — rendered for every
          configured component AND placeholder mode. Placeholder mode keeps the
          chrome (gear, move arrows, delete) visible because the same data-needs-config
          gear-hint UX should apply to fresh slash-inserted blocks the same way it
          does to any other unconfigured-prop block. The placeholder pill provides
          an additional click-to-open affordance via PopoverAnchor; the gear remains
          the canonical PopoverTrigger. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation required inside PM NodeView */}
        <div
          className="jsx-component-chrome"
          contentEditable={false}
          onMouseDown={(e) => e.stopPropagation()}
          {...{ [OPT_OUT_ATTR]: 'true' }}
        >
          {/* Alignment intentionally absent here — the bubble menu's
            `ImageAlignButtons` is the single alignment surface for every
            descriptor in `ALIGNABLE_DESCRIPTOR_NAMES` (`img` /
            `CommonMarkImage` / `Embed` / `video`). NodeSelection fires
            on the image click and the floating bubble bar lands centered
            above the block, so the old chrome-bar trio + PropPanel
            `Align` Select were redundant duplicates. CommonMarkImage's
            descriptor-upgrade path on first non-default alignment lives
            in `ImageAlignButtons` itself; removing it here doesn't lose
            the conversion. */}

          {/* Open in new tab — `Embed` only. Lets the reader hop to the
            embedded URL when they want the full browser surface.
            `primitiveProps.src` is the sanitize-url.ts-filtered value
            (raw `currentProps.src` would bypass the URL_PROP_NAMES
            scheme allowlist on `<a href>`); we also re-test for
            http(s):// here so the anchor refuses to render for
            data:/blob:/file: schemes even if the sanitizer changes its
            default allowlist in the future. Mirrors the iframe-render
            gate inside `Embed.tsx`. */}
          {descriptor.name === 'Embed' &&
            typeof primitiveProps.src === 'string' &&
            /^https?:\/\//i.test(primitiveProps.src) && (
              <a
                href={primitiveProps.src as string}
                target="_blank"
                rel="noopener noreferrer"
                className="jsx-chrome-btn"
                aria-label={t`Open embedded URL in new tab`}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            )}

          {/* Mirror — "Open source" deep link to the source doc. Mirrors the
            Embed `<a>` pattern but builds a same-origin hash href via
            `hashFromDocName(src, anchor)` instead of an external URL. The
            DocumentProvider's hashchange listener picks up the navigation. */}
          {descriptor.name === 'Mirror' &&
            typeof primitiveProps.src === 'string' &&
            primitiveProps.src.length > 0 &&
            (() => {
              const mirrorSrc = primitiveProps.src as string;
              return (
                <a
                  href={hashFromDocName(
                    mirrorSrc,
                    typeof primitiveProps.anchor === 'string' && primitiveProps.anchor.length > 0
                      ? primitiveProps.anchor
                      : null,
                  )}
                  className="jsx-chrome-btn"
                  aria-label={t`Open source doc: ${mirrorSrc}`}
                  title={t`Open source: ${mirrorSrc}`}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              );
            })()}

          {/* Move up/down — only for children inside containers; hidden at boundaries.
            `doc.resolve(pos)` / `doc.slice(...)` can throw `RangeError` when the
            node's position is out-of-bounds because a concurrent remote peer edit
            (or an in-flight Observer B re-parse) shifted it between render and
            click. We classify that as a user-observable move failure (logged +
            counter-bumped) rather than letting it re-throw into the
            `ComponentErrorBoundary`, which would mis-attribute the click-time
            race as a `jsx-render-failure` and auto-convert this component to
            rawMdxFallback. Pattern mirrors the `isChildOfComponent` probe at L213. */}
          {canMoveUp && (
            <button
              type="button"
              className="jsx-chrome-btn"
              aria-label={t`Move up`}
              onClick={() => {
                try {
                  if (typeof pos !== 'number') return;
                  const $p = editor.state.doc.resolve(pos);
                  const idx = $p.index($p.depth);
                  if (idx === 0) return;
                  const parent = $p.node($p.depth);
                  const prev = parent.child(idx - 1);
                  const from = pos - prev.nodeSize;
                  const to = pos + node.nodeSize;
                  const tr = editor.state.tr;
                  const cur = editor.state.doc.slice(pos, pos + node.nodeSize);
                  const pre = editor.state.doc.slice(from, pos);
                  tr.replaceWith(from, to, cur.content.append(pre.content));
                  editor.view.dispatch(tr.scrollIntoView());
                } catch (err) {
                  if (!(err instanceof RangeError)) throw err;
                  incrementJsxMoveFailed('up');
                  console.warn(
                    JSON.stringify({
                      event: 'jsx-component-move-failed',
                      direction: 'up',
                      component: descriptor.name,
                      rawComponentName: String(node.attrs.componentName ?? '').slice(0, 200),
                      reason: err.message.slice(0, 500),
                    }),
                  );
                }
              }}
            >
              <ArrowUp size={12} aria-hidden="true" />
            </button>
          )}

          {canMoveDown && (
            <button
              type="button"
              className="jsx-chrome-btn"
              aria-label={t`Move down`}
              onClick={() => {
                try {
                  if (typeof pos !== 'number') return;
                  const $p = editor.state.doc.resolve(pos);
                  const idx = $p.index($p.depth);
                  const parent = $p.node($p.depth);
                  if (idx >= parent.childCount - 1) return;
                  const next = parent.child(idx + 1);
                  const from = pos;
                  const to = pos + node.nodeSize + next.nodeSize;
                  const tr = editor.state.tr;
                  const cur = editor.state.doc.slice(pos, pos + node.nodeSize);
                  const nxt = editor.state.doc.slice(pos + node.nodeSize, to);
                  tr.replaceWith(from, to, nxt.content.append(cur.content));
                  editor.view.dispatch(tr.scrollIntoView());
                } catch (err) {
                  if (!(err instanceof RangeError)) throw err;
                  incrementJsxMoveFailed('down');
                  console.warn(
                    JSON.stringify({
                      event: 'jsx-component-move-failed',
                      direction: 'down',
                      component: descriptor.name,
                      rawComponentName: String(node.attrs.componentName ?? '').slice(0, 200),
                      reason: err.message.slice(0, 500),
                    }),
                  );
                }
              }}
            >
              <ArrowDown size={12} aria-hidden="true" />
            </button>
          )}

          {/* Edit source — Mermaid + Math (PRD-6821). Opens the
              `CodePreviewEditModal` seeded with the source-bearing prop
              (`chart` / `formula`). Modal mount lives at the bottom of
              this component beside the PopoverContent (Dialog uses its
              own Portal). */}
          {editableSource && typeof pos === 'number' ? (
            <button
              type="button"
              className="jsx-chrome-btn"
              aria-label={t`Edit ${descriptor.displayName ?? descriptor.name} source`}
              data-testid="jsx-component-edit-btn"
              onClick={() => setEditModalOpen(true)}
            >
              <Pencil size={12} aria-hidden="true" />
            </button>
          ) : null}

          {/* Delete — positioned between move arrows and settings so the
            settings gear stays anchored at the right edge of the chrome bar
            (consistent "destructive action mid, config action far-right"
            pattern regardless of whether the component has editable props). */}
          <button
            type="button"
            className="jsx-chrome-btn jsx-chrome-btn--delete"
            aria-label={t`Delete ${deleteDescriptorLabel}`}
            onClick={() => {
              if (typeof pos !== 'number') return;
              try {
                const dispatched = editor
                  .chain()
                  .focus()
                  .setNodeSelection(pos)
                  .deleteSelection()
                  .run();
                if (!dispatched) {
                  incrementJsxKeyboardDeleteFailed(descriptor.name);
                  console.warn(
                    JSON.stringify({
                      event: 'jsx-component-chrome-delete-failed',
                      component: descriptor.name,
                      rawComponentName: String(node.attrs.componentName ?? '').slice(0, 200),
                      reason: 'chain-dispatch-returned-false',
                    }),
                  );
                }
              } catch (err) {
                if (!(err instanceof RangeError)) throw err;
                incrementJsxKeyboardDeleteFailed(descriptor.name);
                console.warn(
                  JSON.stringify({
                    event: 'jsx-component-chrome-delete-failed',
                    component: descriptor.name,
                    rawComponentName: String(node.attrs.componentName ?? '').slice(0, 200),
                    reason: err.message.slice(0, 500),
                  }),
                );
              }
            }}
          >
            <Trash2 size={12} aria-hidden="true" />
          </button>

          {/* Settings — opens the controlled PropPanel popover hoisted above
            NodeViewWrapper. `<PopoverTrigger asChild>` is the canonical click-to-
            open path. In placeholder mode the popover is positioned via the
            `<PopoverAnchor>` wrapping the placeholder pill (Anchor takes precedence
            over Trigger for placement); both paths flip the same popoverOpen state. */}
          {hasEditableProps && (
            <PopoverTrigger asChild>
              <button
                type="button"
                className="jsx-chrome-btn"
                data-jsx-gear=""
                aria-label={t`${settingsDescriptorLabel} properties`}
              >
                <Settings2 size={12} aria-hidden="true" />
              </button>
            </PopoverTrigger>
          )}
        </div>

        {/* Live React component — renders exactly like production.
          Self-closing / no-children components get contentEditable={false} so
          native behaviors work (links navigate, etc.). ALL other components
          stay contentEditable (PM manages the content hole).
          NOTE: typed-children containers do NOT use contentEditable={false} —
          PM's hasFocus() walks the ancestor chain and returns false if ANY
          ancestor has contentEditable='false', which breaks selection tracking,
          BubbleMenu, and all PM features for descendants. Instead, a
          filterTransaction plugin (TypedChildrenGuard) rejects unwanted
          insertions at the PM transaction level. */}
        {/*
        Reset mechanism: rely on `componentDidUpdate`'s resetKey-comparison
        branch (L107) to clear `errored` state when primitive props change.
        Setting `key={resetKey}` here would force a full remount of the
        live fumadocs subtree on every prop edit — losing component-local
        state (ImageZoom's zoom level, in-flight Radix animations) and
        making `componentDidUpdate` unreachable (key-remount always
        produces a fresh instance where prevProps === props). Keeping
        only the prop-comparison reset preserves component state on
        healthy renders and still clears the error path when the user
        fixes a prop that was causing the render to throw.
      */}
        {showPlaceholder && resolvedPlaceholder ? (
          <PopoverAnchor asChild>
            <DescriptorPlaceholder
              label={resolvedPlaceholder.label}
              Icon={resolvedPlaceholder.Icon}
              onClick={openPanel}
              selected={isInnermostSelected}
            />
          </PopoverAnchor>
        ) : (
          <ComponentErrorBoundary
            resetKey={resetKey}
            onError={setRenderError}
            descriptorName={descriptor.name === '*' ? 'wildcard' : descriptor.name}
            rawComponentName={(node.attrs.componentName as string) ?? ''}
          >
            <JsxComponentHostProvider
              value={
                typeof getPos === 'function'
                  ? {
                      editor,
                      getPos: () => {
                        const p = getPos();
                        return typeof p === 'number' ? p : undefined;
                      },
                      addChild: descriptor.emptyChildName
                        ? () => {
                            const childName = descriptor.emptyChildName as string;
                            const childJSON = createChildNode(childName);
                            const insertPos = insertChildAt();
                            editor.chain().focus().insertContentAt(insertPos, childJSON).run();
                            focusInsertedComponent(editor, insertPos, getDescriptor(childName));
                          }
                        : null,
                    }
                  : null
              }
            >
              <Comp {...renderProps}>
                <NodeViewContent
                  className={`component-children ${
                    !descriptor.hasChildren && node.childCount === 0 ? 'min-h-0 m-0 p-0' : ''
                  }`}
                  {...(!descriptor.hasChildren || descriptor.isSelfClosing
                    ? { contentEditable: false }
                    : {})}
                />
              </Comp>
            </JsxComponentHostProvider>
          </ComponentErrorBoundary>
        )}

        {/*
         * "Add child" pill — absolute overlay at bottom edge (containers only).
         *
         * Tabs is the lone exception: when it has ≥1 child, the strip
         * itself owns the inline "Add tab" affordance via `host.addChild()`
         * (see Tabs.tsx), so the floating-bottom pill would be redundant.
         * Tabs' empty-state placeholder (childCount === 0) still renders
         * here — the strip has nothing to anchor an inline button to yet,
         * and the full-width placeholder is the clearer empty-state CTA.
         */}
        {descriptor.emptyChildName &&
          !(descriptor.name === 'Tabs' && node.childCount > 0) &&
          (() => {
            const addChildName = descriptor.emptyChildName;
            return (
              <button
                type="button"
                contentEditable={false}
                className={
                  node.childCount === 0 ? 'jsx-empty-child-placeholder' : 'jsx-add-child-pill'
                }
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => {
                  const childName = descriptor.emptyChildName as string;
                  const childJSON = createChildNode(childName);
                  const insertPos = insertChildAt();
                  editor.chain().focus().insertContentAt(insertPos, childJSON).run();
                  focusInsertedComponent(editor, insertPos, getDescriptor(childName));
                }}
                {...{ [OPT_OUT_ATTR]: 'true' }}
              >
                <span>
                  <Trans>+ Add {addChildName}</Trans>
                </span>
              </button>
            );
          })()}
      </NodeViewWrapper>
      {editableSource && typeof pos === 'number' ? (
        <CodePreviewEditModal
          open={editModalOpen}
          onOpenChange={setEditModalOpen}
          initialValue={
            typeof currentProps[editableSource.propName] === 'string'
              ? (currentProps[editableSource.propName] as string)
              : ''
          }
          language={editableSource.language}
          title={t`Edit ${descriptor.displayName ?? descriptor.name} source`}
          renderPreview={(value) => {
            const Component = descriptor.Component;
            const previewProps = { ...renderProps, [editableSource.propName]: value };
            return (
              <div className="flex h-full w-full items-center justify-center p-4">
                <Component {...previewProps} />
              </div>
            );
          }}
          onSave={(value) => {
            const livePos = typeof getPos === 'function' ? getPos() : undefined;
            if (typeof livePos !== 'number') return;
            const curNode = editor.state.doc.nodeAt(livePos);
            if (!curNode) return;
            const elementAttrs = getElementJsxAttrs(curNode.attrs);
            if (!elementAttrs) return;
            try {
              const currentNodeProps = elementAttrs.props;
              const nextProps = {
                ...currentNodeProps,
                [editableSource.propName]: value,
              };
              const nextAttrs = {
                ...elementAttrs,
                props: nextProps,
                sourceDirty: true,
              };
              editor.view.dispatch(editor.state.tr.setNodeMarkup(livePos, null, nextAttrs));
              markUserTyping();
            } catch (err) {
              if (!(err instanceof RangeError)) throw err;
              console.warn('[JsxComponentView] edit-save failed — position race', err);
            }
          }}
        />
      ) : null}
      {/* z-[60] overrides the shadcn popover base (z-50) so the PropPanel
          reliably sits above other z-50 surfaces (wiki-link Dialog overlays,
          sonner toasts, internal-link Dialogs). The chrome bar in globals.css
          also uses z-50; a PopoverContent at the same level is ordered by
          render-order, which isn't a stable guarantee — explicit bump makes
          it deterministic. */}
      {hasEditableProps && (
        <PopoverContent
          side={showPlaceholder ? 'bottom' : 'right'}
          align={showPlaceholder ? 'center' : 'start'}
          sideOffset={showPlaceholder ? -4 : 8}
          className="w-64 p-3 z-[60] overflow-y-auto subtle-scrollbar max-h-[var(--radix-popper-available-height)] overscroll-contain"
          onCloseAutoFocus={
            isSelfClosingLeaf
              ? (e) => {
                  e.preventDefault();
                  editor.view.focus();
                }
              : undefined
          }
        >
          <div className="text-xs font-medium text-muted-foreground mb-2">
            <Trans>{propPanelDescriptorLabel} Properties</Trans>
          </div>
          <PropPanel
            descriptor={descriptor}
            values={primitiveProps}
            onDismiss={() => setPopoverOpen(false)}
            onChange={(propName, value) => {
              const p = typeof getPos === 'function' ? getPos() : undefined;
              if (typeof p !== 'number') return;
              const curNode = editor.state.doc.nodeAt(p);
              if (!curNode) return;
              const elementAttrs = getElementJsxAttrs(curNode.attrs);
              if (!elementAttrs) return;
              const currentNodeProps = elementAttrs.props;
              const nextProps: Record<string, unknown> = { ...currentNodeProps };
              const currentAttributes = Array.isArray(curNode.attrs.attributes)
                ? (curNode.attrs.attributes as unknown[])
                : [];
              let nextAttributes = currentAttributes;
              if (value === undefined) {
                delete nextProps[propName];
                nextAttributes = currentAttributes.filter(
                  (a) =>
                    !(
                      a != null &&
                      typeof a === 'object' &&
                      (a as Record<string, unknown>).type === 'mdxJsxAttribute' &&
                      (a as Record<string, unknown>).name === propName
                    ),
                );
              } else {
                nextProps[propName] = value;
              }
              editor.view.dispatch(
                editor.state.tr.setNodeMarkup(p, null, {
                  ...elementAttrs,
                  attributes: nextAttributes,
                  props: nextProps,
                  sourceDirty: true,
                }),
              );
              markUserTyping();
            }}
          />
          {/* Explicit confirmation affordance. PropPanel auto-saves on
              every keystroke / select change (`onChange` above runs the
              `setNodeMarkup` dispatch) — the button doesn't gate the
              save, it gives users the psychological closure UX research
              flagged was missing (PRD-7058 #1: "I just write, and it
              just, like, disappears" — without a confirm affordance
              authors interpret the auto-dismiss-on-outside-click as
              losing their changes, even though the changes already
              landed). Click closes the popover; the
              `onCloseAutoFocus`-driven editor refocus above handles
              the focus restore. */}
          <div className="mt-3 flex justify-end border-t border-border pt-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setPopoverOpen(false)}
              className="h-7 px-3 text-xs"
            >
              <Trans>Done</Trans>
            </Button>
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
}
