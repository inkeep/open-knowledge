import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  UninstallDispatchRequest,
  UninstallDispatchResult,
} from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { runDesktopUninstallResultWindow } from '../../src/main/desktop-uninstall-result-window.ts';

const mocks = vi.hoisted(() => ({
  exit: vi.fn(),
  events: new Map<string, () => void>(),
  handle:
    vi.fn<
      (
        channel: string,
        handler: (
          event: { sender: { id: number } },
          request: UninstallDispatchRequest,
        ) => UninstallDispatchResult,
      ) => void
    >(),
}));
vi.mock('electron', () => ({
  app: { whenReady: async () => {}, exit: mocks.exit, focus: vi.fn(), isPackaged: false },
  nativeTheme: { shouldUseDarkColors: false },
  ipcMain: { handle: mocks.handle },
  BrowserWindow: class {
    webContents = { id: 1, setWindowOpenHandler: vi.fn(), on: vi.fn() };
    once = (event: string, listener: () => void) => mocks.events.set(event, listener);
    setMenu = vi.fn();
    visible = false;
    show = () => {
      this.visible = true;
    };
    focus = vi.fn();
    isVisible = () => this.visible;
    setMinimumSize = vi.fn();
    setSize = vi.fn();
    setResizable = vi.fn();
    setTitle = vi.fn();
  },
}));
vi.mock('../../src/main/uninstall-window.ts', () => ({
  loadUninstallEntry: async () => {},
  resolveUninstallEntryTarget: vi.fn(),
  resolveUninstallWindowTheme: vi.fn(),
}));

let profile: string;
beforeEach(() => {
  vi.useFakeTimers();
  mocks.exit.mockClear();
  mocks.handle.mockClear();
  mocks.events.clear();
  profile = mkdtempSync(join(tmpdir(), 'ok-result-backstop-owned-'));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(profile, { recursive: true, force: true });
});

function dispatch(request: UninstallDispatchRequest): UninstallDispatchResult {
  const handler = mocks.handle.mock.calls[0]?.[1];
  if (!handler) throw new Error('Uninstall handler was not registered');
  return handler({ sender: { id: 1 } }, request);
}

async function showProgress(): Promise<void> {
  await runDesktopUninstallResultWindow({ kind: 'progress', profile });
  mocks.events.get('ready-to-show')?.();
  dispatch({ kind: 'progress-shown' });
}

test('unblocks the shell after renderer silence without a user action', async () => {
  await showProgress();
  await vi.advanceTimersByTimeAsync(59_999);
  expect(mocks.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(1);
});

test('a displayed result cancels the backstop and remains until dismissed', async () => {
  await showProgress();
  writeFileSync(join(profile, 'result'), 'Done\0Settings removed.\0Reveal in Finder\0');
  expect(dispatch({ kind: 'ready' })).toEqual({
    kind: 'screen',
    screen: { kind: 'result', outcome: 'success' },
  });
  await vi.advanceTimersByTimeAsync(10 * 60_000 + 5000);
  expect(mocks.exit).not.toHaveBeenCalled();
  dispatch({ kind: 'notice-reveal-log' });
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(10);
});

test.each([true, false])(
  'reports readiness only after painting and visibility, paint first=%s',
  async (paintFirst) => {
    await runDesktopUninstallResultWindow({ kind: 'progress', profile });
    if (paintFirst) dispatch({ kind: 'progress-shown' });
    else mocks.events.get('ready-to-show')?.();
    expect(existsSync(join(profile, 'ready'))).toBe(false);
    if (paintFirst) mocks.events.get('ready-to-show')?.();
    else dispatch({ kind: 'progress-shown' });
    expect(existsSync(join(profile, 'ready'))).toBe(true);
  },
);

test('polls do not disarm the outer deadline and allow a minute to read the notice', async () => {
  await showProgress();
  for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += 10_000) {
    expect(dispatch({ kind: 'ready' })).toEqual({
      kind: 'screen',
      screen: { kind: 'progress', awaitResult: true },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.exit).not.toHaveBeenCalled();
  }
  dispatch({ kind: 'ready' });
  await vi.advanceTimersByTimeAsync(59_999);
  expect(mocks.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(1);
});
