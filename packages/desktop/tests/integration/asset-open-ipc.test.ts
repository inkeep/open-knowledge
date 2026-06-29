
import { describe, expect, mock, test } from 'bun:test';
import type { IpcMain, IpcMainInvokeEvent, IpcRenderer } from 'electron';
import { openAssetSafely, revealAssetSafely } from '../../src/main/asset-allowlist.ts';
import { createHandler } from '../../src/shared/ipc-handler.ts';
import { createInvoker } from '../../src/shared/ipc-invoke.ts';

const POSIX: NodeJS.Platform = 'linux';
const PROJECT = '/tmp/ok-asset-ipc-test-project';

function createInMemoryIpcPair(): { ipcMain: IpcMain; ipcRenderer: IpcRenderer } {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const fakeEvent = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;

  const ipcMain = {
    handle(channel: string, handler: Handler) {
      if (handlers.has(channel)) throw new Error(`duplicate registration for ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
  } as unknown as IpcMain;

  const ipcRenderer = {
    async invoke(channel: string, ...args: unknown[]) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler registered for ${channel}`);
      return await fn(fakeEvent, ...args);
    },
  } as unknown as IpcRenderer;

  return { ipcMain, ipcRenderer };
}

function setupRig() {
  const { ipcMain, ipcRenderer } = createInMemoryIpcPair();
  return { handle: createHandler(ipcMain), invoke: createInvoker(ipcRenderer) };
}

function makeResolver(existingPaths: string[]): (path: string) => string {
  const set = new Set(existingPaths);
  return (path) => {
    if (set.has(path)) return path;
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };
}

describe("'ok:shell:open-asset' round-trip", () => {
  test('happy path: renderer invoke → main handler → shell.openPath fires; result has ok:true', async () => {
    const { handle, invoke } = setupRig();
    const openPath = mock(async (_: string) => '');
    const canonical = `${PROJECT}/notes/meeting.pdf`;

    handle('ok:shell:open-asset', async (_event, relPath) =>
      openAssetSafely(
        {
          projectPath: PROJECT,
          platform: POSIX,
          openPath,
          resolveCanonical: makeResolver([canonical]),
          statExists: (p) => p === canonical,
        },
        relPath,
      ),
    );

    const result = await invoke('ok:shell:open-asset', 'notes/meeting.pdf');
    expect(result).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledWith(canonical);
  });

  test('path escape from renderer surfaces as result-object refusal (not Promise rejection)', async () => {
    const { handle, invoke } = setupRig();
    const openPath = mock(async (_: string) => '');

    handle('ok:shell:open-asset', async (_event, relPath) =>
      openAssetSafely(
        {
          projectPath: PROJECT,
          platform: POSIX,
          openPath,
          resolveCanonical: (p) => p,
          statExists: () => true,
        },
        relPath,
      ),
    );

    const result = await invoke('ok:shell:open-asset', '../../etc/passwd');
    expect(result).toEqual({ ok: false, reason: 'path-escape' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('executable extension rejected across the IPC boundary', async () => {
    const { handle, invoke } = setupRig();
    const openPath = mock(async (_: string) => '');
    const canonical = `${PROJECT}/notes/setup.sh`;

    handle('ok:shell:open-asset', async (_event, relPath) =>
      openAssetSafely(
        {
          projectPath: PROJECT,
          platform: POSIX,
          openPath,
          resolveCanonical: makeResolver([canonical]),
          statExists: (p) => p === canonical,
        },
        relPath,
      ),
    );

    const result = await invoke('ok:shell:open-asset', 'notes/setup.sh');
    expect(result).toEqual({ ok: false, reason: 'extension-blocked' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('not-found refusal distinguished from resolve-error', async () => {
    const { handle, invoke } = setupRig();
    const openPath = mock(async (_: string) => '');

    handle('ok:shell:open-asset', async (_event, relPath) =>
      openAssetSafely(
        {
          projectPath: PROJECT,
          platform: POSIX,
          openPath,
          resolveCanonical: makeResolver([]),
          statExists: () => false,
        },
        relPath,
      ),
    );

    const result = await invoke('ok:shell:open-asset', 'notes/missing.pdf');
    expect(result).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe("'ok:shell:reveal-asset' round-trip", () => {
  test('happy path: shell.showItemInFolder fires on canonical path', async () => {
    const { handle, invoke } = setupRig();
    const showItemInFolder = mock((_: string) => {});
    const canonical = `${PROJECT}/notes/meeting.pdf`;

    handle('ok:shell:reveal-asset', async (_event, relPath) =>
      revealAssetSafely(
        {
          projectPath: PROJECT,
          platform: POSIX,
          showItemInFolder,
          resolveCanonical: makeResolver([canonical]),
          statExists: (p) => p === canonical,
        },
        relPath,
      ),
    );

    const result = await invoke('ok:shell:reveal-asset', 'notes/meeting.pdf');
    expect(result).toEqual({ ok: true });
    expect(showItemInFolder).toHaveBeenCalledWith(canonical);
  });

  test('reveal on an executable is allowed (content handler is not dispatched)', async () => {
    const { handle, invoke } = setupRig();
    const showItemInFolder = mock((_: string) => {});
    const canonical = `${PROJECT}/notes/setup.sh`;

    handle('ok:shell:reveal-asset', async (_event, relPath) =>
      revealAssetSafely(
        {
          projectPath: PROJECT,
          platform: POSIX,
          showItemInFolder,
          resolveCanonical: makeResolver([canonical]),
          statExists: (p) => p === canonical,
        },
        relPath,
      ),
    );

    const result = await invoke('ok:shell:reveal-asset', 'notes/setup.sh');
    expect(result).toEqual({ ok: true });
    expect(showItemInFolder).toHaveBeenCalledWith(canonical);
  });
});

describe("'ok:shell:show-asset-menu' placeholder holds until Commit 5", () => {
  test('invoke resolves undefined; real native-menu construction arrives at Commit 5', async () => {
    const { handle, invoke } = setupRig();

    handle('ok:shell:show-asset-menu', async (_event, _params) => undefined);

    const result = await invoke('ok:shell:show-asset-menu', {
      relPath: 'notes/meeting.pdf',
      title: 'meeting.pdf',
      kind: 'asset',
    });
    expect(result).toBeUndefined();
  });
});
