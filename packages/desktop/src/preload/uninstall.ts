/**
 * The self-uninstall window's half of the preload — `window.okUninstall`.
 *
 * Ships inside `preload/index.ts`'s bundle rather than as its own preload
 * entry: a sandboxed preload's `require` is a polyfill over an allowlist of
 * module names and cannot resolve a relative path, so a preload must be one
 * self-contained file, and a second rollup entry splits the module the two
 * would share into a chunk that neither can then load (see the preload block
 * in `electron.vite.config.ts`). Sharing the bundle costs nothing the renderer
 * can observe: `contextIsolation` keeps the preload's own scope unreachable
 * from the page, and `index.ts` exposes `okUninstall` INSTEAD of `okDesktop`
 * for this window — so the editor's ~90-channel bridge is genuinely absent
 * from the uninstall renderer's world.
 *
 * Main tags the window through `additionalArguments`; the flag and its reader
 * live in `shared/uninstall-preload-arg.ts`.
 */

import type {
  OkUninstallBridge,
  UninstallDispatchResult,
  UninstallIntent,
} from '@inkeep/open-knowledge-core';
import type { IpcInvoker } from '../shared/ipc-invoke.ts';

export function createUninstallBridge(invoke: IpcInvoker): OkUninstallBridge {
  return {
    ready: (): Promise<UninstallDispatchResult> =>
      invoke('ok:uninstall:dispatch', { kind: 'ready' }),
    send: (intent: UninstallIntent): Promise<UninstallDispatchResult> =>
      invoke('ok:uninstall:dispatch', intent),
  };
}
