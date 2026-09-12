import type { EventChannels } from '../shared/ipc-events.ts';
import { sendToRenderer } from '../shared/ipc-send.ts';

export type StartupToastPayload = EventChannels['ok:onboarding:toast']['payload'];

interface StartupToastWebContents {
  isLoading(): boolean;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  on(event: 'did-finish-load', listener: () => void): unknown;
  off(event: 'did-finish-load', listener: () => void): unknown;
}

export interface StartupToastWindow {
  isDestroyed(): boolean;
  readonly webContents: StartupToastWebContents;
  once(event: 'closed', listener: () => void): unknown;
}

interface StartupToastDispatchDeps {
  getAllWindows(): readonly StartupToastWindow[];
  onWindowCreated(listener: (win: StartupToastWindow) => void): () => void;
  setTimeout(fn: () => void, ms: number): unknown;
  now(): number;
  warn(message: string, context: Record<string, unknown>): void;
}

export const STARTUP_TOAST_REDELIVERY_WINDOW_MS = 60_000;

export function dispatchStartupToastAcrossLoads(
  payload: StartupToastPayload,
  deps: StartupToastDispatchDeps,
): { deliveries: () => number } {
  const startedAt = deps.now();
  let deliveries = 0;
  const detachers: (() => void)[] = [];
  const withinWindow = () => deps.now() - startedAt <= STARTUP_TOAST_REDELIVERY_WINDOW_MS;

  const deliver = (wc: StartupToastWebContents): void => {
    if (wc.isDestroyed()) return;
    try {
      sendToRenderer(wc, 'ok:onboarding:toast', payload);
      deliveries += 1;
    } catch (err) {
      deps.warn('[main] startup reclaim toast send failed', { err });
    }
  };

  const attach = (win: StartupToastWindow): void => {
    if (win.isDestroyed()) return;
    const wc = win.webContents;
    const onLoad = (): void => {
      if (withinWindow()) deliver(wc);
    };
    wc.on('did-finish-load', onLoad);
    const detach = (): void => {
      try {
        wc.off('did-finish-load', onLoad);
      } catch {}
    };
    detachers.push(detach);
    win.once('closed', detach);
    if (!wc.isLoading()) deliver(wc);
  };

  for (const win of deps.getAllWindows()) attach(win);
  const stopCreated = deps.onWindowCreated((win) => {
    if (withinWindow()) attach(win);
  });
  deps.setTimeout(() => {
    stopCreated();
    for (const detach of detachers) detach();
  }, STARTUP_TOAST_REDELIVERY_WINDOW_MS);

  return { deliveries: () => deliveries };
}
