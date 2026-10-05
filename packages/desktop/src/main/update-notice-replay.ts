import { type SendableWebContents, sendToRenderer } from '../shared/ipc-send.ts';

export interface UpdateNoticeSource {
  getPendingUpdate(): { version: string } | null;
  getActiveWhatsNew(): { version: string; releaseUrl: string } | null;
}

export interface UpdateNoticeReplayTarget extends SendableWebContents {
  on(event: 'did-finish-load', listener: () => void): unknown;
  once(event: 'destroyed', listener: () => void): unknown;
  removeListener(event: 'did-finish-load', listener: () => void): unknown;
}

export interface LoadStateWebContents extends SendableWebContents {
  isLoading(): boolean;
  getURL(): string;
}

function deliverUpdateNotices(
  webContents: SendableWebContents,
  source: UpdateNoticeSource | null,
): void {
  if (source === null || webContents.isDestroyed?.() === true) return;
  const pending = source.getPendingUpdate();
  if (pending) sendToRenderer(webContents, 'ok:update:downloaded', pending);
  const whatsNew = source.getActiveWhatsNew();
  if (whatsNew) sendToRenderer(webContents, 'ok:update:whats-new', whatsNew);
}

const replaying = new WeakSet<UpdateNoticeReplayTarget>();

export function replayUpdateNoticesOnEveryLoad(
  webContents: UpdateNoticeReplayTarget,
  getSource: () => UpdateNoticeSource | null,
): void {
  if (replaying.has(webContents)) return;
  replaying.add(webContents);
  const onLoad = (): void => {
    deliverUpdateNotices(webContents, getSource());
  };
  webContents.on('did-finish-load', onLoad);
  webContents.once('destroyed', () => {
    webContents.removeListener('did-finish-load', onLoad);
  });
}

export function deliverUpdateNoticesToLoadedWindows(
  webContentsList: readonly LoadStateWebContents[],
  source: UpdateNoticeSource | null,
): void {
  for (const webContents of webContentsList) {
    if (webContents.isDestroyed?.() === true) continue;
    if (webContents.isLoading() || webContents.getURL() === '') continue;
    deliverUpdateNotices(webContents, source);
  }
}
