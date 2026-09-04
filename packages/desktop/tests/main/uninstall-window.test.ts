import { describe, expect, it } from 'vitest';
import {
  loadUninstallEntry,
  noticeCloseIsConfirm,
  resolveUninstallEntryTarget,
  resolveUninstallWindowTheme,
  type UninstallEntryDeps,
} from '../../src/main/uninstall-window.ts';

const PACKAGED: UninstallEntryDeps = {
  devServerUrl: null,
  isPackaged: true,
  resourcesPath: '/Applications/OpenKnowledge.app/Contents/Resources',
  mainDir: '/Applications/OpenKnowledge.app/Contents/Resources/app.asar/out/main',
};

const UNPACKAGED: UninstallEntryDeps = {
  devServerUrl: null,
  isPackaged: false,
  resourcesPath: '/tmp/unused',
  mainDir: '/repo/packages/desktop/out/main',
};

describe('noticeCloseIsConfirm', () => {
  it('closing a one-button acknowledgement (no cancelLabel) confirms it', () => {
    expect(noticeCloseIsConfirm({})).toBe(true);
    expect(noticeCloseIsConfirm({ cancelLabel: undefined })).toBe(true);
  });

  it('closing a two-button question (has cancelLabel) cancels it', () => {
    expect(noticeCloseIsConfirm({ cancelLabel: 'Cancel' })).toBe(false);
  });
});

describe('resolveUninstallWindowTheme', () => {
  it('follows the theme main already resolved for the app', () => {
    expect(resolveUninstallWindowTheme(true)).toBe('dark');
    expect(resolveUninstallWindowTheme(false)).toBe('light');
  });
});

describe('resolveUninstallEntryTarget', () => {
  it('prefers the electron-vite dev server when one is exported', () => {
    const target = resolveUninstallEntryTarget(
      { ...UNPACKAGED, devServerUrl: 'http://localhost:5173' },
      'dark',
    );
    expect(target).toEqual({ kind: 'url', url: 'http://localhost:5173/uninstall.html?theme=dark' });
  });

  it('does not double the separator when the dev URL carries a trailing slash', () => {
    const target = resolveUninstallEntryTarget(
      { ...UNPACKAGED, devServerUrl: 'http://localhost:5173/' },
      'light',
    );
    expect(target).toEqual({
      kind: 'url',
      url: 'http://localhost:5173/uninstall.html?theme=light',
    });
  });

  it('loads from the copied renderer under Resources in a packaged build', () => {
    expect(resolveUninstallEntryTarget(PACKAGED, 'dark')).toEqual({
      kind: 'file',
      path: '/Applications/OpenKnowledge.app/Contents/Resources/app/uninstall.html',
      query: { theme: 'dark' },
    });
  });

  it('falls back to out/renderer when running the unpackaged build with no dev server', () => {
    expect(resolveUninstallEntryTarget(UNPACKAGED, 'light')).toEqual({
      kind: 'file',
      path: '/repo/packages/desktop/out/renderer/uninstall.html',
      query: { theme: 'light' },
    });
  });

  it('treats an empty dev URL as absent', () => {
    const target = resolveUninstallEntryTarget({ ...UNPACKAGED, devServerUrl: '' }, 'light');
    expect(target.kind).toBe('file');
  });
});

describe('loadUninstallEntry', () => {
  function recordingLoader() {
    const calls: Array<{ method: 'loadURL' | 'loadFile'; args: unknown[] }> = [];
    return {
      calls,
      loadURL: async (url: string) => {
        calls.push({ method: 'loadURL', args: [url] });
      },
      loadFile: async (path: string, options?: { query?: Record<string, string> }) => {
        calls.push({ method: 'loadFile', args: [path, options] });
      },
    };
  }

  it('navigates the dev server target with loadURL', async () => {
    const loader = recordingLoader();
    await loadUninstallEntry(loader, { kind: 'url', url: 'http://localhost:5173/uninstall.html' });
    expect(loader.calls).toEqual([
      { method: 'loadURL', args: ['http://localhost:5173/uninstall.html'] },
    ]);
  });

  it('passes the theme query through loadFile so it survives into location.search', async () => {
    const loader = recordingLoader();
    await loadUninstallEntry(loader, resolveUninstallEntryTarget(PACKAGED, 'dark'));
    expect(loader.calls).toEqual([
      {
        method: 'loadFile',
        args: [
          '/Applications/OpenKnowledge.app/Contents/Resources/app/uninstall.html',
          { query: { theme: 'dark' } },
        ],
      },
    ]);
  });
});
