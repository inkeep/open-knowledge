/**
 * InteractionLayer — generic editor-root React plane.
 *
 * Problem: TipTap's per-instance `ReactMarkViewRenderer` /
 * `ReactNodeViewRenderer` creates one React portal per mark/node. On a
 * PROJECT.md-scale doc (768 views) the portals cost ~2.2 s of React
 * reconciliation on cold-pool-warm.
 *
 * Solution: chips render as plain DOM (`<span data-mark-id>`) inside the
 * PM content. A SINGLE React subtree renders once at editor root
 * (`<InteractionLayerRoot>`), holds a single active `nodeId`, and resolves
 * the registered renderer to produce the PropPanel / Toolbar / Breadcrumb
 * surface. Event delegation on `editor.view.dom` + document-level
 * listeners dispatches `setActiveNode` imperatively.
 *
 * **Trigger model**:
 *   - Mouse hover over a chip → schedule open after HOVER_OPEN_DELAY.
 *   - Mouse leave chip → schedule close after HOVER_CLOSE_DELAY. Entering
 *     the popover cancels the close (popover stays sticky).
 *   - Keyboard focus on a chip → open immediately (no delay).
 *   - Bare click / Enter / Space → routes through `handlePrimary` to
 *     navigate; falls through to opening the popover only when nothing
 *     handled the activation (e.g. unresolved page link).
 *   - Cmd/Ctrl+click + middle-click → `handlePrimary(newTab: true)` →
 *     open in a new tab.
 *   - Touch long-press (LONG_PRESS_DELAY) → open popover; tap → navigate.
 *   - Escape dismisses the active popover.
 *   - Tab from a chip whose popover is open → move focus into the first
 *     focusable inside the popover (the chip is not a Radix Trigger, so
 *     Radix's built-in focus management doesn't link the two).
 */

