import type { Page } from '@playwright/test';

const ROSTER_TIMEOUT_MS = 30_000;

export function threadRosterDelivered(page: Page, onRoster?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('thread socket never delivered its roster')),
      ROSTER_TIMEOUT_MS,
    );
    page.once('close', () => clearTimeout(timer));
    page.on('websocket', (socket) => {
      if (!socket.url().includes('/collab/thread')) return;
      socket.on('framereceived', (frame) => {
        if (typeof frame.payload !== 'string' || !frame.payload.includes('"op":"threads"')) return;
        onRoster?.();
        clearTimeout(timer);
        resolve();
      });
    });
  });
}
