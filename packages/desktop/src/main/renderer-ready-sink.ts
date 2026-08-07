/**
 * Renderer-ready mount-ack sink — a permanently-registered `ipcMain.handle`
 * for the fire-and-forget `*:renderer-ready` channels the preload invokes on
 * EVERY renderer mount (`okDesktop.mcpWiring.signalReady()` /
 * `okDesktop.onboarding.signalReady()` at module init).
 *
 * The consent flows that consume those acks (`runMcpWiringOnFirstLaunch`,
 * `requestUserConsent`) are armed only transiently — first-launch, an explicit
 * re-configure, or a Navigator folder pick. On every other boot the invoke
 * used to land on an UNREGISTERED channel, and Electron's main process logs
 * `Error occurred in handler for 'ok:…:renderer-ready': No handler registered`
 * to stderr for each one on every packaged startup. The preload's
 * `.catch(() => {})` swallows the renderer side of that rejection but cannot
 * silence main's log line; only a registered handler can.
 *
 * Design: the sink owns the REAL `ipcMain.handle` registration for its
 * channels, permanently. Flows keep their existing one-shot
 * register/removeHandler lifecycles untouched — they receive a facade whose
 * `handle`/`removeHandler` arm/disarm a listener inside the sink for sink
 * channels and delegate to the real `ipcMain` for everything else. An ack
 * arriving while no flow is armed resolves `undefined` silently (debug log)
 * instead of erroring.
 */

import type { IpcMain, IpcMainInvokeEvent } from 'electron';

/** Structurally-compatible subset of Electron's `IpcMain` (test-injectable). */
export interface SinkIpcMainLike extends Pick<IpcMain, 'handle' | 'removeHandler'> {}

interface SinkLogger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
}

export interface RendererReadySink {
  /**
   * Drop-in `ipcMain` replacement for the consent flows. `handle` on a sink
   * channel arms the sink's listener (throwing on double-arm, mirroring
   * Electron's own "second handler" semantics so flow bugs stay visible);
   * `removeHandler` disarms. Non-sink channels pass straight through to the
   * real `ipcMain`.
   */
  readonly ipcMain: SinkIpcMainLike;
  /** Unregister the permanent handlers (will-quit teardown). */
  destroy(): void;
}

type InvokeListener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

export function createRendererReadySink(
  realIpcMain: SinkIpcMainLike,
  channels: readonly string[],
  logger: SinkLogger = {
    debug: () => {},
    warn: (msg, ctx) => console.warn('[renderer-ready-sink]', msg, ctx ?? ''),
  },
): RendererReadySink {
  const sinkChannels = new Set(channels);
  const armed = new Map<string, InvokeListener>();

  for (const channel of channels) {
    realIpcMain.handle(channel, (event, ...args) => {
      const listener = armed.get(channel);
      if (!listener) {
        // Expected steady-state: a renderer mounted while no consent flow is
        // armed (e.g. every packaged boot after first-launch wiring is done).
        logger.debug('renderer-ready ack with no armed flow — absorbed', { channel });
        return undefined;
      }
      return listener(event, ...args);
    });
  }

  const facade: SinkIpcMainLike = {
    handle(channel: string, listener: InvokeListener): void {
      if (!sinkChannels.has(channel)) {
        realIpcMain.handle(channel, listener);
        return;
      }
      if (armed.has(channel)) {
        // Same failure Electron raises for a genuine double `ipcMain.handle` —
        // keep flow-lifecycle bugs loud rather than silently replacing.
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      }
      armed.set(channel, listener);
    },
    removeHandler(channel: string): void {
      if (!sinkChannels.has(channel)) {
        realIpcMain.removeHandler(channel);
        return;
      }
      armed.delete(channel);
    },
  };

  let destroyed = false;
  return {
    ipcMain: facade,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      armed.clear();
      for (const channel of channels) {
        try {
          realIpcMain.removeHandler(channel);
        } catch (err) {
          logger.warn('removeHandler threw during sink destroy', { channel, err });
        }
      }
    },
  };
}
