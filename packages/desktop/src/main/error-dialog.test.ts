import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const dialogLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('./desktop-logger.ts', () => ({ getLogger: () => dialogLog }));

import { EventEmitter } from 'node:events';
import { showErrorDialog, showErrorDialogOnceVisible } from './error-dialog.ts';

function windowStub(destroyed: boolean): BrowserWindow {
  return { isDestroyed: () => destroyed } as unknown as BrowserWindow;
}

function hostResolving() {
  return { showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })) };
}

const ERROR_OPTIONS = expect.objectContaining({
  type: 'error',
  title: 'Cannot open this folder',
  message: 'Cannot open this folder',
  detail: '/home/me\n\nReason: home',
  buttons: ['OK'],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('showErrorDialog', () => {
  test('attaches the dialog to a live parent window so it stays above it', async () => {
    const host = hostResolving();
    const parent = windowStub(false);
    await showErrorDialog(host, parent, 'Cannot open this folder', '/home/me\n\nReason: home');
    expect(host.showMessageBox).toHaveBeenCalledTimes(1);
    expect(host.showMessageBox).toHaveBeenCalledWith(parent, ERROR_OPTIONS);
  });

  test.each([
    { label: 'no parent', parent: null },
    { label: 'a destroyed parent', parent: windowStub(true) },
  ])('shows an unattached dialog when there is $label', async ({ parent }) => {
    const host = hostResolving();
    await showErrorDialog(host, parent, 'Cannot open this folder', '/home/me\n\nReason: home');
    expect(host.showMessageBox).toHaveBeenCalledWith(ERROR_OPTIONS);
  });

  test('a dialog that throws while showing is logged instead of throwing', async () => {
    const failure = new Error('app not ready');
    const host = {
      showMessageBox: vi.fn(() => {
        throw failure;
      }),
    };
    await expect(showErrorDialog(host, null, 'title', 'body')).resolves.toBeUndefined();
    expect(dialogLog.error).toHaveBeenCalledWith(
      { title: 'title', err: failure },
      'error dialog failed to show',
    );
  });

  test('a dialog that fails to show is logged instead of rejecting', async () => {
    const failure = new Error('no display');
    const host = {
      showMessageBox: vi.fn(async () => {
        throw failure;
      }),
    };
    await expect(showErrorDialog(host, null, 'title', 'body')).resolves.toBeUndefined();
    expect(dialogLog.error).toHaveBeenCalledWith(
      { title: 'title', err: failure },
      'error dialog failed to show',
    );
  });
});

class PendingWindow extends EventEmitter {
  visible = false;
  destroyed = false;
  isVisible(): boolean {
    return this.visible;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  asBrowserWindow(): BrowserWindow {
    return this as unknown as BrowserWindow;
  }
}

function revealDeps() {
  const timers: Array<() => void> = [];
  return {
    timers,
    deps: {
      setTimeout: (cb: () => void) => {
        timers.push(cb);
        return timers.length;
      },
      clearTimeout: vi.fn(),
      timeoutMs: 8_000,
    },
  };
}

describe('showErrorDialogOnceVisible', () => {
  test('attaches to a window that is already visible', async () => {
    const host = hostResolving();
    const window = new PendingWindow();
    window.visible = true;
    await showErrorDialogOnceVisible(
      host,
      window.asBrowserWindow(),
      'title',
      'body',
      revealDeps().deps,
    );
    expect(host.showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({ title: 'title' }),
    );
  });

  test('waits for a hidden window to show, then attaches to it', async () => {
    const host = hostResolving();
    const window = new PendingWindow();
    const shown = showErrorDialogOnceVisible(
      host,
      window.asBrowserWindow(),
      'title',
      'body',
      revealDeps().deps,
    );
    await Promise.resolve();
    expect(host.showMessageBox).not.toHaveBeenCalled();
    window.visible = true;
    window.emit('show');
    await shown;
    expect(host.showMessageBox).toHaveBeenCalledTimes(1);
    expect(host.showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({ title: 'title' }),
    );
  });

  test('attaches to a minimized window once it is restored', async () => {
    const host = hostResolving();
    const window = new PendingWindow();
    const shown = showErrorDialogOnceVisible(
      host,
      window.asBrowserWindow(),
      'title',
      'body',
      revealDeps().deps,
    );
    await Promise.resolve();
    expect(host.showMessageBox).not.toHaveBeenCalled();
    window.visible = true;
    window.emit('restore');
    await shown;
    expect(host.showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({ title: 'title' }),
    );
  });

  test('shows the dialog unattached when the window is still hidden at the reveal timeout', async () => {
    const host = hostResolving();
    const window = new PendingWindow();
    const { timers, deps } = revealDeps();
    const shown = showErrorDialogOnceVisible(host, window.asBrowserWindow(), 'title', 'body', deps);
    expect(timers).toHaveLength(1);
    timers[0]?.();
    await shown;
    expect(host.showMessageBox).toHaveBeenCalledTimes(1);
    expect(host.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ title: 'title' }));
  });

  test('shows the dialog unattached when there is no window', async () => {
    const host = hostResolving();
    await showErrorDialogOnceVisible(host, null, 'title', 'body', revealDeps().deps);
    expect(host.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ title: 'title' }));
  });
});
