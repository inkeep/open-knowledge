/**
 * Per-project consent-store — install, subscribe, confirm, cancel, dismiss
 * flows. Mirrors `mcp-consent-store.test.ts` shape — no @testing-library/react,
 * exercises the store via the module API directly.
 */
import { describe, expect, mock, test } from 'bun:test';
import { createConsentStore } from './consent-store';
import type {
  OkDesktopBridge,
  OkOnboardingConfirmRequest,
  OkOnboardingShowPayload,
} from './desktop-bridge-types';

interface MockBridgeShape {
  onboarding: {
    onShow: ReturnType<typeof mock>;
    signalReady: ReturnType<typeof mock>;
    confirm: ReturnType<typeof mock>;
    cancel: ReturnType<typeof mock>;
    probeContent: ReturnType<typeof mock>;
  };
  fireShow: (payload: OkOnboardingShowPayload) => void;
  unsubscribeCalls: number;
}

function makeBridge(
  opts: {
    confirmResult?: unknown;
    cancelResult?: unknown;
    confirmThrows?: boolean;
    cancelThrows?: boolean;
  } = {},
): OkDesktopBridge & MockBridgeShape {
  const state = {
    handler: null as ((payload: OkOnboardingShowPayload) => void) | null,
    unsubscribeCalls: 0,
  };
  const onShow = mock((cb: (payload: OkOnboardingShowPayload) => void) => {
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
  const cancel = mock(() => {
    if (opts.cancelThrows) return Promise.reject(new Error('cancel-boom'));
    return Promise.resolve(opts.cancelResult ?? { ok: true });
  });
  const probeContent = mock(() =>
    Promise.resolve({ ok: true, count: 0, sample: [], truncated: false }),
  );

  const bridge = {
    onboarding: { onShow, signalReady, confirm, cancel, probeContent },
  } as unknown as OkDesktopBridge & MockBridgeShape;

  Object.defineProperty(bridge, 'fireShow', {
    value: (payload: OkOnboardingShowPayload) => state.handler?.(payload),
  });
  Object.defineProperty(bridge, 'unsubscribeCalls', {
    get: () => state.unsubscribeCalls,
  });
  return bridge;
}

const samplePayload: OkOnboardingShowPayload = {
  pickedPath: '/Users/me/proj',
  projectDir: '/Users/me/proj',
  defaultContentDir: '.',
  gitState: 'absent',
  gitRootPromoted: false,
  warnings: [],
  editorOptions: [
    { id: 'claude', label: 'Claude', hasProjectConfig: true },
    { id: 'cursor', label: 'Cursor', hasProjectConfig: true },
  ],
};

const sampleConfirm: OkOnboardingConfirmRequest = {
  initGit: true,
  contentDir: '.',
  additionalIgnores: '',
  editorIds: ['claude'],
};

describe('createConsentStore — install', () => {
  test('returns undefined when bridge is missing (web/CLI distribution)', () => {
    const store = createConsentStore();
    const result = store.install({ bridge: undefined });
    expect(result).toBeUndefined();
  });

  test('attaches once and signalReady fires', () => {
    const bridge = makeBridge();
    const store = createConsentStore();
    const teardown = store.install({ bridge });
    expect(typeof teardown).toBe('function');
    expect(bridge.onboarding.signalReady).toHaveBeenCalledTimes(1);
    expect(bridge.onboarding.onShow).toHaveBeenCalledTimes(1);
  });

  test('install is idempotent on re-call', () => {
    const bridge = makeBridge();
    const store = createConsentStore();
    store.install({ bridge });
    store.install({ bridge });
    expect(bridge.onboarding.signalReady).toHaveBeenCalledTimes(1);
  });

  test('show payload populates the snapshot and notifies listeners', () => {
    const bridge = makeBridge();
    const store = createConsentStore();
    store.install({ bridge });
    expect(store.getSnapshot()).toBeNull();
    let notifyCount = 0;
    const unsubscribe = store.subscribe(() => {
      notifyCount += 1;
    });
    bridge.fireShow(samplePayload);
    expect(store.getSnapshot()).toEqual(samplePayload);
    expect(notifyCount).toBe(1);
    unsubscribe();
  });
});

describe('createConsentStore — confirm', () => {
  test('ok:true clears snapshot and resolves', async () => {
    const bridge = makeBridge();
    const store = createConsentStore();
    store.install({ bridge });
    bridge.fireShow(samplePayload);
    const result = await store.confirm(sampleConfirm);
    expect(result.ok).toBe(true);
    expect(store.getSnapshot()).toBeNull();
  });

  test('ok:false keeps snapshot for retry', async () => {
    const bridge = makeBridge({ confirmResult: { ok: false, error: 'fail' } });
    const store = createConsentStore();
    store.install({ bridge });
    bridge.fireShow(samplePayload);
    const result = await store.confirm(sampleConfirm);
    expect(result).toEqual({ ok: false, error: 'fail' });
    expect(store.getSnapshot()).toEqual(samplePayload);
  });

  test('thrown error surfaces as ok:false and snapshot stays', async () => {
    const bridge = makeBridge({ confirmThrows: true });
    const store = createConsentStore();
    store.install({ bridge });
    bridge.fireShow(samplePayload);
    const result = await store.confirm(sampleConfirm);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('confirm-boom');
    expect(store.getSnapshot()).toEqual(samplePayload);
  });

  test('confirm without bridge attached fails gracefully', async () => {
    const store = createConsentStore();
    const result = await store.confirm(sampleConfirm);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Not attached to desktop bridge');
  });
});

describe('createConsentStore — cancel', () => {
  test('ok:true clears snapshot', async () => {
    const bridge = makeBridge();
    const store = createConsentStore();
    store.install({ bridge });
    bridge.fireShow(samplePayload);
    const result = await store.cancel();
    expect(result.ok).toBe(true);
    expect(store.getSnapshot()).toBeNull();
  });

  test('ok:false keeps snapshot', async () => {
    const bridge = makeBridge({ cancelResult: { ok: false, error: 'fs-readonly' } });
    const store = createConsentStore();
    store.install({ bridge });
    bridge.fireShow(samplePayload);
    const result = await store.cancel();
    expect(result).toEqual({ ok: false, error: 'fs-readonly' });
    expect(store.getSnapshot()).toEqual(samplePayload);
  });
});

describe('createConsentStore — dismiss + teardown', () => {
  test('dismiss clears the snapshot without bridge call', () => {
    const bridge = makeBridge();
    const store = createConsentStore();
    store.install({ bridge });
    bridge.fireShow(samplePayload);
    store.dismiss();
    expect(store.getSnapshot()).toBeNull();
    expect(bridge.onboarding.confirm).not.toHaveBeenCalled();
    expect(bridge.onboarding.cancel).not.toHaveBeenCalled();
  });

  test('teardown unsubscribes and clears state', () => {
    const bridge = makeBridge();
    const store = createConsentStore();
    const teardown = store.install({ bridge });
    bridge.fireShow(samplePayload);
    teardown?.();
    expect(bridge.unsubscribeCalls).toBe(1);
    expect(store.getSnapshot()).toBeNull();
  });
});
