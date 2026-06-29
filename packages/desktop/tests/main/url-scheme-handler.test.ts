import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Candidate, CandidateSelection } from '@inkeep/open-knowledge-core';
import { encodeShareUrl } from '@inkeep/open-knowledge-core';
import type {
  ScreenTarget,
  ShareDeepLinkPayload,
  ShareNavigatorPayload,
  ShareUrlPayload,
} from '../../src/main/url-scheme.ts';
import { parseOpenKnowledgeFileUrl, registerProtocolHandler } from '../../src/main/url-scheme.ts';


type AppEvent = 'open-url' | 'second-instance' | 'before-quit' | 'continue-activity';
type OpenUrlListener = (event: { preventDefault: () => void }, url: string) => void;
type SecondInstanceListener = (event: unknown, argv: readonly string[]) => void;
type BeforeQuitListener = () => void;
type ContinueActivityListener = (
  event: { preventDefault: () => void },
  type: string,
  userInfo: unknown,
  details?: { webpageURL?: string },
) => void;
type AppListener =
  | OpenUrlListener
  | SecondInstanceListener
  | BeforeQuitListener
  | ContinueActivityListener;

interface FakeApp {
  on: ReturnType<typeof mock>;
  whenReady: () => Promise<void>;
  isPackaged: boolean;
  setAsDefaultProtocolClient: ReturnType<typeof mock>;
  removeAsDefaultProtocolClient: ReturnType<typeof mock>;
  fireOpenUrl: (url: string) => void;
  fireSecondInstance: (argv: readonly string[]) => void;
  fireBeforeQuit: () => void;
  fireContinueActivity: (
    type: string,
    userInfo: unknown,
    details?: { webpageURL?: string },
  ) => { preventDefault: ReturnType<typeof mock> };
  resolveReady: () => void;
}

function makeFakeApp(opts?: { isPackaged?: boolean }): FakeApp {
  const listeners = new Map<AppEvent, AppListener>();
  let resolveReadyFn: (() => void) | null = null;
  const whenReady = () =>
    new Promise<void>((resolve) => {
      resolveReadyFn = resolve;
    });
  const on = mock((event: AppEvent, cb: AppListener) => {
    listeners.set(event, cb);
  });
  return {
    on,
    whenReady,
    isPackaged: opts?.isPackaged ?? true,
    setAsDefaultProtocolClient: mock(() => true),
    removeAsDefaultProtocolClient: mock(() => true),
    fireOpenUrl: (url) => {
      const cb = listeners.get('open-url') as OpenUrlListener | undefined;
      if (!cb) throw new Error('open-url listener not registered');
      const event = { preventDefault: mock(() => {}) };
      cb(event, url);
    },
    fireSecondInstance: (argv) => {
      const cb = listeners.get('second-instance') as SecondInstanceListener | undefined;
      if (!cb) throw new Error('second-instance listener not registered');
      cb({}, argv);
    },
    fireBeforeQuit: () => {
      const cb = listeners.get('before-quit') as BeforeQuitListener | undefined;
      if (!cb) throw new Error('before-quit listener not registered');
      cb();
    },
    fireContinueActivity: (type, userInfo, details) => {
      const cb = listeners.get('continue-activity') as ContinueActivityListener | undefined;
      if (!cb) throw new Error('continue-activity listener not registered');
      const event = { preventDefault: mock(() => {}) };
      cb(event, type, userInfo, details);
      return event;
    },
    resolveReady: () => {
      if (!resolveReadyFn) throw new Error('whenReady not awaited yet');
      resolveReadyFn();
    },
  };
}

interface FakeWindowHandle {
  id: string;
}

interface TestEnv {
  app: FakeApp;
  focusWindowForProject: ReturnType<typeof mock>;
  openProject: ReturnType<typeof mock>;
  openEphemeralFile: ReturnType<typeof mock>;
  sendDeepLink: ReturnType<typeof mock>;
  getAnyReadyWindow: ReturnType<typeof mock>;
  timers: Array<{ cb: () => void; ms: number }>;
  warnLog: Array<{ obj: object; msg: string }>;
  existingWindows: Map<string, FakeWindowHandle>;
  readyWindow: FakeWindowHandle | null;
}

