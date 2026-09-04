import type { Candidate, CandidateSelection } from '@inkeep/open-knowledge-core';
import { encodeShareUrl } from '@inkeep/open-knowledge-core';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import shareFixture from '../../../../test-support/fixtures/share-url-v1-v2.json';
import type {
  ForeignHostDecision,
  ScreenTarget,
  ShareDeepLinkPayload,
  ShareNavigatorPayload,
  ShareUrlPayload,
} from '../../src/main/url-scheme.ts';
import { parseOpenKnowledgeFileUrl, registerProtocolHandler } from '../../src/main/url-scheme.ts';

// biome-ignore lint/suspicious/noExplicitAny: bun's `mock()` default was any-callable; the fakes below are assigned to precisely-typed SUT deps, which is where the checking happens.
type AnyMock = Mock<(...args: any[]) => any>;

type AppEvent = 'open-url' | 'open-file' | 'second-instance' | 'before-quit' | 'continue-activity';
type OpenUrlListener = (event: { preventDefault: () => void }, url: string) => void;
type OpenFileListener = (event: { preventDefault: () => void }, path: string) => void;
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
  | OpenFileListener
  | SecondInstanceListener
  | BeforeQuitListener
  | ContinueActivityListener;

interface FakeApp {
  on: AnyMock;
  whenReady: () => Promise<void>;
  isPackaged: boolean;
  setAsDefaultProtocolClient: AnyMock;
  removeAsDefaultProtocolClient: AnyMock;
  fireOpenUrl: (url: string) => void;
  fireOpenFile: (path: string) => { preventDefault: AnyMock };
  fireSecondInstance: (argv: readonly string[]) => void;
  fireBeforeQuit: () => void;
  fireContinueActivity: (
    type: string,
    userInfo: unknown,
    details?: { webpageURL?: string },
  ) => { preventDefault: AnyMock };
  resolveReady: () => void;
}

