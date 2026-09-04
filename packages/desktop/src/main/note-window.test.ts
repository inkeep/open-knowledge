import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AssetOpenResult } from './asset-allowlist.ts';
import { attachAssetSafetyNet } from './asset-safety-net.ts';
import {
  closeNoteWindowsForProject,
  createNoteWindow,
  dispatchNoteWindowMainActionToProject,
  type NoteBrowserWindow,
  type NoteWindowProject,
  noteWindowNativeChromeOptions,
  openNoteWindow,
  parseNoteWindowMainAction,
  resolveNoteWindowProject,
  resolveWindowProjectScope,
} from './note-window.ts';
import {
  __resetNoteWindowRegistryForTests,
  findNoteWindowForDoc,
  getNoteWindowContext,
  listNoteWindowsForProject,
} from './note-window-registry.ts';
import type { ShowGateRegistry } from './show-gate.ts';

const recordNoteWindowOpened = vi.hoisted(() => vi.fn());
vi.mock('./note-window-telemetry.ts', () => ({ recordNoteWindowOpened }));

const PROJECT: NoteWindowProject = {
  projectPath: '/Users/me/project',
  projectName: 'project',
  collabUrl: 'ws://localhost:5200/collab',
  apiOrigin: 'http://localhost:5200',
};

function makeFakeWindow(id: number) {
  const closedHandlers: Array<() => void> = [];
  const window = {
    id,
    on: (event: string, cb: () => void) => {
      if (event === 'closed') closedHandlers.push(cb);
    },
    once: () => {},
    loadFile: vi.fn(async () => {}),
    loadURL: vi.fn(async () => {}),
    webContents: { send: () => {}, once: () => {} },
  } as unknown as NoteBrowserWindow;
  return {
    window,
    fireClosed: () => {
      for (const cb of closedHandlers) cb();
    },
  };
}

function makeDeps(opts: {
  id: number;
  docName: string;
  project?: NoteWindowProject;
  rendererDevUrl?: string | null;
}) {
  const fake = makeFakeWindow(opts.id);
  const createWindow = vi.fn((_o: { additionalArguments: string[]; title: string }) => fake.window);
  const disposeShowGate = vi.fn(() => {});
  const register = vi.fn((_window: unknown, _opts?: { kind?: string }) => disposeShowGate);
  const showGate = { register, fireThemeApplied: () => {} } as unknown as ShowGateRegistry;
  const placeWindow = vi.fn((_w: NoteBrowserWindow) => {});
  return {
    fake,
    createWindow,
    disposeShowGate,
    register,
    placeWindow,
    deps: {
      createWindow,
      rendererEntryPath: '/app/index.html',
      rendererDevUrl: opts.rendererDevUrl ?? null,
      appVersion: '1.2.3',
      showGate,
      project: opts.project ?? PROJECT,
      docName: opts.docName,
      placeWindow,
    },
  };
}

afterEach(() => {
  __resetNoteWindowRegistryForTests();
  recordNoteWindowOpened.mockClear();
});

describe('parseNoteWindowMainAction', () => {
  test('accepts every bounded conversation and comment action', () => {
    expect(
      parseNoteWindowMainAction({
        kind: 'active-input',
        text: 'Review this',
        newTab: true,
        submit: true,
      }),
    ).toEqual({ kind: 'active-input', text: 'Review this', newTab: true, submit: true });
    expect(
      parseNoteWindowMainAction({
        kind: 'agent-thread',
        agentSource: 'registry',
        agentId: 'claude-acp',
        prompt: 'Review this',
        docName: 'notes/alpha',
        titleHint: null,
      }),
    ).toEqual({
      kind: 'agent-thread',
      agentSource: 'registry',
      agentId: 'claude-acp',
      prompt: 'Review this',
      docName: 'notes/alpha',
      titleHint: null,
    });
    expect(
      parseNoteWindowMainAction({
        kind: 'terminal-launch',
        prompt: 'Review this',
        cli: 'codex',
        stage: false,
      }),
    ).toEqual({ kind: 'terminal-launch', prompt: 'Review this', cli: 'codex', stage: false });
    expect(
      parseNoteWindowMainAction({
        kind: 'reveal-comments',
        docName: 'notes/alpha',
        scope: 'doc',
      }),
    ).toEqual({ kind: 'reveal-comments', docName: 'notes/alpha', scope: 'doc' });
  });

  test('rejects inherited registry keys, unknown CLIs, and malformed comment scope', () => {
    expect(
      parseNoteWindowMainAction({
        kind: 'terminal-launch',
        prompt: 'Review',
        cli: 'toString',
        stage: false,
      }),
    ).toBeNull();
    expect(
      parseNoteWindowMainAction({
        kind: 'terminal-launch',
        prompt: 'Review',
        cli: 'shell',
        stage: false,
      }),
    ).toBeNull();
    expect(
      parseNoteWindowMainAction({
        kind: 'reveal-comments',
        docName: 'notes/alpha',
        scope: 'project',
      }),
    ).toBeNull();
  });

  test('accepts the agents target and queue comment scope, and rejects unknown targets', () => {
    expect(
      parseNoteWindowMainAction({
        kind: 'active-input',
        text: 'Review this',
        newTab: true,
        submit: true,
        target: 'agents',
      }),
    ).toEqual({
      kind: 'active-input',
      text: 'Review this',
      newTab: true,
      submit: true,
      target: 'agents',
    });
    expect(
      parseNoteWindowMainAction({
        kind: 'active-input',
        text: 'Review this',
        newTab: true,
        submit: true,
        target: 'unknown',
      }),
    ).toBeNull();
    expect(
      parseNoteWindowMainAction({
        kind: 'reveal-comments',
        docName: 'notes/alpha',
        scope: 'queue',
      }),
    ).toEqual({ kind: 'reveal-comments', docName: 'notes/alpha', scope: 'queue' });
  });
});