function makeEnv(opts?: { isPackaged?: boolean }): TestEnv {
  const existingWindows = new Map<string, FakeWindowHandle>();
  let readyWindow: FakeWindowHandle | null = null;
  const timers: Array<{ cb: () => void; ms: number }> = [];
  const warnLog: Array<{ obj: object; msg: string }> = [];
  return {
    app: makeFakeApp(opts),
    focusWindowForProject: mock((p: string) => existingWindows.get(p) ?? null),
    openProject: mock(
      async (
        p: string,
        _opts?: { pendingDeepLinkDoc?: string },
      ): Promise<FakeWindowHandle | null> => {
        const win: FakeWindowHandle = { id: `win-${p}` };
        existingWindows.set(p, win);
        readyWindow ||= win;
        return win;
      },
    ),
    openEphemeralFile: mock(async (_filePath: string): Promise<void> => {}),
    sendDeepLink: mock(() => {}),
    getAnyReadyWindow: mock(() => readyWindow),
    timers,
    warnLog,
    existingWindows,
    get readyWindow() {
      return readyWindow;
    },
    set readyWindow(w: FakeWindowHandle | null) {
      readyWindow = w;
    },
  } as unknown as TestEnv;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function tickTimer(env: TestEnv): void {
  const next = env.timers.shift();
  if (!next) throw new Error('no timer to tick');
  next.cb();
}

describe('registerProtocolHandler — setAsDefaultProtocolClient', () => {
  test('calls setAsDefaultProtocolClient in dev mode (!isPackaged)', () => {
    const env = makeEnv({ isPackaged: false });
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    expect(env.app.setAsDefaultProtocolClient).toHaveBeenCalledWith('openknowledge');
  });

  test('does NOT call setAsDefaultProtocolClient in packaged builds', () => {
    const env = makeEnv({ isPackaged: true });
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    expect(env.app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  test('logs a warn when setAsDefaultProtocolClient returns false', () => {
    const env = makeEnv({ isPackaged: false });
    env.app.setAsDefaultProtocolClient = mock(() => false);
    const warnLog: Array<{ obj: object; msg: string }> = [];
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: { warn: (obj, msg) => warnLog.push({ obj, msg }) },
    });
    expect(warnLog).toHaveLength(1);
    expect(warnLog[0]?.msg).toContain('returned false');
  });
});

describe('registerProtocolHandler — before-quit Launch Services cleanup', () => {
  test('registers before-quit handler that calls removeAsDefaultProtocolClient in dev mode', () => {
    const env = makeEnv({ isPackaged: false });
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.fireBeforeQuit();
    expect(env.app.removeAsDefaultProtocolClient).toHaveBeenCalledWith('openknowledge');
  });

  test('does NOT register before-quit handler in packaged builds', () => {
    const env = makeEnv({ isPackaged: true });
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    expect(() => env.app.fireBeforeQuit()).toThrow(/before-quit listener not registered/);
    expect(env.app.removeAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  test('does NOT register before-quit handler when setAsDefaultProtocolClient returned false', () => {
    const env = makeEnv({ isPackaged: false });
    env.app.setAsDefaultProtocolClient = mock(() => false);
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    expect(() => env.app.fireBeforeQuit()).toThrow(/before-quit listener not registered/);
    expect(env.app.removeAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  test('swallows removeAsDefaultProtocolClient throws with a warn log line', () => {
    const env = makeEnv({ isPackaged: false });
    env.app.removeAsDefaultProtocolClient = mock(() => {
      throw new Error('launch services refused');
    });
    const warnLog: Array<{ obj: object; msg: string }> = [];
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: { warn: (obj, msg) => warnLog.push({ obj, msg }) },
    });
    expect(() => env.app.fireBeforeQuit()).not.toThrow();
    expect(warnLog.some((e) => e.msg.includes('removeAsDefaultProtocolClient failed'))).toBe(true);
  });
});

describe('registerProtocolHandler — deferred-share routeUrl + dedup', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  test('routeUrl feeds a redeemed /d/ universal link through the share spine; a near-simultaneous duplicate is deduped', async () => {
    env.readyWindow = { id: 'pre-existing' };
    const resolveShareTarget = mock(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));
    const routeShareToNavigator = mock(() => {});
    let clock = 1_000_000;

    const control = registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget: resolveShareTarget as unknown as (
        share: ShareUrlPayload,
      ) => Promise<CandidateSelection>,
      routeShareToNavigator,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      now: () => clock,
    });
    env.app.resolveReady();
    await flushPromises();

    const token = encodeShareUrl('https://github.com/inkeep/tech-ipos/blob/main/README.md');
    const url = `https://openknowledge.ai/d/${token}`;

    control.routeUrl(url);
    await flushPromises();
    await flushPromises();
    expect(resolveShareTarget).toHaveBeenCalledTimes(1);
    expect(routeShareToNavigator).toHaveBeenCalledTimes(1); // miss → launcher-miss

    clock += 2_000;
    control.routeUrl(url);
    await flushPromises();
    await flushPromises();
    expect(resolveShareTarget).toHaveBeenCalledTimes(1);
    expect(routeShareToNavigator).toHaveBeenCalledTimes(1);

    clock += 11_000;
    control.routeUrl(url);
    await flushPromises();
    await flushPromises();
    expect(resolveShareTarget).toHaveBeenCalledTimes(2);
  });
});

describe('registerProtocolHandler — queue-then-flush', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  test('queues URLs received before whenReady resolves', async () => {
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });

    env.app.fireOpenUrl('openknowledge://open?project=/tmp/p&doc=a.md');
    expect(env.openProject).not.toHaveBeenCalled();
    expect(env.sendDeepLink).not.toHaveBeenCalled();
  });

  test('flushes queued URLs after whenReady when a window is already ready', async () => {
    env.readyWindow = { id: 'pre-existing' };
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.fireOpenUrl('openknowledge://open?project=/tmp/p&doc=a.md');
    env.app.resolveReady();
    await flushPromises();

    await flushPromises();
    expect(env.openProject).toHaveBeenCalledWith('/tmp/p', {
      pendingDeepLinkTarget: { kind: 'doc', path: 'a.md' },
    });
    expect(env.sendDeepLink).not.toHaveBeenCalled();
  });

  test('two deep-links received before whenReady both drain in FIFO order', async () => {
    env.readyWindow = { id: 'pre-existing' };
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.fireOpenUrl('openknowledge://open?project=/tmp/p1&doc=a.md');
    env.app.fireOpenUrl('openknowledge://open?project=/tmp/p2&doc=b.md');

    expect(env.openProject).not.toHaveBeenCalled();

    env.app.resolveReady();
    await flushPromises();
    await flushPromises();

    expect(env.openProject).toHaveBeenCalledTimes(2);
    expect(env.openProject).toHaveBeenNthCalledWith(1, '/tmp/p1', {
      pendingDeepLinkTarget: { kind: 'doc', path: 'a.md' },
    });
    expect(env.openProject).toHaveBeenNthCalledWith(2, '/tmp/p2', {
      pendingDeepLinkTarget: { kind: 'doc', path: 'b.md' },
    });
    expect(env.sendDeepLink).not.toHaveBeenCalled();
  });

  test('retries flush up to 10 × 500ms while no window is up, then drains anyway', async () => {
    env.readyWindow = null;
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.fireOpenUrl('openknowledge://open?project=/tmp/p&doc=a.md');
    env.app.resolveReady();
    await flushPromises();

    for (let retryIndex = 1; retryIndex <= 9; retryIndex++) {
      expect(env.timers.length).toBe(1);
      expect(env.timers[0]?.ms).toBe(500);
      expect(env.openProject).not.toHaveBeenCalled();
      tickTimer(env);
      await flushPromises();
      expect(env.openProject).not.toHaveBeenCalled();
    }
    expect(env.timers.length).toBe(1);
    expect(env.timers[0]?.ms).toBe(500);
    expect(env.openProject).not.toHaveBeenCalled();
    tickTimer(env);
    await flushPromises();
    expect(env.openProject).toHaveBeenCalledWith('/tmp/p', {
      pendingDeepLinkTarget: { kind: 'doc', path: 'a.md' },
    });
    expect(env.timers.length).toBe(0);
    expect(env.openProject).toHaveBeenCalledTimes(1);
  });

  test('silent-drops malformed URLs with a single warn log line', async () => {
    const warnLog: Array<{ obj: object; msg: string }> = [];
    env.readyWindow = { id: 'pre-existing' };
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: {
        warn: (obj, msg) => warnLog.push({ obj, msg }),
      },
    });
    env.app.fireOpenUrl('openknowledge://open?doc=a.md'); // missing project
    env.app.resolveReady();
    await flushPromises();

    expect(env.openProject).not.toHaveBeenCalled();
    expect(env.sendDeepLink).not.toHaveBeenCalled();
    expect(warnLog).toHaveLength(1);
    expect(warnLog[0]?.msg).toContain('dropped malformed URL');
  });

  test('focuses existing window when project is already open (warm same-project)', async () => {
    const existingWin: FakeWindowHandle = { id: 'existing' };
    env.existingWindows.set('/tmp/p', existingWin);
    env.readyWindow = existingWin;

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl('openknowledge://open?project=/tmp/p&doc=b.md');
    await flushPromises();

    expect(env.focusWindowForProject).toHaveBeenCalledWith('/tmp/p');
    expect(env.openProject).not.toHaveBeenCalled();
    expect(env.sendDeepLink).toHaveBeenCalledWith(existingWin, { doc: 'b.md', kind: 'doc' });
  });

  test('spawns new window when project is not yet open (warm different-project)', async () => {
    env.existingWindows.set('/tmp/A', { id: 'A' });
    env.readyWindow = { id: 'A' };

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl('openknowledge://open?project=/tmp/B&doc=x.md');
    await flushPromises();
    await flushPromises();

    expect(env.openProject).toHaveBeenCalledWith('/tmp/B', {
      pendingDeepLinkTarget: { kind: 'doc', path: 'x.md' },
    });
    expect(env.sendDeepLink).not.toHaveBeenCalled();
  });

  test('handles openProject resolving null without throwing (failure already surfaced)', async () => {
    env.readyWindow = { id: 'primary' };
    const openProjectStub = mock(
      async (
        _p: string,
        _opts?: { pendingDeepLinkDoc?: string },
      ): Promise<FakeWindowHandle | null> => null,
    );

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: openProjectStub,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl('openknowledge://open?project=/tmp/broken&doc=x.md');
    await flushPromises();
    await flushPromises();

    expect(openProjectStub).toHaveBeenCalledWith('/tmp/broken', {
      pendingDeepLinkTarget: { kind: 'doc', path: 'x.md' },
    });
    expect(env.sendDeepLink).not.toHaveBeenCalled();
  });
});

