/**
 * The renderer-facing `slides` bridge slice, extracted from the preload's
 * `exposeInMainWorld` object so it can run against a fake invoker in tests.
 *
 * Why this is its own module: the slice is not a pass-through. Both methods
 * narrow a discriminated wire union (`ok:slides:dispatch` answers `status | open`)
 * and THROW when main returns the wrong arm — a real guard against a handler
 * regression that would otherwise reach the renderer as a plausible-looking
 * object of the wrong shape. Inline in `preload/index.ts` that logic is
 * unreachable from tests: the module calls `contextBridge.exposeInMainWorld` at
 * import time, so a renderer test can only fake the whole slice, which replaces
 * the narrowing instead of exercising it.
 *
 * Taking `IpcInvoker` as a parameter is the shape `ipc-invoke.ts` already
 * documents for preload helpers. The seam is carved at the true external
 * boundary — the IPC call — so everything above it (narrowing, guards) is the
 * real production code in both production and test.
 */

import type { OkSlidesOpenResult, OkSlidesStatusResult } from '../shared/ipc-channels.ts';
import type { IpcInvoker } from '../shared/ipc-invoke.ts';

export interface SlidesBridge {
  status(): Promise<OkSlidesStatusResult>;
  open(docPath: string): Promise<OkSlidesOpenResult>;
}

export function createSlidesBridge(invoke: IpcInvoker): SlidesBridge {
  return {
    // Single discriminated channel (`ok:slides:dispatch`). The result is a union
    // (status | open), so each method narrows on `result.kind` and throws if the
    // wire returns the wrong arm — mirrors the `ok:sharing:dispatch` preload.
    status: async () => {
      const result = await invoke('ok:slides:dispatch', { kind: 'status' });
      if (result.kind !== 'status') {
        throw new Error('ok:slides:dispatch: expected status result');
      }
      return result;
    },
    open: async (docPath: string) => {
      const result = await invoke('ok:slides:dispatch', { kind: 'open', docPath });
      if (result.kind !== 'open') {
        throw new Error('ok:slides:dispatch: expected open result');
      }
      return result;
    },
  };
}