function makeFakeApp(opts?: { isPackaged?: boolean }): FakeApp {
  const listeners = new Map<AppEvent, AppListener>();
  let resolveReadyFn: (() => void) | null = null;
  const whenReady = () =>
    new Promise<void>((resolve) => {
      resolveReadyFn = resolve;
    });
  const on = vi.fn((event: AppEvent, cb: AppListener) => {
    listeners.set(event, cb);
  });
  return {
    on,
    whenReady,
    isPackaged: opts?.isPackaged ?? true,
    setAsDefaultProtocolClient: vi.fn(() => true),
    removeAsDefaultProtocolClient: vi.fn(() => true),
    fireOpenUrl: (url) => {
      const cb = listeners.get('open-url') as OpenUrlListener | undefined;
      if (!cb) throw new Error('open-url listener not registered');
      const event = { preventDefault: vi.fn(() => {}) };
      cb(event, url);
    },
    fireOpenFile: (path) => {
      const cb = listeners.get('open-file') as OpenFileListener | undefined;
      if (!cb) throw new Error('open-file listener not registered');
      const event = { preventDefault: vi.fn(() => {}) };
      cb(event, path);
      return event;
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
      const event = { preventDefault: vi.fn(() => {}) };
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
  focusWindowForProject: AnyMock;
  openProject: AnyMock;
  openEphemeralFile: AnyMock;
  sendDeepLink: AnyMock;
  getAnyReadyWindow: AnyMock;
  timers: Array<{ cb: () => void; ms: number }>;
  log: NonNullable<Parameters<typeof registerProtocolHandler>[0]['log']>;
  warnLog: Array<{ obj: Record<string, unknown>; msg: string }>;
  infoLog: Array<{ obj: Record<string, unknown>; msg: string }>;
  errorLog: Array<{ obj: Record<string, unknown>; msg: string }>;
  existingWindows: Map<string, FakeWindowHandle>;
  readyWindow: FakeWindowHandle | null;
}

function makeEnv(opts?: { isPackaged?: boolean }): TestEnv {
  const existingWindows = new Map<string, FakeWindowHandle>();
  let readyWindow: FakeWindowHandle | null = null;
  const timers: Array<{ cb: () => void; ms: number }> = [];
  const warnLog: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const infoLog: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const errorLog: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const log: NonNullable<Parameters<typeof registerProtocolHandler>[0]['log']> = {
    warn: (obj, msg) => warnLog.push({ obj, msg }),
    info: (obj, msg) => infoLog.push({ obj, msg }),
    error: (obj, msg) => errorLog.push({ obj, msg }),
  };
  return {
    app: makeFakeApp(opts),
    focusWindowForProject: vi.fn((p: string) => existingWindows.get(p) ?? null),
    openProject: vi.fn(
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
    openEphemeralFile: vi.fn(async (_filePath: string): Promise<void> => {}),
    sendDeepLink: vi.fn(() => {}),
    getAnyReadyWindow: vi.fn(() => readyWindow),
    timers,
    log,
    warnLog,
    infoLog,
    errorLog,
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

  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    test(`packaged ${platform} builds self-heal the scheme binding per boot`, () => {
      const env = makeEnv({ isPackaged: true });
      registerProtocolHandler({
        app: env.app,
        focusWindowForProject: env.focusWindowForProject,
        openProject: env.openProject,
        sendDeepLink: env.sendDeepLink,
        getAnyReadyWindow: env.getAnyReadyWindow,
        setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
        platform,
      });
      expect(env.app.setAsDefaultProtocolClient).toHaveBeenCalledWith('openknowledge');
      expect(env.app.on).not.toHaveBeenCalledWith('before-quit', expect.anything());
    });
  }

  test('logs a warn when setAsDefaultProtocolClient returns false', () => {
    const env = makeEnv({ isPackaged: false });
    env.app.setAsDefaultProtocolClient = vi.fn(() => false);
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: env.log,
    });
    expect(env.warnLog).toHaveLength(1);
    expect(env.warnLog[0]?.msg).toContain('returned false');
  });

  test('escalates a failed packaged self-heal to error, not warn', () => {
    const env = makeEnv({ isPackaged: true });
    env.app.setAsDefaultProtocolClient = vi.fn(() => false);
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: env.log,
      platform: 'darwin',
    });
    expect(env.warnLog).toHaveLength(0);
    expect(env.errorLog).toHaveLength(1);
    expect(env.errorLog[0]?.msg).toContain('packaged setAsDefaultProtocolClient returned false');
  });

  test('escalates a throwing packaged self-heal to error, not warn', () => {
    const env = makeEnv({ isPackaged: true });
    env.app.setAsDefaultProtocolClient = vi.fn(() => {
      throw new Error('Launch Services unavailable');
    });
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: env.log,
      platform: 'darwin',
    });
    expect(env.warnLog).toHaveLength(0);
    expect(env.errorLog).toHaveLength(1);
    expect(env.errorLog[0]?.msg).toContain('packaged setAsDefaultProtocolClient failed');
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
    env.app.setAsDefaultProtocolClient = vi.fn(() => false);
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
    env.app.removeAsDefaultProtocolClient = vi.fn(() => {
      throw new Error('launch services refused');
    });
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: env.log,
    });
    expect(() => env.app.fireBeforeQuit()).not.toThrow();
    expect(env.warnLog.some((e) => e.msg.includes('removeAsDefaultProtocolClient failed'))).toBe(
      true,
    );
  });
});

