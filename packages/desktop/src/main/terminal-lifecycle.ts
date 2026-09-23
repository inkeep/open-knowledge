import type { AppShutdownCause } from './terminal-manager.ts';

export interface TerminalReaper {
  noteAppShutdown(cause: AppShutdownCause): void;
  killForWindow(windowId: number): void;
  killAll(cause: AppShutdownCause): Promise<void>;
}

export interface ClosableWindow {
  readonly id: number;
  on(event: 'closed', cb: () => void): void;
}

export function wireWindowTerminalReap(
  win: ClosableWindow,
  reaper: TerminalReaper,
  onReap?: (windowId: number) => void,
): void {
  const windowId = win.id;
  win.on('closed', () => {
    reaper.killForWindow(windowId);
    onReap?.(windowId);
  });
}
