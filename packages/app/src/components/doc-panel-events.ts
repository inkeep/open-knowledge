import type { PanelTab } from './DocPanel';
import type { PanelScope } from './PanelScopeHeader';

type DocPanelTab = PanelTab;

const DOC_PANEL_TAB_EVENT = 'open-knowledge:doc-panel-tab';
let pendingRequestedTab: DocPanelTab | null = null;

/**
 * What a request asks of the receiving panel beyond which tab to show. Every
 * field is optional and an absent one means "leave that alone", so a plain
 * "show this tab" request never overrides state the user chose themselves.
 */
export interface DocPanelTabRequest {
  /** Scope the receiving panel should switch to, for requests made on behalf of
   *  a specific document (a file row's problem badge) rather than the open one. */
  readonly scope?: PanelScope;
  /** Move focus into the requested panel after a keyboard activation. */
  readonly focus?: 'panel';
}

type DocPanelTabRequestHandler = (tab: DocPanelTab, request: DocPanelTabRequest) => void;

type DocPanelTabEventTarget = Pick<Window, 'dispatchEvent'> | EventTarget;

interface DocPanelTabDetail extends DocPanelTabRequest {
  readonly tab: DocPanelTab;
}

/** A detached target keeps a non-browser import (SSR, node test) from throwing. */
function defaultTarget(): EventTarget {
  return typeof window === 'undefined' ? new EventTarget() : window;
}

export function consumePendingDocPanelTabRequest(): DocPanelTab | null {
  const next = pendingRequestedTab;
  pendingRequestedTab = null;
  return next;
}

/**
 * Latch for request details that go out before their panel exists to hear them.
 *
 * `DocPanel` mounts a tab's body only while that tab is showing, so a request
 * that switches TO a tab only schedules the mount — the panel it names has not
 * subscribed by the time the event dispatches, and details delivered only over
 * the wire land in an empty room. Keyed by tab so intent meant for one panel
 * cannot be picked up by another. A live subscriber clears it; a panel mounting
 * afterwards consumes it instead. Latching the whole request keeps future
 * fields from silently inheriting the same delivery hole.
 *
 * `comments/reveal-queue.ts` carries the same latch for the Comments tab's
 * scope, on a channel of its own that predates this field. The two have not
 * been merged: `revealComments` becomes expressible here once the comment
 * scope moves onto this request, and until someone does that migration the
 * older channel stays the Comments tab's only route. An unconsumed request
 * expires after the next browser paint: the latch bridges the resulting React
 * commit and passive effects without depending on discrete-event scheduling,
 * but cannot change an unrelated navigation later in the session.
 */
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
    // Hidden or occluded windows may suspend animation frames indefinitely.
    // Bound the latch even when no paint arrives.
    backstop = setTimeout(expire, 250);
  } else {
    backstop = setTimeout(expire, 0);
  }
  return cancel;
}

function shouldLatchForTarget(target: DocPanelTabEventTarget): boolean {
  return typeof window === 'undefined' || target === window;
}

/** Details a request named for `tab` and no live subscriber took, once. */
export function consumePendingDocPanelRequest(tab: DocPanelTab): DocPanelTabRequest | null {
  if (pendingPanelRequest?.tab !== tab) return null;
  const { request } = pendingPanelRequest;
  clearPendingPanelRequest();
  return request;
}

export function requestDocPanelTab(
  tab: DocPanelTab,
  request: DocPanelTabRequest = {},
  // A request raised inside a popped-out note window addresses that window
  // rather than the main one, so the target stays overridable.
  target: DocPanelTabEventTarget = defaultTarget(),
): void {
  if (shouldLatchForTarget(target)) {
    pendingRequestedTab = tab;
    clearPendingPanelRequest();
    if (request.scope !== undefined || request.focus !== undefined) {
      const pending = { tab, request };
      pendingPanelRequest = pending;
      // A second animation frame runs after the React commit's passive effects,
      // including the subscriber mounted by this request. The timeout fallback
      // retains deterministic expiry for non-browser imports and tests.
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