import { type FC, useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Duck-typed editor shape. We only need a reference to `view.dom` (or
 * `editorView.dom` for TipTap's non-throwing accessor) so event delegation
 * can attach.
 */
interface InteractionLayerEditor {
  editorView?: { dom: HTMLElement };
  view?: { dom: HTMLElement };
}

export interface InteractionContext {
  nodeId: string;
  type: string;
  /** Caller-side callback to deactivate (close) the panel. */
  deactivate: () => void;
}

/**
 * Context passed to the optional `handlePrimary` handler. Chips that want
 * to short-circuit the default "open the PropPanel" behavior on bare-click
 * / Enter / Space can register this hook and perform navigation (or any
 * other primary-action semantics) directly.
 *
 * `newTab` is set when the user pressed Cmd/Ctrl/middle-click — the layer
 * routes these through `handlePrimary` so chips can preserve the universal
 * web "open in new tab" mental model even though they're plain-DOM chips
 * without an `<a href>`.
 */
interface InteractionPrimaryContext {
  nodeId: string;
  type: string;
  /** True when the user intended new-tab semantics (Cmd/Ctrl/middle-click). */
  newTab: boolean;
}

export interface InteractionControls {
  /** Rendered at editor root when nodeId becomes active. */
  propPanel?: (ctx: InteractionContext) => React.ReactNode;
  /**
   * Reserved for CB-v2 per spec §9.2 — extension point. V2 extensions
   * do NOT set this; CB-v2's JsxComponentView will.
   */
  toolbar?: (ctx: InteractionContext) => React.ReactNode;
  /**
   * Reserved for CB-v2 per spec §9.2 — extension point. V2 extensions
   * do NOT set this; CB-v2's JsxComponentView will.
   */
  breadcrumb?: (ctx: InteractionContext) => React.ReactNode;
}

export interface RegisterParams {
  /** Semantic kind: 'internalLink', 'wikiLink', 'jsxComponent', etc. */
  type: string;
  /**
   * Unique id for this registration — typically mark-id or stable
   * node-id derived from `getPos()`.
   */
  nodeId: string;
  /** Optional PM position resolver (useful for NodeView consumers). */
  getPos?: () => number | undefined;
  /** Render-function bag for the three singleton slots. */
  controls: InteractionControls;
  /**
   * Optional hook invoked BEFORE the layer routes primary activation
   * (click / Enter / Space) to `setActiveNode`. Returning `true` means
   * "handled — do not open the PropPanel"; returning `false`/`undefined`
   * falls through to the default setActiveNode behavior.
   *
   * Chip kinds that want to preserve universal link semantics (bare-click
   * navigates immediately, Cmd+Click opens in a new tab) implement this
   * hook. The layer routes keyboard activation (Enter / Space) here too —
   * keyboard + pointer share one path.
   */
  handlePrimary?: (ctx: InteractionPrimaryContext) => boolean | undefined;
}

export interface InteractionLayerHandle {
  /** Register a node's controls. Overwrites prior registration for same nodeId. */
  register(params: RegisterParams): void;
  /** Remove a registration. If the nodeId was active, active is cleared. */
  deregister(nodeId: string): void;
  /** Imperatively set the active nodeId (or null to dismiss). */
  setActiveNode(nodeId: string | null): void;
  /** Read the current active nodeId. */
  getActiveNode(): string | null;
  /** Inspect a registered entry (useful for extension event handlers). */
  getRegistration(nodeId: string): RegisterParams | undefined;
  /** Remove event listener, clear registry, unmount React subtree. Idempotent. */
  destroy(): void;
  /**
   * Direct store access — exposed so the host (`<InteractionLayerView>`)
   * can subscribe via React without going through createRoot. The store is
   * the source of truth; the handle's register/deregister/setActiveNode
   * are convenience proxies. Tests + main-tree React render both go through
   * the store.
   */
  store: InteractionLayerStore;
}

interface CreateInteractionLayerParams {
  editor: InteractionLayerEditor;
}

// ---------------------------------------------------------------------------
// Hover state machine — tuning constants
// ---------------------------------------------------------------------------

/** Mouse must dwell this long over a chip before the popover opens. */
const HOVER_OPEN_DELAY = 300;
/** Grace period after pointer leaves chip/popover before closing — lets the
 *  user move diagonally between chip and popover without the panel flickering
 *  closed. Matches the Notion/Linear popover convention. */
const HOVER_CLOSE_DELAY = 150;
/** Touch press-and-hold this long to open the popover (tap is navigate). */
const LONG_PRESS_DELAY = 500;

// ---------------------------------------------------------------------------
// Internal store — pure, testable without React
// ---------------------------------------------------------------------------

/** Snapshot consumed by `useSyncExternalStore` for React-side reads. */
interface LayerSnapshot {
  /** Currently active node id, or null. */
  activeNodeId: string | null;
  /** Active registration (null if no active or deregistered). */
  active: RegisterParams | null;
}

type Listener = () => void;

/**
 * Pure imperative store. No React dependency — exported for unit testing.
 *
 * Single responsibility: hold the registry + active node id, notify
 * subscribers on change. `useSyncExternalStore` consumes the public
 * `subscribe` + `getSnapshot` surface from the React root component.
 */
export class InteractionLayerStore {
  private readonly registry = new Map<string, RegisterParams>();
  private _activeNodeId: string | null = null;
  private readonly listeners = new Set<Listener>();
  /** Cached snapshot for `useSyncExternalStore` — only replaced on change. */
  private _snapshot: LayerSnapshot = { activeNodeId: null, active: null };

  register(params: RegisterParams): void {
    this.registry.set(params.nodeId, params);
    // Update snapshot lazily only if the active entry was the one changed.
    if (this._activeNodeId === params.nodeId) {
      this.refreshSnapshot();
    }
  }

  deregister(nodeId: string): void {
    const hadEntry = this.registry.delete(nodeId);
    if (!hadEntry) return;
    if (this._activeNodeId === nodeId) {
      this._activeNodeId = null;
      this.refreshSnapshot();
    }
  }

  setActiveNode(nodeId: string | null): void {
    if (this._activeNodeId === nodeId) return;
    // Validate against registry — setting active to a non-registered id is a
    // no-op. This makes the API idempotent even when the consumer has race
    // conditions (e.g. deregister happened just before click dispatches).
    if (nodeId !== null && !this.registry.has(nodeId)) return;
    this._activeNodeId = nodeId;
    this.refreshSnapshot();
  }

  getActiveNode(): string | null {
    return this._activeNodeId;
  }

  getRegistration(nodeId: string): RegisterParams | undefined {
    return this.registry.get(nodeId);
  }

  hasRegistration(nodeId: string): boolean {
    return this.registry.has(nodeId);
  }

  clear(): void {
    this.registry.clear();
    this._activeNodeId = null;
    this.refreshSnapshot();
  }

  /**
   * `useSyncExternalStore` contract: identity-stable snapshot between
   * notifies, new object on change. Prevents tear-based inconsistency.
   */
  getSnapshot = (): LayerSnapshot => {
    return this._snapshot;
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private refreshSnapshot(): void {
    const active =
      this._activeNodeId != null ? (this.registry.get(this._activeNodeId) ?? null) : null;
    this._snapshot = { activeNodeId: this._activeNodeId, active };
    for (const l of this.listeners) l();
  }
}

// ---------------------------------------------------------------------------
// Event delegation — pure helper, testable without DOM
// ---------------------------------------------------------------------------

/**
 * Walk up from a click target; return the closest element carrying a
 * `data-mark-id` or `data-node-id` attribute that matches the registry.
 *
 * Pure w.r.t. the DOM: we only call `Element.getAttribute` (read-only)
 * and `Element.parentElement` (read-only) — so tests can pass a fake
 * tree made of plain objects.
 */
interface ResolverNode {
  getAttribute?: (key: string) => string | null;
  parentElement?: ResolverNode | null;
}

export function resolveClickTargetNodeId(
  target: EventTarget | null,
  registry: Pick<InteractionLayerStore, 'hasRegistration'>,
): string | null {
  let el: ResolverNode | null = (target as unknown as ResolverNode) ?? null;
  while (el && typeof el === 'object') {
    const getAttr = el.getAttribute;
    if (typeof getAttr === 'function') {
      const markId = getAttr.call(el, 'data-mark-id');
      if (markId && registry.hasRegistration(markId)) return markId;
      const nodeId = getAttr.call(el, 'data-node-id');
      if (nodeId && registry.hasRegistration(nodeId)) return nodeId;
    }
    el = el.parentElement ?? null;
  }
  return null;
}

/** True iff the element is inside any popover content (Radix portals to body
 *  but our InteractionPropPanel tags content with `data-ok-prop-panel`). */
function isInsidePropPanel(target: Element | null): boolean {
  if (!target) return false;
  return target.closest('[data-ok-prop-panel]') !== null;
}

/** True iff a layer-spawned modal (Edit dialog, etc.) is currently open.
 *  These dialogs MUST carry `data-ok-layer-spawned=""`. */
function isLayerSpawnedDialogOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector('[data-ok-layer-spawned]') !== null;
}

// ---------------------------------------------------------------------------
// React root — singleton subtree that renders the active PropPanel + extension
// slots. Uses the `useState + subscribe` pattern (NOT useSyncExternalStore —
// see component body). React re-renders only when
// activeNodeId (or the active registration) transitions.
// ---------------------------------------------------------------------------

interface InteractionLayerRootProps {
  store: InteractionLayerStore;
}

const InteractionLayerRoot: FC<InteractionLayerRootProps> = ({ store }) => {
  // Read from store using the basic `useState + subscribe` pattern. We avoid
  // useSyncExternalStore to side-step React 19's strict `getSnapshot` identity
  // requirements while keeping re-renders bounded: the store's snapshot
  // reference only changes when register/deregister/setActiveNode fires a
  // real transition.
  const [snapshot, setSnapshot] = useState<LayerSnapshot>(() => store.getSnapshot());
  useEffect(() => {
    setSnapshot(store.getSnapshot());
    const unsubscribe = store.subscribe(() => {
      setSnapshot(store.getSnapshot());
    });
    return unsubscribe;
  }, [store]);

  const { active } = snapshot;
  if (!active) return null;

  const ctx: InteractionContext = {
    nodeId: active.nodeId,
    type: active.type,
    deactivate: () => store.setActiveNode(null),
  };

  return (
    <>
      {active.controls.propPanel?.(ctx)}
      {active.controls.toolbar?.(ctx)}
      {active.controls.breadcrumb?.(ctx)}
    </>
  );
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function getEditorDom(editor: InteractionLayerEditor): HTMLElement | null {
  // `editor.view` is a throwing proxy when `editor.editorView`
  // is null. The proxy fires during PM `new EditorView()` construction when PM
  // walks the document and invokes nodeview factories *before* assigning
  // `editorView` — and during recycle/remount windows. `editor.editorView` is
  // the non-throwing direct field (returns `undefined` when unset).
  return editor.editorView?.dom ?? null;
}

/**
 * Match an element to a node id the way event delegation does — via the
 * `data-mark-id` / `data-node-id` chain. Used by focus-restoration to
 * decide whether the element owning focus at activation time IS the chip
 * that triggered activation.
 */
function isPotentialChipElement(el: HTMLElement | null, nodeId: string): boolean {
  let cur: Element | null = el;
  while (cur) {
    if (cur.getAttribute?.('data-mark-id') === nodeId) return true;
    if (cur.getAttribute?.('data-node-id') === nodeId) return true;
    cur = cur.parentElement;
  }
  return false;
}

/**
 * Create a layer handle bound to the editor. Call `destroy()` on editor
 * teardown — `InteractionLayerHandle` owns the event listener, React root,
 * and registry, and releases all three on destroy.
 */
export function createInteractionLayer(
  params: CreateInteractionLayerParams,
): InteractionLayerHandle {
  const { editor } = params;
  const store = new InteractionLayerStore();

  let editorDom: HTMLElement | null = getEditorDom(editor);
  let listenersAttached = false;

  // ── Hover state machine ──────────────────────────────────────────────────
  // Two timers track pending state transitions. Open is debounced to avoid
  // ghost popovers when the pointer just sweeps across text containing chips;
  // close is debounced so the user can move diagonally chip→popover without
  // the popover flickering away mid-traverse.
  let hoverOpenTimer: ReturnType<typeof setTimeout> | null = null;
  let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let hoverOpenTargetId: string | null = null;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when long-press fires — the subsequent synthetic `click` event
   *  (iOS Safari fires click after touchend even on long-press) must NOT
   *  navigate, since long-press already opened the popover. */
  let suppressNextClickForId: string | null = null;

  const clearHoverOpen = (): void => {
    if (hoverOpenTimer !== null) {
      clearTimeout(hoverOpenTimer);
      hoverOpenTimer = null;
    }
    hoverOpenTargetId = null;
  };

  const clearHoverClose = (): void => {
    if (hoverCloseTimer !== null) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = null;
    }
  };

  const clearLongPress = (): void => {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

  const scheduleHoverOpen = (id: string): void => {
    if (store.getActiveNode() === id) {
      // Already open for this chip — just cancel any pending close.
      clearHoverClose();
      return;
    }
    if (hoverOpenTargetId === id && hoverOpenTimer !== null) return;
    clearHoverOpen();
    clearHoverClose();
    hoverOpenTargetId = id;
    hoverOpenTimer = setTimeout(() => {
      hoverOpenTimer = null;
      hoverOpenTargetId = null;
      store.setActiveNode(id);
    }, HOVER_OPEN_DELAY);
  };

  const scheduleHoverClose = (): void => {
    if (store.getActiveNode() === null) return;
    if (hoverCloseTimer !== null) return;
    hoverCloseTimer = setTimeout(() => {
      hoverCloseTimer = null;
      // Spawned dialog (Edit/Create) keeps the popover sticky — closing
      // it mid-edit would lose the user's in-progress input.
      if (isLayerSpawnedDialogOpen()) return;
      store.setActiveNode(null);
    }, HOVER_CLOSE_DELAY);
  };

  // ── Focus restoration ────────────────────────────────────────────────────
  // When `setActiveNode(id)` fires, we capture the element that OWNED focus
  // at dispatch time if it matches the chip whose node id we're activating.
  // On `setActiveNode(null)` we restore focus to that element. Falls back
  // to `editor.view.dom` if the captured element is gone.
  //
  // `restoringFocus` gates the `focusin` listener around the synchronous
  // `.focus()` call below: HTMLElement.focus() fires `focusin` synchronously
  // before returning, and without this guard `onFocusIn` would interpret
  // that synthetic event as a fresh keyboard activation and reopen the
  // popover we just dismissed (breaks Escape and Enter-to-navigate on
  // same-doc anchors).
  let lastActivator: HTMLElement | null = null;
  let restoringFocus = false;
  const restoreFocusTo = (target: HTMLElement): void => {
    try {
      restoringFocus = true;
      target.focus({ preventScroll: true });
    } catch {
      // Best-effort.
    } finally {
      restoringFocus = false;
    }
  };
  const unsubscribeFocus = store.subscribe(() => {
    const activeId = store.getActiveNode();
    if (activeId !== null) {
      if (typeof document !== 'undefined') {
        const active = document.activeElement as HTMLElement | null;
        if (active && isPotentialChipElement(active, activeId)) {
          lastActivator = active;
        } else {
          lastActivator = null;
        }
      }
      return;
    }
    if (typeof document === 'undefined') return;
    const target = lastActivator;
    lastActivator = null;
    if (target && document.contains(target) && typeof target.focus === 'function') {
      restoreFocusTo(target);
      return;
    }
    const dom = editorDom ?? getEditorDom(editor);
    if (dom && typeof (dom as HTMLElement).focus === 'function') {
      restoreFocusTo(dom as HTMLElement);
    }
  });

  // ── Event handlers ───────────────────────────────────────────────────────

  // pointerdown: handles Cmd/Ctrl/middle-click intent suppression and
  // touch long-press scheduling. Bare-click PropPanel activation is NOT
  // done here anymore — it flows through `click` (hover
  // already opened the popover for mouse; click navigates).
  const onPointerDown = (ev: Event): void => {
    const pe = ev as PointerEvent;
    if (pe.button === 2) return;
    const isNewTabIntent = pe.metaKey || pe.ctrlKey || pe.button === 1;
    if (isNewTabIntent) {
      // After Cmd-click navigates in a new tab, any pending hover-open
      // would fire ~100-200 ms later and pop the panel for a chip the user
      // already actioned. Clear it before delegating to `click`/`auxclick`.
      clearHoverOpen();
      // Let `click` / `auxclick` drive navigation. Suppress the browser's
      // default middle-click scroll-cursor so the user isn't confused.
      if (pe.button === 1) pe.preventDefault?.();
      return;
    }
    // Touch: schedule long-press. Tap (no long-press) falls through to the
    // synthetic `click` event which calls handlePrimary to navigate.
    if (pe.pointerType === 'touch') {
      const id = resolveClickTargetNodeId(ev.target, store);
      if (id === null) return;
      clearLongPress();
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        suppressNextClickForId = id;
        store.setActiveNode(id);
      }, LONG_PRESS_DELAY);
      return;
    }
    // Mouse bare click — let the `click` handler navigate. If the user clicks
    // before the hover-open delay elapsed, we cancel the pending open so the
    // panel doesn't pop up after they've navigated away.
    clearHoverOpen();
  };

  const onPointerUpOrCancel = (): void => {
    clearLongPress();
  };

  const onPointerMove = (ev: Event): void => {
    // Cancel long-press if the finger drifts (touch scroll / accidental
    // movement). Mouse pointermove is irrelevant — its long-press timer
    // is never armed.
    const pe = ev as PointerEvent;
    if (pe.pointerType !== 'touch') return;
    if (longPressTimer !== null) {
      clearLongPress();
    }
  };

  // click + auxclick: drive ALL navigation (bare-click and new-tab) via
  // handlePrimary. Bare click navigates; Cmd/Ctrl/middle opens new tab.
  // If handlePrimary returns false (unresolved link, etc.), bare-click
  // falls through to opening the popover so the user can act on it.
  //
  // Firefox historically fires BOTH `click` and `auxclick` for middle-
  // click. Filter `click` with button === 1 so middle-click only goes
  // through auxclick once.
  const onMouseActivate = (ev: Event): void => {
    const me = ev as MouseEvent;
    if (me.button === 2) return;
    if (me.type === 'click' && me.button === 1) return;
    const id = resolveClickTargetNodeId(ev.target, store);
    if (id === null) return;
    // Long-press just opened the popover — swallow the synthetic click
    // so we don't immediately navigate over the panel the user just
    // surfaced. Clear the flag unconditionally on ANY click (the synthetic
    // click may target a different element after finger drift); only
    // suppress when the id matches.
    if (suppressNextClickForId !== null) {
      const shouldSuppress = suppressNextClickForId === id;
      suppressNextClickForId = null;
      if (shouldSuppress) {
        me.preventDefault?.();
        return;
      }
    }
    const newTab = me.metaKey || me.ctrlKey || me.button === 1;
    const reg = store.getRegistration(id);
    if (reg?.handlePrimary) {
      const handled = reg.handlePrimary({ nodeId: id, type: reg.type, newTab });
      if (handled) {
        me.preventDefault?.();
        // Hover may have left the popover open; close it now that the
        // user navigated. (Hash-route navigation often keeps the editor
        // mounted, so we need an explicit close.)
        if (!newTab) {
          clearHoverOpen();
          clearHoverClose();
          if (store.getActiveNode() === id) store.setActiveNode(null);
        }
        return;
      }
    }
    // Unhandled bare click — fall through to opening the popover (e.g.
    // unresolved page link → user needs to see the "Create page" action).
    if (newTab) return;
    clearHoverOpen();
    clearHoverClose();
    store.setActiveNode(id);
  };

  // Keyboard activation (WCAG 2.1.1 keyboard parity): Enter on a focused
  // chip with `role="link"` navigates; Space activates `role="button"`
  // chips (wiki-link). Both route through handlePrimary first; fall through
  // to opening the popover on return-false (unresolved links).
  //
  // Escape dismisses the active popover for users who don't have a visible
  // close button to click.
  //
  // Tab from a focused chip whose popover is open moves focus into the
  // popover. The chip is not a Radix Trigger, so Radix's built-in focus
  // link doesn't apply — we synthesize it.
  const onKeyDown = (ev: Event): void => {
    const ke = ev as KeyboardEvent;
    if (ke.key === 'Escape') {
      if (store.getActiveNode() !== null) {
        clearHoverOpen();
        clearHoverClose();
        store.setActiveNode(null);
        ke.preventDefault?.();
      }
      return;
    }
    // Tab into popover: only intercept forward-Tab from the focused chip
    // when the popover for that chip is open. Shift+Tab stays as the
    // browser default (moves focus before the chip).
    if (ke.key === 'Tab' && !ke.shiftKey && !ke.altKey && !ke.metaKey && !ke.ctrlKey) {
      const id = resolveClickTargetNodeId(ev.target, store);
      if (id !== null && store.getActiveNode() === id) {
        const panel = document.querySelector<HTMLElement>('[data-ok-prop-panel]');
        if (panel) {
          const focusable = panel.querySelector<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          );
          if (focusable) {
            ke.preventDefault?.();
            focusable.focus();
            return;
          }
        }
      }
      return;
    }
    const isEnter = ke.key === 'Enter';
    const isSpace = ke.key === ' ' || ke.key === 'Spacebar';
    if (!isEnter && !isSpace) return;
    const id = resolveClickTargetNodeId(ev.target, store);
    if (id === null) return;
    // Per WAI-ARIA: `role="link"` activates on Enter only — Space should
    // scroll the page. `role="button"` activates on both. Resolve the role
    // off the focused chip element so the rule travels with the chip.
    if (isSpace) {
      const focused = ev.target instanceof Element ? ev.target : null;
      const chip = focused?.closest('[data-mark-id], [data-node-id]') ?? null;
      if (chip?.getAttribute('role') === 'link') return;
    }
    const reg = store.getRegistration(id);
    const newTab = false;
    ke.preventDefault?.();
    if (reg?.handlePrimary) {
      const handled = reg.handlePrimary({ nodeId: id, type: reg.type, newTab });
      if (handled) {
        clearHoverOpen();
        clearHoverClose();
        if (store.getActiveNode() === id) store.setActiveNode(null);
        return;
      }
    }
    store.setActiveNode(id);
  };

  // Document-level pointerover/out: drive the hover state machine for both
  // chip enters/leaves AND popover enters/leaves. We use pointerover/out
  // (bubbling) so a single document-level listener catches events on the
  // editor surface AND on the Radix-portaled popover content. Mouse only —
  // touch is handled via the long-press path on pointerdown.
  const onDocPointerOver = (ev: Event): void => {
    const pe = ev as PointerEvent;
    if (pe.pointerType !== 'mouse') return;
    const target = pe.target;
    if (!(target instanceof Element)) return;
    // Entering the popover for the active chip — cancel any pending close
    // so the popover stays sticky while the pointer is on it.
    if (isInsidePropPanel(target)) {
      clearHoverClose();
      return;
    }
    const id = resolveClickTargetNodeId(target, store);
    if (id === null) return;
    scheduleHoverOpen(id);
  };

  const onDocPointerOut = (ev: Event): void => {
    const pe = ev as PointerEvent;
    if (pe.pointerType !== 'mouse') return;
    const target = pe.target;
    const related = pe.relatedTarget;
    if (!(target instanceof Element)) return;
    const relatedEl = related instanceof Element ? related : null;
    // Leaving a chip — if going to its own popover, stay open. Otherwise
    // cancel pending open + schedule close.
    const fromChipId = resolveClickTargetNodeId(target, store);
    if (fromChipId !== null) {
      if (relatedEl && isInsidePropPanel(relatedEl)) {
        clearHoverClose();
        return;
      }
      if (relatedEl && resolveClickTargetNodeId(relatedEl, store) === fromChipId) {
        return;
      }
      if (hoverOpenTargetId === fromChipId) clearHoverOpen();
      scheduleHoverClose();
      return;
    }
    // Leaving the popover — if going to the active chip, stay open;
    // otherwise schedule close.
    if (isInsidePropPanel(target)) {
      if (relatedEl && isInsidePropPanel(relatedEl)) return;
      const activeId = store.getActiveNode();
      if (
        activeId !== null &&
        relatedEl &&
        resolveClickTargetNodeId(relatedEl, store) === activeId
      ) {
        return;
      }
      scheduleHoverClose();
    }
  };

  // Focusin: keyboard tab onto a chip opens the popover immediately (no
  // hover delay). Focusout: if focus is leaving for somewhere outside the
  // chip+popover, schedule close.
  const onFocusIn = (ev: Event): void => {
    // Synthetic focusin fired by our own focus-restoration after Escape /
    // Enter-to-navigate — don't reopen the popover the user just dismissed.
    if (restoringFocus) return;
    const fe = ev as FocusEvent;
    const target = fe.target;
    if (!(target instanceof Element)) return;
    const id = resolveClickTargetNodeId(target, store);
    if (id === null) return;
    clearHoverOpen();
    clearHoverClose();
    store.setActiveNode(id);
  };

  const onFocusOut = (ev: Event): void => {
    const fe = ev as FocusEvent;
    const activeId = store.getActiveNode();
    if (activeId === null) return;
    const next = fe.relatedTarget;
    const nextEl = next instanceof Element ? next : null;
    // Focus leaving for the popover itself or its descendants — stay open.
    if (nextEl && isInsidePropPanel(nextEl)) return;
    // Focus moving to any recognized chip (the same chip's own subtree, or a
    // sibling chip during Tab navigation) — let that chip's `focusin` drive
    // activation instead of scheduling a close we'd immediately cancel.
    if (nextEl && resolveClickTargetNodeId(nextEl, store) !== null) return;
    scheduleHoverClose();
  };

  // Outside click — defense in depth. Radix Popover's own onInteractOutside
  // also fires onOpenChange(false) for clicks outside the content, but this
  // hand-written handler predates Radix and provides the `data-ok-layer-
  // spawned` carve-out for our Edit dialogs.
  const onOutsideClick = (ev: Event): void => {
    if (store.getActiveNode() === null) return;
    const target = ev.target as Node | null;
    if (!target) return;
    if (editorDom?.contains(target)) return;
    if (target instanceof Element) {
      if (target.closest('[data-ok-interaction-layer]')) return;
      if (target.closest('[data-ok-prop-panel]')) return;
      const spawnedDialog = target.closest('[data-ok-layer-spawned]');
      if (spawnedDialog) return;
    }
    clearHoverOpen();
    clearHoverClose();
    store.setActiveNode(null);
  };

  const attachListeners = (): void => {
    if (listenersAttached) return;
    editorDom = getEditorDom(editor);
    if (!editorDom) return;
    editorDom.addEventListener('pointerdown', onPointerDown, true);
    editorDom.addEventListener('pointerup', onPointerUpOrCancel, true);
    editorDom.addEventListener('pointercancel', onPointerUpOrCancel, true);
    editorDom.addEventListener('pointermove', onPointerMove, true);
    editorDom.addEventListener('click', onMouseActivate, true);
    editorDom.addEventListener('auxclick', onMouseActivate, true);
    editorDom.addEventListener('keydown', onKeyDown, true);
    if (typeof document !== 'undefined') {
      // Document-level capture catches events on portaled popover content too.
      document.addEventListener('pointerover', onDocPointerOver, true);
      document.addEventListener('pointerout', onDocPointerOut, true);
      document.addEventListener('focusin', onFocusIn, true);
      document.addEventListener('focusout', onFocusOut, true);
      document.addEventListener('pointerdown', onOutsideClick, true);
    }
    listenersAttached = true;
  };

  const detachListeners = (): void => {
    if (!listenersAttached) return;
    editorDom?.removeEventListener('pointerdown', onPointerDown, true);
    editorDom?.removeEventListener('pointerup', onPointerUpOrCancel, true);
    editorDom?.removeEventListener('pointercancel', onPointerUpOrCancel, true);
    editorDom?.removeEventListener('pointermove', onPointerMove, true);
    editorDom?.removeEventListener('click', onMouseActivate, true);
    editorDom?.removeEventListener('auxclick', onMouseActivate, true);
    editorDom?.removeEventListener('keydown', onKeyDown, true);
    if (typeof document !== 'undefined') {
      document.removeEventListener('pointerover', onDocPointerOver, true);
      document.removeEventListener('pointerout', onDocPointerOut, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('pointerdown', onOutsideClick, true);
    }
    listenersAttached = false;
  };

  attachListeners();

  return {
    register(p) {
      store.register(p);
      if (!listenersAttached) attachListeners();
    },
    deregister(id) {
      store.deregister(id);
    },
    setActiveNode(id) {
      store.setActiveNode(id);
    },
    getActiveNode() {
      return store.getActiveNode();
    },
    getRegistration(id) {
      return store.getRegistration(id);
    },
    destroy() {
      detachListeners();
      clearHoverOpen();
      clearHoverClose();
      clearLongPress();
      unsubscribeFocus();
      store.clear();
    },
    store,
  };
}

/**
 * `<InteractionLayerView>` — React component that subscribes to a store and
 * renders the active registration's controls (PropPanel, Toolbar, Breadcrumb).
 *
 * Render this INSIDE the main React tree (e.g. from `<TiptapEditor>`'s
 * wrapper) so the PropPanel renderers have access to React context providers
 * like `<PageListProvider>`, `<ThemeProvider>`, `<DocumentContext>`, etc.
 *
 * The wrapping div carries `data-ok-interaction-layer` — the layer's
 * outside-click handler uses this marker to detect clicks INSIDE the
 * PropPanel/dialogs and avoid dismissing them as "outside".
 */
export const InteractionLayerView: FC<{ store: InteractionLayerStore }> = ({ store }) => {
  return (
    <div data-ok-interaction-layer="" className="contents">
      <InteractionLayerRoot store={store} />
    </div>
  );
};
