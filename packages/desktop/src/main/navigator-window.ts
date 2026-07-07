/**
 * Project Navigator window — transient launcher.
 *
 * Single window, no utilityProcess attached. Renders the same React bundle
 * as editor windows but with `--ok-mode=navigator` so the renderer renders
 * `<NavigatorApp />` instead of the editor shell.
 *
 * Lifecycle:
 *   - App boot: opens Navigator (unless `lastOpenedProject` was set + Option NOT held).
 *   - User picks a project → main spawns the editor BrowserWindow + utility,
 *     then closes the Navigator once `createProjectWindow` resolves (see
 *     `openProject` in `index.ts`). Failure path keeps Navigator visible via
 *     `openProjectOrFallbackToNavigator`.
 *   - Re-summoned from inside an editor via `bridge.navigator.open()`
 *     (sidebar pill, File menu, Command Palette).
 *   - Dock click while no windows visible: re-open Navigator.
 */

import { registerPendingDelivery } from '../shared/ipc-send.ts';
import type { ShowGateRegistry } from './show-gate.ts';
import type { ShareNavigatorPayload } from './url-scheme.ts';
import type { BrowserWindowLike, WindowManagerDeps } from './window-manager.ts';

/**
 * Best-effort close. A thrown `close()` must not propagate out of the
 * caller's success path — `openProject` calls this after `createProjectWindow`
 * resolves, and a propagating exception there would be caught by
 * `openProjectOrFallbackToNavigator`'s catch and shown to the user as
 * "Unable to open project" even though the project did open. The
 * `isDestroyed` guard avoids the throw on the common destroyed-window race;
 * the try/catch covers any remaining native-layer failure.
 */
export function tryCloseNavigator(
  nav: BrowserWindowLike | null,
  context: { projectPath: string },
  log: (event: string, fields: Record<string, unknown>) => void = (event, fields) =>
    console.warn(`[main] ${event}`, fields),
): void {
  try {
    if (nav && nav.isDestroyed?.() !== true) nav.close?.();
  } catch (err) {
    log('failed to close Navigator after project open', {
      projectPath: context.projectPath,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

interface NavigatorDeps {
  createWindow: WindowManagerDeps['createWindow'];
  /** Path to the built renderer HTML (used in packaged/prod mode). */
  rendererEntryPath: string;
  /** Dev-server URL injected by electron-vite (`process.env.ELECTRON_RENDERER_URL`).
   *  When set, main uses `loadURL` for HMR; otherwise falls back to `loadFile`. */
  rendererDevUrl?: string | null;
  /** App version, passed to the preload via additionalArguments. */
  appVersion: string;
  /**
   * Dual-signal window-show coordinator. Same registry the editor windows
   * use; navigator gets `kind: 'navigator'` so timeout warns are
   * distinguishable in diagnostic logs.
   */
  showGate: ShowGateRegistry;
  /**
   * Launcher-scoped share payload to deliver to the Navigator renderer once
   * its DOM is parsed. Registered as `webContents.once('dom-ready', ...)`
   * BEFORE `loadFile`/`loadURL` so the cold-start first-click works for
   * the `launcher-consent` and `launcher-miss` outcomes (mirrors the
   * `pendingDeepLinkDoc` gate in `window-manager.ts`'s editor factories).
   * When omitted, no listener is registered.
   */
  pendingPayload?: ShareNavigatorPayload;
}

export function createNavigatorWindow(deps: NavigatorDeps): BrowserWindowLike {
  const window = deps.createWindow({
    additionalArguments: [
      '--ok-mode=navigator',
      `--ok-app-version=${deps.appVersion}`,
      // Editor windows pass collab-url / project-path; navigator omits them
      // (renderer's useCollabUrl short-circuit returns null/empty when missing
      // and just renders the Navigator component).
      '--ok-collab-url=',
      '--ok-api-origin=',
      '--ok-project-path=',
      '--ok-project-name=Project Navigator',
    ],
    // Static launcher title — no project bound, so branded app name works
    // here. Editor windows override with their own `projectName` title.
    title: 'OpenKnowledge',
  });
  // Defer OS-level window display until both first-paint AND chrome-theme
  // signals arrive — same dual-signal gate as editor windows. The Navigator
  // path has no utility-process gate, so without this defer the user sees
  // the longest white-flash band of any cold-launch path. A 5 s safety
  // timeout in show-gate.ts handles the case where either signal stalls.
  const disposeShowGate = deps.showGate.register(window, { kind: 'navigator' });
  window.on('closed', () => {
    disposeShowGate();
  });
  // Launcher-scoped share payload gate — symmetric with the editor windows'
  // `pendingDeepLinkDoc` / `pendingShareBranchSwitch` gates. Register
  // `webContents.once('dom-ready', ...)` BEFORE the load is initiated so
  // the renderer's module-init `onShareReceived` listener (installed
  // synchronously at script-init) is in place before the IPC fires. Without
  // this, a cold-start launcher-scoped share races the renderer mount and
  // silently drops on the first click.
  if (deps.pendingPayload) {
    const payload = deps.pendingPayload;
    registerPendingDelivery(window.webContents, 'ok:share:received', payload);
  }
  // Load failure surfacing: bare `void` discards the rejection — a 404 / file
  // read error / network error against the dev server would leave the user
  // with a blank window and no diagnostic. Catch + structured warn so smoke-
  // test logs + dogfood crash reports have a grep-able trail. The window
  // stays open with the show-gate active; the 5 s safety timeout fires
  // window.show() on the blank renderer so failure mode is visible, not
  // silently hung.
  const loadPromise = deps.rendererDevUrl
    ? window.loadURL(deps.rendererDevUrl)
    : window.loadFile(deps.rendererEntryPath);
  loadPromise.catch((err: unknown) => {
    console.warn(
      JSON.stringify({
        event: 'navigator-load-failed',
        target: deps.rendererDevUrl ?? deps.rendererEntryPath,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  });
  return window;
}
