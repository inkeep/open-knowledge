import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import {
  observeThemeSourcePushes,
  probeLiveWindowsInMain,
  type ThemeSourceWindowProbe,
  windowsStillOwingAThemeSourcePush,
} from './theme-source-pushes';

function pushLine(senderWindowId: number): string {
  return `${JSON.stringify({ event: 'theme-source-set', source: 'dark', senderWindowId })}\n`;
}

function fakeElectronProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return { stdout, stderr, app: { process: () => ({ stdout, stderr }) } };
}

describe('observeThemeSourcePushes', () => {
  test('records the sender of a push line delivered whole on stderr', () => {
    const { stderr, app } = fakeElectronProcess();
    const pushedBy = observeThemeSourcePushes(app);

    stderr.emit('data', Buffer.from(pushLine(3), 'utf8'));

    expect([...pushedBy]).toEqual([3]);
  });

  test('records the sender of a push line delivered whole on stdout', () => {
    const { stdout, app } = fakeElectronProcess();
    const pushedBy = observeThemeSourcePushes(app);

    stdout.emit('data', Buffer.from(pushLine(4), 'utf8'));

    expect([...pushedBy]).toEqual([4]);
  });

  test('reassembles a stderr push line split around a chunk from stdout', () => {
    const { stdout, stderr, app } = fakeElectronProcess();
    const pushedBy = observeThemeSourcePushes(app);
    const line = pushLine(7);
    const splitAt = line.indexOf('"source"');

    stderr.emit('data', Buffer.from(line.slice(0, splitAt), 'utf8'));
    stdout.emit('data', Buffer.from('[1:0921/084326.1:INFO:x.cc(9)] unrelated noise\n', 'utf8'));
    stderr.emit('data', Buffer.from(line.slice(splitAt), 'utf8'));

    expect([...pushedBy]).toEqual([7]);
  });
});

interface FakeProbedWindow {
  id: number;
  url?: string;
  loading?: boolean;
  destroyed?: boolean;
  executeJavaScript: (code: string) => Promise<unknown>;
}

function fakeElectron(windows: readonly FakeProbedWindow[]) {
  return {
    BrowserWindow: {
      getAllWindows: () =>
        windows.map((win) => ({
          id: win.id,
          isDestroyed: () => win.destroyed === true,
          webContents: {
            getURL: () => win.url ?? `file:///app/index.html#/${win.id}`,
            isLoading: () => win.loading === true,
            executeJavaScript: win.executeJavaScript,
          },
        })),
    },
  };
}

const PROBE_LIMITS = { abandonProbeAfterMs: 20, maxCauseChars: 200 };

describe('probeLiveWindowsInMain', () => {
  test('reports a renderer that answers with the bridge exposed as present', async () => {
    const probes = await probeLiveWindowsInMain(
      fakeElectron([{ id: 1, executeJavaScript: async () => true }]),
      PROBE_LIMITS,
    );

    expect(probes).toEqual([
      { id: 1, url: 'file:///app/index.html#/1', loading: false, bridge: 'present' },
    ]);
  });

  test('reports a renderer that answers without the bridge as absent', async () => {
    const probes = await probeLiveWindowsInMain(
      fakeElectron([{ id: 2, executeJavaScript: async () => false }]),
      PROBE_LIMITS,
    );

    expect(probes.map((probe) => probe.bridge)).toEqual(['absent']);
    expect(probes[0]?.cause).toBeUndefined();
  });

  test('reports a renderer whose probe is rejected as probe-rejected, quoting the rejection', async () => {
    const probes = await probeLiveWindowsInMain(
      fakeElectron([
        {
          id: 3,
          executeJavaScript: async () => {
            throw new Error('Render frame was disposed before executeJavaScript could be run');
          },
        },
      ]),
      PROBE_LIMITS,
    );

    expect(probes.map((probe) => probe.bridge)).toEqual(['probe-rejected']);
    expect(probes[0]?.cause).toContain('Render frame was disposed');
  });

  test('reports a renderer whose probe never answers as probe-unanswered, naming the bound', async () => {
    const probes = await probeLiveWindowsInMain(
      fakeElectron([{ id: 4, executeJavaScript: () => new Promise<never>(() => {}) }]),
      PROBE_LIMITS,
    );

    expect(probes.map((probe) => probe.bridge)).toEqual(['probe-unanswered']);
    expect(probes[0]?.cause).toContain('20ms');
  });

  test('bounds a runaway rejection message at maxCauseChars', async () => {
    const probes = await probeLiveWindowsInMain(
      fakeElectron([
        {
          id: 5,
          executeJavaScript: async () => {
            throw new Error('x'.repeat(5_000));
          },
        },
      ]),
      { abandonProbeAfterMs: 20, maxCauseChars: 32 },
    );

    expect(probes.map((probe) => probe.bridge)).toEqual(['probe-rejected']);
    expect(probes[0]?.cause).toBe('x'.repeat(32));
  });

  test('records a bounded cause for a rejection that is not an Error', async () => {
    const probes = await probeLiveWindowsInMain(
      fakeElectron([{ id: 6, executeJavaScript: () => Promise.reject('script failed') }]),
      PROBE_LIMITS,
    );

    expect(probes.map((probe) => probe.bridge)).toEqual(['probe-rejected']);
    expect(probes[0]?.cause).toBe('script failed');
  });

  test('carries each live window id, url and load state through its probe', async () => {
    const probes = await probeLiveWindowsInMain(
      fakeElectron([
        {
          id: 7,
          url: 'file:///app/index.html#/doc',
          loading: true,
          executeJavaScript: async () => true,
        },
        {
          id: 8,
          url: 'http://localhost:3030/',
          loading: false,
          executeJavaScript: async () => false,
        },
      ]),
      PROBE_LIMITS,
    );

    expect(probes).toEqual([
      { id: 7, url: 'file:///app/index.html#/doc', loading: true, bridge: 'present' },
      { id: 8, url: 'http://localhost:3030/', loading: false, bridge: 'absent' },
    ]);
  });

  test('skips a destroyed window instead of probing it', async () => {
    const reached: number[] = [];
    const answerAndRecord = (id: number) => async () => {
      reached.push(id);
      return true;
    };

    const probes = await probeLiveWindowsInMain(
      fakeElectron([
        { id: 9, destroyed: true, executeJavaScript: answerAndRecord(9) },
        { id: 10, executeJavaScript: answerAndRecord(10) },
      ]),
      PROBE_LIMITS,
    );

    expect(probes.map((probe) => probe.id)).toEqual([10]);
    expect(reached).toEqual([10]);
  });

  test('keeps answering after Playwright serializes it through String(pageFunction)', async () => {
    const rebuilt = new Function(
      `return ${String(probeLiveWindowsInMain)}`,
    )() as typeof probeLiveWindowsInMain;

    const probes = await rebuilt(
      fakeElectron([
        {
          id: 11,
          executeJavaScript: async () => {
            throw new Error('Render frame was disposed');
          },
        },
      ]),
      PROBE_LIMITS,
    );

    expect(probes.map((probe) => probe.bridge)).toEqual(['probe-rejected']);
    expect(probes[0]?.cause).toContain('Render frame was disposed');
  });
});