describe('registerProtocolHandler — deferred-share routeUrl + dedup', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  test('routeUrl feeds a redeemed /d/ universal link through the share spine; a near-simultaneous duplicate is deduped', async () => {
    env.readyWindow = { id: 'pre-existing' };
    const resolveShareTarget = vi.fn(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));
    const routeShareToNavigator = vi.fn(() => {});
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
    expect(routeShareToNavigator).toHaveBeenCalledTimes(1);

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

  test('does not dedup v1 and v2 when the source URL text is identical', async () => {
    env.readyWindow = { id: 'pre-existing' };
    const resolveShareTarget = vi.fn(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));
    const control = registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      routeShareToNavigator: vi.fn(() => {}),
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      now: () => 1_000_000,
    });
    env.app.resolveReady();
    await flushPromises();

    const sharedUrl = 'https://github.com/o/r/blob/main/wiki/x.md';
    control.routeUrl(`https://openknowledge.ai/d/${encodeShareUrl(sharedUrl)}`);
    control.routeUrl(`https://openknowledge.ai/d/${encodeShareUrl(sharedUrl, 1)}`);
    await flushPromises();
    await flushPromises();

    expect(resolveShareTarget).toHaveBeenCalledTimes(2);
    expect(resolveShareTarget.mock.calls[0]?.[0]).toMatchObject({
      target: { kind: 'doc', docPath: 'wiki/x.md' },
    });
    expect(resolveShareTarget.mock.calls[1]?.[0]).toMatchObject({
      target: { kind: 'doc', docPath: 'x.md' },
    });
  });
});

