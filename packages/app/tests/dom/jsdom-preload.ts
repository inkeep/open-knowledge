import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  if (!vi.isFakeTimers()) await new Promise((resolve) => setTimeout(resolve, 0));
});

const domWindow = globalThis.window as (Window & typeof globalThis) | undefined;

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

class MinimalResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= MinimalResizeObserver;

if (domWindow?.HTMLElement) {
  domWindow.HTMLElement.prototype.scrollIntoView ||= () => {};
}

if (domWindow?.HTMLElement) {
  domWindow.HTMLElement.prototype.hasPointerCapture ||= () => false;
  domWindow.HTMLElement.prototype.setPointerCapture ||= () => {};
  domWindow.HTMLElement.prototype.releasePointerCapture ||= () => {};
}

const ZERO_RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON() {
    return this;
  },
};
for (const ctor of [domWindow?.Range, domWindow?.Element, domWindow?.Text]) {
  if (!ctor) continue;
  const proto = ctor.prototype as {
    getClientRects?: () => unknown;
    getBoundingClientRect?: () => unknown;
  };
  proto.getClientRects ||= () => [];
  proto.getBoundingClientRect ||= () => ZERO_RECT;
}

if (typeof (globalThis as { MessageChannel?: unknown }).MessageChannel === 'undefined') {
  class MinimalMessagePort {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    private peer: MinimalMessagePort | null = null;
    setPeer(peer: MinimalMessagePort) {
      this.peer = peer;
    }
    postMessage(data: unknown) {
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
