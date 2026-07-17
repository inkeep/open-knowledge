/**
 * jsdom setup for the React-runtime (Tier-3) test substrate.
 *
 * Carried as a per-project `setupFiles` entry by `vitest.dom.config.ts`, which
 * runs the `*.dom.test.tsx` suite under `environment: 'jsdom'`. Vitest's jsdom
 * environment installs `window`/`document`/`navigator` and the DOM constructor
 * globals; this file only backfills the handful of globals jsdom omits but the
 * app's React components reach for at mount. Scoped to the DOM project alone, so
 * the node-env unit/integration substrate keeps `typeof document === 'undefined'`
 * short-circuits honest — no global bleed.
 */

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// React's test path checks this global before installing act warnings.
// @testing-library/react also sets it, but assert it early so the flag is live
// before the first render in a file that renders outside RTL's act wrapper.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Unmount rendered trees after every test. @testing-library/react auto-registers
// this only when a test-runner `afterEach` global is present; bun exposes one, so
// the bun DOM tier got auto-cleanup for free. Vitest runs with `globals: false`
// here, so register it explicitly to match — without it, a component re-rendered
// across tests accumulates duplicate DOM ("found multiple elements").
afterEach(() => {
  cleanup();
});

const domWindow = globalThis.window as (Window & typeof globalThis) | undefined;

// jsdom doesn't ship `matchMedia`; hooks like `useThemeBridge` call it for
// `(prefers-reduced-transparency: reduce)`. Install on `globalThis` and the
// `window` proxy so both `window.matchMedia(...)` and bare `matchMedia(...)`
// paths resolve.
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
if (domWindow) {
  (domWindow as { matchMedia?: typeof matchMediaStub }).matchMedia = matchMediaStub;
}

// jsdom doesn't ship `ResizeObserver`; Radix's Select/Popper collections read it
// from globalThis on mount.
class MinimalResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= MinimalResizeObserver;

// jsdom's `scrollIntoView` throws "not implemented"; Radix/CodeMirror call it on
// focus. Stub it if jsdom left the prototype method absent or non-functional.
if (domWindow?.HTMLElement) {
  domWindow.HTMLElement.prototype.scrollIntoView ||= () => {};
}

// jsdom doesn't ship MessageChannel; React 19's scheduler uses it for postTask
// scheduling. Node 24 provides it globally, but guard for jsdom builds that
// shadow it as undefined.
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
