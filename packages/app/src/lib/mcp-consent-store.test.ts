/**
 * mcp-consent-store — install, subscribe, confirm, skip, dismiss flows.
 * Repo convention is no @testing-library/react; tests exercise the store via
 * the module API directly and assert bridge-call counters + snapshot deltas.
 */
import { describe, expect, mock, test } from 'bun:test';
import type {
  OkDesktopBridge,
  OkMcpWiringEditorId,
  OkMcpWiringShowPayload,
} from './desktop-bridge-types';
import { createMcpConsentStore } from './mcp-consent-store';

interface MockBridgeShape {
  mcpWiring: {
    onShow: ReturnType<typeof mock>;
    signalReady: ReturnType<typeof mock>;
    confirm: ReturnType<typeof mock>;
    skip: ReturnType<typeof mock>;
  };
  fireShow: (payload: OkMcpWiringShowPayload) => void;
  unsubscribeCalls: number;
}

function makeBridge(
  opts: {
    confirmResult?: unknown;
    skipResult?: unknown;
    confirmThrows?: boolean;
    skipThrows?: boolean;
  } = {},
): OkDesktopBridge & MockBridgeShape {
  const state = {
    handler: null as ((payload: OkMcpWiringShowPayload) => void) | null,
    unsubscribeCalls: 0,
  };
  const onShow = mock((cb: (payload: OkMcpWiringShowPayload) => void) => {
    state.handler = cb;
    return mock(() => {
      state.handler = null;
      state.unsubscribeCalls += 1;
    });
  });
  const signalReady = mock(() => {});
  const confirm = mock(() => {
    if (opts.confirmThrows) return Promise.reject(new Error('confirm-boom'));
    return Promise.resolve(opts.confirmResult ?? { ok: true });
  });
  const skip = mock(() => {
    if (opts.skipThrows) return Promise.reject(new Error('skip-boom'));
    return Promise.resolve(opts.skipResult ?? { ok: true });
  });

  // Cast at the boundary — we exercise only `mcpWiring` so the full bridge
  // shape does not need to be mocked out here.
  const bridge = {
    mcpWiring: { onShow, signalReady, confirm, skip },
  } as unknown as OkDesktopBridge & MockBridgeShape;

  Object.defineProperty(bridge, 'fireShow', {
    value: (payload: OkMcpWiringShowPayload) => state.handler?.(payload),
  });
  Object.defineProperty(bridge, 'unsubscribeCalls', {
    get: () => state.unsubscribeCalls,
  });
  return bridge;
}

const sampleShowPayload: OkMcpWiringShowPayload = {
  detectedEditors: [
    { id: 'claude', label: 'Claude', detected: true, willReplace: false },
    { id: 'cursor', label: 'Cursor', detected: false, willReplace: false },
  ],
  pathInstall: { shellDetected: true, rcFilesToTouch: ['~/.zshrc'], alreadyInstalled: false },
  globalSkills: [],
};

describe('createMcpConsentStore — install', () => {
  test('returns undefined when bridge is missing (web/CLI distribution)', () => {
    const store = createMcpConsentStore();
    const result = store.install({ bridge: undefined });
    expect(result).toBeUndefined();
    // Snapshot stays null — subscription never attached.
    expect(store.getSnapshot()).toBeNull();
  });

  test('subscribes to onShow + calls signalReady exactly once', () => {
    const store = createMcpConsentStore();
    const bridge = makeBridge();
    const unsubscribe = store.install({ bridge });
    expect(typeof unsubscribe).toBe('function');
    expect(bridge.mcpWiring.onShow.mock.calls.length).toBe(1);
    expect(bridge.mcpWiring.signalReady.mock.calls.length).toBe(1);
  });

  test('idempotent — a second install with same bridge does not re-subscribe', () => {
    const store = createMcpConsentStore();
    const bridge = makeBridge();
    store.install({ bridge });
    store.install({ bridge });
    expect(bridge.mcpWiring.onShow.mock.calls.length).toBe(1);
    expect(bridge.mcpWiring.signalReady.mock.calls.length).toBe(1);
  });

  test('returned unsubscribe detaches the bridge listener + clears snapshot', () => {
    const store = createMcpConsentStore();
    const bridge = makeBridge();
    const unsubscribe = store.install({ bridge });
    bridge.fireShow(sampleShowPayload);
    expect(store.getSnapshot()).toEqual(sampleShowPayload);
    unsubscribe?.();
    expect(bridge.unsubscribeCalls).toBe(1);
    expect(store.getSnapshot()).toBeNull();
  });
});

describe('createMcpConsentStore — onShow propagation', () => {
  test('fireShow updates snapshot + notifies subscribers', () => {
    const store = createMcpConsentStore();
    const bridge = makeBridge();
    store.install({ bridge });
    const listener = mock(() => {});
    store.subscribe(listener);

    bridge.fireShow(sampleShowPayload);
    expect(store.getSnapshot()).toEqual(sampleShowPayload);
    expect(listener.mock.calls.length).toBe(1);
  });

  test('subscribe returns unsubscribe that detaches from listeners Set', () => {
    const store = createMcpConsentStore();
    const bridge = makeBridge();
    store.install({ bridge });
    const listener = mock(() => {});
    const unsub = store.subscribe(listener);
    unsub();
    bridge.fireShow(sampleShowPayload);
    expect(listener.mock.calls.length).toBe(0);
  });
});

