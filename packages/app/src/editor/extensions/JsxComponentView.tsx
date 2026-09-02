/**
 * JsxComponentView — overlay-based descriptor-dispatch NodeView.
 *
 * **Design principle:** Zero permanent chrome in document flow. Components
 * render exactly like production. All editor affordances are hover-revealed
 * overlays at top-right (move up/down, delete, settings gear) plus an
 * "add child" pill at the bottom edge of container descriptors.
 *
 * A persistent component-name chip was proposed but dropped — the
 * "zero permanent chrome" principle won. The
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
  commentLeafText,
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
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  Maximize2,
  Pencil,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
import { emitStartComment } from '@/comments/store';
import { Button } from '@/components/ui/button';
import { useIsEmbedded } from '@/hooks/use-is-embedded';
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
import { boardDocNameFromSrc } from '../components/ExcalidrawEmbed.tsx';
import { JsxComponentHostProvider } from '../components/jsx-host-context.tsx';
import { MermaidLightbox } from '../components/Mermaid';
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
import { getEditorView } from '../utils/get-editor-view.ts';
import { reconstructSource } from '../utils/reconstruct-source.ts';
import { sanitizeComponentProps } from '../utils/sanitize-url.ts';
import {
  autonomousFragmentEditAllowed,
  markAutonomousFragmentEdit,
} from './autonomous-fragment-edit.ts';

interface ComponentErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
  onError: (error: Error) => void;
  descriptorName: string;
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

const MAX_AUTO_CONVERT_ATTEMPTS = 3;

export function JsxComponentView({ node, editor, extension, getPos, selected }: NodeViewProps) {
  const { t } = useLingui();
  const descriptor = getDescriptor(node.attrs.componentName as string);
  const [renderError, setRenderError] = useState<Error | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const wasSelected = useRef(false);

  const pos = typeof getPos === 'function' ? getPos() : undefined;
  const isEmbedded = useIsEmbedded();

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
  const [diagramLightboxOpen, setDiagramLightboxOpen] = useState(false);
  const [boardLightboxOpen, setBoardLightboxOpen] = useState(false);

  const isSourceBearing = editableSource !== null;
  const sourcePropValue = editableSource ? currentProps[editableSource.propName] : undefined;
  const showSourcePlaceholder =
    isSourceBearing &&
    !hasEditableProps &&
    editor.isEditable &&
    (typeof sourcePropValue !== 'string' || sourcePropValue.trim() === '');
  const sourcePlaceholder = showSourcePlaceholder ? resolveDescriptorPlaceholder(descriptor) : null;

  useEffect(() => {
    if (
      selected &&
      !wasSelected.current &&
      (hasEditableProps || isSourceBearing) &&
      consumeAutoOpen(pos)
    ) {
      if (hasEditableProps) {
        setPopoverOpen(true);
      } else {
        setEditModalOpen(true);
      }
    }
    wasSelected.current = selected;
  }, [selected, hasEditableProps, isSourceBearing, pos]);

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
  const lightboxRenderChart =
    descriptor.name === 'MermaidFence' && typeof renderProps.chart === 'string'
      ? renderProps.chart
      : null;
  const expandableChart =
    lightboxRenderChart !== null && lightboxRenderChart.trim() !== '' ? lightboxRenderChart : null;
  const diagramExpandable = expandableChart !== null;
  useEffect(() => {
    if (!diagramExpandable) setDiagramLightboxOpen(false);
  }, [diagramExpandable]);
  const boardExpandable =
    descriptor.name === 'Excalidraw' &&
    typeof renderProps.src === 'string' &&
    boardDocNameFromSrc(renderProps.src) !== null;
  useEffect(() => {
    if (!boardExpandable) setBoardLightboxOpen(false);
  }, [boardExpandable]);
  const resetKey = `${descriptor.name}::${stableHash(primitiveProps)}`;

  const insertChildAt = () => {
    const p = typeof getPos === 'function' ? (getPos() ?? 0) : 0;
    return p + 1 + node.content.size;
  };

  const needsConversion = descriptor.name === '*' || renderError !== null;
  const convertedRef = useRef(false);
  const attemptCountRef = useRef(0);
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
      if (!autonomousFragmentEditAllowed(editor)) return;
      const failTransiently = (failureReason: string) => {
        const clampedComponent = descriptor.name === '*' ? 'wildcard' : descriptor.name;
        console.warn(
          JSON.stringify({
            event: 'jsx-component-auto-convert-failed',
            component: clampedComponent,
            rawComponentName: String(node.attrs.componentName ?? '').slice(0, 200),
            reason: failureReason.slice(0, 500),
            retry: attemptCountRef.current,
          }),
        );
        incrementJsxAutoConvertFailed(clampedComponent);

        attemptCountRef.current += 1;
        if (attemptCountRef.current < MAX_AUTO_CONVERT_ATTEMPTS) {
          const delay = 50 * (2 ** attemptCountRef.current - 1);
          timeoutId = setTimeout(() => {
            if (cancelled) return;
            dispatchOnce();
          }, delay);
        } else {
          if (!cancelled) setStuck(true);
        }
      };

      const view = getEditorView(editor);
      if (!view) {
        failTransiently('ProseMirror view not mounted');
        return;
      }
      try {
        view.dispatch(
          markAutonomousFragmentEdit(view.state.tr.replaceWith(p, p + node.nodeSize, fallbackNode)),
        );
        convertedRef.current = true;
        const clampedComponent = descriptor.name === '*' ? 'wildcard' : descriptor.name;
        incrementJsxAutoConvertSucceeded(clampedComponent);
      } catch (err) {
        failTransiently(err instanceof Error ? err.message : String(err));
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
    if (showPlaceholder || showSourcePlaceholder) return;
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
        {}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation required inside PM NodeView */}
        <div
          className="jsx-component-chrome"
          contentEditable={false}
          onMouseDown={(e) => e.stopPropagation()}
          {...{ [OPT_OUT_ATTR]: 'true' }}
        >
          {}

          {}
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

          {}
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

          {}
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

          {}
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

          {}
          {expandableChart !== null ? (
            <button
              type="button"
              className="jsx-chrome-btn"
              aria-label={t`Expand diagram`}
              data-testid="jsx-component-expand-btn"
              onClick={() => setDiagramLightboxOpen(true)}
            >
              <Maximize2 size={12} aria-hidden="true" />
            </button>
          ) : null}

          {}
          {boardExpandable ? (
            <button
              type="button"
              className="jsx-chrome-btn"
              aria-label={t`Expand board`}
              data-testid="jsx-component-expand-board-btn"
              onClick={() => setBoardLightboxOpen(true)}
            >
              <Maximize2 size={12} aria-hidden="true" />
            </button>
          ) : null}

          {}
          {!isEmbedded && commentLeafText(node).length > 0 && typeof pos === 'number' ? (
            <button
              type="button"
              className="jsx-chrome-btn"
              aria-label={t`Comment or ask AI about this ${descriptor.displayName ?? descriptor.name}`}
              data-testid="jsx-component-ask-ai-btn"
              onClick={() => {
                try {
                  editor.commands.setNodeSelection(pos);
                } catch (err) {
                  console.warn(
                    JSON.stringify({
                      event: 'jsx-component-chrome-ask-ai-failed',
                      component: descriptor.name,
                      rawComponentName: String(node.attrs.componentName ?? '').slice(0, 200),
                      reason: err instanceof Error ? err.message.slice(0, 500) : String(err),
                    }),
                  );
                  return;
                }
                requestAnimationFrame(() => {
                  try {
                    emitStartComment();
                  } catch (err) {
                    console.warn(
                      JSON.stringify({
                        event: 'jsx-component-chrome-ask-ai-emit-failed',
                        component: descriptor.name,
                        rawComponentName: String(node.attrs.componentName ?? '').slice(0, 200),
                        reason: err instanceof Error ? err.message.slice(0, 500) : String(err),
                      }),
                    );
                  }
                });
              }}
            >
              <Sparkles size={12} aria-hidden="true" />
            </button>
          ) : null}

          {}
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

          {}
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

        {}
        {}
        {showPlaceholder && resolvedPlaceholder ? (
          <PopoverAnchor asChild>
            <DescriptorPlaceholder
              label={resolvedPlaceholder.label}
              Icon={resolvedPlaceholder.Icon}
              onClick={openPanel}
              selected={isInnermostSelected}
            />
          </PopoverAnchor>
        ) : showSourcePlaceholder && sourcePlaceholder ? (
          <DescriptorPlaceholder
            label={sourcePlaceholder.label}
            Icon={sourcePlaceholder.Icon}
            onClick={() => setEditModalOpen(true)}
            selected={isInnermostSelected}
          />
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
              <Comp
                {...renderProps}
                {...(expandableChart !== null
                  ? { onExpand: () => setDiagramLightboxOpen(true) }
                  : {})}
                {...(boardExpandable
                  ? { expandOpen: boardLightboxOpen, onExpandOpenChange: setBoardLightboxOpen }
                  : {})}
              >
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

        {}
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
      {expandableChart !== null ? (
        <MermaidLightbox
          chart={expandableChart}
          open={diagramLightboxOpen}
          onOpenChange={setDiagramLightboxOpen}
        />
      ) : null}
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
          renderPreview={(value, setValue) => {
            const Component = descriptor.Component;
            const previewProps = {
              ...renderProps,
              [editableSource.propName]: value,
              ...(descriptor.name === 'MermaidFence' && {
                className: 'border-0 bg-transparent rounded-none',
                editBinding: { canEdit: editor.isEditable, commitChart: setValue },
              }),
            };

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
      {}
      {hasEditableProps && (
        <PopoverContent
          side={showPlaceholder ? 'bottom' : 'right'}
          align={showPlaceholder ? 'center' : 'start'}
          sideOffset={showPlaceholder ? -4 : 8}
          className="w-64 p-3 z-60 overflow-y-auto subtle-scrollbar max-h-(--radix-popper-available-height) overscroll-contain"
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
          {}
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
