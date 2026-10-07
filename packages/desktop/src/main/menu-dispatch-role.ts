import type { BrowserWindow, WebContents } from 'electron';
import type { MenuDispatchRole } from '../shared/ipc-channels.ts';

export interface MenuDispatchRoleDeps {
  quit(): void;
  showAboutPanel(): void;
  resolveWindow(sender: WebContents): BrowserWindow | null;
  readonly devToolsAllowed: boolean;
}

export function applyMenuDispatchRole(
  role: MenuDispatchRole,
  sender: WebContents,
  deps: MenuDispatchRoleDeps,
): void {
  if (role === 'quit') {
    deps.quit();
    return;
  }
  if (role === 'about') {
    deps.showAboutPanel();
    return;
  }
  const win = deps.resolveWindow(sender);
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  switch (role) {
    case 'undo':
      wc.undo();
      return;
    case 'redo':
      wc.redo();
      return;
    case 'cut':
      wc.cut();
      return;
    case 'copy':
      wc.copy();
      return;
    case 'paste':
      wc.paste();
      return;
    case 'selectAll':
      wc.selectAll();
      return;
    case 'reload':
      wc.reload();
      return;
    case 'forceReload':
      wc.reloadIgnoringCache();
      return;
    case 'toggleDevTools':
      if (deps.devToolsAllowed) {
        wc.toggleDevTools();
      }
      return;
    case 'resetZoom':
      wc.setZoomLevel(0);
      return;
    case 'zoomIn':
      wc.setZoomLevel(wc.getZoomLevel() + 0.5);
      return;
    case 'zoomOut':
      wc.setZoomLevel(wc.getZoomLevel() - 0.5);
      return;
    case 'toggleFullScreen':
      win.setFullScreen(!win.isFullScreen());
      return;
    case 'minimize':
      win.minimize();
      return;
    case 'close':
      win.close();
      return;
    default:
      role satisfies never;
  }
}
