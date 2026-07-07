/**
 * Typed `ipcMain.handle` wrapper (main-side usage).
 *
 * Consumers: `packages/desktop/src/main/ipc-main.ts` or equivalent — the
 * main-process entry where request handlers live. The Biome GritQL rule
 * `no-loosely-typed-webcontents-ipc` forbids raw `ipcMain.handle` outside
 * allowlisted IPC wrapper files; this helper is the canonical path.
 */

import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { RequestChannels } from './ipc-channels.ts';

/**
 * Build a typed registrar bound to an `ipcMain` instance.
 *
 * Usage:
 * ```ts
 * const register = createHandler(ipcMain);
 * register('ok:dialog:open-folder', async (_event) => {
 *   const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
 *   return r.canceled ? null : (r.filePaths[0] ?? null);
 * });
 * ```
 *
 * The handler receives the full `IpcMainInvokeEvent` as its first arg so
 * handlers can access `event.sender` (webContents) when needed.
 */
export function createHandler(ipc: IpcMain) {
  return <K extends keyof RequestChannels>(
    channel: K,
    handler: (
      event: IpcMainInvokeEvent,
      ...args: RequestChannels[K]['args']
    ) => RequestChannels[K]['result'] | Promise<RequestChannels[K]['result']>,
  ): void => {
    ipc.handle(channel, (event, ...rawArgs: unknown[]) => {
      return handler(event, ...(rawArgs as RequestChannels[K]['args']));
    });
  };
}
