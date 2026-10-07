import type { BrowserWindow, WebContents } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import {
  applyMenuDispatchRole,
  type MenuDispatchRoleDeps,
} from '../../src/main/menu-dispatch-role.ts';

function makeWindow() {
  const webContents = {
    undo: vi.fn(),
    toggleDevTools: vi.fn(),
    getZoomLevel: vi.fn(() => 1),
    setZoomLevel: vi.fn(),
  };
  const win = {
    webContents,
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    setFullScreen: vi.fn(),
    minimize: vi.fn(),
    close: vi.fn(),
  };
  return { win, webContents };
}

function makeDeps(overrides: Partial<MenuDispatchRoleDeps> = {}): MenuDispatchRoleDeps {
  return {
    quit: vi.fn(),
    showAboutPanel: vi.fn(),
    resolveWindow: vi.fn(() => null),
    devToolsAllowed: true,
    ...overrides,
  };
}

const sender = {} as WebContents;

describe('applyMenuDispatchRole', () => {
  test('about shows the about panel without needing a window', () => {
    const deps = makeDeps();

    applyMenuDispatchRole('about', sender, deps);

    expect(deps.showAboutPanel).toHaveBeenCalledTimes(1);
    expect(deps.resolveWindow).not.toHaveBeenCalled();
    expect(deps.quit).not.toHaveBeenCalled();
  });

  test('quit quits the app without needing a window', () => {
    const deps = makeDeps();

    applyMenuDispatchRole('quit', sender, deps);

    expect(deps.quit).toHaveBeenCalledTimes(1);
    expect(deps.showAboutPanel).not.toHaveBeenCalled();
  });

  test('window roles act on the resolved window', () => {
    const { win, webContents } = makeWindow();
    const deps = makeDeps({ resolveWindow: vi.fn(() => win as unknown as BrowserWindow) });

    applyMenuDispatchRole('undo', sender, deps);
    applyMenuDispatchRole('zoomIn', sender, deps);
    applyMenuDispatchRole('toggleFullScreen', sender, deps);

    expect(deps.resolveWindow).toHaveBeenCalledWith(sender);
    expect(webContents.undo).toHaveBeenCalledTimes(1);
    expect(webContents.setZoomLevel).toHaveBeenCalledWith(1.5);
    expect(win.setFullScreen).toHaveBeenCalledWith(true);
  });

  test('toggleDevTools toggles dev tools when they are allowed', () => {
    const { win, webContents } = makeWindow();
    const deps = makeDeps({
      resolveWindow: vi.fn(() => win as unknown as BrowserWindow),
      devToolsAllowed: true,
    });

    applyMenuDispatchRole('toggleDevTools', sender, deps);

    expect(webContents.toggleDevTools).toHaveBeenCalledTimes(1);
  });

  test('toggleDevTools is a no-op when dev tools are not allowed', () => {
    const { win, webContents } = makeWindow();
    const deps = makeDeps({
      resolveWindow: vi.fn(() => win as unknown as BrowserWindow),
      devToolsAllowed: false,
    });

    applyMenuDispatchRole('toggleDevTools', sender, deps);

    expect(webContents.toggleDevTools).not.toHaveBeenCalled();
  });

  test('window roles do nothing when no live window resolves', () => {
    const { win } = makeWindow();
    win.isDestroyed.mockReturnValue(true);
    const deps = makeDeps({ resolveWindow: vi.fn(() => win as unknown as BrowserWindow) });

    applyMenuDispatchRole('minimize', sender, deps);

    expect(win.minimize).not.toHaveBeenCalled();
  });
});
