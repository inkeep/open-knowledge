/**
 * Unthrottled tick source for the awareness heartbeat. A dedicated Web Worker
 * timer is not subject to the background-tab throttling the main thread is, so
 * it keeps posting ticks on schedule while the tab is hidden — which is the
 * whole point of homing the presence keepalive off the main thread.
 */
import { AWARENESS_RENEW_INTERVAL_MS } from './awareness-heartbeat';

type WorkerScope = {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};
// In a worker context `self` is the DedicatedWorkerGlobalScope; the cast keeps
// this file typeable under the app's DOM lib without a webworker-lib reference
// that would conflict with the rest of the package.
const scope = self as unknown as WorkerScope;

let timer: ReturnType<typeof setInterval> | null = null;

scope.onmessage = (event) => {
  if (event.data === 'start') {
    if (timer === null) {
      timer = setInterval(() => scope.postMessage('tick'), AWARENESS_RENEW_INTERVAL_MS);
    }
  } else if (event.data === 'stop') {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }
};
