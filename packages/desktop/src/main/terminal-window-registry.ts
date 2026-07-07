/**
 * windowId-keyed registry of standalone terminal windows.
 *
 * Terminal windows are deliberately NOT tracked in the window manager's
 * per-project `windowsByPath` map (which is one-per-project, focus-existing) so
 * multiple terminal windows for the same project can coexist. Because they are
 * absent from `windowsByPath`, `getContextForBrowserWindow` returns nothing for
 * them, so the `ok:pty:create` handler resolves a terminal window's cwd +
 * consent path from this registry instead.
 */

export interface TerminalWindowContext {
  /** Inherited project root, or null when the window was launched project-less. */
  readonly projectRoot: string | null;
  /** Inherited collab server URL (attach-mode) when the project's server is running. */
  readonly collabUrl?: string;
  /** Inherited API origin (attach-mode). */
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

/**
 * Resolve the cwd for an `ok:pty:create` call.
 *
 * Editor windows keep their existing per-project resolution (the project path
 * the window manager already resolved via `windowsByPath`). Terminal windows
 * resolve from the registry, falling back to `homedir` when project-less —
 * never null, because the PTY manager refuses a null root. Returns null only
 * when the window is neither (e.g. the Navigator), so the handler refuses with
 * `no-project`.
 */
export function resolvePtyProjectRoot(args: {
  readonly editorProjectPath: string | null;
  readonly terminalWindow: TerminalWindowContext | undefined;
  readonly homedir: string;
}): string | null {
  if (args.editorProjectPath) return args.editorProjectPath;
  if (args.terminalWindow) return args.terminalWindow.projectRoot ?? args.homedir;
  return null;
}
