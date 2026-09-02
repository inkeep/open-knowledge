import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn(() => Promise.resolve({ ok: true }));
const exposed = new Map<string, Record<string, unknown>>();

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: Record<string, unknown>) => {
      exposed.set(key, value);
    },
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => invokeMock(...(args as [])),
    on: () => {},
    removeListener: () => {},
    send: () => {},
  },
}));

type BridgeProbe = {
  bugReport: {
    send(request: {
      zipPath: string;
      metadata: Record<string, unknown>;
      includeScreenshot?: boolean;
    }): Promise<unknown>;
    create(request: Record<string, unknown>): Promise<unknown>;
  };
  terminal: {
    setDockState(state: {
      surface: 'terminal';
      order: string[];
      activeKey: string | null;
      terminalSnapshot: { tabs: []; activeOrdinal: null };
    }): Promise<{ ok: true } | { ok: false; reason: string }>;
  };
  editor: {
    notifyViewMenuStateChanged(state: {
      terminalVisible?: boolean;
      terminalPlacement?: 'bottom' | 'right';
    }): void;
  };
};

async function loadBridge(): Promise<BridgeProbe> {
  exposed.clear();
  vi.resetModules();
  await import('./index.ts');
  const bridge = exposed.get('okDesktop');
  if (bridge === undefined) throw new Error('preload did not expose okDesktop');
  return bridge as unknown as BridgeProbe;
}

function dispatchedPayload(channel: string): Record<string, unknown> {
  const call = invokeMock.mock.calls.find((c) => c[0] === channel);
  if (call === undefined) throw new Error(`nothing dispatched on ${channel}`);
  return call[1] as Record<string, unknown>;
}

beforeEach(() => {
  invokeMock.mockClear();
});

describe('preload editor view-menu state marshalling', () => {
  it('forwards terminal placement through the existing view-state channel', async () => {
    const bridge = await loadBridge();

    bridge.editor.notifyViewMenuStateChanged({
      terminalVisible: true,
      terminalPlacement: 'right',
    });

    expect(dispatchedPayload('ok:editor:view-menu-state-changed')).toEqual({
      terminalVisible: true,
      terminalPlacement: 'right',
    });
  });
});

describe('preload bugReport.send marshalling', () => {
  it('forwards the screenshot consent flag to main', async () => {
    const bridge = await loadBridge();

    await bridge.bugReport.send({
      zipPath: '/tmp/report.zip',
      metadata: { level: 'standard' },
      includeScreenshot: true,
    });

    expect(dispatchedPayload('ok:bug-report:dispatch')).toMatchObject({
      kind: 'send',
      zipPath: '/tmp/report.zip',
      includeScreenshot: true,
    });
  });

  it('forwards a withheld consent flag rather than omitting it', async () => {
    const bridge = await loadBridge();

    await bridge.bugReport.send({
      zipPath: '/tmp/report.zip',
      metadata: { level: 'standard' },
      includeScreenshot: false,
    });

    expect(dispatchedPayload('ok:bug-report:dispatch').includeScreenshot).toBe(false);
  });

  it('leaves the consent flag absent when the caller omits it', async () => {
    const bridge = await loadBridge();

    await bridge.bugReport.send({
      zipPath: '/tmp/report.zip',
      metadata: { level: 'standard' },
    });

    const payload = dispatchedPayload('ok:bug-report:dispatch');
    expect(payload.includeScreenshot).toBeUndefined();
  });

  it('dispatches the caller request verbatim under the send discriminant', async () => {
    const bridge = await loadBridge();
    const request = {
      zipPath: '/tmp/report.zip',
      metadata: { level: 'full', systemWide: false },
      includeScreenshot: true,
    };

    await bridge.bugReport.send(request);

    expect(dispatchedPayload('ok:bug-report:dispatch')).toEqual({ ...request, kind: 'send' });
  });
});

describe('preload bugReport.create marshalling', () => {
  it('dispatches the caller request verbatim under the create discriminant', async () => {
    const bridge = await loadBridge();
    const request = {
      level: 'full',
      note: 'a note',
      includeCrashDump: true,
      includeScreenshot: true,
    };

    await bridge.bugReport.create(request);

    expect(dispatchedPayload('ok:bug-report:dispatch')).toEqual({
      ...request,
      kind: 'create',
    });
  });
});

describe('preload terminal dock-state marshalling', () => {
  it('forwards terminal tab state and returns the main-process persistence result', async () => {
    const bridge = await loadBridge();

    const result = await bridge.terminal.setDockState({
      surface: 'terminal',
      order: ['pty-a', 'pty-b'],
      activeKey: 'pty-b',
      terminalSnapshot: { tabs: [], activeOrdinal: null },
    });

    expect(result).toEqual({ ok: true });
    expect(dispatchedPayload('ok:terminal:set-dock-state')).toEqual({
      surface: 'terminal',
      order: ['pty-a', 'pty-b'],
      activeKey: 'pty-b',
      terminalSnapshot: { tabs: [], activeOrdinal: null },
    });
  });

  it('propagates an unrecognized invoke failure instead of reporting false success', async () => {
    invokeMock.mockRejectedValueOnce(new Error('serialization bug'));
    const bridge = await loadBridge();

    await expect(
      bridge.terminal.setDockState({
        surface: 'terminal',
        order: [],
        activeKey: null,
        terminalSnapshot: { tabs: [], activeOrdinal: null },
      }),
    ).rejects.toThrow('serialization bug');
  });

  it('classifies a destroyed IPC endpoint as an unavailable write', async () => {
    invokeMock.mockRejectedValueOnce(new Error('Object has been destroyed'));
    const bridge = await loadBridge();

    await expect(
      bridge.terminal.setDockState({
        surface: 'terminal',
        order: [],
        activeKey: null,
        terminalSnapshot: { tabs: [], activeOrdinal: null },
      }),
    ).resolves.toEqual({ ok: false, reason: 'ipc-unavailable' });
  });
});