describe('registerProtocolHandler — single-file launch control', () => {
  let env: TestEnv;
  const FILE_URL = `openknowledge://open?file=${encodeURIComponent('/Users/me/notes/todo.md')}`;

  beforeEach(() => {
    env = makeEnv();
  });

  test('singleFileLaunch() is false with no URL and after a project deep-link', () => {
    const control = registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      openEphemeralFile: env.openEphemeralFile,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    expect(control.singleFileLaunch()).toBe(false);
    env.app.fireOpenUrl('openknowledge://open?project=/tmp/p&doc=a.md');
    expect(control.singleFileLaunch()).toBe(false);
  });

  test('singleFileLaunch() becomes true after a file= URL queued pre-ready', () => {
    const control = registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      openEphemeralFile: env.openEphemeralFile,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.fireOpenUrl(FILE_URL);
    expect(control.singleFileLaunch()).toBe(true);
  });

  test('drainQueuedUrls() routes a queued file= URL with NO ready window (suppress path)', async () => {
    env.readyWindow = null;
    const control = registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      openEphemeralFile: env.openEphemeralFile,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.fireOpenUrl(FILE_URL);
    env.app.resolveReady();
    await flushPromises();

    expect(env.openEphemeralFile).not.toHaveBeenCalled();
    expect(env.timers.length).toBe(1);

    control.drainQueuedUrls();
    await flushPromises();
    expect(env.openEphemeralFile).toHaveBeenCalledWith('/Users/me/notes/todo.md');

    tickTimer(env);
    await flushPromises();
    expect(env.openEphemeralFile).toHaveBeenCalledTimes(1);
  });
});

describe('registerProtocolHandler — urlLaunchOwnsWindow (boot-restore suppression)', () => {
  let env: TestEnv;
  const SHARE_URL = `https://openknowledge.ai/d/${encodeShareUrl(
    'https://github.com/inkeep/notes/blob/main/welcome.md',
  )}`;
  const FILE_URL = `openknowledge://open?file=${encodeURIComponent('/Users/me/notes/todo.md')}`;

  beforeEach(() => {
    env = makeEnv();
  });

  function makeControl() {
    return registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      openEphemeralFile: env.openEphemeralFile,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
  }

  test('becomes true after a valid share URL queued pre-ready (suppresses boot-restore window)', () => {
    const control = makeControl();
    expect(control.urlLaunchOwnsWindow()).toBe(false);
    env.app.fireOpenUrl(SHARE_URL);
    expect(control.urlLaunchOwnsWindow()).toBe(true);
  });

  test('becomes true after a valid custom-scheme share URL', () => {
    const control = makeControl();
    const blobUrl = 'https://github.com/inkeep/notes/blob/main/welcome.md';
    env.app.fireOpenUrl(`openknowledge://share?url=${encodeURIComponent(blobUrl)}`);
    expect(control.urlLaunchOwnsWindow()).toBe(true);
  });

  test('becomes true after a single-file file= URL (own-window launch parity)', () => {
    const control = makeControl();
    env.app.fireOpenUrl(FILE_URL);
    expect(control.urlLaunchOwnsWindow()).toBe(true);
  });

  test('stays false for an invalid share URL — its toast needs an existing window', () => {
    const control = makeControl();
    env.app.fireOpenUrl('https://openknowledge.ai/d/!!!not-base64!!!');
    expect(control.urlLaunchOwnsWindow()).toBe(false);
  });

  test('stays false after a screen deep-link — it targets an existing window', () => {
    const control = makeControl();
    env.app.fireOpenUrl('openknowledge://screen?name=settings');
    expect(control.urlLaunchOwnsWindow()).toBe(false);
  });

  test('stays false after a legacy project deep-link (unchanged scope)', () => {
    const control = makeControl();
    env.app.fireOpenUrl('openknowledge://open?project=/tmp/p&doc=a.md');
    expect(control.urlLaunchOwnsWindow()).toBe(false);
  });
});

describe('registerProtocolHandler — second-instance argv parsing', () => {
  test('extracts openknowledge:// entries from second-instance argv', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'primary' };
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireSecondInstance([
      '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
      'openknowledge://open?project=/tmp/si&doc=readme.md',
    ]);
    await flushPromises();
    await flushPromises();

    expect(env.openProject).toHaveBeenCalledWith('/tmp/si', {
      pendingDeepLinkTarget: { kind: 'doc', path: 'readme.md' },
    });
  });

  test('ignores argv entries that are not openknowledge:// URLs', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'primary' };
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireSecondInstance(['--some-flag', 'random-positional', 'https://example.com']);
    await flushPromises();

    expect(env.openProject).not.toHaveBeenCalled();
    expect(env.sendDeepLink).not.toHaveBeenCalled();
  });
});

describe('registerProtocolHandler — cold-start process.argv scan', () => {
  test('queues openknowledge:// URL from process.argv on cold-start CLI launch', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'pre-existing' };
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      getInitialArgv: () => [
        '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
        'openknowledge://open?project=/tmp/cs&doc=a.md',
      ],
    });
    env.app.resolveReady();
    await flushPromises();
    await flushPromises();

    expect(env.openProject).toHaveBeenCalledWith('/tmp/cs', {
      pendingDeepLinkTarget: { kind: 'doc', path: 'a.md' },
    });
  });

  test('no-op when no openknowledge:// URLs in initial argv', async () => {
    const env = makeEnv();
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      getInitialArgv: () => ['/path/to/electron', '/path/to/main.js', '--some-flag'],
    });
    env.app.resolveReady();
    await flushPromises();

    expect(env.openProject).not.toHaveBeenCalled();
    expect(env.sendDeepLink).not.toHaveBeenCalled();
  });

  test('defaults to no-op when getInitialArgv is omitted', async () => {
    const env = makeEnv();
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    expect(env.openProject).not.toHaveBeenCalled();
  });
});

