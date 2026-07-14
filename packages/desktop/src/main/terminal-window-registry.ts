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

import type { RemoteProjectInfo } from '@inkeep/open-knowledge-core';

export interface TerminalWindowContext {
  /** Inherited project root, or null when the window was launched project-less. */
  readonly projectRoot: string | null;
  /** Stable display name used when chaining another terminal window. */
  readonly projectName?: string;
  /** Inherited collab server URL (attach-mode) when the project's server is running. */
  readonly collabUrl?: string;
  /** Inherited API origin (attach-mode). */
  readonly apiOrigin?: string;
  /** SSH metadata when this terminal is attached to a remote project. */
  readonly remote?: RemoteProjectInfo;
}

/**
 * Minimal native-window surface retained by the registry. Keeping this
 * structural avoids importing Electron (and keeps the registry unit-testable),
 * while still letting the remote-session owner close attached terminal
 * windows before its SSH tunnel is released.
 */
interface TerminalWindowHandle {
  close?(): void;
  destroy?(): void;
  isDestroyed?(): boolean;
}

interface TerminalWindowLifecycle {
  readonly window: TerminalWindowHandle;
  readonly reapPtys: () => void;
}

interface RegisteredTerminalWindow {
  readonly context: TerminalWindowContext;
  readonly lifecycle: TerminalWindowLifecycle;
}

const terminalWindows = new Map<number, RegisteredTerminalWindow>();

function warnTeardownFailure(event: string, windowId: number, error: unknown): void {
  console.warn(
    JSON.stringify({
      event,
      windowId,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}

export function registerTerminalWindow(
  windowId: number,
  context: TerminalWindowContext,
  lifecycle: TerminalWindowLifecycle,
): void {
  terminalWindows.set(windowId, { context, lifecycle });
}

export function getTerminalWindowContext(windowId: number): TerminalWindowContext | undefined {
  return terminalWindows.get(windowId)?.context;
}

export function unregisterTerminalWindow(windowId: number): void {
  terminalWindows.delete(windowId);
}

/**
 * Close every standalone terminal attached to one SSH-backed project.
 *
 * Remote terminal renderers inherit the editor's loopback HTTP/WebSocket
 * endpoints, so they cannot remain usable after that editor releases its SSH
 * tunnel. Local and project-less terminals are intentionally left alone: only
 * entries carrying remote metadata and the exact opaque project key match.
 *
 * Entries are revoked before touching the native window, then destroyed when
 * possible so renderer `beforeunload` cannot veto teardown. Returns the number
 * of live native windows for which destroy/close was requested. A stale
 * destroyed entry is pruned defensively.
 */
export function closeTerminalWindowsForProject(projectRoot: string): number {
  let closeRequests = 0;
  for (const [windowId, registered] of terminalWindows) {
    if (registered.context.remote === undefined || registered.context.projectRoot !== projectRoot) {
      continue;
    }

    // Revoke the main-process project/remote authority synchronously. Even if
    // later cleanup fails, this renderer cannot create another PTY or run a
    // fresh remote probe while the editor releases its session.
    terminalWindows.delete(windowId);
    const { window, reapPtys } = registered.lifecycle;
    // Reap the PTY host before touching the native window. `destroy()` normally
    // emits `closed`, whose lifecycle listener reaps again, but native teardown
    // can throw. Revoking the shell here makes cleanup deterministic even then;
    // TerminalManager.killForWindow is idempotent.
    try {
      reapPtys();
    } catch (error) {
      warnTeardownFailure('remote-terminal-pty-reap-failed', windowId, error);
    }
    if (window.isDestroyed?.() === true) {
      continue;
    }
    if (window.destroy) {
      try {
        window.destroy();
        closeRequests += 1;
      } catch (error) {
        warnTeardownFailure('remote-terminal-window-destroy-failed', windowId, error);
        // Fall back to a graceful close if a force-destroy unexpectedly fails.
        // The registry entry is already gone and its PTYs have been reaped.
        try {
          window.close?.();
          if (window.close) closeRequests += 1;
        } catch (closeError) {
          warnTeardownFailure('remote-terminal-window-close-failed', windowId, closeError);
        }
      }
    } else if (window.close) {
      try {
        window.close();
        closeRequests += 1;
      } catch (error) {
        warnTeardownFailure('remote-terminal-window-close-failed', windowId, error);
      }
    }
  }
  return closeRequests;
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

/**
 * Revalidate the window-owned authority captured before an asynchronous PTY
 * consent probe. Object identity is intentional: a replacement editor or a
 * revoked standalone-terminal registration must not inherit the completed
 * probe and create a shell for the old window.
 */
export function isPtyWindowAuthorityCurrent(args: {
  readonly sameWindow: boolean;
  readonly windowDestroyed: boolean;
  readonly senderDestroyed: boolean;
  readonly capturedEditorContext: unknown | null;
  readonly liveEditorContext: unknown | null;
  readonly capturedTerminalWindow: TerminalWindowContext | undefined;
  readonly liveTerminalWindow: TerminalWindowContext | undefined;
}): boolean {
  if (!args.sameWindow || args.windowDestroyed || args.senderDestroyed) return false;
  if (args.capturedEditorContext !== null) {
    return args.liveEditorContext === args.capturedEditorContext;
  }
  return (
    args.capturedTerminalWindow !== undefined &&
    args.liveTerminalWindow === args.capturedTerminalWindow
  );
}

/** Sender-owned project authority for local filesystem/process operations. */
export interface WindowProjectAuthority {
  readonly projectPath: string;
  readonly remote: boolean;
}

/** True only when the sender owns this exact local project path. */
export function hasLocalProjectAuthority(
  authority: WindowProjectAuthority | null,
  requestedProjectPath: unknown,
): boolean {
  return (
    typeof requestedProjectPath === 'string' &&
    authority !== null &&
    !authority.remote &&
    authority.projectPath === requestedProjectPath
  );
}

/**
 * Resolve project identity consistently for editor and standalone terminal
 * windows. Editor context wins when both are present. A project-less terminal
 * and the Navigator have no project authority; an SSH-backed context remains
 * identifiable even though its opaque project key is not a local path.
 */
export function resolveWindowProjectAuthority(args: {
  readonly editorProjectPath: string | null | undefined;
  readonly editorRemote: RemoteProjectInfo | undefined;
  readonly terminalWindow: TerminalWindowContext | undefined;
}): WindowProjectAuthority | null {
  if (args.editorProjectPath) {
    return { projectPath: args.editorProjectPath, remote: args.editorRemote !== undefined };
  }
  if (args.terminalWindow?.projectRoot) {
    return {
      projectPath: args.terminalWindow.projectRoot,
      remote: args.terminalWindow.remote !== undefined,
    };
  }
  return null;
}
