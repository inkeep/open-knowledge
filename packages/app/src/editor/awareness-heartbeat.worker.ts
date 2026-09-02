import { AWARENESS_RENEW_INTERVAL_MS } from './awareness-heartbeat';

type WorkerScope = {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};
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