describe('registerProtocolHandler — foreign-host trust gate', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  function ghesShareUrl(): string {
    const token = encodeShareUrl('https://ghes.acme.test/acme/kb/blob/main/README.md');
    return `https://openknowledge.ai/d/${token}`;
  }

  async function driveGhesShare(overrides: {
    gateForeignShareHost?: (host: string, sharedUrl: string) => Promise<ForeignHostDecision>;
  }): Promise<{ resolveShareTarget: AnyMock }> {
    env.readyWindow = { id: 'pre-existing' };
    const resolveShareTarget = vi.fn(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));
    const control = registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget: resolveShareTarget as unknown as (
        share: ShareUrlPayload,
      ) => Promise<CandidateSelection>,
      routeShareToNavigator: vi.fn(() => {}),
      gateForeignShareHost: overrides.gateForeignShareHost,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      now: () => 1_000_000,
    });
    env.app.resolveReady();
    await flushPromises();
    control.routeUrl(ghesShareUrl());
    await flushPromises();
    await flushPromises();
    return { resolveShareTarget };
  }

  test('a foreign-host share is dropped when no gate is wired (fail-closed)', async () => {
    const { resolveShareTarget } = await driveGhesShare({ gateForeignShareHost: undefined });
    expect(resolveShareTarget).not.toHaveBeenCalled();
  });

  test('a foreign-host share does NOT resolve when the gate declines', async () => {
    const gate = vi.fn(async (): Promise<ForeignHostDecision> => 'cancel');
    const { resolveShareTarget } = await driveGhesShare({ gateForeignShareHost: gate });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate.mock.calls[0][0]).toBe('ghes.acme.test');
    expect(resolveShareTarget).not.toHaveBeenCalled();
  });

  test('a foreign-host share resolves when the gate proceeds (trusted host)', async () => {
    const gate = vi.fn(async (): Promise<ForeignHostDecision> => 'proceed');
    const { resolveShareTarget } = await driveGhesShare({ gateForeignShareHost: gate });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(resolveShareTarget).toHaveBeenCalledTimes(1);
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
      platform: 'linux',
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
    env.readyWindow = { id: 'pre-existing' };
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: env.log,
    });
    env.app.fireOpenUrl('openknowledge://open?doc=a.md');
    env.app.resolveReady();
    await flushPromises();

    expect(env.openProject).not.toHaveBeenCalled();
    expect(env.sendDeepLink).not.toHaveBeenCalled();
    expect(env.warnLog).toHaveLength(1);
    expect(env.warnLog[0]?.msg).toContain('dropped malformed URL');
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
    const openProjectStub = vi.fn(
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
      platform: 'linux',
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
    const resolveShareTarget = vi.fn(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));

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
      contentRootDepth: null,
      host: 'github.com',
      owner: 'inkeep',
      repo: 'playbooks',
      branch: 'main',
      repositoryTarget: { kind: 'doc', docPath: 'x.md' },
      sharedUrl: blobUrl,
      target: { kind: 'doc', docPath: 'x.md' },
    });
    expect(env.sendDeepLink).not.toHaveBeenCalled();
  });

  test('dispatches unsupported-version payload + logs [receive] action=url-parse', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const sendShareDeepLink = vi.fn((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: env.log,
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl('https://openknowledge.ai/d/AwABAg');
    await flushPromises();

    expect(sendShareDeepLink).toHaveBeenCalledWith(focusedWin, { kind: 'unsupported-version' });
    expect(env.warnLog).toContainEqual({
      obj: {
        source: 'universal-link',
        result: 'unsupported-version',
        codecVersion: 'unsupported',
        targetKind: 'unknown',
        rootScope: 'unknown',
        version: 3,
      },
      msg: '[receive] action=url-parse',
    });
  });

  test('dispatches invalid payload + logs [receive] for corrupt base64', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const sendShareDeepLink = vi.fn((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: env.log,
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl('https://openknowledge.ai/d/!!!not-base64!!!');
    await flushPromises();

    expect(sendShareDeepLink).toHaveBeenCalledWith(focusedWin, { kind: 'invalid' });
    expect(env.warnLog).toContainEqual({
      obj: {
        source: 'universal-link',
        result: 'invalid',
        codecVersion: 'unknown',
        targetKind: 'unknown',
        rootScope: 'unknown',
      },
      msg: '[receive] action=url-parse',
    });
    expect(JSON.stringify([...env.warnLog, ...env.errorLog])).not.toContain('!!!not-base64!!!');
  });

  test('malformed share-shaped and lookalike authority inputs keep logs scrubbed', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const sendShareDeepLink = vi.fn((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});
    const secret = 'SECRET-MALFORMED-SHARE';

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: env.log,
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(`https://openknowledge.ai/d/${secret}%00PATH`);
    env.app.fireOpenUrl(`openknowledge://share?token=${secret}%00`);
    env.app.fireOpenUrl(`https://openknowledge.ai:bad/d/${secret}`);
    env.app.fireOpenUrl(`https://www.openknowledge.ai:99999/d/${secret}`);
    env.app.fireOpenUrl(`openknowledge://share:bad?token=${secret}`);
    env.app.fireOpenUrl(`https://openknowledge.ai%00/d/${secret}`);
    env.app.fireOpenUrl(`https://openknowledge.ai./d/${secret}`);
    await flushPromises();

    expect(sendShareDeepLink).toHaveBeenCalledTimes(5);
    expect(sendShareDeepLink).toHaveBeenNthCalledWith(1, focusedWin, { kind: 'invalid' });
    expect(sendShareDeepLink).toHaveBeenNthCalledWith(2, focusedWin, { kind: 'invalid' });
    expect(sendShareDeepLink).toHaveBeenNthCalledWith(3, focusedWin, { kind: 'invalid' });
    expect(sendShareDeepLink).toHaveBeenNthCalledWith(4, focusedWin, { kind: 'invalid' });
    expect(sendShareDeepLink).toHaveBeenNthCalledWith(5, focusedWin, { kind: 'invalid' });
    expect(JSON.stringify([...env.warnLog, ...env.errorLog])).not.toContain(secret);
    expect(env.warnLog.filter(({ msg }) => msg === '[url-scheme] dropped malformed URL')).toEqual([
      { obj: {}, msg: '[url-scheme] dropped malformed URL' },
      { obj: {}, msg: '[url-scheme] dropped malformed URL' },
    ]);
    expect(env.warnLog).toContainEqual({
      obj: {
        source: 'universal-link',
        result: 'invalid',
        codecVersion: 'unknown',
        targetKind: 'unknown',
        rootScope: 'unknown',
      },
      msg: '[receive] action=url-parse',
    });
    expect(env.warnLog).toContainEqual({
      obj: {
        source: 'custom-scheme',
        result: 'invalid',
        codecVersion: 'unknown',
        targetKind: 'unknown',
        rootScope: 'unknown',
      },
      msg: '[receive] action=url-parse',
    });
  });

  test('logs a bounded v2 success classification without token, URL, or target path', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'ready' };
    const fixtureEntry = shareFixture.validShares.find(
      (entry) => entry.id === 'v2-one-segment-document',
    );
    if (!fixtureEntry || fixtureEntry.version !== 2) throw new Error('missing v2 fixture');

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget: async () => ({ kind: 'miss' }),
      routeShareToNavigator: () => {},
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: env.log,
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(`https://openknowledge.ai/d/${fixtureEntry.token}`);
    await flushPromises();

    expect(env.infoLog).toContainEqual({
      obj: {
        source: 'universal-link',
        result: 'ok',
        codecVersion: 'v2',
        targetKind: 'doc',
        rootScope: 'nested',
      },
      msg: '[receive] action=url-parse',
    });
    const serialized = JSON.stringify([...env.warnLog, ...env.infoLog, ...env.errorLog]);
    expect(serialized).not.toContain(fixtureEntry.token);
    expect(serialized).not.toContain(fixtureEntry.sharedUrl);
    expect(serialized).not.toContain(fixtureEntry.target.docPath);
  });

  test('ok share with no resolveShareTarget dep surfaces warn + no dispatch', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'ready' };
    const sendShareDeepLink = vi.fn((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      getFocusedWindow: () => null,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: env.log,
    });
    env.app.resolveReady();
    await flushPromises();

    const encoded = encodeShareUrl('https://github.com/o/r/blob/main/x.md');
    env.app.fireOpenUrl(`https://openknowledge.ai/d/${encoded}`);
    await flushPromises();

    expect(sendShareDeepLink).not.toHaveBeenCalled();
    expect(env.openProject).not.toHaveBeenCalled();
    expect(env.warnLog.some((e) => e.msg.includes('resolveShareTarget dep missing'))).toBe(true);
  });

  test('open-action URLs continue routing through the legacy path (regression check)', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.existingWindows.set('/tmp/p', focusedWin);
    env.readyWindow = focusedWin;
    const sendShareDeepLink = vi.fn((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});

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
      contentRootDepth: null,
      host: 'github.com',
      owner: 'inkeep',
      repo: 'playbooks',
      branch: 'main',
      sharedUrl: 'https://github.com/inkeep/playbooks/blob/main/docs/getting-started.md',
      repositoryTarget: { kind: 'doc', docPath: 'docs/getting-started.md' },
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
    const resolveShareTarget = vi.fn(
      async (_share: ShareUrlPayload): Promise<CandidateSelection> => ({
        kind: 'branch-match-ok',
        candidate: makeCandidate({ path: '/Users/me/playbooks', currentBranch: 'main' }),
        multiCandidate: true,
      }),
    );
    const sendShareDeepLink = vi.fn((_w: FakeWindowHandle, _p: ShareDeepLinkPayload) => {});

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
      pendingDeepLinkTarget: {
        kind: 'doc',
        path: 'docs/getting-started.md',
        repositoryPath: 'docs/getting-started.md',
      },
      pendingBranch: 'main',
      pendingMultiCandidate: true,
    });
    expect(sendShareDeepLink).not.toHaveBeenCalled();
  });

  test('v2 probes the repository coordinate but navigates the content coordinate', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'pre-existing' };
    const resolveShareTarget = vi.fn(
      async (): Promise<CandidateSelection> => ({
        kind: 'branch-match-ok',
        candidate: makeCandidate({ path: '/Users/me/playbooks', currentBranch: 'main' }),
        multiCandidate: false,
      }),
    );
    const checkShareTargetExists = vi.fn(() => 'exists' as const);
    const sharedUrl = 'https://github.com/inkeep/playbooks/blob/main/wiki/docs/getting-started.md';

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      checkShareTargetExists,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });
    env.app.resolveReady();
    await flushPromises();
    env.app.fireOpenUrl(`https://openknowledge.ai/d/${encodeShareUrl(sharedUrl, 1)}`);
    await flushPromises();
    await flushPromises();

    expect(checkShareTargetExists).toHaveBeenCalledWith(
      '/Users/me/playbooks',
      'doc',
      'wiki/docs/getting-started.md',
    );
    expect(env.openProject).toHaveBeenCalledWith('/Users/me/playbooks', {
      pendingDeepLinkTarget: {
        kind: 'doc',
        path: 'docs/getting-started.md',
        repositoryPath: 'wiki/docs/getting-started.md',
        contentRootDepth: 1,
      },
      pendingBranch: 'main',
      pendingMultiCandidate: false,
    });
  });

  test('branch-match-ok with multiCandidate=false omits the toast hint', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'pre-existing' };
    const resolveShareTarget = vi.fn(
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
      pendingDeepLinkTarget: {
        kind: 'doc',
        path: 'docs/getting-started.md',
        repositoryPath: 'docs/getting-started.md',
      },
      pendingBranch: 'main',
      pendingMultiCandidate: false,
    });
  });

  test('branch-match-ok (warm) focuses existing editor + delivers ok:deep-link immediately', async () => {
    const env = makeEnv();
    const editorWin: FakeWindowHandle = { id: 'editor' };
    env.existingWindows.set('/Users/me/playbooks', editorWin);
    env.readyWindow = editorWin;
    const resolveShareTarget = vi.fn(
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
      repositoryPath: 'docs/getting-started.md',
    });
    expect(env.openProject).not.toHaveBeenCalled();
  });

  test('fallback (warm) focuses existing window + sends project-branch-switch payload', async () => {
    const env = makeEnv();
    const editorWin: FakeWindowHandle = { id: 'editor' };
    env.existingWindows.set('/Users/me/playbooks', editorWin);
    env.readyWindow = editorWin;
    const resolveShareTarget = vi.fn(
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
    const sendShareDeepLink = vi.fn((_w: FakeWindowHandle, _p: ShareDeepLinkPayload) => {});

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
    const resolveShareTarget = vi.fn(
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

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      getFocusedWindow: () => editorWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: env.log,
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(makeShareUrl(sharedBlobUrl));
    await flushPromises();
    await flushPromises();

    expect(env.warnLog.some((e) => e.msg.includes('sendShareDeepLink dep missing'))).toBe(true);
    expect(env.openProject).toHaveBeenCalledWith(
      '/Users/me/playbooks',
      expect.objectContaining({ pendingShareBranchSwitch: expect.any(Object) }),
    );
  });

  test('fallback (cold) opens project with pendingShareBranchSwitch', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'some-other-editor' };
    const resolveShareTarget = vi.fn(
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
    const sendShareDeepLink = vi.fn((_w: FakeWindowHandle, _p: ShareDeepLinkPayload) => {});

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
    const resolveShareTarget = vi.fn(
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
    const sendShareDeepLink = vi.fn((_w: FakeWindowHandle, _p: ShareDeepLinkPayload) => {});

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
    const resolveShareTarget = vi.fn(
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
    const routeShareToNavigator = vi.fn((_p: ShareNavigatorPayload) => {});

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
    const resolveShareTarget = vi.fn(
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
    const routeShareToNavigator = vi.fn((_p: ShareNavigatorPayload) => {});

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
    const resolveShareTarget = vi.fn(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));
    const routeShareToNavigator = vi.fn((_p: ShareNavigatorPayload) => {});

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
    const openProjectStub = vi.fn(
      async (_p: string, _opts?: object): Promise<FakeWindowHandle | null> => null,
    );
    const resolveShareTarget = vi.fn(
      async (): Promise<CandidateSelection> => ({
        kind: 'branch-match-ok',
        candidate: makeCandidate({ path: '/Users/me/missing-project', currentBranch: 'main' }),
        multiCandidate: true,
      }),
    );
    const routeShareToNavigator = vi.fn((_p: ShareNavigatorPayload) => {});

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
    const openProjectStub = vi.fn(
      async (_p: string, _opts?: object): Promise<FakeWindowHandle | null> => null,
    );
    const resolveShareTarget = vi.fn(
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
    const routeShareToNavigator = vi.fn((_p: ShareNavigatorPayload) => {});

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
    const resolveShareTarget = vi.fn(async (): Promise<CandidateSelection> => {
      throw new Error('git fetch failed');
    });
    const sendShareDeepLink = vi.fn((_w: FakeWindowHandle, _p: ShareDeepLinkPayload) => {});
    const routeShareToNavigator = vi.fn((_p: ShareNavigatorPayload) => {});

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
      log: env.log,
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
    expect(env.warnLog.some((e) => e.msg.includes('resolveShareTarget rejected'))).toBe(true);
  });

  test('branch-match-non-ok with no routeShareToNavigator dep surfaces warn + no dispatch', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'pre-existing' };
    const resolveShareTarget = vi.fn(
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

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      resolveShareTarget,
      getFocusedWindow: () => env.readyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: env.log,
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl(makeShareUrl(sharedBlobUrl));
    await flushPromises();
    await flushPromises();

    expect(env.openProject).not.toHaveBeenCalled();
    expect(env.warnLog.some((e) => e.msg.includes('launcher-consent dropped'))).toBe(true);
  });

  test('share URL via second-instance argv reaches resolution', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'primary' };
    const resolveShareTarget = vi.fn(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));

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
    const resolveShareTarget = vi.fn(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));

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
    const resolveShareTarget = vi.fn(
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
      expect.objectContaining({
        pendingDeepLinkTarget: { kind: 'doc', path: 'b.md', repositoryPath: 'b.md' },
      }),
    );
    expect(env.openProject).toHaveBeenCalledWith(
      '/p/repo-a',
      expect.objectContaining({
        pendingDeepLinkTarget: { kind: 'doc', path: 'a.md', repositoryPath: 'a.md' },
      }),
    );
  });
});

