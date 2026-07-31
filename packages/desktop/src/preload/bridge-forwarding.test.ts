/**
 * Preload marshalling contract.
 *
 * The preload sits between the renderer and main and re-assembles requests on
 * the way through, so a field the renderer sends and this layer forgets is
 * simply gone. Nothing else catches that: the main-process tests call the
 * handlers directly, and the renderer DOM tests assert what the component hands
 * a bridge stub. Both sides can be individually correct while the join drops
 * data, and the drop is silent whenever the field is optional and main reads
 * absent as a legitimate value — which is the shape of every consent flag.
 *
 * These tests assert the dispatched payload carries what the caller passed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn(() => Promise.resolve({ ok: true }));
const exposed = new Map<string, Record<string, unknown>>();

// Electron is unavailable in the test runner, and importing the preload module
// executes it — so both halves it touches at import time are stubbed here.
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

/** The `okDesktop` bridge object the preload exposed, typed loosely for probing. */
type BridgeProbe = {
  bugReport: {
    send(request: {
      zipPath: string;
      metadata: Record<string, unknown>;
      includeScreenshot?: boolean;
    }): Promise<unknown>;
    create(request: Record<string, unknown>): Promise<unknown>;
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

/** The payload object handed to `ipcRenderer.invoke` for the given channel. */
function dispatchedPayload(channel: string): Record<string, unknown> {
  const call = invokeMock.mock.calls.find((c) => c[0] === channel);
  if (call === undefined) throw new Error(`nothing dispatched on ${channel}`);
  return call[1] as Record<string, unknown>;
}

beforeEach(() => {
  invokeMock.mockClear();
});

describe('preload bugReport.send marshalling', () => {
  it('forwards the screenshot consent flag to main', async () => {
    // Absent means "reporter declined" on the main side, so dropping the flag
    // here disables the inline screenshot with no trace at all: main's skip
    // logging never fires, because from its view consent was refused.
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
    // `false` and absent mean the same thing to main today, but they must not be
    // conflated here: an explicit refusal is a decision the reporter made, and a
    // future main-side change that distinguishes them should not be silently
    // deprived of the difference by this layer.
    const bridge = await loadBridge();

    await bridge.bugReport.send({
      zipPath: '/tmp/report.zip',
      metadata: { level: 'standard' },
      includeScreenshot: false,
    });

    expect(dispatchedPayload('ok:bug-report:dispatch').includeScreenshot).toBe(false);
  });

  it('leaves the consent flag absent when the caller omits it', async () => {
    // The retry path in the report list omits the flag: by then the capture is
    // no longer in memory, and absent is what makes main withhold the upload.
    // Nothing may synthesize a value here, in either direction.
    const bridge = await loadBridge();

    await bridge.bugReport.send({
      zipPath: '/tmp/report.zip',
      metadata: { level: 'standard' },
    });

    const payload = dispatchedPayload('ok:bug-report:dispatch');
    expect(payload.includeScreenshot).toBeUndefined();
  });

  it('dispatches the caller request verbatim under the send discriminant', async () => {
    // Compared against the request itself rather than a written-out key list, so
    // a field this file does not know about still has to survive the crossing.
    // What it cannot cover is a field no caller here passes — the request below
    // has to gain one when the contract does.
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
    // `create` was already correct; pinning it keeps the sibling operation from
    // regressing the same way, since it carries the other screenshot opt-in.
    // Asserted with the same exact-equality shape as `send` rather than a
    // per-key loop: a loop cannot see an added key, and the discriminant is
    // part of what the caller is entitled to have dispatched unchanged.
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
