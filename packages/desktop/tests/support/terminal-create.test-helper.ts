import type { TerminalManager } from '../../src/main/terminal-manager.ts';

export function createStartedTerminal(
  manager: TerminalManager,
  request: Parameters<TerminalManager['create']>[0],
): ReturnType<TerminalManager['create']> {
  const result = manager.create(request);
  if (result.ok) {
    const attached = manager.adoptSession({
      windowId: request.windowId,
      start: true,
      ptyId: result.ptyId,
      webContents: request.webContents,
    });
    if (!attached.ok) throw new Error(attached.reason);
  }
  return result;
}

export function startedPtyId(result: ReturnType<TerminalManager['create']>): string {
  if (!result.ok) throw new Error(result.reason);
  return result.ptyId;
}
