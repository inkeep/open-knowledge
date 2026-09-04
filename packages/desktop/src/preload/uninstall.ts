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
