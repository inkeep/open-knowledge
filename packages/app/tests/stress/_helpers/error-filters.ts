export interface LogEntry {
  type: string;
  text: string;
  url?: string;
  line?: number;
}

const LOAD_FAILURE =
  /Failed to load resource|net::ERR_|Failed to fetch|error loading dynamically imported module|status of \d{3}/i;

const BENIGN_PREDICATES: Array<(e: LogEntry) => boolean> = [
  (e) => e.text.includes('favicon'),
  (e) => e.text.includes('HMR'),
  (e) => e.text.includes('[vite]'),
  (e) => !!e.url?.includes('/favicon'),
  (e) => !!e.url?.endsWith('.map'),
  (e) => !!e.url?.includes('.hot-update.'),

  (e) => !!e.url?.includes('/@vite/') && LOAD_FAILURE.test(e.text),
  (e) => !!e.url?.includes('/@fs/') && LOAD_FAILURE.test(e.text),
  (e) => !!e.url?.includes('/@id/') && LOAD_FAILURE.test(e.text),
  (e) => !!e.url?.includes('/node_modules/.vite/') && LOAD_FAILURE.test(e.text),

  (e) => e.text.includes('WebSocket is closed before the connection is established'),
  (e) =>
    (e.text.includes("WebSocket connection to 'ws://") ||
      e.text.includes('WebSocket connection to "ws://')) &&
    e.text.includes('/collab'),
  (e) => !!e.url?.includes('/collab') && e.url.startsWith('ws://'),
  (e) => e.text.includes("can't establish a connection"),
  (e) => e.text.includes('can’t establish a connection'),
];

export function filterCriticalErrors(logs: LogEntry[]): LogEntry[] {
  return logs.filter((e) => !BENIGN_PREDICATES.some((pred) => pred(e)));
}
