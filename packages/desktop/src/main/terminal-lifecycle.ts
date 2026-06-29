export interface TerminalReaper {
  killForWindow(windowId: number): void;
  killAll(): void;
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