describe('registerProtocolHandler — screen-flow routing', () => {
  test('warm path: routes a screen URL to the focused window via openScreen', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const openScreen = vi.fn((_win: FakeWindowHandle, _screen: ScreenTarget) => {});

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
    const openScreen = vi.fn((_win: FakeWindowHandle, _screen: ScreenTarget) => {});

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
    const openScreen = vi.fn((_win: FakeWindowHandle, _screen: ScreenTarget) => {});

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

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      getFocusedWindow: () => null,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: env.log,
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl('openknowledge://screen?name=settings');
    await flushPromises();

    expect(env.warnLog.some((e) => e.msg.includes('openScreen dep missing'))).toBe(true);
    expect(env.openProject).not.toHaveBeenCalled();
    expect(env.sendDeepLink).not.toHaveBeenCalled();
  });

  test('screen URL with no window available surfaces warn + no dispatch', async () => {
    const env = makeEnv();
    env.readyWindow = { id: 'ready' };
    const openScreen = vi.fn((_win: FakeWindowHandle, _screen: ScreenTarget) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: vi.fn(() => null),
      openScreen,
      getFocusedWindow: () => null,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: env.log,
    });
    env.app.resolveReady();
    await flushPromises();

    env.app.fireOpenUrl('openknowledge://screen?name=settings');
    await flushPromises();

    expect(openScreen).not.toHaveBeenCalled();
    expect(env.warnLog.some((e) => e.msg.includes('no target window'))).toBe(true);
  });
});

