/**
 * Standalone terminal window — a dedicated `--ok-mode=terminal` window whose
 * content is the multi-session terminal (tab strip + sessions) full-window.
 *
 * Modeled on `navigator-window.ts`: same renderer bundle, a distinct window
 * mode, and the dual-signal show gate. Differs in two ways that make the
 * terminal a first-class peer rather than a launcher:
 *   - It records itself in the windowId-keyed `terminalWindows` registry (and
 *     never in `windowsByPath`), so `ok:pty:create` can resolve its cwd +
 *     consent path and multiple terminal windows for the same project coexist
 *     instead of focusing an existing one.
 *   - It wires the per-window PTY reap so closing the window kills its shells.
 *
 * When launched from a project it inherits that project's collab/api server
 * (attach-mode); launched project-less it carries empty collab/api argv and a
 * home-cwd shell (resolved in the create handler).
 */

import { basename } from 'node:path';
import type { ShowGateRegistry } from './show-gate.ts';
import { type TerminalReaper, wireWindowTerminalReap } from './terminal-lifecycle.ts';
import {
  registerTerminalWindow,
  type TerminalWindowContext,
  unregisterTerminalWindow,
} from './terminal-window-registry.ts';
import type { BrowserWindowLike } from './window-manager.ts';

/** A created window exposing the numeric `id` the reap + registry wiring needs.
 *  The real Electron `BrowserWindow` always has `id`; `BrowserWindowLike` omits
 *  it because most window plumbing keys off the window object, not its id. */
export type TerminalBrowserWindow = BrowserWindowLike & { readonly id: number };

/** Project context a terminal window inherits (attach-mode). Null = project-less. */
export interface TerminalWindowProject {
  readonly projectPath: string;
  readonly projectName: string;
  readonly collabUrl: string;
  readonly apiOrigin: string;
}

interface CreateTerminalWindowDeps {
  /** Creates the real BrowserWindow (with `show: false`); the show gate reveals it. */
  createWindow(opts: { additionalArguments: string[]; title: string }): TerminalBrowserWindow;
  /** Path to the built renderer HTML (packaged/prod). */
  rendererEntryPath: string;
  /** electron-vite dev-server URL for HMR; when set, `loadURL` is used over `loadFile`. */
  rendererDevUrl?: string | null;
  /** App version, passed to the preload via additionalArguments. */
  appVersion: string;
  /** Dual-signal show coordinator — terminal windows get `kind: 'terminal'`. */
  showGate: ShowGateRegistry;
  /** PTY reap surface so a closed terminal window never leaks its shells. */
  terminalReaper: TerminalReaper;
  /** Inherited project context (attach-mode), or null for a home-cwd window. */
  project: TerminalWindowProject | null;
}

const GENERIC_TITLE = 'Open Knowledge Terminal';

export function createTerminalWindow(deps: CreateTerminalWindowDeps): TerminalBrowserWindow {
  const { project } = deps;
  const title = project ? `${GENERIC_TITLE} — ${project.projectName}` : GENERIC_TITLE;
  const window = deps.createWindow({
    additionalArguments: [
      '--ok-mode=terminal',
      `--ok-app-version=${deps.appVersion}`,
      // Attach-mode: inherit the launching project's collab + api server so the
      // window shares its config / consent / MCP. A project-less window omits
      // them (the renderer's useCollabUrl short-circuit returns empty) and runs
      // a home-cwd shell.
      `--ok-collab-url=${project?.collabUrl ?? ''}`,
      `--ok-api-origin=${project?.apiOrigin ?? ''}`,
      `--ok-project-path=${project?.projectPath ?? ''}`,
      `--ok-project-name=${project?.projectName ?? GENERIC_TITLE}`,
    ],
    title,
  });

  // Record the window's cwd + attach context BEFORE the renderer loads, so the
  // first `ok:pty:create` resolves a shell. Terminal windows are deliberately
  // absent from `windowsByPath` (one-per-project, focus-existing), so this is
  // their only cwd/consent source. projectRoot is null when project-less; the
  // create handler falls back to homedir().
  registerTerminalWindow(window.id, {
    projectRoot: project?.projectPath ?? null,
    collabUrl: project?.collabUrl,
    apiOrigin: project?.apiOrigin,
  });

  // Closing the window reaps its PTY host (no orphan shells) and drops its
  // registry entry. The reap wiring captures the id eagerly (the window is
  // destroyed by the time `closed` fires).
  wireWindowTerminalReap(window, deps.terminalReaper);
  const disposeShowGate = deps.showGate.register(window, { kind: 'terminal' });
  window.on('closed', () => {
    disposeShowGate();
    unregisterTerminalWindow(window.id);
  });

  // Surface load failures with a grep-able structured warn (mirrors the
  // Navigator factory) rather than discarding the rejection — the show gate's
  // 5 s safety timeout still reveals the (blank) window so failure is visible.
  const loadPromise = deps.rendererDevUrl
    ? window.loadURL(deps.rendererDevUrl)
    : window.loadFile(deps.rendererEntryPath);
  loadPromise.catch((err: unknown) => {
    console.warn(
      JSON.stringify({
        event: 'terminal-load-failed',
        // Terminal windows are multi-instance (unlike the single Navigator), so
        // attribute the failure to the specific window.
        windowId: window.id,
        target: deps.rendererDevUrl ?? deps.rendererEntryPath,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  });

  return window;
}

/** The editor-window project fields the resolver reads. The full `ProjectContext`
 *  (window-manager.ts) is structurally assignable to this. */
interface EditorProjectContext {
  readonly projectPath: string;
  readonly projectName: string;
  readonly port: number;
  readonly apiOrigin: string;
}

/**
 * Resolve the project a new terminal window inherits from the focused window.
 * An editor window's context (from `windowsByPath`) wins — its collab URL is
 * derived from the port the same way editor windows build their `--ok-collab-url`
 * argv. Otherwise a focused terminal window's registry context lets "New
 * Terminal Window" chain within the same project. Returns null when neither
 * resolves (the Navigator, no focused window, or a project-less terminal window)
 * so the new window opens project-less (home cwd).
 */
export function resolveTerminalWindowProject(args: {
  readonly editor: EditorProjectContext | null;
  readonly terminal: TerminalWindowContext | undefined;
}): TerminalWindowProject | null {
  if (args.editor) {
    return {
      projectPath: args.editor.projectPath,
      projectName: args.editor.projectName,
      collabUrl: `ws://localhost:${args.editor.port}/collab`,
      apiOrigin: args.editor.apiOrigin,
    };
  }
  if (args.terminal?.projectRoot) {
    return {
      projectPath: args.terminal.projectRoot,
      projectName: basename(args.terminal.projectRoot),
      collabUrl: args.terminal.collabUrl ?? '',
      apiOrigin: args.terminal.apiOrigin ?? '',
    };
  }
  return null;
}