describe('registerProtocolHandler — share-flow routing', () => {
  test('routes custom-scheme share URLs (openknowledge://share?url=...) through resolution', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const resolveShareTarget = mock(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    const blobUrl = 'https://github.com/inkeep/playbooks/blob/main/x.md';
    env.app.fireOpenUrl(`openknowledge://share?url=${encodeURIComponent(blobUrl)}`);
    await flushPromises();

    expect(resolveShareTarget).toHaveBeenCalledTimes(1);
    expect(resolveShareTarget).toHaveBeenCalledWith({
      owner: 'inkeep',
      repo: 'playbooks',
      branch: 'main',
      sharedUrl: blobUrl,
      target: { kind: 'doc', docPath: 'x.md' },
    });
    expect(env.sendDeepLink).not.toHaveBeenCalled();
  });

  test('dispatches unsupported-version payload + logs [receive] action=url-parse', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const warnLog: Array<{ obj: object; msg: string }> = [];
    const sendShareDeepLink = mock((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: { warn: (obj, msg) => warnLog.push({ obj, msg }) },
    });
    env.app.resolveReady();
    await flushPromises();

    const blobBytes = new TextEncoder().encode('https://github.com/o/r/blob/main/x.md');
    const v2 = new Uint8Array(blobBytes.length + 1);
    v2[0] = 0x02;
    v2.set(blobBytes, 1);
    let raw = '';
    for (const b of v2) raw += String.fromCharCode(b);
    const encoded = btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    env.app.fireOpenUrl(`https://openknowledge.ai/d/${encoded}`);
    await flushPromises();

    expect(sendShareDeepLink).toHaveBeenCalledWith(focusedWin, { kind: 'unsupported-version' });
    expect(
      warnLog.some(
        (entry) =>
          entry.msg.includes('[receive] action=url-parse') &&
          (entry.obj as { result?: string }).result === 'unsupported-version',
      ),
    ).toBe(true);
  });

  test('dispatches invalid payload + logs [receive] for corrupt base64', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const warnLog: Array<{ obj: object; msg: string }> = [];
    const sendShareDeepLink = mock((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: { warn: (obj, msg) => warnLog.push({ obj, msg }) },
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl('https://openknowledge.ai/d/!!!not-base64!!!');
    await flushPromises();

    expect(sendShareDeepLink).toHaveBeenCalledWith(focusedWin, { kind: 'invalid' });
    expect(
      warnLog.some(
        (entry) =>
          entry.msg.includes('[receive] action=url-parse') &&
          (entry.obj as { result?: string }).result === 'invalid',
      ),
    ).toBe(true);
  });

  test('ok share with no resolveShareTarget dep surfaces warn + no dispatch', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'ready' };
    const sendShareDeepLink = mock((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});
    const warnLog: Array<{ obj: object; msg: string }> = [];

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      getFocusedWindow: () => null,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: { warn: (obj, msg) => warnLog.push({ obj, msg }) },
    });
    env.app.resolveReady();
    await flushPromises();

    const encoded = encodeShareUrl('https://github.com/o/r/blob/main/x.md');
    env.app.fireOpenUrl(`https://openknowledge.ai/d/${encoded}`);
    await flushPromises();

    expect(sendShareDeepLink).not.toHaveBeenCalled();
    expect(env.openProject).not.toHaveBeenCalled();
    expect(warnLog.some((e) => e.msg.includes('resolveShareTarget dep missing'))).toBe(true);
  });

  test('open-action URLs continue routing through the legacy path (regression check)', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.existingWindows.set('/tmp/p', focusedWin);
    env.readyWindow = focusedWin;
    const sendShareDeepLink = mock((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl('openknowledge://open?project=/tmp/p&doc=a.md');
    await flushPromises();

    expect(env.sendDeepLink).toHaveBeenCalledWith(focusedWin, { doc: 'a.md', kind: 'doc' });
    expect(sendShareDeepLink).not.toHaveBeenCalled();
  });
});

