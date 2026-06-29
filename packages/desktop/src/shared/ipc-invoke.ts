import type { IpcRenderer } from 'electron';
import type { RequestChannels } from './ipc-channels.ts';

export function createInvoker(ipc: IpcRenderer) {
  return <K extends keyof RequestChannels>(
    channel: K,
    ...args: RequestChannels[K]['args']
  ): Promise<RequestChannels[K]['result']> => ipc.invoke(channel, ...args);
}
