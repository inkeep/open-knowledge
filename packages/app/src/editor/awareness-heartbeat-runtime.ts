import { AwarenessHeartbeat, type HeartbeatTicker } from './awareness-heartbeat';

class WorkerTicker implements HeartbeatTicker {
  private worker: Worker | null = null;

  start(onTick: () => void): void {
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

export function getAwarenessHeartbeat(): AwarenessHeartbeat {
  if (singleton === null) singleton = new AwarenessHeartbeat(new WorkerTicker());
  return singleton;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    singleton?.stop();
    singleton = null;
  });
}