describe('registerProtocolHandler — resolved share routing (US-003)', () => {
  function makeShareUrl(blobUrl: string): string {
    return `openknowledge://share?url=${encodeURIComponent(blobUrl)}`;
  }

  function expectedSharePayload(): ShareUrlPayload {
    return {
      owner: 'inkeep',
      repo: 'playbooks',
      branch: 'main',
      sharedUrl: 'https://github.com/inkeep/playbooks/blob/main/docs/getting-started.md',
      target: { kind: 'doc', docPath: 'docs/getting-started.md' },
    };
  }

  const sharedBlobUrl = 'https://github.com/inkeep/playbooks/blob/main/docs/getting-started.md';

  function makeCandidate(opts: {
    path: string;
    currentBranch?: string | null;
    hasOkConfig?: boolean;
  }): Candidate {
    return {
      path: opts.path,
      source: 'recent',
      recent: null,
      head: { currentBranch: opts.currentBranch ?? null, headSha: null, detached: false },
      gitDirKind: 'directory',
      hasOkConfig: opts.hasOkConfig ?? true,
      locked: false,
      recencyIndex: 0,
      worktreeOrder: null,
    };
  }

  test('branch-match-ok routes to openProject with pendingDeepLinkDoc + pendingMultiCandidate', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'pre-existing' };
    const resolveShareTarget = mock(
      async (_share: ShareUrlPayload): Promise<CandidateSelection> => ({
        kind: 'branch-match-ok',
        candidate: makeCandidate({ path: '/Users/me/playbooks', currentBranch: 'main' }),
        multiCandidate: true,
      }),
    );
    const sendShareDeepLink = mock((_w: FakeWindowHandle, _p: ShareDeepLinkPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      resolveShareTarget,
      getFocusedWindow: () => env.readyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(makeShareUrl(sharedBlobUrl));
    await flushPromises();
    await flushPromises();

    expect(resolveShareTarget).toHaveBeenCalledTimes(1);
    expect(resolveShareTarget).toHaveBeenCalledWith(expectedSharePayload());
    expect(env.openProject).toHaveBeenCalledWith('/Users/me/playbooks', {
      pendingDeepLinkTarget: { kind: 'doc', path: 'docs/getting-started.md' },
      pendingBranch: 'main',
      pendingMultiCandidate: true,
    });
    expect(sendShareDeepLink).not.toHaveBeenCalled();
  });

  test('branch-match-ok with multiCandidate=false omits the toast hint', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'pre-existing' };
    const resolveShareTarget = mock(
      async (): Promise<CandidateSelection> => ({
        kind: 'branch-match-ok',
        candidate: makeCandidate({ path: '/Users/me/solo-clone', currentBranch: 'main' }),
        multiCandidate: false,
      }),
    );

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      getFocusedWindow: () => env.readyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(makeShareUrl(sharedBlobUrl));
    await flushPromises();
    await flushPromises();

    expect(env.openProject).toHaveBeenCalledWith('/Users/me/solo-clone', {
      pendingDeepLinkTarget: { kind: 'doc', path: 'docs/getting-started.md' },
      pendingBranch: 'main',
      pendingMultiCandidate: false,
    });
  });

  test('branch-match-ok (warm) focuses existing editor + delivers ok:deep-link immediately', async () => {
    const env = makeEnv();
    const editorWin: FakeWindowHandle = { id: 'editor' };
    env.existingWindows.set('/Users/me/playbooks', editorWin);
    env.readyWindow = editorWin;
    const resolveShareTarget = mock(
      async (): Promise<CandidateSelection> => ({
        kind: 'branch-match-ok',
        candidate: makeCandidate({ path: '/Users/me/playbooks', currentBranch: 'main' }),
        multiCandidate: true,
      }),
    );

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      getFocusedWindow: () => editorWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(makeShareUrl(sharedBlobUrl));
    await flushPromises();
    await flushPromises();

    expect(env.focusWindowForProject).toHaveBeenCalledWith('/Users/me/playbooks');
    expect(env.sendDeepLink).toHaveBeenCalledWith(editorWin, {
      doc: 'docs/getting-started.md',
      kind: 'doc',
      branch: 'main',
      multiCandidate: true,
    });
    expect(env.openProject).not.toHaveBeenCalled();
  });

  test('fallback (warm) focuses existing window + sends project-branch-switch payload', async () => {
    const env = makeEnv();
    const editorWin: FakeWindowHandle = { id: 'editor' };
    env.existingWindows.set('/Users/me/playbooks', editorWin);
    env.readyWindow = editorWin;
    const resolveShareTarget = mock(
      async (): Promise<CandidateSelection> => ({
        kind: 'fallback',
        anchor: makeCandidate({
          path: '/Users/me/playbooks',
          currentBranch: 'feature/x',
          hasOkConfig: true,
        }),
        reason: 'main-checkout',
      }),
    );
    const sendShareDeepLink = mock((_w: FakeWindowHandle, _p: ShareDeepLinkPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      resolveShareTarget,
      getFocusedWindow: () => editorWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(makeShareUrl(sharedBlobUrl));
    await flushPromises();
    await flushPromises();

    expect(env.focusWindowForProject).toHaveBeenCalledWith('/Users/me/playbooks');
    expect(env.openProject).not.toHaveBeenCalled();
    expect(sendShareDeepLink).toHaveBeenCalledWith(editorWin, {
      kind: 'project-branch-switch',
      share: expectedSharePayload(),
      projectPath: '/Users/me/playbooks',
      currentBranch: 'feature/x',
    });
  });

  test('fallback (warm) with sendShareDeepLink unwired logs the missing dep and falls through', async () => {
    const env = makeEnv();
    const editorWin: FakeWindowHandle = { id: 'editor' };
    env.existingWindows.set('/Users/me/playbooks', editorWin);
    env.readyWindow = editorWin;
    const resolveShareTarget = mock(
      async (): Promise<CandidateSelection> => ({
        kind: 'fallback',
        anchor: makeCandidate({
          path: '/Users/me/playbooks',
          currentBranch: 'feature/x',
          hasOkConfig: true,
        }),
        reason: 'main-checkout',
      }),
    );
    const warnLog: Array<{ obj: object; msg: string }> = [];

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      getFocusedWindow: () => editorWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: { warn: (obj, msg) => warnLog.push({ obj, msg }) },
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(makeShareUrl(sharedBlobUrl));
    await flushPromises();
    await flushPromises();

    expect(warnLog.some((e) => e.msg.includes('sendShareDeepLink dep missing'))).toBe(true);
    expect(env.openProject).toHaveBeenCalledWith(
      '/Users/me/playbooks',
      expect.objectContaining({ pendingShareBranchSwitch: expect.any(Object) }),
    );
  });

  test('fallback (cold) opens project with pendingShareBranchSwitch', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'some-other-editor' };
    const resolveShareTarget = mock(
      async (): Promise<CandidateSelection> => ({
        kind: 'fallback',
        anchor: makeCandidate({
          path: '/Users/me/playbooks',
          currentBranch: 'feature/x',
          hasOkConfig: true,
        }),
        reason: 'main-checkout',
      }),
    );
    const sendShareDeepLink = mock((_w: FakeWindowHandle, _p: ShareDeepLinkPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      resolveShareTarget,
      getFocusedWindow: () => env.readyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(makeShareUrl(sharedBlobUrl));
    await flushPromises();
    await flushPromises();

    expect(env.openProject).toHaveBeenCalledWith('/Users/me/playbooks', {
      pendingShareBranchSwitch: {
        share: expectedSharePayload(),
        projectPath: '/Users/me/playbooks',
        currentBranch: 'feature/x',
      },
    });
    expect(sendShareDeepLink).not.toHaveBeenCalled();
  });

  test('fallback (reason:only-worktrees) routes through the same dispatch as main-checkout', async () => {
    const env = makeEnv();
    const editorWin: FakeWindowHandle = { id: 'editor' };
    env.existingWindows.set('/Users/me/playbooks/worktrees/wt-1', editorWin);
    env.readyWindow = editorWin;
    const resolveShareTarget = mock(
      async (): Promise<CandidateSelection> => ({
        kind: 'fallback',
        anchor: makeCandidate({
          path: '/Users/me/playbooks/worktrees/wt-1',
          currentBranch: 'feature/x',
          hasOkConfig: true,
        }),
        reason: 'only-worktrees',
      }),
    );
    const sendShareDeepLink = mock((_w: FakeWindowHandle, _p: ShareDeepLinkPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      resolveShareTarget,
      getFocusedWindow: () => editorWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(makeShareUrl(sharedBlobUrl));
    await flushPromises();
    await flushPromises();

    expect(env.focusWindowForProject).toHaveBeenCalledWith('/Users/me/playbooks/worktrees/wt-1');
    expect(env.openProject).not.toHaveBeenCalled();
    expect(sendShareDeepLink).toHaveBeenCalledWith(editorWin, {
      kind: 'project-branch-switch',
      share: expectedSharePayload(),
      projectPath: '/Users/me/playbooks/worktrees/wt-1',
      currentBranch: 'feature/x',
    });
  });

  test('branch-match-non-ok routes to Navigator via launcher-consent payload', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'pre-existing' };
    const resolveShareTarget = mock(
      async (): Promise<CandidateSelection> => ({
        kind: 'branch-match-non-ok',
        candidate: makeCandidate({
          path: '/Users/me/playbooks/worktrees/wt-1',
          currentBranch: 'main',
          hasOkConfig: false,
        }),
        anchorRecent: null,
      }),
    );
    const routeShareToNavigator = mock((_p: ShareNavigatorPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      routeShareToNavigator,
      getFocusedWindow: () => env.readyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(makeShareUrl(sharedBlobUrl));
    await flushPromises();
    await flushPromises();

    expect(routeShareToNavigator).toHaveBeenCalledTimes(1);
    expect(routeShareToNavigator).toHaveBeenCalledWith({
      kind: 'launcher-consent',
      share: expectedSharePayload(),
      candidatePath: '/Users/me/playbooks/worktrees/wt-1',
      parentProjectName: null,
    });
    expect(env.openProject).not.toHaveBeenCalled();
  });

  test('branch-match-non-ok threads anchorRecent.name through as parentProjectName', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'pre-existing' };
    const resolveShareTarget = mock(
      async (): Promise<CandidateSelection> => ({
        kind: 'branch-match-non-ok',
        candidate: makeCandidate({
          path: '/Users/me/playbooks/worktrees/wt-1',
          currentBranch: 'main',
          hasOkConfig: false,
        }),
        anchorRecent: {
          name: 'playbooks',
          path: '/Users/me/playbooks',
          lastOpenedAt: '2026-06-01T00:00:00.000Z',
          gitRemoteUrl: 'https://github.com/me/playbooks',
        },
      }),
    );
    const routeShareToNavigator = mock((_p: ShareNavigatorPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      routeShareToNavigator,
      getFocusedWindow: () => env.readyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(makeShareUrl(sharedBlobUrl));
    await flushPromises();
    await flushPromises();

    expect(routeShareToNavigator).toHaveBeenCalledWith({
      kind: 'launcher-consent',
      share: expectedSharePayload(),
      candidatePath: '/Users/me/playbooks/worktrees/wt-1',
      parentProjectName: 'playbooks',
    });
  });

  test('miss routes to Navigator via launcher-miss payload', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'pre-existing' };
    const resolveShareTarget = mock(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));
    const routeShareToNavigator = mock((_p: ShareNavigatorPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      routeShareToNavigator,
      getFocusedWindow: () => env.readyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(makeShareUrl(sharedBlobUrl));
    await flushPromises();
    await flushPromises();

    expect(routeShareToNavigator).toHaveBeenCalledTimes(1);
    expect(routeShareToNavigator).toHaveBeenCalledWith({
      kind: 'launcher-miss',
      share: expectedSharePayload(),
    });
    expect(env.openProject).not.toHaveBeenCalled();
  });

  test('branch-match-ok cold path: openProject returning null degrades to launcher-miss', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'pre-existing' };
    const openProjectStub = mock(
      async (_p: string, _opts?: object): Promise<FakeWindowHandle | null> => null,
    );
    const resolveShareTarget = mock(
      async (): Promise<CandidateSelection> => ({
        kind: 'branch-match-ok',
        candidate: makeCandidate({ path: '/Users/me/missing-project', currentBranch: 'main' }),
        multiCandidate: true,
      }),
    );
    const routeShareToNavigator = mock((_p: ShareNavigatorPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: openProjectStub,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      routeShareToNavigator,
      getFocusedWindow: () => env.readyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(makeShareUrl(sharedBlobUrl));
    await flushPromises();
    await flushPromises();

    expect(openProjectStub).toHaveBeenCalledTimes(1);
    expect(routeShareToNavigator).toHaveBeenCalledWith({
      kind: 'launcher-miss',
      share: expectedSharePayload(),
    });
  });

  test('fallback cold path: openProject returning null degrades to launcher-miss', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'some-other-editor' };
    const openProjectStub = mock(
      async (_p: string, _opts?: object): Promise<FakeWindowHandle | null> => null,
    );
    const resolveShareTarget = mock(
      async (): Promise<CandidateSelection> => ({
        kind: 'fallback',
        anchor: makeCandidate({
          path: '/Users/me/wedged-project',
          currentBranch: 'feature/x',
          hasOkConfig: true,
        }),
        reason: 'main-checkout',
      }),
    );
    const routeShareToNavigator = mock((_p: ShareNavigatorPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: openProjectStub,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      routeShareToNavigator,
      getFocusedWindow: () => env.readyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(makeShareUrl(sharedBlobUrl));
    await flushPromises();
    await flushPromises();

    expect(openProjectStub).toHaveBeenCalledTimes(1);
    expect(routeShareToNavigator).toHaveBeenCalledWith({
      kind: 'launcher-miss',
      share: expectedSharePayload(),
    });
  });

  test('resolveShareTarget rejection degrades to Navigator (miss), not a silent drop', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'pre-existing' };
    const resolveShareTarget = mock(async (): Promise<CandidateSelection> => {
      throw new Error('git fetch failed');
    });
    const sendShareDeepLink = mock((_w: FakeWindowHandle, _p: ShareDeepLinkPayload) => {});
    const routeShareToNavigator = mock((_p: ShareNavigatorPayload) => {});
    const warnLog: Array<{ obj: object; msg: string }> = [];

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      resolveShareTarget,
      routeShareToNavigator,
      getFocusedWindow: () => env.readyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: { warn: (obj, msg) => warnLog.push({ obj, msg }) },
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(makeShareUrl(sharedBlobUrl));
    await flushPromises();
    await flushPromises();

    expect(routeShareToNavigator).toHaveBeenCalledTimes(1);
    expect(routeShareToNavigator).toHaveBeenCalledWith({
      kind: 'launcher-miss',
      share: expectedSharePayload(),
    });
    expect(env.openProject).not.toHaveBeenCalled();
    expect(warnLog.some((e) => e.msg.includes('resolveShareTarget rejected'))).toBe(true);
  });

  test('branch-match-non-ok with no routeShareToNavigator dep surfaces warn + no dispatch', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'pre-existing' };
    const resolveShareTarget = mock(
      async (): Promise<CandidateSelection> => ({
        kind: 'branch-match-non-ok',
        candidate: makeCandidate({
          path: '/some/worktree',
          currentBranch: 'main',
          hasOkConfig: false,
        }),
        anchorRecent: null,
      }),
    );
    const warnLog: Array<{ obj: object; msg: string }> = [];

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      getFocusedWindow: () => env.readyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: { warn: (obj, msg) => warnLog.push({ obj, msg }) },
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(makeShareUrl(sharedBlobUrl));
    await flushPromises();
    await flushPromises();

    expect(env.openProject).not.toHaveBeenCalled();
    expect(warnLog.some((e) => e.msg.includes('launcher-consent dropped'))).toBe(true);
  });

  test('share URL via second-instance argv reaches resolution', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'primary' };
    const resolveShareTarget = mock(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireSecondInstance([
      '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
      makeShareUrl(sharedBlobUrl),
    ]);
    await flushPromises();
    await flushPromises();

    expect(resolveShareTarget).toHaveBeenCalledTimes(1);
    expect(resolveShareTarget).toHaveBeenCalledWith(expectedSharePayload());
  });

  test('share URL via cold-start process.argv reaches resolution', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'pre-existing' };
    const resolveShareTarget = mock(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      getInitialArgv: () => [
        '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
        makeShareUrl(sharedBlobUrl),
      ],
    });
    env.app.resolveReady();
    await flushPromises();
    await flushPromises();

    expect(resolveShareTarget).toHaveBeenCalledTimes(1);
    expect(resolveShareTarget).toHaveBeenCalledWith(expectedSharePayload());
  });

  test('two share clicks in quick succession route independently even when resolution finishes out of order', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'ready' };
    let resolveA: (s: CandidateSelection) => void = () => {};
    let resolveB: (s: CandidateSelection) => void = () => {};
    const resolveShareTarget = mock(
      (share: ShareUrlPayload): Promise<CandidateSelection> =>
        share.repo === 'repo-a'
          ? new Promise<CandidateSelection>((r) => {
              resolveA = r;
            })
          : new Promise<CandidateSelection>((r) => {
              resolveB = r;
            }),
    );

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      getFocusedWindow: () => env.readyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(makeShareUrl('https://github.com/o/repo-a/blob/main/a.md'));
    env.app.fireOpenUrl(makeShareUrl('https://github.com/o/repo-b/blob/main/b.md'));
    await flushPromises();
    expect(env.openProject).not.toHaveBeenCalled();

    resolveB({
      kind: 'branch-match-ok',
      candidate: makeCandidate({ path: '/p/repo-b', currentBranch: 'main' }),
      multiCandidate: false,
    });
    await flushPromises();
    await flushPromises();
    resolveA({
      kind: 'branch-match-ok',
      candidate: makeCandidate({ path: '/p/repo-a', currentBranch: 'main' }),
      multiCandidate: false,
    });
    await flushPromises();
    await flushPromises();

    expect(env.openProject).toHaveBeenCalledWith(
      '/p/repo-b',
      expect.objectContaining({ pendingDeepLinkTarget: { kind: 'doc', path: 'b.md' } }),
    );
    expect(env.openProject).toHaveBeenCalledWith(
      '/p/repo-a',
      expect.objectContaining({ pendingDeepLinkTarget: { kind: 'doc', path: 'a.md' } }),
    );
  });
});