describe('registerProtocolHandler — continue-activity Handoff path', () => {
  test('routes Universal Link to share dispatch via enqueueOrRoute', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const resolveShareTarget = vi.fn(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));

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
      contentRootDepth: null,
      host: 'github.com',
      owner: 'inkeep',
      repo: 'playbooks',
      branch: 'main',
      repositoryTarget: { kind: 'doc', docPath: 'x.md' },
      sharedUrl: 'https://github.com/inkeep/playbooks/blob/main/x.md',
      target: { kind: 'doc', docPath: 'x.md' },
    });
  });

  test('accepts www.openknowledge.ai host (dual-host AASA discipline)', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const resolveShareTarget = vi.fn(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));

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
    const resolveShareTarget = vi.fn(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));

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
    const sendShareDeepLink = vi.fn((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: env.log,
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
    expect(env.warnLog.some((e) => e.msg.includes('continue-activity-received'))).toBe(false);
  });

  test('ignores activities whose webpageURL is on a non-AASA host', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const sendShareDeepLink = vi.fn((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: env.log,
    });
    env.app.resolveReady();
    await flushPromises();

    const event = env.app.fireContinueActivity('NSUserActivityTypeBrowsingWeb', null, {
      webpageURL: 'https://attacker.example.com/d/payload',
    });
    await flushPromises();

    expect(sendShareDeepLink).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(env.warnLog.some((e) => e.msg.includes('continue-activity-received'))).toBe(false);
  });

  test('ignores activities with no webpageURL on either details or userInfo', async () => {
    const env = makeEnv();
    const focusedWin: FakeWindowHandle = { id: 'focused' };
    env.readyWindow = focusedWin;
    const sendShareDeepLink = vi.fn((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});

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
    const sendShareDeepLink = vi.fn((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});

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
    const sendShareDeepLink = vi.fn((_win: FakeWindowHandle, _payload: ShareDeepLinkPayload) => {});

    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      sendShareDeepLink,
      getFocusedWindow: () => focusedWin,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
      log: env.log,
    });
    env.app.resolveReady();
    await flushPromises();

    const encoded = encodeShareUrl('https://github.com/o/r/blob/main/x.md');
    env.app.fireContinueActivity('NSUserActivityTypeBrowsingWeb', null, {
      webpageURL: `https://openknowledge.ai/d/${encoded}`,
    });
    await flushPromises();

    const entry = env.warnLog.find((e) => e.msg.includes('continue-activity-received'));
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
    const resolveShareTarget = vi.fn(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));

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
    const resolveShareTarget = vi.fn(async (): Promise<CandidateSelection> => ({ kind: 'miss' }));

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

