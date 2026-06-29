
import { type FC, useEffect, useState } from 'react';


interface InteractionLayerEditor {
  editorView?: { dom: HTMLElement };
  view?: { dom: HTMLElement };
}

export interface InteractionContext {
  nodeId: string;
  type: string;
  deactivate: () => void;
}

interface InteractionPrimaryContext {
  nodeId: string;
  type: string;
  newTab: boolean;
}

export interface InteractionControls {
  propPanel?: (ctx: InteractionContext) => React.ReactNode;
  toolbar?: (ctx: InteractionContext) => React.ReactNode;
  breadcrumb?: (ctx: InteractionContext) => React.ReactNode;
}

export interface RegisterParams {
  type: string;
  nodeId: string;
  getPos?: () => number | undefined;
  controls: InteractionControls;
  handlePrimary?: (ctx: InteractionPrimaryContext) => boolean | undefined;
}

export interface InteractionLayerHandle {
  register(params: RegisterParams): void;
  deregister(nodeId: string): void;
  setActiveNode(nodeId: string | null): void;
  getActiveNode(): string | null;
  getRegistration(nodeId: string): RegisterParams | undefined;
  destroy(): void;
  store: InteractionLayerStore;
}

interface CreateInteractionLayerParams {
  editor: InteractionLayerEditor;
}


const HOVER_OPEN_DELAY = 300;
/** Grace period after pointer leaves chip/popover before closing — lets the
 *  user move diagonally between chip and popover without the panel flickering
 *  closed. Matches the Notion/Linear popover convention. */
const HOVER_CLOSE_DELAY = 150;
const LONG_PRESS_DELAY = 500;


interface LayerSnapshot {
  activeNodeId: string | null;
  active: RegisterParams | null;
}

type Listener = () => void;

export class InteractionLayerStore {
  private readonly registry = new Map<string, RegisterParams>();
  private _activeNodeId: string | null = null;
  private readonly listeners = new Set<Listener>();
  private _snapshot: LayerSnapshot = { activeNodeId: null, active: null };

  register(params: RegisterParams): void {
    this.registry.set(params.nodeId, params);
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
 *  These dialogs MUST carry `data-ok-layer-spawned=""` — see the outside-
 *  click handler below for the rationale. */
function isLayerSpawnedDialogOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector('[data-ok-layer-spawned]') !== null;
}


interface InteractionLayerRootProps {
  store: InteractionLayerStore;
}

const InteractionLayerRoot: FC<InteractionLayerRootProps> = ({ store }) => {
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


function getEditorDom(editor: InteractionLayerEditor): HTMLElement | null {
  return editor.editorView?.dom ?? null;
}

function isPotentialChipElement(el: HTMLElement | null, nodeId: string): boolean {
  let cur: Element | null = el;
  while (cur) {
    if (cur.getAttribute?.('data-mark-id') === nodeId) return true;
    if (cur.getAttribute?.('data-node-id') === nodeId) return true;
    cur = cur.parentElement;
  }
  return false;
}

export function createInteractionLayer(
  params: CreateInteractionLayerParams,
): InteractionLayerHandle {
  const { editor } = params;
  const store = new InteractionLayerStore();

  let editorDom: HTMLElement | null = getEditorDom(editor);
  let listenersAttached = false;

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
      if (isLayerSpawnedDialogOpen()) return;
      store.setActiveNode(null);
    }, HOVER_CLOSE_DELAY);
  };

  let lastActivator: HTMLElement | null = null;
  let restoringFocus = false;
  const restoreFocusTo = (target: HTMLElement): void => {
    try {
      restoringFocus = true;
      target.focus({ preventScroll: true });
    } catch {
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


  const onPointerDown = (ev: Event): void => {
    const pe = ev as PointerEvent;
    if (pe.button === 2) return;
    const isNewTabIntent = pe.metaKey || pe.ctrlKey || pe.button === 1;
    if (isNewTabIntent) {
      clearHoverOpen();
      if (pe.button === 1) pe.preventDefault?.();
      return;
    }
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
    clearHoverOpen();
  };

  const onPointerUpOrCancel = (): void => {
    clearLongPress();
  };

  const onPointerMove = (ev: Event): void => {
    const pe = ev as PointerEvent;
    if (pe.pointerType !== 'touch') return;
    if (longPressTimer !== null) {
      clearLongPress();
    }
  };

  const onMouseActivate = (ev: Event): void => {
    const me = ev as MouseEvent;
    if (me.button === 2) return;
    if (me.type === 'click' && me.button === 1) return;
    const id = resolveClickTargetNodeId(ev.target, store);
    if (id === null) return;
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
        if (!newTab) {
          clearHoverOpen();
          clearHoverClose();
          if (store.getActiveNode() === id) store.setActiveNode(null);
        }
        return;
      }
    }
    if (newTab) return;
    clearHoverOpen();
    clearHoverClose();
    store.setActiveNode(id);
  };

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

  const onDocPointerOver = (ev: Event): void => {
    const pe = ev as PointerEvent;
    if (pe.pointerType !== 'mouse') return;
    const target = pe.target;
    if (!(target instanceof Element)) return;
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

  const onFocusIn = (ev: Event): void => {
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
    if (nextEl && isInsidePropPanel(nextEl)) return;
    if (nextEl && resolveClickTargetNodeId(nextEl, store) !== null) return;
    scheduleHoverClose();
  };

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

export const InteractionLayerView: FC<{ store: InteractionLayerStore }> = ({ store }) => {
  return (
    <div data-ok-interaction-layer="" className="contents">
      <InteractionLayerRoot store={store} />
    </div>
  );
};
