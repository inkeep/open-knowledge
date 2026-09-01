import type { OkSlidesOpenResult, OkSlidesStatusResult } from '../shared/ipc-channels.ts';
import type { IpcInvoker } from '../shared/ipc-invoke.ts';

export interface SlidesBridge {
  status(): Promise<OkSlidesStatusResult>;
  open(docPath: string): Promise<OkSlidesOpenResult>;
}

export function createSlidesBridge(invoke: IpcInvoker): SlidesBridge {
  return {
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