describe('dispatchNoteWindowMainActionToProject', () => {
  const context = {
    projectRoot: PROJECT.projectPath,
    collabUrl: PROJECT.collabUrl,
    apiOrigin: PROJECT.apiOrigin,
    currentDocName: 'notes/alpha',
  };

  test('focuses the owning project before delivering the validated action', () => {
    const order: string[] = [];
    const target = { id: 'main-window' };
    const action = { kind: 'active-input', text: 'Review', newTab: true, submit: true };

    const result = dispatchNoteWindowMainActionToProject({
      originWindowId: 7,
      action,
      getContext: (windowId) => (windowId === 7 ? context : undefined),
      focusProjectWindow: (projectRoot) => {
        order.push(`focus:${projectRoot}`);
        return target;
      },
      send: (actualTarget, actualAction) => {
        order.push(`send:${actualTarget.id}:${actualAction.kind}`);
      },
    });

    expect(result).toEqual({ ok: true });
    expect(order).toEqual([`focus:${PROJECT.projectPath}`, 'send:main-window:active-input']);
  });

  test.each([
    {
      name: 'the sender is not a registered note window',
      originWindowId: null,
      action: { kind: 'active-input', text: 'Review', newTab: true, submit: true },
      context: undefined,
      target: { id: 'main-window' },
      reason: 'not-note-window',
    },
    {
      name: 'the action is malformed',
      originWindowId: 7,
      action: { kind: 'terminal-launch', prompt: 'Review', cli: 'toString', stage: false },
      context,
      target: { id: 'main-window' },
      reason: 'invalid-action',
    },
    {
      name: 'the owning project window is gone',
      originWindowId: 7,
      action: { kind: 'active-input', text: 'Review', newTab: true, submit: true },
      context,
      target: null,
      reason: 'project-not-open',
    },
  ] as const)('fails closed when $name', ({ originWindowId, action, context, target, reason }) => {
    const send = vi.fn();
    const result = dispatchNoteWindowMainActionToProject({
      originWindowId,
      action,
      getContext: () => context,
      focusProjectWindow: () => target,
      send,
    });

    expect(result).toEqual({ ok: false, reason });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('noteWindowNativeChromeOptions', () => {
  test('centers macOS traffic lights in the compact titlebar and avoids sidebar framing', () => {
    expect(noteWindowNativeChromeOptions('darwin')).toEqual({
      vibrancy: 'window',
      trafficLightPosition: { x: 22, y: 17 },
    });
  });

  test.each([
    'win32',
    'linux',
  ] as const)('leaves %s chrome to the shared WCO policy', (platform) => {
    expect(noteWindowNativeChromeOptions(platform)).toEqual({});
  });
});

describe('createNoteWindow', () => {
  test('opens a --ok-mode=note window with attach argv and the initial document', () => {
    const h = makeDeps({ id: 1, docName: 'notes/alpha' });
    createNoteWindow(h.deps);

    const args = h.createWindow.mock.calls[0]?.[0]?.additionalArguments ?? [];
    expect(args).toContain('--ok-mode=note');
    expect(args).toContain('--ok-collab-url=ws://localhost:5200/collab');
    expect(args).toContain('--ok-api-origin=http://localhost:5200');
    expect(args).toContain('--ok-project-path=/Users/me/project');
    expect(args).toContain('--ok-initial-doc=notes/alpha');
  });

  test('titles the window with the document name', () => {
    const h = makeDeps({ id: 1, docName: 'notes/alpha' });
    createNoteWindow(h.deps);
    expect(h.createWindow.mock.calls[0]?.[0]?.title).toBe('notes/alpha');
  });

  test('registers with the show gate as kind note', () => {
    const h = makeDeps({ id: 1, docName: 'notes/alpha' });
    createNoteWindow(h.deps);
    expect(h.register).toHaveBeenCalledWith(h.fake.window, { kind: 'note' });
  });

  test('registers the window context before the renderer load starts', () => {
    const h = makeDeps({ id: 1, docName: 'notes/alpha' });
    createNoteWindow(h.deps);

    expect(getNoteWindowContext(1)).toEqual({
      projectRoot: '/Users/me/project',
      collabUrl: 'ws://localhost:5200/collab',
      apiOrigin: 'http://localhost:5200',
      currentDocName: 'notes/alpha',
    });
  });

  test('applies placement', () => {
    const h = makeDeps({ id: 1, docName: 'notes/alpha' });
    createNoteWindow(h.deps);
    expect(h.placeWindow).toHaveBeenCalledWith(h.fake.window);
  });

  test('closing the window disposes the show gate and drops the registry entry', () => {
    const h = makeDeps({ id: 1, docName: 'notes/alpha' });
    createNoteWindow(h.deps);

    h.fake.fireClosed();

    expect(h.disposeShowGate).toHaveBeenCalledTimes(1);
    expect(getNoteWindowContext(1)).toBeUndefined();
  });

  test('closing notifies main-side per-window state so nothing keeps a stale entry', () => {
    const h = makeDeps({ id: 1, docName: 'notes/alpha' });
    const onClosed = vi.fn();
    createNoteWindow({ ...h.deps, onClosed });

    h.fake.fireClosed();

    expect(onClosed).toHaveBeenCalledWith(1);
  });

  test('loads the dev URL when one is configured, else the built entry', () => {
    const dev = makeDeps({
      id: 1,
      docName: 'notes/alpha',
      rendererDevUrl: 'http://localhost:5173',
    });
    createNoteWindow(dev.deps);
    expect(dev.fake.window.loadURL).toHaveBeenCalledWith('http://localhost:5173');
    expect(dev.fake.window.loadFile).not.toHaveBeenCalled();

    __resetNoteWindowRegistryForTests();

    const prod = makeDeps({ id: 2, docName: 'notes/alpha' });
    createNoteWindow(prod.deps);
    expect(prod.fake.window.loadFile).toHaveBeenCalledWith('/app/index.html');
  });

  test('preserves the stack trace when renderer loading fails', async () => {
    const h = makeDeps({ id: 1, docName: 'notes/alpha' });
    const err = new Error('renderer failed');
    err.stack = 'STACK: renderer failed';
    vi.mocked(h.fake.window.loadFile).mockRejectedValue(err);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      createNoteWindow(h.deps);
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      const parsed = JSON.parse(warn.mock.calls[0]?.[0] as string);
      expect(parsed.message).toBe('STACK: renderer failed');
    } finally {
      warn.mockRestore();
    }
  });

  test('attaches the external-link safety net before the renderer loads, so a stray external window.open is denied and delegated to the OS browser', () => {
    let windowOpenHandler: ((details: { url: string }) => { action: 'allow' | 'deny' }) | null =
      null;
    let handlerRegisteredBeforeLoad = false;
    const openExternal = vi.fn(async () => {});
    const openAsset = vi.fn(async (): Promise<AssetOpenResult> => ({ ok: true }));
    const loadFile = vi.fn(async () => {
      handlerRegisteredBeforeLoad = windowOpenHandler !== null;
    });
    const window = {
      id: 1,
      on: () => {},
      once: () => {},
      loadFile,
      loadURL: vi.fn(async () => {}),
      webContents: {
        send: () => {},
        once: () => {},
        setWindowOpenHandler: (
          handler: (details: { url: string }) => { action: 'allow' | 'deny' },
        ) => {
          windowOpenHandler = handler;
        },
        on: () => {},
        getURL: () => PROJECT.apiOrigin,
      },
    } as unknown as NoteBrowserWindow;
    const showGate = {
      register: vi.fn(() => vi.fn(() => {})),
      fireThemeApplied: () => {},
    } as unknown as ShowGateRegistry;

    createNoteWindow({
      createWindow: () => window,
      rendererEntryPath: '/app/index.html',
      rendererDevUrl: null,
      appVersion: '1.2.3',
      showGate,
      project: PROJECT,
      docName: 'notes/alpha',
      attachSafetyNet: (win) =>
        attachAssetSafetyNet(win.webContents, {
          editorOrigin: PROJECT.apiOrigin,
          openExternal,
          openAsset,
        }),
    });

    expect(windowOpenHandler).not.toBeNull();
    expect(handlerRegisteredBeforeLoad).toBe(true);
    if (windowOpenHandler === null) throw new Error('safety net not attached');
    expect(windowOpenHandler({ url: 'https://evil.example.com/' })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledWith('https://evil.example.com/');
  });
});

describe('openNoteWindow — dedup and focus-existing', () => {
  test('creates a window when the document has none, and emits one adoption span', () => {
    const h = makeDeps({ id: 1, docName: 'notes/alpha' });
    const focusWindowById = vi.fn(() => true);

    const result = openNoteWindow({ ...h.deps, entryPoint: 'tab-menu', focusWindowById });

    expect(result).toEqual({ outcome: 'created', windowId: 1 });
    expect(focusWindowById).not.toHaveBeenCalled();
    expect(recordNoteWindowOpened).toHaveBeenCalledWith({ entryPoint: 'tab-menu' });
  });

  test('re-invoking on an already-popped document focuses instead of creating', () => {
    const first = makeDeps({ id: 1, docName: 'notes/alpha' });
    const focusWindowById = vi.fn(() => true);
    openNoteWindow({ ...first.deps, entryPoint: 'tab-menu', focusWindowById });

    const second = makeDeps({ id: 2, docName: 'notes/alpha' });
    const result = openNoteWindow({ ...second.deps, entryPoint: 'palette', focusWindowById });

    expect(result).toEqual({ outcome: 'focused', windowId: 1 });
    expect(second.createWindow).not.toHaveBeenCalled();
    expect(focusWindowById).toHaveBeenCalledWith(1);
  });

  test('an open with no entry point is not counted either', () => {
    const h = makeDeps({ id: 1, docName: 'notes/alpha' });
    const result = openNoteWindow({ ...h.deps, focusWindowById: () => true });

    expect(result.outcome).toBe('created');
    expect(recordNoteWindowOpened).not.toHaveBeenCalled();
  });

  test('a dedup hit is not counted as an open', () => {
    const first = makeDeps({ id: 1, docName: 'notes/alpha' });
    const focusWindowById = vi.fn(() => true);
    openNoteWindow({ ...first.deps, entryPoint: 'tab-menu', focusWindowById });
    recordNoteWindowOpened.mockClear();

    const second = makeDeps({ id: 2, docName: 'notes/alpha' });
    openNoteWindow({ ...second.deps, entryPoint: 'palette', focusWindowById });

    expect(recordNoteWindowOpened).not.toHaveBeenCalled();
  });

  test('two same-tick opens for one document yield exactly one window', () => {
    const focusWindowById = vi.fn(() => true);
    const first = makeDeps({ id: 1, docName: 'notes/alpha' });
    const second = makeDeps({ id: 2, docName: 'notes/alpha' });

    const a = openNoteWindow({ ...first.deps, entryPoint: 'tab-menu', focusWindowById });
    const b = openNoteWindow({ ...second.deps, entryPoint: 'tab-menu', focusWindowById });

    expect(a.outcome).toBe('created');
    expect(b.outcome).toBe('focused');
    expect(listNoteWindowsForProject(PROJECT.projectPath)).toEqual([1]);
  });

  test('N documents from one project plus one from another yield three windows', () => {
    const focusWindowById = vi.fn(() => true);
    const other: NoteWindowProject = {
      ...PROJECT,
      projectPath: '/Users/me/other',
      projectName: 'other',
    };

    openNoteWindow({
      ...makeDeps({ id: 1, docName: 'notes/alpha' }).deps,
      entryPoint: 'tab-menu',
      focusWindowById,
    });
    openNoteWindow({
      ...makeDeps({ id: 2, docName: 'notes/beta' }).deps,
      entryPoint: 'tab-menu',
      focusWindowById,
    });
    openNoteWindow({
      ...makeDeps({ id: 3, docName: 'notes/gamma', project: other }).deps,
      entryPoint: 'tab-menu',
      focusWindowById,
    });

    expect(listNoteWindowsForProject(PROJECT.projectPath)).toEqual([1, 2]);
    expect(listNoteWindowsForProject('/Users/me/other')).toEqual([3]);
    expect(recordNoteWindowOpened).toHaveBeenCalledTimes(3);
  });

  test('a stale entry whose window cannot be focused is replaced, not shadowed', () => {
    const first = makeDeps({ id: 1, docName: 'notes/alpha' });
    openNoteWindow({ ...first.deps, entryPoint: 'tab-menu', focusWindowById: () => true });

    const second = makeDeps({ id: 2, docName: 'notes/alpha' });
    const result = openNoteWindow({
      ...second.deps,
      entryPoint: 'tab-menu',
      focusWindowById: () => false,
    });

    expect(result).toEqual({ outcome: 'created', windowId: 2 });
    expect(findNoteWindowForDoc(PROJECT.projectPath, 'notes/alpha')).toBe(2);
  });
});

describe('resolveNoteWindowProject', () => {
  const helpers = {
    collabUrlFromApiOrigin: (apiOrigin: string) => `${apiOrigin.replace('http', 'ws')}/collab`,
    projectNameFromPath: (projectPath: string) => projectPath.split('/').pop() ?? '',
  };

  test('an editor window contributes its windowsByPath project', () => {
    expect(
      resolveNoteWindowProject({
        editor: {
          projectPath: '/Users/me/project',
          projectName: 'project',
          apiOrigin: 'http://localhost:5200',
        },
        note: undefined,
        ...helpers,
      }),
    ).toEqual({
      projectPath: '/Users/me/project',
      projectName: 'project',
      collabUrl: 'ws://localhost:5200/collab',
      apiOrigin: 'http://localhost:5200',
    });
  });

  test('popping out from inside a note window inherits that window project', () => {
    expect(
      resolveNoteWindowProject({
        editor: null,
        note: {
          projectRoot: '/Users/me/project',
          collabUrl: 'ws://localhost:5200/collab',
          apiOrigin: 'http://localhost:5200',
          currentDocName: 'notes/alpha',
        },
        ...helpers,
      }),
    ).toEqual({
      projectPath: '/Users/me/project',
      projectName: 'project',
      collabUrl: 'ws://localhost:5200/collab',
      apiOrigin: 'http://localhost:5200',
    });
  });

  test('an editor context wins over a note context', () => {
    const resolved = resolveNoteWindowProject({
      editor: {
        projectPath: '/Users/me/editor-project',
        projectName: 'editor-project',
        apiOrigin: 'http://localhost:5200',
      },
      note: {
        projectRoot: '/Users/me/other',
        collabUrl: 'ws://localhost:5300/collab',
        apiOrigin: 'http://localhost:5300',
        currentDocName: 'notes/alpha',
      },
      ...helpers,
    });
    expect(resolved?.projectPath).toBe('/Users/me/editor-project');
  });

  test('no project context resolves to null, never a project-less window', () => {
    expect(resolveNoteWindowProject({ editor: null, note: undefined, ...helpers })).toBeNull();
  });
});

describe('resolveWindowProjectScope', () => {
  const note = {
    projectRoot: '/Users/me/project',
    collabUrl: 'ws://localhost:5200/collab',
    apiOrigin: 'http://localhost:5200',
    currentDocName: 'notes/alpha',
  };

  test('an editor window keeps its windowsByPath scope', () => {
    expect(
      resolveWindowProjectScope({
        editor: { projectPath: '/Users/me/editor', apiOrigin: 'http://localhost:5300' },
        note: undefined,
      }),
    ).toEqual({ projectPath: '/Users/me/editor', apiOrigin: 'http://localhost:5300' });
  });

  test('a note window resolves through the registry instead of refusing', () => {
    expect(resolveWindowProjectScope({ editor: undefined, note })).toEqual({
      projectPath: '/Users/me/project',
      apiOrigin: 'http://localhost:5200',
    });
  });

  test('a window in neither map still resolves to nothing', () => {
    expect(resolveWindowProjectScope({ editor: null, note: undefined })).toEqual({
      projectPath: undefined,
      apiOrigin: undefined,
    });
  });

  test('resolves per field, so a path-only editor context is unchanged', () => {
    expect(
      resolveWindowProjectScope({ editor: { projectPath: '/Users/me/editor' }, note: undefined }),
    ).toEqual({ projectPath: '/Users/me/editor', apiOrigin: undefined });
  });

  test('an editor context wins field-by-field over a note context', () => {
    expect(
      resolveWindowProjectScope({
        editor: { projectPath: '/Users/me/editor', apiOrigin: 'http://localhost:5300' },
        note,
      }),
    ).toEqual({ projectPath: '/Users/me/editor', apiOrigin: 'http://localhost:5300' });
  });
});

describe('closeNoteWindowsForProject — owner-close cascade', () => {
  test('preserves recreated note windows when the closing owner has a live replacement', () => {
    openNoteWindow({
      ...makeDeps({ id: 1, docName: 'notes/alpha' }).deps,
      entryPoint: 'tab-menu',
      focusWindowById: () => true,
    });

    const closingProjectWindow = makeFakeWindow(90).window;
    const activeProjectWindow = makeFakeWindow(91).window;
    const closeWindowById = vi.fn(() => {});
    const closeRequest = {
      projectRoot: PROJECT.projectPath,
      reason: 'project-close' as const,
      closingProjectWindow,
      activeProjectWindow,
      closeWindowById,
    };

    const closed = closeNoteWindowsForProject(closeRequest);

    expect(closed).toEqual([]);
    expect(closeWindowById).not.toHaveBeenCalled();
    expect(listNoteWindowsForProject(PROJECT.projectPath)).toEqual([1]);
  });

  test('closes pop-outs when the replacement project window is already destroyed', () => {
    openNoteWindow({
      ...makeDeps({ id: 1, docName: 'notes/alpha' }).deps,
      entryPoint: 'tab-menu',
      focusWindowById: () => true,
    });

    const closingProjectWindow = makeFakeWindow(90).window;
    const activeProjectWindow = makeFakeWindow(91).window;
    activeProjectWindow.isDestroyed = () => true;
    const closeWindowById = vi.fn(() => {});

    const closed = closeNoteWindowsForProject({
      projectRoot: PROJECT.projectPath,
      reason: 'project-close',
      closingProjectWindow,
      activeProjectWindow,
      closeWindowById,
    });

    expect(closed).toEqual([1]);
    expect(closeWindowById).toHaveBeenCalledWith(1);
  });

  test('closes every note window of the project and leaves no registry entry', () => {
    const focusWindowById = vi.fn(() => true);
    openNoteWindow({
      ...makeDeps({ id: 1, docName: 'notes/alpha' }).deps,
      entryPoint: 'tab-menu',
      focusWindowById,
    });
    openNoteWindow({
      ...makeDeps({ id: 2, docName: 'notes/beta' }).deps,
      entryPoint: 'tab-menu',
      focusWindowById,
    });

    const closeWindowById = vi.fn(() => {});
    const closed = closeNoteWindowsForProject({
      projectRoot: PROJECT.projectPath,
      reason: 'project-close',
      closeWindowById,
    });

    expect(closed).toEqual([1, 2]);
    expect(closeWindowById).toHaveBeenCalledTimes(2);
    expect(listNoteWindowsForProject(PROJECT.projectPath)).toEqual([]);
    expect(getNoteWindowContext(1)).toBeUndefined();
    expect(getNoteWindowContext(2)).toBeUndefined();
  });

  test('leaves another project note windows alone', () => {
    const focusWindowById = vi.fn(() => true);
    const other: NoteWindowProject = {
      ...PROJECT,
      projectPath: '/Users/me/other',
      projectName: 'other',
    };
    openNoteWindow({
      ...makeDeps({ id: 1, docName: 'notes/alpha' }).deps,
      entryPoint: 'tab-menu',
      focusWindowById,
    });
    openNoteWindow({
      ...makeDeps({ id: 2, docName: 'notes/gamma', project: other }).deps,
      entryPoint: 'tab-menu',
      focusWindowById,
    });

    closeNoteWindowsForProject({
      projectRoot: PROJECT.projectPath,
      reason: 'project-close',
      closeWindowById: () => {},
    });

    expect(listNoteWindowsForProject('/Users/me/other')).toEqual([2]);
  });

  test('a project with no note windows closes nothing', () => {
    const closeWindowById = vi.fn(() => {});
    expect(
      closeNoteWindowsForProject({
        projectRoot: PROJECT.projectPath,
        reason: 'quit',
        closeWindowById,
      }),
    ).toEqual([]);
    expect(closeWindowById).not.toHaveBeenCalled();
  });
});