describe('registerProtocolHandler — open-file Apple event (Finder Open With)', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  test('a warm open-file event routes to openEphemeralFile with the raw path + calls preventDefault', async () => {
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

    const event = env.app.fireOpenFile('/Users/me/notes/todo.md');
    await flushPromises();

    expect(event.preventDefault).toHaveBeenCalled();
    expect(env.openEphemeralFile).toHaveBeenCalledWith('/Users/me/notes/todo.md');
    expect(env.openProject).not.toHaveBeenCalled();
  });

  test('a path with spaces/special chars round-trips through the synthesized file= URL', async () => {
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

    const messy = '/Users/me/My Notes/draft #1 & more.md';
    env.app.fireOpenFile(messy);
    await flushPromises();

    expect(env.openEphemeralFile).toHaveBeenCalledWith(messy);
  });

  test('a cold-launch open-file (before whenReady) queues, then drains to openEphemeralFile', async () => {
    registerProtocolHandler({
      app: env.app,
      focusWindowForProject: env.focusWindowForProject,
      openProject: env.openProject,
      openEphemeralFile: env.openEphemeralFile,
      sendDeepLink: env.sendDeepLink,
      getAnyReadyWindow: env.getAnyReadyWindow,
      setTimeout: (cb, ms) => env.timers.push({ cb, ms }),
    });

    env.app.fireOpenFile('/Users/me/notes/todo.md');
    expect(env.openEphemeralFile).not.toHaveBeenCalled();

    env.readyWindow = { id: 'pre-existing' };
    env.app.resolveReady();
    await flushPromises();
    await flushPromises();

    expect(env.openEphemeralFile).toHaveBeenCalledWith('/Users/me/notes/todo.md');
  });
});
