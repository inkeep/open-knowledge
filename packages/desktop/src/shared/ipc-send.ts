import type { EventChannels } from './ipc-events.ts';

export interface SendableWebContents {
  send(channel: string, ...args: unknown[]): void;
  isDestroyed?(): boolean;
}

export function sendToRenderer<K extends keyof EventChannels>(
  webContents: SendableWebContents,
  channel: K,
  payload: EventChannels[K]['payload'],
): void {
  // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: typed sendToRenderer factory body (precedent #14)
  webContents.send(channel, payload);
}

export interface GateableWebContents extends SendableWebContents {
  once(event: 'dom-ready' | 'did-finish-load', listener: () => void): void;
}

export function registerPendingDelivery<K extends keyof EventChannels>(
  webContents: GateableWebContents,
  channel: K,
  payload: EventChannels[K]['payload'],
  opts?: { readonly event?: 'dom-ready' | 'did-finish-load' },
): void {
  webContents.once(opts?.event ?? 'dom-ready', () => {
    if (webContents.isDestroyed?.() === true) return;
    sendToRenderer(webContents, channel, payload);
  });
}
