
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { RequestChannels } from './ipc-channels.ts';

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
