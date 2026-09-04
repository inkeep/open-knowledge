import type { PanelTab } from './DocPanel';
import type { PanelScope } from './PanelScopeHeader';

type DocPanelTab = PanelTab;

const DOC_PANEL_TAB_EVENT = 'open-knowledge:doc-panel-tab';
let pendingRequestedTab: DocPanelTab | null = null;

export interface DocPanelTabRequest {
  readonly scope?: PanelScope;
  readonly focus?: 'panel';
}

type DocPanelTabRequestHandler = (tab: DocPanelTab, request: DocPanelTabRequest) => void;

type DocPanelTabEventTarget = Pick<Window, 'dispatchEvent'> | EventTarget;

interface DocPanelTabDetail extends DocPanelTabRequest {
  readonly tab: DocPanelTab;
}

function defaultTarget(): EventTarget {
  return typeof window === 'undefined' ? new EventTarget() : window;
}

export function consumePendingDocPanelTabRequest(): DocPanelTab | null {
  const next = pendingRequestedTab;
  pendingRequestedTab = null;
  return next;
}

let pendingPanelRequest: { tab: DocPanelTab; request: DocPanelTabRequest } | null = null;
let cancelPendingPanelRequestExpiry: (() => void) | null = null;

function clearPendingPanelRequest(): void {
  pendingPanelRequest = null;
  cancelPendingPanelRequestExpiry?.();
  cancelPendingPanelRequestExpiry = null;
}

function schedulePendingPanelRequestExpiry(
  pending: NonNullable<typeof pendingPanelRequest>,
): () => void {
  let firstFrame: number | null = null;
  let secondFrame: number | null = null;
  let backstop: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (typeof cancelAnimationFrame === 'function') {
      if (firstFrame !== null) cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) cancelAnimationFrame(secondFrame);
    }
    if (backstop !== null) clearTimeout(backstop);
    if (cancelPendingPanelRequestExpiry === cancel) {
      cancelPendingPanelRequestExpiry = null;
    }
  };
  const expire = () => {
    if (pendingPanelRequest === pending) pendingPanelRequest = null;
    cancel();
  };
  if (typeof requestAnimationFrame === 'function') {
    firstFrame = requestAnimationFrame(() => {
      firstFrame = null;
      secondFrame = requestAnimationFrame(() => {
        secondFrame = null;
        expire();
      });
    });
    backstop = setTimeout(expire, 250);
  } else {
    backstop = setTimeout(expire, 0);
  }
  return cancel;
}

function shouldLatchForTarget(target: DocPanelTabEventTarget): boolean {
  return typeof window === 'undefined' || target === window;
}

export function consumePendingDocPanelRequest(tab: DocPanelTab): DocPanelTabRequest | null {
  if (pendingPanelRequest?.tab !== tab) return null;
  const { request } = pendingPanelRequest;
  clearPendingPanelRequest();
  return request;
}

export function requestDocPanelTab(
  tab: DocPanelTab,
  request: DocPanelTabRequest = {},
  target: DocPanelTabEventTarget = defaultTarget(),
): void {
  if (shouldLatchForTarget(target)) {
    pendingRequestedTab = tab;
    clearPendingPanelRequest();
    if (request.scope !== undefined || request.focus !== undefined) {
      const pending = { tab, request };
      pendingPanelRequest = pending;
      cancelPendingPanelRequestExpiry = schedulePendingPanelRequestExpiry(pending);
    }
  }
  target.dispatchEvent(
    new CustomEvent<DocPanelTabDetail>(DOC_PANEL_TAB_EVENT, {
      detail: { tab, ...request },
    }),
  );
}

export function subscribeToDocPanelTabRequests(
  onRequest: DocPanelTabRequestHandler,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | EventTarget = defaultTarget(),
): () => void {
  const listener = (event: Event) => {
    const detail =
      event instanceof CustomEvent ? (event as CustomEvent<DocPanelTabDetail>).detail : undefined;
    if (detail?.tab) onRequest(detail.tab, { scope: detail.scope, focus: detail.focus });
  };
  target.addEventListener(DOC_PANEL_TAB_EVENT, listener as EventListener);
  return () => target.removeEventListener(DOC_PANEL_TAB_EVENT, listener as EventListener);
}