describe('windowsStillOwingAThemeSourcePush', () => {
  test('drops a settled bridgeless window, which has no way to push a theme source', () => {
    const slidesWindow: ThemeSourceWindowProbe = {
      id: 5,
      url: 'http://localhost:3030/',
      bridge: 'absent',
      loading: false,
    };

    expect(windowsStillOwingAThemeSourcePush([slidesWindow], new Set())).toEqual([]);
  });

  test('keeps a bridged window that has not pushed, and a loading window whose bridge is not up yet', () => {
    const windows: ThemeSourceWindowProbe[] = [
      { id: 1, url: 'file:///app/index.html#/doc', bridge: 'present', loading: false },
      { id: 2, url: '', bridge: 'absent', loading: true },
      { id: 3, url: 'file:///app/index.html#/other', bridge: 'present', loading: false },
    ];

    const owed = windowsStillOwingAThemeSourcePush(windows, new Set([3]));

    expect(owed.map(({ id, reason }) => ({ id, reason }))).toEqual([
      { id: 1, reason: 'owes' },
      { id: 2, reason: 'loading' },
    ]);
  });

  test('names each stalled window by its own url', () => {
    const windows: ThemeSourceWindowProbe[] = [
      { id: 11, url: 'file:///app/index.html#/first', bridge: 'present', loading: false },
      { id: 12, url: 'file:///app/uninstall.html', bridge: 'present', loading: false },
    ];

    expect(windowsStillOwingAThemeSourcePush(windows, new Set())).toEqual([
      { id: 11, url: 'file:///app/index.html#/first', reason: 'owes' },
      { id: 12, url: 'file:///app/uninstall.html', reason: 'owes' },
    ]);
  });

  test('keeps a settled window whose bridge probe was rejected, and carries the rejection cause', () => {
    const rejectedWindow: ThemeSourceWindowProbe = {
      id: 9,
      url: 'file:///app/index.html#/stalled',
      bridge: 'probe-rejected',
      loading: false,
      cause: 'Render frame was disposed',
    };

    expect(windowsStillOwingAThemeSourcePush([rejectedWindow], new Set())).toEqual([
      {
        id: 9,
        url: 'file:///app/index.html#/stalled',
        reason: 'probe-rejected',
        cause: 'Render frame was disposed',
      },
    ]);
  });

  test('keeps a settled window whose bridge probe never answered, since it cannot be told apart from one that owes a push', () => {
    const unansweredWindow: ThemeSourceWindowProbe = {
      id: 10,
      url: 'file:///app/index.html#/silent',
      bridge: 'probe-unanswered',
      loading: false,
      cause: 'bridge probe went unanswered for 2000ms',
    };

    expect(windowsStillOwingAThemeSourcePush([unansweredWindow], new Set())).toEqual([
      {
        id: 10,
        url: 'file:///app/index.html#/silent',
        reason: 'probe-unanswered',
        cause: 'bridge probe went unanswered for 2000ms',
      },
    ]);
  });

  test('a push settles a window regardless of load state', () => {
    const pushedWhileStillLoading: ThemeSourceWindowProbe = {
      id: 8,
      url: 'file:///app/index.html#/booting',
      bridge: 'present',
      loading: true,
    };

    expect(windowsStillOwingAThemeSourcePush([pushedWhileStillLoading], new Set())).toEqual([
      { id: 8, url: 'file:///app/index.html#/booting', reason: 'loading' },
    ]);
    expect(windowsStillOwingAThemeSourcePush([pushedWhileStillLoading], new Set([8]))).toEqual([]);
  });
});
