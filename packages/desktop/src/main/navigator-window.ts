
import { registerPendingDelivery } from '../shared/ipc-send.ts';
import type { ShowGateRegistry } from './show-gate.ts';
import type { ShareNavigatorPayload } from './url-scheme.ts';
import type { BrowserWindowLike, WindowManagerDeps } from './window-manager.ts';

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
  rendererEntryPath: string;
  /** Dev-server URL injected by electron-vite (`process.env.ELECTRON_RENDERER_URL`).
   *  When set, main uses `loadURL` for HMR; otherwise falls back to `loadFile`. */
  rendererDevUrl?: string | null;
  appVersion: string;
  showGate: ShowGateRegistry;
  pendingPayload?: ShareNavigatorPayload;
}

export function createNavigatorWindow(deps: NavigatorDeps): BrowserWindowLike {
  const window = deps.createWindow({
    additionalArguments: [
      '--ok-mode=navigator',
      `--ok-app-version=${deps.appVersion}`,
      '--ok-collab-url=',
      '--ok-api-origin=',
      '--ok-project-path=',
      '--ok-project-name=Project Navigator',
    ],
    title: 'OpenKnowledge',
  });
  const disposeShowGate = deps.showGate.register(window, { kind: 'navigator' });
  window.on('closed', () => {
    disposeShowGate();
  });
  if (deps.pendingPayload) {
    const payload = deps.pendingPayload;
    registerPendingDelivery(window.webContents, 'ok:share:received', payload);
  }
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