describe('createMcpConsentStore — confirm', () => {
  test('no-op + error result when bridge is not attached', async () => {
    const store = createMcpConsentStore();
    const result = await store.confirm({ editorIds: [] });
    expect(result).toEqual({ ok: false, error: 'Not attached to desktop bridge' });
  });

  test('passes the confirm request (editors + PATH toggle) through to the bridge', async () => {
    const store = createMcpConsentStore();
    const bridge = makeBridge();
    store.install({ bridge });
    bridge.fireShow(sampleShowPayload);

    const editorIds: OkMcpWiringEditorId[] = ['claude', 'cursor'];
    const result = await store.confirm({ editorIds, pathInstall: false });

    expect(result).toEqual({ ok: true });
    expect(bridge.mcpWiring.confirm.mock.calls[0]).toEqual([{ editorIds, pathInstall: false }]);
  });

  test('clears snapshot on success', async () => {
    const store = createMcpConsentStore();
    const bridge = makeBridge();
    store.install({ bridge });
    bridge.fireShow(sampleShowPayload);
    expect(store.getSnapshot()).not.toBeNull();

    await store.confirm({ editorIds: ['claude'], pathInstall: true });
    expect(store.getSnapshot()).toBeNull();
  });

  // Partial-failure recovery contract: thrown rejections
  // from the bridge (IPC channel dead, main-side exception) must NOT
  // unmount the dialog. The surface is transient (channel can recover on
  // retry); the store keeps `currentRequest` populated so the user can
  // click Add again from the same still-visible dialog.
  test('keeps snapshot mounted + returns error shape on thrown rejection', async () => {
    const store = createMcpConsentStore();
    const bridge = makeBridge({ confirmThrows: true });
    store.install({ bridge });
    bridge.fireShow(sampleShowPayload);

    const result = await store.confirm({ editorIds: ['claude'] });
    expect(result).toEqual({ ok: false, error: 'confirm-boom' });
    // Dialog stays mounted — partial-failure recovery contract. User
    // can click Add again without waiting for next-boot re-fire.
    expect(store.getSnapshot()).toEqual(sampleShowPayload);
  });

  test('keeps snapshot mounted on ok:false result (main-side write failure)', async () => {
    const store = createMcpConsentStore();
    const bridge = makeBridge({ confirmResult: { ok: false, error: 'no editors selected' } });
    store.install({ bridge });
    bridge.fireShow(sampleShowPayload);

    const result = await store.confirm({ editorIds: [] });
    expect(result).toEqual({ ok: false, error: 'no editors selected' });
    // Dialog stays mounted so the user can adjust selections + retry.
    // The main handler has reset its `handled` flag on the failure path
    // (mcp-wiring.ts:confirmHandler), so the retry is live.
    expect(store.getSnapshot()).toEqual(sampleShowPayload);
  });
});

describe('createMcpConsentStore — skip', () => {
  test('no-op + error result when bridge is not attached', async () => {
    const store = createMcpConsentStore();
    const result = await store.skip();
    expect(result).toEqual({ ok: false, error: 'Not attached to desktop bridge' });
  });

  test('invokes bridge.skip + clears snapshot on success', async () => {
    const store = createMcpConsentStore();
    const bridge = makeBridge();
    store.install({ bridge });
    bridge.fireShow(sampleShowPayload);

    const result = await store.skip();
    expect(result).toEqual({ ok: true });
    expect(bridge.mcpWiring.skip.mock.calls.length).toBe(1);
    expect(store.getSnapshot()).toBeNull();
  });

  test('keeps snapshot mounted + returns error shape on thrown rejection', async () => {
    // Symmetric with confirm. A transient IPC failure
    // on skip shouldn't permanently dismiss the dialog — the user may
    // retry and reach success, or pick Add instead. Dialog stays mounted
    // until a truly-acknowledged outcome lands.
    const store = createMcpConsentStore();
    const bridge = makeBridge({ skipThrows: true });
    store.install({ bridge });
    bridge.fireShow(sampleShowPayload);

    const result = await store.skip();
    expect(result).toEqual({ ok: false, error: 'skip-boom' });
    expect(store.getSnapshot()).toEqual(sampleShowPayload);
  });
});

describe('createMcpConsentStore — dismiss', () => {
  test('clears snapshot without invoking the bridge', () => {
    const store = createMcpConsentStore();
    const bridge = makeBridge();
    store.install({ bridge });
    bridge.fireShow(sampleShowPayload);
    expect(store.getSnapshot()).not.toBeNull();

    store.dismiss();

    expect(store.getSnapshot()).toBeNull();
    expect(bridge.mcpWiring.confirm.mock.calls.length).toBe(0);
    expect(bridge.mcpWiring.skip.mock.calls.length).toBe(0);
  });

  test('second dismiss on already-null snapshot is a no-op (no listener fire)', () => {
    const store = createMcpConsentStore();
    const bridge = makeBridge();
    store.install({ bridge });
    const listener = mock(() => {});
    store.subscribe(listener);

    store.dismiss();
    store.dismiss();

    // First dismiss fires 0 notifications (snapshot was already null).
    expect(listener.mock.calls.length).toBe(0);
  });
});
