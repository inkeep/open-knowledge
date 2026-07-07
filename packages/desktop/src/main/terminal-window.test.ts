import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { ShowGateRegistry } from './show-gate.ts';
import type { TerminalReaper } from './terminal-lifecycle.ts';
import {
  createTerminalWindow,
  resolveTerminalWindowProject,
  type TerminalBrowserWindow,
  type TerminalWindowProject,
} from './terminal-window.ts';
import { getTerminalWindowContext, unregisterTerminalWindow } from './terminal-window-registry.ts';

const PROJECT: TerminalWindowProject = {
  projectPath: '/Users/me/project',
  projectName: 'project',
  collabUrl: 'ws://localhost:5200/collab',
  apiOrigin: 'http://localhost:5200',
};

/** A fake window exposing only what the factory touches; `closed` handlers are
 *  captured so a test can fire the lifecycle event. */
function makeFakeWindow(id: number) {
  const closedHandlers: Array<() => void> = [];
  const window = {
    id,
    on: (event: string, cb: () => void) => {
      if (event === 'closed') closedHandlers.push(cb);
    },
    once: () => {},
    loadFile: mock(async () => {}),
    loadURL: mock(async () => {}),
    webContents: { send: () => {}, once: () => {} },
  } as unknown as TerminalBrowserWindow;
  return {
    window,
    fireClosed: () => {
      for (const cb of closedHandlers) cb();
    },
  };
}

function makeDeps(opts: {
  id: number;
  project: TerminalWindowProject | null;
  rendererDevUrl?: string | null;
}) {
  const fake = makeFakeWindow(opts.id);
  const createWindow = mock((_o: { additionalArguments: string[]; title: string }) => fake.window);
  const disposeShowGate = mock(() => {});
  const register = mock((_window: unknown, _opts?: { kind?: string }) => disposeShowGate);
  const showGate = { register, fireThemeApplied: () => {} } as unknown as ShowGateRegistry;
  const killForWindow = mock((_id: number) => {});
  const terminalReaper = { killForWindow, killAll: () => {} } as unknown as TerminalReaper;
  return {
    fake,
    createWindow,
    disposeShowGate,
    register,
    killForWindow,
    deps: {
      createWindow,
      rendererEntryPath: '/app/index.html',
      rendererDevUrl: opts.rendererDevUrl ?? null,
      appVersion: '1.2.3',
      showGate,
      terminalReaper,
      project: opts.project,
    },
  };
}

const CREATED_IDS = [70_001, 70_002, 70_003];

afterEach(() => {
  // The registry is a module-global Map — drop anything a test registered (most
  // tests fire `closed` which unregisters; this covers the ones that do not).
  for (const id of CREATED_IDS) unregisterTerminalWindow(id);
});

