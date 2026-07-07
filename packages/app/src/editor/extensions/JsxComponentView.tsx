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

// ── Error Boundary ──────────────────────────────────────────────────────
//
// Thin wrapper around `react-error-boundary`'s `<ErrorBoundary>` — same
// pattern as `packages/app/src/components/DocumentErrorBoundary.tsx`. The
// prior hand-rolled `class ComponentErrorBoundary` carried its own
// `getDerivedStateFromError` / `componentDidCatch` / `componentDidUpdate`
// trio that duplicated library semantics for no behavioral gain. This
// refactor collapses both error boundaries onto the same contract:
//
//   <ErrorBoundary fallbackRender resetKeys={[resetKey]} onError> …
//
// Fallback: renders the original children wrapped in
// `.jsx-component-error-fallback` (preserves the "surface the source so
// users can edit out of error state" UX from Precedent #30). When
// `resetKey` flips (prop change, node-name change, auto-convert reset —
// see the orchestrating effect at `resetKey` computation), the library
// auto-remounts the subtree.

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
  // react-error-boundary's FallbackProps (error, resetErrorBoundary) are
  // intentionally ignored here — Precedent #30 says errored blocks render
  // their children (source text) in place, not an error card. The CSS
  // class + the resetKeys-driven remount handle the visual recovery
  // story; the children passed through are the original subtree, which
  // renders as nested rawMdxFallback source under the wildcard path.
  return <div className="jsx-component-error-fallback">{children}</div>;
}