describe('registerProtocolHandler — screen-flow routing', () => {
  test('warm path: routes a screen URL to the focused window via openScreen', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const openScreen = mock((_win: FakeWindowHandle, _screen: ScreenTarget) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      openScreen,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl('openknowledge://screen?name=settings');
    await flushPromises();

    expect(openScreen).toHaveBeenCalledTimes(1);
    expect(openScreen).toHaveBeenCalledWith(focusedWin, 'settings');
    expect(env.openProject).not.toHaveBeenCalled();
    expect(env.sendDeepLink).not.toHaveBeenCalled();
  });

  test('routes the install-claude screen', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const openScreen = mock((_win: FakeWindowHandle, _screen: ScreenTarget) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      openScreen,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl('openknowledge://screen?name=install-claude');
    await flushPromises();

    expect(openScreen).toHaveBeenCalledWith(focusedWin, 'install-claude');
    expect(env.openProject).not.toHaveBeenCalled();
    expect(env.sendDeepLink).not.toHaveBeenCalled();
  });

  test('falls back to getAnyReadyWindow when getFocusedWindow returns null', async () => {
    const env = makeEnv();
    const readyWin: FakeWindowHandle = { id: 'fallback' };
    env.readyWindow = readyWin;
    const openScreen = mock((_win: FakeWindowHandle, _screen: ScreenTarget) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      openScreen,
      getFocusedWindow: () => null,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl('openknowledge://screen?name=settings');
    await flushPromises();

    expect(openScreen).toHaveBeenCalledTimes(1);
    expect(openScreen.mock.calls[0]?.[0]).toBe(readyWin);
  });

  test('missing openScreen dep surfaces a warn + no dispatch', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'ready' };
    const warnLog: Array<{ obj: object; msg: string }> = [];

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      getFocusedWindow: () => null,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: { warn: (obj, msg) => warnLog.push({ obj, msg }) },
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl('openknowledge://screen?name=settings');
    await flushPromises();

    expect(warnLog.some((e) => e.msg.includes('openScreen dep missing'))).toBe(true);
    expect(env.openProject).not.toHaveBeenCalled();
    expect(env.sendDeepLink).not.toHaveBeenCalled();
  });

  test('screen URL with no window available surfaces warn + no dispatch', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'ready' };
    const openScreen = mock((_win: FakeWindowHandle, _screen: ScreenTarget) => {});
    const warnLog: Array<{ obj: object; msg: string }> = [];

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: mock(() => null),
      openScreen,
      getFocusedWindow: () => null,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: { warn: (obj, msg) => warnLog.push({ obj, msg }) },
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl('openknowledge://screen?name=settings');
    await flushPromises();

    expect(openScreen).not.toHaveBeenCalled();
    expect(warnLog.some((e) => e.msg.includes('no target window'))).toBe(true);
  });
});

