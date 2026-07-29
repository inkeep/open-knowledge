/**
 * Production wiring for {@link AwarenessHeartbeat}: a Web Worker-backed ticker
 * plus a process singleton the active editor points at its awareness.
 */
import { AwarenessHeartbeat, type HeartbeatTicker } from './awareness-heartbeat';

class WorkerTicker implements HeartbeatTicker {
  private worker: Worker | null = null;

  start(onTick: () => void): void {
    // No Worker outside a browser (jsdom unit rigs, SSR) — degrade to inert
    // rather than throw; the vendored main-thread renewal still runs there.
    if (typeof Worker === 'undefined' || this.worker !== null) return;
    this.worker = new Worker(new URL('./awareness-heartbeat.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (event: MessageEvent) => {
      if (event.data === 'tick') onTick();
    };
    this.worker.postMessage('start');
  }

  stop(): void {
    if (this.worker === null) return;
    this.worker.postMessage('stop');
    this.worker.terminate();
    this.worker = null;
  }
}

let singleton: AwarenessHeartbeat | null = null;

/** The process-wide awareness heartbeat, created lazily on first use. */
export function getAwarenessHeartbeat(): AwarenessHeartbeat {
  if (singleton === null) singleton = new AwarenessHeartbeat(new WorkerTicker());
  return singleton;
}

// Under Vite HMR the module reloads, but the Web Worker + interval the singleton
// started would be orphaned. Tear it down on dispose, mirroring the ProviderPool
// singleton in DocumentContext. Production builds strip this branch entirely
// (Vite replaces `import.meta.hot` with `undefined` at build time).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    singleton?.stop();
    singleton = null;
  });
}
