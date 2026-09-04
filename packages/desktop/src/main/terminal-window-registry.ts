export interface TerminalWindowContext {
  readonly projectRoot: string | null;
  readonly collabUrl?: string;
  readonly apiOrigin?: string;
}

const terminalWindows = new Map<number, TerminalWindowContext>();

export function registerTerminalWindow(windowId: number, context: TerminalWindowContext): void {
  terminalWindows.set(windowId, context);
}

export function getTerminalWindowContext(windowId: number): TerminalWindowContext | undefined {
  return terminalWindows.get(windowId);
}

export function unregisterTerminalWindow(windowId: number): void {
  terminalWindows.delete(windowId);
}

export function resolvePtyProjectRoot(args: {
  readonly editorProjectPath: string | null;
  readonly terminalWindow: TerminalWindowContext | undefined;
  readonly homedir: string;
}): string | null {
  if (args.editorProjectPath) return args.editorProjectPath;
  if (args.terminalWindow) return args.terminalWindow.projectRoot ?? args.homedir;
  return null;
}