describe('registerProtocolHandler — continue-activity Handoff path', () => {
  test('routes Universal Link to share dispatch via enqueueOrRoute', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const resolveShareTarget = mock(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    const encoded = encodeShareUrl('https://github.com/inkeep/playbooks/blob/main/x.md');
    const url = `https://openknowledge.ai/d/${encoded}`;
    const event = env.app.fireContinueActivity('NSUserActivityTypeBrowsingWeb', null, {
      webpageURL: url,
    });
    await flushPromises();

    expect(event.preventDefault).toHaveBeenCalled();
    expect(resolveShareTarget).toHaveBeenCalledTimes(1);
    expect(resolveShareTarget).toHaveBeenCalledWith({
      owner: 'inkeep',
      repo: 'playbooks',
      branch: 'main',
      sharedUrl: 'https://github.com/inkeep/playbooks/blob/main/x.md',
      target: { kind: 'doc', docPath: 'x.md' },
    });
  });

  test('accepts www.openknowledge.ai host (dual-host AASA discipline)', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const resolveShareTarget = mock(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    const encoded = encodeShareUrl('https://github.com/o/r/blob/main/x.md');
    env.app.fireContinueActivity('NSUserActivityTypeBrowsingWeb', null, {
      webpageURL: `https://www.openknowledge.ai/d/${encoded}`,
    });
    await flushPromises();

    expect(resolveShareTarget).toHaveBeenCalledTimes(1);
  });

  test('reads webpageURL from userInfo as a fallback when details is undefined', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const resolveShareTarget = mock(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    const encoded = encodeShareUrl('https://github.com/o/r/blob/main/x.md');
    env.app.fireContinueActivity(
      'NSUserActivityTypeBrowsingWeb',
      { webpageURL: `https://openknowledge.ai/d/${encoded}` },
      undefined,
    );
    await flushPromises();

    expect(resolveShareTarget).toHaveBeenCalledTimes(1);
  });

  test('ignores non-NSUserActivityTypeBrowsingWeb activity types silently', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const sendShareDeepLink = mock((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});
    const warnLog: Array<{ obj: object; msg: string }> = [];

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: { warn: (obj, msg) => warnLog.push({ obj, msg }) },
    });
    env.app.resolveReady();
    await flushPromises();

    const event = env.app.fireContinueActivity(
      'com.example.unrelated.activity',
      { webpageURL: 'https://openknowledge.ai/d/x' },
      { webpageURL: 'https://openknowledge.ai/d/x' },
    );
    await flushPromises();

    expect(sendShareDeepLink).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(warnLog.some((e) => e.msg.includes('continue-activity-received'))).toBe(false);
  });

  test('ignores activities whose webpageURL is on a non-AASA host', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const sendShareDeepLink = mock((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});
    const warnLog: Array<{ obj: object; msg: string }> = [];

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: { warn: (obj, msg) => warnLog.push({ obj, msg }) },
    });
    env.app.resolveReady();
    await flushPromises();

    const event = env.app.fireContinueActivity('NSUserActivityTypeBrowsingWeb', null, {
      webpageURL: 'https://attacker.example.com/d/payload',
    });
    await flushPromises();

    expect(sendShareDeepLink).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(warnLog.some((e) => e.msg.includes('continue-activity-received'))).toBe(false);
  });

  test('ignores activities with no webpageURL on either details or userInfo', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const sendShareDeepLink = mock((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    const event = env.app.fireContinueActivity('NSUserActivityTypeBrowsingWeb', null, undefined);
    await flushPromises();

    expect(sendShareDeepLink).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test('ignores activities whose webpageURL is not a parseable URL', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const sendShareDeepLink = mock((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    const event = env.app.fireContinueActivity('NSUserActivityTypeBrowsingWeb', null, {
      webpageURL: 'not a url',
    });
    await flushPromises();

    expect(sendShareDeepLink).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test('emits [receive] action=continue-activity-received log with type + url-host', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const sendShareDeepLink = mock((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});
    const warnLog: Array<{ obj: object; msg: string }> = [];

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: { warn: (obj, msg) => warnLog.push({ obj, msg }) },
    });
    env.app.resolveReady();
    await flushPromises();

    const encoded = encodeShareUrl('https://github.com/o/r/blob/main/x.md');
    env.app.fireContinueActivity('NSUserActivityTypeBrowsingWeb', null, {
      webpageURL: `https://openknowledge.ai/d/${encoded}`,
    });
    await flushPromises();

    const entry = warnLog.find((e) => e.msg.includes('continue-activity-received'));
    expect(entry).toBeDefined();
    expect(entry?.obj).toMatchObject({
      type: 'NSUserActivityTypeBrowsingWeb',
      urlHost: 'openknowledge.ai',
    });
  });

  test('queue-then-flush: activity received before whenReady is drained after', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const resolveShareTarget = mock(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });

    const encoded = encodeShareUrl('https://github.com/o/r/blob/main/x.md');
    env.app.fireContinueActivity('NSUserActivityTypeBrowsingWeb', null, {
      webpageURL: `https://openknowledge.ai/d/${encoded}`,
    });
    expect(resolveShareTarget).not.toHaveBeenCalled();

    env.app.resolveReady();
    await flushPromises();

    expect(resolveShareTarget).toHaveBeenCalledTimes(1);
  });

  test('existing open-url + share-flow paths still route correctly after adding continue-activity', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.existingWindows.set('/tmp/p', focusedWin);
    env.readyWindow = focusedWin;
    const resolveShareTarget = mock(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl('openknowledge://open?project=/tmp/p&doc=a.md');
    await flushPromises();
    expect(env.sendDeepLink).toHaveBeenCalledWith(focusedWin, { doc: 'a.md', kind: 'doc' });

    const blobUrl = 'https://github.com/o/r/blob/main/x.md';
    env.app.fireOpenUrl(`openknowledge://share?url=${encodeURIComponent(blobUrl)}`);
    await flushPromises();
    expect(resolveShareTarget).toHaveBeenCalledTimes(1);
  });
});

