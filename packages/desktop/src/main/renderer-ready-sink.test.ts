import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createRendererReadySink } from './renderer-ready-sink.ts';

const CHANNELS = ['ok:mcp-wiring:renderer-ready', 'ok:onboarding:renderer-ready'] as const;

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/**
 * Minimal ipcMain stub mirroring Electron's semantics: `handle` throws on a
 * second registration for the same channel; `invoke` simulates a renderer
 * `ipcRenderer.invoke` landing on main — rejecting with the exact "No handler
 * registered" error Electron raises (the packaged-startup stderr warning this
 * sink exists to eliminate).
 */
function createIpcMainStub() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    handle(channel: string, handler: Handler): void {
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      }
      handlers.set(channel, handler);
    },
    removeHandler(channel: string): void {
      handlers.delete(channel);
    },
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      const handler = handlers.get(channel);
      if (!handler) {
        throw new Error(`No handler registered for '${channel}'`);
      }
      return handler({ sender: { id: 7 } } as unknown as IpcMainInvokeEvent, ...args);
    },
  };
}

describe('createRendererReadySink', () => {
  let real: ReturnType<typeof createIpcMainStub>;

  beforeEach(() => {
    real = createIpcMainStub();
  });

  test('registers a permanent handler for every sink channel at construction', () => {
    createRendererReadySink(real, CHANNELS);
    for (const channel of CHANNELS) {
      expect(real.handlers.has(channel)).toBe(true);
    }
  });

  test('an ack with no armed flow resolves undefined instead of "No handler registered"', async () => {
    createRendererReadySink(real, CHANNELS);
    // Before the sink, this exact invoke rejected and Electron logged the
    // packaged-startup warning; with it, the invoke settles cleanly.
    await expect(real.invoke('ok:mcp-wiring:renderer-ready')).resolves.toBeUndefined();
    await expect(real.invoke('ok:onboarding:renderer-ready')).resolves.toBeUndefined();
  });

  test('arming via the facade routes acks to the flow listener with the real event', async () => {
    const sink = createRendererReadySink(real, CHANNELS);
    const listener = vi.fn().mockReturnValue(undefined);
    sink.ipcMain.handle('ok:mcp-wiring:renderer-ready', listener);
    await expect(real.invoke('ok:mcp-wiring:renderer-ready')).resolves.toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]?.[0] as IpcMainInvokeEvent).sender.id).toBe(7);
    // The sibling channel stays unarmed and keeps absorbing.
    await expect(real.invoke('ok:onboarding:renderer-ready')).resolves.toBeUndefined();
  });

  test('facade removeHandler disarms — later acks absorb again instead of erroring', async () => {
    const sink = createRendererReadySink(real, CHANNELS);
    const listener = vi.fn();
    sink.ipcMain.handle('ok:onboarding:renderer-ready', listener);
    sink.ipcMain.removeHandler('ok:onboarding:renderer-ready');
    await expect(real.invoke('ok:onboarding:renderer-ready')).resolves.toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });

  test('re-arming after disarm works (reconfigure / next folder pick lifecycle)', async () => {
    const sink = createRendererReadySink(real, CHANNELS);
    const first = vi.fn();
    sink.ipcMain.handle('ok:mcp-wiring:renderer-ready', first);
    sink.ipcMain.removeHandler('ok:mcp-wiring:renderer-ready');
    const second = vi.fn();
    sink.ipcMain.handle('ok:mcp-wiring:renderer-ready', second);
    await real.invoke('ok:mcp-wiring:renderer-ready');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('double-arm throws, mirroring Electron second-handler semantics', () => {
    const sink = createRendererReadySink(real, CHANNELS);
    sink.ipcMain.handle('ok:mcp-wiring:renderer-ready', vi.fn());
    expect(() => sink.ipcMain.handle('ok:mcp-wiring:renderer-ready', vi.fn())).toThrow(
      /second handler/,
    );
  });

  test('non-sink channels pass through to the real ipcMain', async () => {
    const sink = createRendererReadySink(real, CHANNELS);
    const passthrough = vi.fn().mockReturnValue('ok');
    sink.ipcMain.handle('ok:mcp-wiring:confirm', passthrough);
    await expect(real.invoke('ok:mcp-wiring:confirm')).resolves.toBe('ok');
    sink.ipcMain.removeHandler('ok:mcp-wiring:confirm');
    await expect(real.invoke('ok:mcp-wiring:confirm')).rejects.toThrow(/No handler registered/);
  });

  test('listener return value and args flow through the sink', async () => {
    const sink = createRendererReadySink(real, CHANNELS);
    sink.ipcMain.handle('ok:onboarding:renderer-ready', (_event, ...args) => args);
    await expect(real.invoke('ok:onboarding:renderer-ready', 'a', 2)).resolves.toEqual(['a', 2]);
  });

  test('destroy unregisters the permanent handlers and is idempotent', async () => {
    const sink = createRendererReadySink(real, CHANNELS);
    sink.destroy();
    sink.destroy();
    await expect(real.invoke('ok:mcp-wiring:renderer-ready')).rejects.toThrow(
      /No handler registered/,
    );
  });
});
