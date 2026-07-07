/**
 * Typed `ipcRenderer.invoke` wrapper (preload-side usage).
 *
 * Consumers: `packages/desktop/src/preload/index.ts` — the ONE place where
 * raw `ipcRenderer` is allowed (enforced by the Biome GritQL rule
 * `no-loosely-typed-webcontents-ipc`). Everything else calls through
 * `window.okDesktop` which in turn calls these wrappers.
 *
 * Why a function-returning factory instead of direct re-export of
 * `ipcRenderer.invoke`: the wrapper enforces the channel-name + args types at
 * the call site, so a typo in the channel name fails at compile time rather
 * than at runtime.
 */

import type { IpcRenderer } from 'electron';
import type { RequestChannels } from './ipc-channels.ts';

/**
 * Build a typed invoker bound to an `ipcRenderer` instance. Preload calls
 * this once at load time:
 * ```ts
 * const invoke = createInvoker(ipcRenderer);
 * invoke('ok:dialog:open-folder'); // args + result fully typed
 * ```
 */
export function createInvoker(ipc: IpcRenderer) {
  return <K extends keyof RequestChannels>(
    channel: K,
    ...args: RequestChannels[K]['args']
  ): Promise<RequestChannels[K]['result']> => ipc.invoke(channel, ...args);
}
