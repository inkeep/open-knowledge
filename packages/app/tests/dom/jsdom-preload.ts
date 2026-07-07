/**
 * jsdom preload for the React-runtime test substrate.
 *
 * Installs DOM globals onto `globalThis` BEFORE any test module is evaluated.
 * Attached invocation-scoped via `bun test --preload ./tests/dom/jsdom-preload.ts`
 * (the `test:dom` script in `packages/app/package.json`). The bunfig.toml
 * preload chain is intentionally NOT mutated — the unit-tier substrate stays
 * no-DOM so production `typeof document === 'undefined'` short-circuits
 * keep their contract.
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
  url: 'http://localhost:5173',
  pretendToBeVisual: true,
});

// React's test path checks this global before installing act warnings.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const win = dom.window as unknown as Window & typeof globalThis;

// Install only the globals React 19 + DOM APIs structurally require. Order
// matters where browsers have constructors that close over `window` — copy
// the constructor refs first, then the document.
Object.assign(globalThis, {
  window: win,
  document: win.document,
  navigator: win.navigator,
  location: win.location,
  history: win.history,
  HTMLElement: win.HTMLElement,
  HTMLDivElement: win.HTMLDivElement,
  HTMLSpanElement: win.HTMLSpanElement,
  HTMLButtonElement: win.HTMLButtonElement,
  HTMLInputElement: win.HTMLInputElement,
  HTMLAnchorElement: win.HTMLAnchorElement,
  Element: win.Element,
  Node: win.Node,
  NodeList: win.NodeList,
  // React 19's act-compat path walks the DOM during fireEvent dispatch and
  // reads `NodeFilter` from globalThis (used internally by some traversal
  // helpers). Without this, any `fireEvent.*` call from
  // `@testing-library/react` inside a dom-tier test throws
  // `ReferenceError: NodeFilter is not defined`.
  NodeFilter: win.NodeFilter,
  // Radix's Select/Popper reads `DocumentFragment` from globalThis during mount
  // (portal/collection plumbing); without it a Select-bearing dom test throws
  // `ReferenceError: DocumentFragment is not defined`.

  DocumentFragment: win.DocumentFragment,
  DOMRect: win.DOMRect,
  Event: win.Event,
  CustomEvent: win.CustomEvent,
  EventTarget: win.EventTarget,
  MouseEvent: win.MouseEvent,
  KeyboardEvent: win.KeyboardEvent,
  InputEvent: win.InputEvent,
  FocusEvent: win.FocusEvent,
  PointerEvent: win.PointerEvent,
  DataTransfer: win.DataTransfer,
  // Radix's `react-focus-scope` (used inside DropdownMenu, Dialog, Popover) reads
  // `MutationObserver` from globalThis on mount; without this attach, any DOM-tier
  // test that opens a Radix focus-trap throws `ReferenceError`.
  MutationObserver: win.MutationObserver,
  ResizeObserver: class MinimalResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
});

// jsdom doesn't ship `matchMedia`; hooks like `useThemeBridge` call it for
// `(prefers-reduced-transparency: reduce)`. Install on `globalThis`, the
// `win` proxy, AND `window` so both `window.matchMedia(...)` and bare
// `matchMedia(...)` paths resolve.
const matchMediaStub = (query: string): MediaQueryList =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList;

(globalThis as { matchMedia?: typeof matchMediaStub }).matchMedia = matchMediaStub;
(win as { matchMedia?: typeof matchMediaStub }).matchMedia = matchMediaStub;

win.HTMLElement.prototype.scrollIntoView ||= () => {};

// jsdom doesn't ship MessageChannel by default; React 19's scheduler uses
// it for postTask scheduling. Polyfill if absent.
if (typeof (globalThis as { MessageChannel?: unknown }).MessageChannel === 'undefined') {
  // Minimal MessageChannel — synchronous, sufficient for scheduler smoke.
  class MinimalMessagePort {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    private peer: MinimalMessagePort | null = null;
    setPeer(peer: MinimalMessagePort) {
      this.peer = peer;
    }
    postMessage(data: unknown) {
      // Defer to microtask to mimic real port semantics.
      queueMicrotask(() => {
        if (this.peer?.onmessage) this.peer.onmessage({ data });
      });
    }
    start() {}
    close() {}
  }
  class MinimalMessageChannel {
    port1: MinimalMessagePort;
    port2: MinimalMessagePort;
    constructor() {
      this.port1 = new MinimalMessagePort();
      this.port2 = new MinimalMessagePort();
      this.port1.setPeer(this.port2);
      this.port2.setPeer(this.port1);
    }
  }
  (globalThis as { MessageChannel?: unknown }).MessageChannel = MinimalMessageChannel;
}