describe('parseOpenKnowledgeFileUrl', () => {
  test('parses a well-formed file= URL to an absolute resolved path', () => {
    const parsed = parseOpenKnowledgeFileUrl(
      `openknowledge://open?file=${encodeURIComponent('/Users/me/notes/todo.md')}`,
    );
    expect(parsed).toEqual({ host: 'open', file: '/Users/me/notes/todo.md' });
  });

  test('rejects a relative path, `..` traversal, null bytes, and a missing param', () => {
    expect(parseOpenKnowledgeFileUrl('openknowledge://open?file=notes/todo.md')).toBeNull();
    expect(
      parseOpenKnowledgeFileUrl(
        `openknowledge://open?file=${encodeURIComponent('/Users/me/../etc/passwd')}`,
      ),
    ).toBeNull();
    expect(parseOpenKnowledgeFileUrl('openknowledge://open?file=%00/x.md')).toBeNull();
    expect(parseOpenKnowledgeFileUrl('openknowledge://open?project=/tmp/p&doc=a.md')).toBeNull();
  });

  test('rejects a foreign protocol / host', () => {
    expect(parseOpenKnowledgeFileUrl('https://open/?file=/x.md')).toBeNull();
    expect(
      parseOpenKnowledgeFileUrl(`openknowledge://share?file=${encodeURIComponent('/x.md')}`),
    ).toBeNull();
  });
});

describe('registerProtocolHandler — single-file open (file=)', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  test('a file= URL routes to openEphemeralFile, not openProject', async () => {
    env.readyWindow = { id: 'pre-existing' };
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      openEphemeralFile: env.openEphemeralFile,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(
      `openknowledge://open?file=${encodeURIComponent('/Users/me/notes/todo.md')}`,
    );
    await flushPromises();

    expect(env.openEphemeralFile).toHaveBeenCalledWith('/Users/me/notes/todo.md');
    expect(env.openProject).not.toHaveBeenCalled();
  });

  test('a project=&doc= URL still routes to openProject (file= branch did not shadow it)', async () => {
    env.readyWindow = { id: 'pre-existing' };
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      openEphemeralFile: env.openEphemeralFile,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl('openknowledge://open?project=/tmp/p&doc=a.md');
    await flushPromises();

    expect(env.openProject).toHaveBeenCalledWith('/tmp/p', {
      pendingDeepLinkTarget: { kind: 'doc', path: 'a.md' },
    });
    expect(env.openEphemeralFile).not.toHaveBeenCalled();
  });

  test('a file= URL with openEphemeralFile unwired warn-drops (no throw)', async () => {
    env.readyWindow = { id: 'pre-existing' };
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();

    expect(() =>
      env.app.fireOpenUrl(`openknowledge://open?file=${encodeURIComponent('/Users/me/x.md')}`),
    ).not.toThrow();
    await flushPromises();
    expect(env.openProject).not.toHaveBeenCalled();
  });
});