describe('createTerminalWindow', () => {
  test('opens a --ok-mode=terminal window inheriting the project collab/api argv', () => {
    const h = makeDeps({ id: 70_001, project: PROJECT });
    createTerminalWindow(h.deps);

    expect(h.createWindow).toHaveBeenCalledTimes(1);
    const args = h.createWindow.mock.calls[0]?.[0];
    expect(args?.additionalArguments).toContain('--ok-mode=terminal');
    expect(args?.additionalArguments).toContain('--ok-collab-url=ws://localhost:5200/collab');
    expect(args?.additionalArguments).toContain('--ok-api-origin=http://localhost:5200');
    expect(args?.additionalArguments).toContain('--ok-project-path=/Users/me/project');
    expect(args?.additionalArguments).toContain('--ok-app-version=1.2.3');
  });

  test('titles the window with the project name when a project is present', () => {
    const h = makeDeps({ id: 70_001, project: PROJECT });
    createTerminalWindow(h.deps);
    expect(h.createWindow.mock.calls[0]?.[0]?.title).toBe('Open Knowledge Terminal — project');
  });

  test('records the window in the terminalWindows registry with its project root', () => {
    const h = makeDeps({ id: 70_001, project: PROJECT });
    createTerminalWindow(h.deps);
    expect(getTerminalWindowContext(70_001)).toEqual({
      projectRoot: '/Users/me/project',
      collabUrl: 'ws://localhost:5200/collab',
      apiOrigin: 'http://localhost:5200',
    });
  });

  test('registers the show gate with kind terminal', () => {
    const h = makeDeps({ id: 70_001, project: PROJECT });
    createTerminalWindow(h.deps);
    expect(h.register).toHaveBeenCalledTimes(1);
    expect(h.register.mock.calls[0]?.[1]).toEqual({ kind: 'terminal' });
  });

  test('a project-less window carries empty collab/api argv, a generic title, and a null project root', () => {
    const h = makeDeps({ id: 70_002, project: null });
    createTerminalWindow(h.deps);

    const args = h.createWindow.mock.calls[0]?.[0];
    expect(args?.additionalArguments).toContain('--ok-collab-url=');
    expect(args?.additionalArguments).toContain('--ok-api-origin=');
    expect(args?.additionalArguments).toContain('--ok-project-path=');
    expect(args?.title).toBe('Open Knowledge Terminal');
    expect(getTerminalWindowContext(70_002)?.projectRoot).toBeNull();
  });

  test('closing the window reaps its PTYs, disposes the show gate, and clears the registry', () => {
    const h = makeDeps({ id: 70_001, project: PROJECT });
    createTerminalWindow(h.deps);
    expect(getTerminalWindowContext(70_001)).not.toBeUndefined();

    h.fake.fireClosed();

    expect(h.killForWindow).toHaveBeenCalledWith(70_001);
    expect(h.disposeShowGate).toHaveBeenCalledTimes(1);
    expect(getTerminalWindowContext(70_001)).toBeUndefined();
  });

  test('opening twice for the same project yields two independent windows (no focus-existing)', () => {
    const a = makeDeps({ id: 70_001, project: PROJECT });
    createTerminalWindow(a.deps);
    const b = makeDeps({ id: 70_003, project: PROJECT });
    createTerminalWindow(b.deps);

    // Each call created its own window + registry entry — terminal windows are
    // not deduped by project the way windowsByPath editor windows are.
    expect(a.createWindow).toHaveBeenCalledTimes(1);
    expect(b.createWindow).toHaveBeenCalledTimes(1);
    expect(getTerminalWindowContext(70_001)).not.toBeUndefined();
    expect(getTerminalWindowContext(70_003)).not.toBeUndefined();

    a.fake.fireClosed();
    b.fake.fireClosed();
  });

  test('uses loadURL with the dev URL when provided, else loadFile', () => {
    const dev = makeDeps({ id: 70_001, project: PROJECT, rendererDevUrl: 'http://localhost:5173' });
    createTerminalWindow(dev.deps);
    expect(dev.fake.window.loadURL).toHaveBeenCalledWith('http://localhost:5173');
    expect(dev.fake.window.loadFile).not.toHaveBeenCalled();
    dev.fake.fireClosed();

    const prod = makeDeps({ id: 70_002, project: PROJECT });
    createTerminalWindow(prod.deps);
    expect(prod.fake.window.loadFile).toHaveBeenCalledWith('/app/index.html');
    expect(prod.fake.window.loadURL).not.toHaveBeenCalled();
    prod.fake.fireClosed();
  });

  test('a renderer load rejection surfaces a structured terminal-load-failed warn (not an unhandled rejection)', async () => {
    const h = makeDeps({ id: 70_001, project: PROJECT, rendererDevUrl: 'http://localhost:5173' });
    const failing = mock(async () => {
      throw new Error('renderer boom');
    });
    // Override the happy-path loadURL with one that rejects, exercising the
    // factory's `.catch` handler rather than the resolve path the tests above hit.
    (h.fake.window as unknown as { loadURL: typeof failing }).loadURL = failing;
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    createTerminalWindow(h.deps);
    // The factory attaches its `.catch` synchronously; the rejected promise queues
    // that handler as a microtask. Flush the microtask queue so it has run before
    // asserting — deterministic, no timer wait.
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(warnSpy.mock.calls[0]?.[0] as string);
    expect(payload).toMatchObject({
      event: 'terminal-load-failed',
      windowId: 70_001,
      target: 'http://localhost:5173',
      message: 'renderer boom',
    });

    warnSpy.mockRestore();
    h.fake.fireClosed();
  });
});

describe('resolveTerminalWindowProject', () => {
  test('an editor window context wins, deriving the collab URL from its port', () => {
    expect(
      resolveTerminalWindowProject({
        editor: {
          projectPath: '/Users/me/proj',
          projectName: 'proj',
          port: 5200,
          apiOrigin: 'http://localhost:5200',
        },
        terminal: { projectRoot: '/Users/me/other' },
      }),
    ).toEqual({
      projectPath: '/Users/me/proj',
      projectName: 'proj',
      collabUrl: 'ws://localhost:5200/collab',
      apiOrigin: 'http://localhost:5200',
    });
  });

  test('a focused terminal window inherits its registry context (chaining)', () => {
    expect(
      resolveTerminalWindowProject({
        editor: null,
        terminal: {
          projectRoot: '/Users/me/proj',
          collabUrl: 'ws://localhost:5300/collab',
          apiOrigin: 'http://localhost:5300',
        },
      }),
    ).toEqual({
      projectPath: '/Users/me/proj',
      projectName: 'proj',
      collabUrl: 'ws://localhost:5300/collab',
      apiOrigin: 'http://localhost:5300',
    });
  });

  test('chaining from a terminal window with no collab/api fields falls back to empty strings', () => {
    // The registry's collabUrl/apiOrigin are optional; the resolver's `?? ''`
    // fallbacks must keep argv as `--ok-collab-url=` (empty) rather than letting
    // `undefined` through and producing `--ok-collab-url=undefined`.
    expect(
      resolveTerminalWindowProject({
        editor: null,
        terminal: { projectRoot: '/Users/me/proj' },
      }),
    ).toEqual({
      projectPath: '/Users/me/proj',
      projectName: 'proj',
      collabUrl: '',
      apiOrigin: '',
    });
  });

  test('a project-less focused terminal window resolves to null (project-less)', () => {
    expect(
      resolveTerminalWindowProject({ editor: null, terminal: { projectRoot: null } }),
    ).toBeNull();
  });

  test('no focused project (Navigator / no window) resolves to null', () => {
    expect(resolveTerminalWindowProject({ editor: null, terminal: undefined })).toBeNull();
  });
});
