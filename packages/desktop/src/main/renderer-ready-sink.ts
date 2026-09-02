import type { IpcMain, IpcMainInvokeEvent } from 'electron';

export interface SinkIpcMainLike extends Pick<IpcMain, 'handle' | 'removeHandler'> {}

interface SinkLogger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
}

export interface RendererReadySink {
  readonly ipcMain: SinkIpcMainLike;
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