function ComponentErrorBoundary(props: ComponentErrorBoundaryProps) {
  const { children, resetKey, onError, descriptorName, rawComponentName } = props;
  return (
    <ErrorBoundary
      resetKeys={[resetKey]}
      onError={(error, info) => {
        // react-error-boundary types `error` as `unknown` because React can
        // capture arbitrary thrown values (strings, null, etc.). Normalize
        // to Error for both telemetry + the upstream onError contract.
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

// ── Prop extraction ─────────────────────────────────────────────────────

/**
 * Extract primitive (non-ReactNode) props from PM node attrs.
 * Passes through ALL keys from attrs.props — undeclared attrs reach the
 * component to prevent crashes on components requiring non-PropDef attrs.
 */
/**
 * Insertion-order-independent stringification. Sorts keys recursively so
 * `{a:1, b:2}` and `{b:2, a:1}` hash to the same string.
 *
 * Does NOT dedupe circular references — PM attr trees are acyclic by
 * construction, so a cycle here would be a bug worth surfacing.
 */
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

/**
 * Extract primitive (non-reactnode) props from PM node attrs.
 * `reactNodeNames` is the descriptor's pre-computed set of reactnode-typed
 * prop names — stable per descriptor, cached at registry build time so we
 * don't re-allocate per render (see `registry/types.ts`).
 *
 * Every returned object flows through `sanitizeComponentProps`, which:
 *   - Strips javascript:/vbscript:/data: URLs from URL-typed props
 *     (case-insensitive match, covers React camelCase formAction/xlinkHref).
 *   - Drops dangerouslySetInnerHTML / on* event handlers / React internals.
 *   - Filters `url(javascript:…)` / `expression(…)` from style strings and
 *     drops non-string style values (MDX-expression-authored style objects
 *     bypass the string scanner).
 *   - Traverses nested URL-shaped keys in arrays / plain objects (bounded).
 *
 * Storage (Y.Text, XmlFragment, shadow repo) retains the raw bytes per the
 * storage-layer fidelity contract — only the live render is sanitized.
 */
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

// ── Main NodeView ───────────────────────────────────────────────────────

/**
 * How many times the auto-convert effect retries its `replaceWith` dispatch
 * before falling through to the stuck-state UX. Observed failure shapes are
 * all transient position races (remote peer edit shifts the target range,
 * Observer B re-parse lands mid-flight), so three attempts over ~350ms is
 * long enough to clear every realistic contention window without keeping
 * the user on a dead placeholder if something deeper is wrong.
 */
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
    // PM `doc.resolve(pos)` throws RangeError when the position is outside
    // the current doc — happens during teardown (getPos() returns a stale
    // position after the node was detached) and during the recycle race
    // where the ProseMirror view rebuilds mid-render. Both are expected;
    // re-throwing would blow up the ErrorBoundary and mask real bugs.
    // Anything other than RangeError is unexpected — surface it.
    if (!(err instanceof RangeError)) throw err;
  }
  const canMoveUp = isChildOfComponent && siblingIndex > 0;
  const canMoveDown = isChildOfComponent && siblingIndex < siblingCount - 1;

  // Selection layer (Precedent #31): read canonical block-selection state
  // from SelectionStatePlugin and derive this wrapper's role.
  //
  //  - isRangeEncompassed:  TextSelection / AllSelection fully covers this
  //                         wrapper. Paints the soft `--selection-soft` halo.
  //  - isInnermostSelected: THIS wrapper has NodeSelection on it — the halo
  //                         gate. Routed through TipTap's `selected` NodeView
  //                         prop (NOT a direct `editor.state.selection` read)
  //                         because `useBlockSelection` is identity-preserving;
  //                         a direct read would not trigger a re-render on the
  //                         TextSelection-inside → NodeSelection-on transition
  //                         that the popover-close restore performs inside
  //                         `requestAnimationFrame`. `selected` flips true for
  //                         both NodeSelection-on and range-encompass-of this
  //                         wrapper; subtracting `isRangeEncompassed` narrows
  //                         it to NodeSelection-on.
  //  - isInnermostInChain:  THIS wrapper is the leaf of the ancestor chain.
  //                         Selection-type-agnostic — fires for both
  //                         NodeSelection-on AND TextSelection-inside this
  //                         wrapper. Used as the non-leaf guard for
  //                         `hasChildSelected` so that under TextSelection-
  //                         inside (where `isInnermostSelected` is false on
  //                         the chain leaf) the leaf does not falsely tag
  //                         itself as its own ancestor.
  //  - hasChildSelected:    THIS wrapper is a non-leaf ancestor of the
  //                         current selection. Gets `data-has-child-selected`
  //                         so the CSS layer can hide its own halo in favor
  //                         of the innermost (Gutenberg-style innermost-wins,
  //                         store-driven rather than `:has()`-based —
  //                         Precedent #34).
  //  - selectionOrigin:     How the user arrived at this selection
  //                         ('keyboard' | 'pointer' | 'programmatic').
  //                         Plumbed-through for future keyboard-only focus-
  //                         ring differentiation; no v1 visual treatment.
  //  - isDragging:          An HTML5 drag is active; suppress the halo.
  //
  // Plugin may not be registered during intermediate build states —
  // `useBlockSelection` then returns EMPTY (all flags off).
  const blockSelection = useBlockSelection(editor);
  const wrapperBridgeId = typeof pos === 'number' ? getWrapperBridgeId(editor.state, pos) : null;
  const isRangeEncompassed =
    wrapperBridgeId !== null &&
    (blockSelection?.rangeEncompassedBlockIds.has(wrapperBridgeId) ?? false);
  const chainLeafBridgeId = blockSelection?.ancestorChain.at(-1)?.bridgeId ?? null;
  const isInnermostInChain = wrapperBridgeId !== null && chainLeafBridgeId === wrapperBridgeId;
  // `selected && !isRangeEncompassed` alone is not enough: TipTap's
  // `selectNode()` fires whenever `from <= pos && to >= pos + nodeSize`,
  // which is true for ANY wrapper whose range is fully covered by the
  // selection — including an inner wrapper nested inside an outer that
  // is NodeSelected (the outer's NodeSelection range fully encloses the
  // inner). Without the chain-leaf guard, both wrappers paint a halo.
  // `isInnermostInChain` resolves the chain leaf (the actual NodeSelection
  // target) from the selection-state plugin's ancestor walk, which only
  // collects wrappers reached by `$from.node(depth)` outward plus the
  // NodeSelection's own `selection.node` — never inner descendants of the
  // selected node.
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

  // needsConfig = at least one required STRING prop has no decision yet
  // (key absent from props). Used as a passive visual hint: the chrome bar
  // surfaces the gear without hover (via `data-needs-config` CSS rule in
  // globals.css). Clears as soon as every required string prop has a key —
  // even an explicit empty string counts as a decision (e.g. `alt=""` is
  // WCAG-canonical decorative-image opt-in).
  //
  // Tri-state for required string props:
  //   - missing key → "author hasn't decided" → fires the nudge
  //   - `''`        → "explicit opt-out / decorative" → does NOT fire
  //   - non-empty   → satisfied → does NOT fire
  //
  // Scoping rationale:
  //   - boolean / number / enum props have sensible defaults from
  //     `getDefaultProps` (false / 0 / first enum value) — defaulting is
  //     intentional, not "unconfigured."
  //   - Optional string props (no `required: true`) opt out of the nudge
  //     entirely — `<Callout type="info">` legitimately omits title and
  //     should not nag.
  //   - Required string props without an explicit `defaultValue` are
  //     genuine "must decide" surfaces; `getDefaultProps` leaves the key
  //     absent on slash-insert, which is what trips the nudge here.
  const currentProps = (node.attrs.props as Record<string, unknown>) ?? {};
  const needsConfig =
    hasEditableProps &&
    descriptor.props.some((p) => {
      if (p.type !== 'string') return false;
      if (!p.required) return false;
      if ('hidden' in p && p.hidden) return false;
      return !Object.hasOwn(currentProps, p.name);
    });

  // STRICTER than `needsConfig`: only fires when the descriptor's autoFocus
  // string prop is empty/absent. `needsConfig` flags any required string
  // with a missing-key decision (e.g. alt absent on an `<img>`) and drives
  // the chrome-bar gear nudge — conflating the two would regress images
  // with valid src but unset alt into placeholder mode.
  const showPlaceholder = shouldRenderPlaceholder(descriptor, currentProps);
  const resolvedPlaceholder = showPlaceholder ? resolveDescriptorPlaceholder(descriptor) : null;

  // Single source of truth for the three sites (handleBodyClick / handleOpenChange /
  // onCloseAutoFocus) that gate behavior on "this descriptor renders as a leaf with
  // no editable content hole" (img / video / audio). Drift between sites silently
  // breaks focus + selection for one descriptor class.
  const isSelfClosingLeaf = !descriptor.hasChildren || !!descriptor.isSelfClosing;

  // Two render-time call sites below (data-align default clamp +
  // chrome-bar render condition) gate on whether this descriptor is
  // alignable; the click-handler's live-reread guard uses
  // `ALIGNABLE_DESCRIPTOR_NAMES.has(curDescriptorName)` directly so it
  // doesn't close over `descriptor.name`. Mirrors the
  // `isSelfClosingLeaf` centralization above.
  const isAlignable = ALIGNABLE_DESCRIPTOR_NAMES.has(descriptor.name);

  /**
   * Per-descriptor "source-bearing prop" mapping for the edit
   * modal. Each entry names the prop that carries the rendered source
   * (`MermaidFence.chart`, `Math.formula`) and the CodeMirror language
   * to surface. Descriptors not in the table don't render the edit
   * button. Mermaid + LaTeX grammars resolve via
   * `resolveLanguageExtension` in `CodePreviewEditModal`
   * (`codemirror-lang-mermaid` + `@codemirror/legacy-modes/mode/stex`),
   * so both surfaces get real token highlighting.
   */
  const editableSource: { propName: string; language: 'mermaid' | 'latex' } | null =
    descriptor.name === 'MermaidFence'
      ? { propName: 'chart', language: 'mermaid' }
      : descriptor.name === 'Math' ||
          descriptor.name === 'DollarMath' ||
          descriptor.name === 'MathFence'
        ? { propName: 'formula', language: 'latex' }
        : null;
  const [editModalOpen, setEditModalOpen] = useState(false);

  // Auto-open popover when: (1) component becomes selected AND (2) the
  // pendingAutoOpen flag is set. Uses controlled state so it works across
  // React re-renders (defaultOpen only reads on first mount). `wasSelected`
  // ref prevents double-fire under Strict Mode; explicit deps ensure the
  // effect only runs when one of the watched values actually changes.
  useEffect(() => {
    if (selected && !wasSelected.current && hasEditableProps && consumeAutoOpen(pos)) {
      setPopoverOpen(true);
    }
    wasSelected.current = selected;
  }, [selected, hasEditableProps, pos]);

  const primitiveProps = extractPrimitiveProps(node.attrs, descriptor.reactNodePropNames);
  // Compat descriptors render through their canonical's React component via
  // a render-time prop translation. `translateProps` is identity for v1's
  // three compat descriptors (their prop names already match canonical) but
  // the seam exists for future compats whose source spelling differs from
  // canonical (e.g., a hypothetical Mintlify Note → Callout mapping that
  // renames `title` to `heading` without changing storage).
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
  // Stable reset key for the ErrorBoundary. `JSON.stringify` on an arbitrary
  // props object produced a string whose content was key-order-sensitive
  // across engines — combined with the post-edit re-serialization that
  // mutates `primitiveProps`'s property insertion order (spread + overwrite),
  // the key changed between renders even when the prop values didn't, and
  // the ErrorBoundary (and therefore PropPanel) remounted mid-typing,
  // stealing focus from the active input. Sort keys so two objects with the
  // same (key, value) pairs hash to the same string regardless of insertion
  // order.
  const resetKey = `${descriptor.name}::${stableHash(primitiveProps)}`;

  // Shared: compute child insertion position (inside container, after last child)
  const insertChildAt = () => {
    const p = typeof getPos === 'function' ? (getPos() ?? 0) : 0;
    return p + 1 + node.content.size;
  };

  // ── Auto-convert to rawMdxFallback for wildcard + render errors ────────
  // Fires once after the dispatch actually lands. The rawMdxFallback CM
  // handles source editing + re-parse on commit.
  //
  // `convertedRef` is flipped INSIDE the rAF callback (after the successful
  // dispatch), not before scheduling it. Under React 19 StrictMode, every
  // effect runs → cleanup → remounts-and-reruns. If the ref were flipped
  // pre-dispatch, the StrictMode cleanup `cancelAnimationFrame` would cancel
  // the only dispatch attempt and the remount's effect would early-return
  // (convertedRef already true → skip) — leaving the user stuck on the
  // "opening source editor..." placeholder forever. Flipping the ref
  // post-dispatch means the first rAF that actually lands wins; cancelled
  // rAFs don't count toward "already converted."
  //
  // The `cancelled` closure flag makes this re-entry-safe: if a fast
  // re-render triggers the effect twice before the first rAF fires, only
  // the first dispatch succeeds; the second sees `cancelled === true` from
  // its own cleanup and skips. Local to the effect invocation, so a
  // cancelled first run doesn't block a subsequent run's dispatch.
  //
  // Bounded retry: on dispatch failure (position went stale under a remote
  // peer edit, Observer B re-parse, etc.) we schedule up to MAX_AUTO_CONVERT_RETRIES
  // backoff attempts before giving up. Without a retry schedule, nothing
  // guarantees a subsequent re-render fires — a quiescent doc with a latent
  // failing condition would leave the user on the non-editable placeholder
  // forever (no retry signal, no React re-render trigger). After retries
  // exhaust, the placeholder swaps to a stuck-state UX with Delete + Copy
  // source affordances so the user can recover without blaming the editor.
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
        // Position may have changed if other transactions fired.
        // Log as a structured event so recurring failures are visible in
        // telemetry — a swallowed exception here would otherwise leave the
        // user on the "opening source editor..." placeholder with no signal.
        const clampedComponent = descriptor.name === '*' ? 'wildcard' : descriptor.name;
        console.warn(
          JSON.stringify({
            event: 'jsx-component-auto-convert-failed',
            // Low-cardinality label for aggregation — always registered
            // descriptor name or literal 'wildcard'. Raw user text goes in
            // rawComponentName (see also ComponentErrorBoundary). Capped at
            // 200 chars to match the slicing pattern used elsewhere for
            // user-authored names in log payloads.
            component: clampedComponent,
            rawComponentName: String(node.attrs.componentName ?? '').slice(0, 200),
            reason: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
            retry: retryCountRef.current,
          }),
        );
        incrementJsxAutoConvertFailed(clampedComponent);

        retryCountRef.current += 1;
        if (retryCountRef.current < MAX_AUTO_CONVERT_RETRIES) {
          // Exponential-ish backoff: 50ms, 150ms, 350ms. Short enough to
          // feel instant in the typical case where a concurrent tx cleared
          // on the next tick; long enough to not hammer the event loop.
          const delay = 50 * (2 ** retryCountRef.current - 1);
          timeoutId = setTimeout(() => {
            if (cancelled) return;
            dispatchOnce();
          }, delay);
        } else {
          // Retries exhausted — surface the stuck-state UX so the user
          // can Delete / Copy source instead of sitting on a dead placeholder.
          if (!cancelled) setStuck(true);
        }
      }
    };

    // Defer to next frame to avoid dispatching during render. Tracked +
    // cancelled on cleanup so an unmount between schedule and fire (e.g.,
    // parent tree replaced by a remote peer edit, or StrictMode's
    // intentional unmount-remount) does not dispatch against a stale view.
    const frameId = requestAnimationFrame(dispatchOnce);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [needsConversion, node, editor, getPos, descriptor, renderError, stuck]);

  // Stuck-state UX: retries exhausted. The user sees a durable placeholder
  // with "Delete" and "Copy source" affordances so they can recover without
  // being trapped on a dead placeholder. Precedent #28 is preserved — the
  // source bytes are available via Copy source even when the auto-convert
  // can't land.
  if (stuck) {
    // Use action-oriented copy instead of internal jargon ("could not open
    // source editor"). The stuck state is the highest-friction UX moment
    // in the feature — the label should explain the recovery bridge (copy
    // → close → paste elsewhere), not name an internal subsystem the user
    // has never encountered.
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
        // Clipboard API may be unavailable (permissions, test env). The
        // Delete affordance still works, and the source bytes are safe in
        // the underlying node regardless of clipboard access — log at
        // debug for operator visibility so the stuck-state UX leaves a
        // support trail. The structured warn lets ops compute a
        // recovery-success rate against the existing jsxAutoConvertFailed
        // denominator.
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
        // Position races (concurrent remote peer edit, Observer B re-parse
        // shift) are the expected failure shape — classify + log so the
        // stuck-state last-line-of-defense leaves a correlatable trail.
        // Matches the Move Up/Down handler telemetry in the chrome bar so
        // ops can aggregate against a consistent denominator.
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

  // Show placeholder while the auto-convert rAF (above) dispatches. This
  // usually flashes for < 1 frame and is invisible; a slow hot-reload on
  // a large doc can surface it. Copy is action-oriented ("source editable
  // below") so even when it does surface, the user reads a meaningful
  // next step rather than implementation jargon.
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

  // ── BRANCH 2: Registered healthy render ───────────────────────────────
  const Comp = descriptor.Component;
  const deleteDescriptorLabel = descriptor.displayName ?? descriptor.name;
  const settingsDescriptorLabel = descriptor.displayName ?? descriptor.name;
  const propPanelDescriptorLabel = descriptor.displayName ?? descriptor.name;

  // For components with no editable children (self-closing like Image, …), a
  // click on the rendered body would otherwise land the caret in the node's
  // empty content hole — the user then sees "stuck caret" chrome with no
  // visible cursor and no productive keystrokes. Instead: NodeSelect the
  // component so the chrome highlights and the user can act via arrows /
  // Delete / the gear popover. Uses `onClick` (runs after PM's mousedown
  // has committed) rather than `onMouseDown` (would clobber HTML5 drag).
  // Placeholder-mode click is owned by `<DescriptorPlaceholder onClick>` —
  // skip the wrapper-level handler so setNodeSelection does not double-fire
  // alongside `openPanel`'s own selection + popover-open.
  const handleBodyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (showPlaceholder) return;
    if (!isSelfClosingLeaf) return;
    const target = e.target as HTMLElement;
    // React events bubble through the React tree including portals, so
    // clicks on inputs inside Radix Popover/Dialog content reach this
    // handler even though those nodes live at document.body. Filter to
    // clicks that are actually inside this wrapper's DOM — otherwise the
    // `setNodeSelection().focus()` below steals focus from the popover's
    // inputs and the user can't type into the PropPanel.
    if (!e.currentTarget.contains(target)) return;
    if (target.closest('.jsx-component-chrome')) return;
    if (target.closest('.jsx-add-child-pill, .jsx-empty-child-placeholder')) return;
    // If the click is on an actual `<a href>` link inside the rendered
    // body (e.g. File's `<a download>` row), let the browser's default
    // link behavior run — the user expects clicking the file to open
    // it, not to NodeSelect the block. NodeSelection remains reachable
    // via keyboard L2 nav (arrow keys) and via clicking the chrome bar.
    if (target.closest('a[href]')) return;
    if (typeof pos !== 'number') return;
    const curNode = editor.state.doc.nodeAt(pos);
    if (!curNode) return;
    const nodeEnd = pos + curNode.nodeSize;
    const selFrom = editor.state.selection.from;
    if (selFrom < pos || selFrom >= nodeEnd) return;
    editor.chain().focus().setNodeSelection(pos).run();
  };

  // Click-on-placeholder: NodeSelect this block (so chrome / halo reflect
  // it) and open the controlled popover. No rAF-defer needed (unlike the
  // slash-insert auto-open path) — the click is user-event-time and the
  // NodeView is already mounted, so `setNodeSelection` + `setPopoverOpen` can
  // dispatch synchronously.
  const openPanel = () => {
    const p = typeof getPos === 'function' ? getPos() : undefined;
    if (typeof p !== 'number') return;
    editor.chain().focus().setNodeSelection(p).run();
    setPopoverOpen(true);
  };

  // ARIA: role="group" for typed-children containers, with a descriptive
  // aria-label summarizing content. Screen readers announce on focus/select.
  // See precedent "A11y codified in the selection plugin, not retrofitted
  // per-block" and its consumers (SelectionAnnouncer).
  //
  // Descriptor display text is English (all descriptors ship with
  // English labels). Pluralization uses locale-neutral "with N items"
  // shapes that avoid inflecting the descriptor's child name — every
  // string change goes through the `editor-strings.ts` helpers so a
  // future i18n pass has a single place to swap.
  const componentLabel = descriptor.displayName ?? descriptor.name;
  const isGroupContainer = Boolean(descriptor.emptyChildName);
  const groupAriaLabel = isGroupContainer
    ? formatContainerAriaLabel(componentLabel, descriptor.emptyChildName, node.childCount)
    : undefined;

  // Keyboard surface for the NodeView wrapper:
  //  - Backspace/Delete: remove the NodeSelected wrapper. Works from any
  //    focus inside the wrapper subtree, including focusable cE=false
  //    descendants (Accordion `<summary>`, chrome `<button>`) where PM's
  //    keymap doesn't dispatch because DOM focus is outside `view.dom`.
  //  - Enter/Space: open the PropPanel (WCAG 2.1.1 keyboard-equivalent to
  //    clicking the gear) when the descriptor has editable props. For
  //    container components with editable children, the default
  //    NodeSelection → Enter PM behavior (enter the content hole) is
  //    preserved by only handling the key when editable props exist.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;

    if (e.key === 'Backspace' || e.key === 'Delete') {
      // Strict NodeSelection-on-this-wrapper. TipTap's raw `selected` prop
      // fires for range-encompass too (any `from <= pos && to >= pos +
      // nodeSize`), so gating on raw `selected` would let a multi-block
      // range-delete collapse to "delete just this wrapper" if PM's keymap
      // didn't intercept first. `isInnermostSelected` is the strict
      // NodeSelection-on-this-wrapper discriminator used everywhere else
      // for the data-selected attr, chrome visibility, and tabindex.
      if (!isInnermostSelected) return;
      // React events bubble through the React tree including portals, so
      // keydowns inside Radix `<PopoverContent>` reach this handler even
      // though its DOM lives at document.body. Filter to events whose DOM
      // target is actually inside this wrapper's subtree — otherwise
      // pressing Backspace on a popover input would delete the block out
      // from under the user. Mirrors `handleBodyClick`'s containment guard.
      if (!e.currentTarget.contains(target)) return;
      // The text-edit guard is narrowed to native form controls. Composite
      // wrappers (Accordion / Cards / …) carry contentEditable=true on
      // their content holes for PM's prose editing, so an `isContentEditable`
      // check would over-match and let users hit Backspace on focused chrome
      // buttons without ever reaching the wrapper-delete path. The
      // `isInnermostSelected` gate above already filters out the user-in-body
      // case (TextSelection-inside → `selected=false` → early-return), so
      // by the time we reach here, the remaining text-edit surface is a
      // <input>/<textarea> embedded in the rendered body (chrome inputs,
      // future descriptor-defined text fields).
      if (target.matches('input, textarea')) return;
      const p = typeof getPos === 'function' ? getPos() : undefined;
      if (typeof p !== 'number') return;
      e.preventDefault();
      // Defensive: a remote peer edit between the gate check and the chain
      // dispatch can shift `p` so the chain throws `RangeError`. `chain().run()`
      // also returns `false` on dispatch failure without throwing. Either
      // outcome means the user's keystroke was consumed but produced nothing
      // visible. Mirror the stuck-state `deleteNode` telemetry shape so ops
      // can aggregate the failure rate against a consistent denominator.
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
    // Allow keystrokes inside the chrome / child inputs to bubble normally.
    if (target.closest('.jsx-component-chrome')) return;
    if (target.closest('input, textarea, select, button')) return;
    e.preventDefault();
    setPopoverOpen(true);
  };

  // PropPanel close-handler. Two paths share the same "selection still inside
  // the node" guard (respect user intent when a click-outside has moved PM's
  // selection to a different position):
  //  - Self-closing leaves (Image / Video / Audio): advance the caret past
  //    the node via `TextSelection.near` so typing doesn't land in the empty
  //    content hole. `near` is load-bearing — `setTextSelection(pos+nodeSize)`
  //    can land on a block boundary (parent is a block container, not a
  //    textblock) so typing wraps in a new paragraph.
  //  - Composites (Callout / Accordion / future Tabs+Cards+Steps): restore
  //    NodeSelection on the wrapper. After a popover round-trip, PM's
  //    selection has drifted to TextSelection inside the body (focus on a
  //    focusable cE=false descendant breaks the halo↔selection invariant);
  //    re-anchoring NodeSelection re-paints the halo and lets Backspace
  //    (handled above) delete the block from any subsequent focus state.
  //
  // Defer to rAF so PM's click handler settles first. No `.focus()` call —
  // DOM focus is owned by Radix's `onCloseAutoFocus` on `<PopoverContent>`
  // (returns focus to the trigger button).
  const handleOpenChange = (open: boolean) => {
    setPopoverOpen(open);
    if (open) return;
    requestAnimationFrame(() => {
      const p = typeof getPos === 'function' ? getPos() : undefined;
      if (typeof p !== 'number') return;
      // The dispatch sites below can throw `RangeError` if a concurrent
      // CRDT edit shifts positions between the guard checks above and the
      // actual dispatch. Mirrors every sibling handler in this file
      // (handleKeyDown, deleteNode, the auto-convert effect) — narrow on
      // RangeError, log structured telemetry, re-raise anything else.
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
        // Stable test-selector contract, decoupled from `className` (which can
        // change for visual reasons). Tests that target "every component
        // wrapper" use `[data-jsx-component]` — do not remove without
        // updating `packages/app/tests/a11y/component-blocks.e2e.ts` etc.
        data-jsx-component=""
        data-component-type={descriptor.name.toLowerCase()}
        // Alignment — driven by the `align` prop on the alignable
        // descriptors (`img` + `CommonMarkImage` + `Embed` + `video` —
        // see `ALIGNABLE_DESCRIPTOR_NAMES`). The wrapper-level
        // `data-align` lets CSS (`globals.css`,
        // `.jsx-component-wrapper[data-component-type="<name>"]
        // [data-align]` selectors) apply a `text-align` rule for
        // centering / left / right placement. When the user sets a
        // non-default alignment on a `CommonMarkImage`, the chrome-bar
        // click handler upgrades the descriptor to `img` (commonmark
        // syntax has no alignment surface); this default-`center`
        // mirroring keeps the pre-click visual consistent with where
        // it'll land.
        //
        // The value is clamped to the `'left' | 'center' | 'right'`
        // enum — an HTML4-era paste like `<img align="middle" />` would
        // otherwise pass through to `[data-align]`, with no matching
        // text-align rule, leaving the wrapper visually unaligned with
        // no diagnostic. Treat anything outside the canonical enum as
        // `'center'`.
        data-align={(() => {
          const rawAlign = currentProps.align;
          if (rawAlign === 'left' || rawAlign === 'right' || rawAlign === 'center') {
            return rawAlign;
          }
          // Default-`center` fallback for descriptors whose `align` prop
          // carries `omitOnDefault: true` (parsed-without-explicit-align
          // → `align` undefined on the prop bag, so the CSS rule
          // `[data-component-type="X"][data-align="center"]` never
          // matches without this clamp). Must stay in lockstep with the
          // chrome-bar alignment trio condition + bubble-menu
          // predicates in `ImageAlignButtons.tsx`.
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
        // `aria-selected` is intentionally omitted — per WAI-ARIA 1.2, it's
        // only valid on `role` values that support selection semantics
        // (option, tab, row, gridcell, treeitem, columnheader, rowheader).
        // Our wrappers carry `role="group"` (for emptyChildName containers)
        // or no role (for generic block components). Emitting `aria-selected`
        // on those roles is an ARIA conformance violation caught by axe-core.
        // Selection announcement to AT is handled via the `<SelectionAnnouncer>`
        // aria-live region which works regardless of wrapper role.
        role={isGroupContainer ? 'group' : undefined}
        aria-label={groupAriaLabel}
        // Roving tabindex (W3C ARIA Authoring Practices, "Composite Widgets"):
        // exactly one wrapper per editor is in the document tab order at a
        // time — the currently-selected one. Without this, every top-level
        // jsxComponent created an O(N) Tab cost before the user could reach
        // anything outside the editor (presence bar, chrome controls). The
        // wrappers remain reachable via PM's NodeSelection arrow-nav; Tab
        // stays a "leave the editor" affordance, not "step through every
        // block." Matches Gutenberg / Lexical block-editor conventions.
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
                // Prevent PM from interpreting the click as a node-selection
                // (the chrome wrapper already stopPropagation's mousedown,
                // but the anchor needs its native click-to-navigate path).
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
            rawMdxFallback. Pattern mirrors the `isChildOfComponent` probe. */}
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

          {/* Edit source — Mermaid + Math. Opens the
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
              // Same defensive pattern as the seven other dispatch sites in
              // this file + drag-handle's grip click — narrow on RangeError,
              // bump the keyboard-delete counter (same failure-mode shape),
              // and log a structured warning so ops can aggregate against a
              // consistent denominator. Otherwise an uncaught RangeError
              // from a concurrent CRDT edit propagates to
              // `ComponentErrorBoundary` and auto-converts to
              // `rawMdxFallback`, which presents to the user as the block
              // silently turning into stuck-state placeholder.
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
        branch to clear `errored` state when primitive props change.
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
          // No NodeViewContent here for the same reason the healthy branch's
          // Image / Video / Audio components silently drop children: the
          // descriptors that surface the placeholder are self-closing leaves
          // (`hasChildren: false`), so PM never has block children to map.
          // The slot's absence here matches Branch 2 for self-closing leaves;
          // Precedent #30's "always rendered" obligation lives downstream in
          // the renderer that does have children to host (Callout / Accordion).
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
                      // Pass the live `getPos` rather than a snapshot — host writes
                      // can fire seconds after render (e.g. ResizeHandles pointerup
                      // for Embed) and snapshot pos drifts under concurrent edits.
                      // Matches the fresh-getPos pattern at every other dispatch
                      // site in this file.
                      getPos: () => {
                        const p = getPos();
                        return typeof p === 'number' ? p : undefined;
                      },
                      // Compound containers (descriptor.emptyChildName is set,
                      // e.g. Tabs) can render their own inline "add child"
                      // affordance by calling this. Mirrors the floating-pill
                      // onClick below; takes the same insert + focus path.
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
            // Spread the *sanitized* `renderProps` (post
            // `extractPrimitiveProps` → `sanitizeComponentProps` →
            // `normalizeDocRelativeMediaRenderProps`) rather than raw
            // `currentProps`, matching the production render branch.
            // Today's `editableSource` descriptors (Math /
            // DollarMath / MathFence / MermaidFence) carry no URL-typed
            // props so the practical attack surface is zero, but the
            // sanitization contract documented on `extractPrimitiveProps` ("Every
            // returned object flows through `sanitizeComponentProps`")
            // is structural — keeping the preview on the same path
            // means a future descriptor with URL props can't open an
            // XSS hole by joining the table.
            const previewProps = {
              ...renderProps,
              [editableSource.propName]: value,
              ...(descriptor.name === 'MermaidFence' && {
                className: 'border-0 bg-transparent rounded-none',
              }),
            };

            return (
              <div className="flex h-full w-full items-center justify-center p-4">
                <Component {...previewProps} />
              </div>
            );
          }}
          onSave={(value) => {
            // Mirror the canonical sibling-write pattern in
            // PropPanel.onChange and the alignment click handler: read
            // `pos` fresh via `getPos()` at dispatch time, re-read the
            // current node via `nodeAt()` so concurrent CRDT edits
            // (remote peers, agent writes) aren't clobbered by a stale
            // render-closure attr spread, and call `markUserTyping()`
            // after dispatch so Observer-B classification + debounced
            // persistence behave identically to the other write paths.
            // The modal stays open for seconds-to-minutes during which
            // remote edits can land — this pattern is load-bearing.
            const livePos = typeof getPos === 'function' ? getPos() : undefined;
            if (typeof livePos !== 'number') return;
            const curNode = editor.state.doc.nodeAt(livePos);
            if (!curNode) return;
            // Defense at the write boundary — see the PropPanel site
            // for full rationale. `editableSource` is set only
            // for element-kind descriptors today, so this guard is
            // structurally unreachable; a future broadening of the
            // table would otherwise stamp element-shaped attrs onto an
            // expression node and `markdown/index.ts`'s jsxComponent
            // serializer would silently emit `sourceRaw` verbatim,
            // dropping the modal edit.
            const elementAttrs = getElementJsxAttrs(curNode.attrs);
            if (!elementAttrs) return;
            try {
              const currentNodeProps = elementAttrs.props;
              const nextProps = {
                ...currentNodeProps,
                [editableSource.propName]: value,
              };
              // `sourceDirty: true` is the same contract the alignment
              // click handler enforces — without it the serializer
              // re-emits the verbatim `sourceRaw` and the modal edit is
              // silently dropped on save.
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
      {/* z-60 overrides the shadcn popover base (z-50) so the PropPanel
          reliably sits above other z-50 surfaces (wiki-link Dialog overlays,
          sonner toasts, internal-link Dialogs). The chrome bar in globals.css
          also uses z-50; a PopoverContent at the same level is ordered by
          render-order, which isn't a stable guarantee — explicit bump makes
          it deterministic. */}
      {hasEditableProps && (
        // Placeholder mode anchors the popover via PopoverAnchor on the full-
        // width pill, so the right-of-the-gear placement that suits a
        // configured component reads as off-center and disconnected. Drop the
        // popover under the pill, centered horizontally, with a small negative
        // sideOffset so the top of the popover overlaps the bottom of the
        // pill — Notion-style continuation between affordance and form.
        <PopoverContent
          side={showPlaceholder ? 'bottom' : 'right'}
          align={showPlaceholder ? 'center' : 'start'}
          sideOffset={showPlaceholder ? -4 : 8}
          className="w-64 p-3 z-60 overflow-y-auto subtle-scrollbar max-h-(--radix-popper-available-height) overscroll-contain"
          // Self-closing leaves (img/video/audio) want the caret back in the
          // editor body so the user can keep typing — the Notion-style
          // "fill prop → Escape → continue" loop. Radix's default close-time
          // focus restore points at `previouslyFocusedElement` captured when
          // the popover mounted, which is typically the gear button or a
          // now-detached slash-menu element; keystrokes after Escape land
          // there and silently vanish until the user clicks back into the
          // editor. Container components (Callout/Accordion) keep Radix's
          // default — their content hole already pulls focus naturally.
          //
          // Runs inside Radix's setTimeout(0) close-tick, which beats the
          // rAF-deferred caret-advance in handleOpenChange and any other
          // racing focus calls. preventDefault on the unmount-auto-focus
          // event tells FocusScope to skip its own focus() restore.
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
              // Update the node at its live position — NOT via
              // `editor.commands.updateAttributes`, which targets the
              // *current selection*. When the PropPanel popover has an input
              // focused, the PM selection has already moved off this Card
              // (the editor loses focus to the portal input), so
              // selection-based updateAttributes silently no-ops and every
              // keystroke disappears. `setNodeMarkup(pos, ...)` targets the
              // node at its position regardless of where the selection is now.
              const p = typeof getPos === 'function' ? getPos() : undefined;
              if (typeof p !== 'number') return;
              const curNode = editor.state.doc.nodeAt(p);
              if (!curNode) return;
              // Defense at the write boundary: PropPanel writes only target
              // `kind: 'element'` nodes. Today PropPanel never opens for
              // `kind: 'expression'` nodes (their componentName is empty,
              // which falls through to the wildcard descriptor with empty
              // `props`, so `hasEditableProps` is false). If a future
              // refactor changes that gate (e.g., custom PropPanel for
              // expression blocks), this spread would otherwise stamp
              // element-shaped attrs onto an expression node and the
              // serializer at `markdown/index.ts:jsxComponent` would silently
              // emit `sourceRaw` verbatim, dropping every PropPanel edit.
              const elementAttrs = getElementJsxAttrs(curNode.attrs);
              if (!elementAttrs) return;
              const currentNodeProps = elementAttrs.props;
              // `undefined` means "clear this prop" — we DELETE the key
              // rather than storing `{[propName]: undefined}`. If we kept
              // the undefined entry, `reconstructAttrs` would serialize it
              // as a boolean-shorthand attr (`<Image width />`) via
              // `propToMdxJsxAttribute`'s `value == null` branch. PropPanel
              // passes undefined when the user backspaces a numeric input to
              // empty for an optional prop. We ALSO filter the matching
              // entry out of the preserved `attributes` array so the
              // dirty-path reconstruction in `reconstructAttrs` doesn't
              // re-emit the original (stale) value.
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
              flagged was missing ("I just write, and it
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
