import { describe, expect, mock, test } from 'bun:test';
import * as actualSonner from 'sonner';
import type {
  OkDesktopBridge,
  OkServerRestartOutcome,
  OkServerVersionDriftInfo,
} from '@/lib/desktop-bridge-types';

// Capture sonner calls so we can assert the toast wiring without a DOM.
const toastWarning = mock((_msg: string, _opts?: unknown) => 'warn-id');
const toastSuccess = mock((_msg: string) => 'success-id');
const toastLoading = mock((_msg: string, _opts?: unknown) => 'loading-id');
const toastError = mock((_msg: string, _opts?: unknown) => 'error-id');
const toastDismiss = mock((_id?: unknown) => {});
const toastCustom = mock((_render: (id: unknown) => unknown, _opts?: unknown) => 'custom-id');
mock.module('sonner', () => ({
  ...actualSonner,
  toast: Object.assign(
    mock(() => {}),
    {
      warning: toastWarning,
      success: toastSuccess,
      loading: toastLoading,
      error: toastError,
      dismiss: toastDismiss,
      custom: toastCustom,
    },
  ),
}));

import {
  driftToastBody,
  installServerDriftListener,
  reclaimNoticeMessage,
  restartDisruptionWarning,
  restartFailureMessage,
  restartSuccessMessage,
} from '@/lib/install-server-drift-listener';

const olderInfo: OkServerVersionDriftInfo = {
  relation: 'older',
  dimension: 'runtime',
  serverRuntime: '0.8.0',
  appRuntime: '0.8.2',
};

/** Minimal bridge fake — only the surfaces the listener touches. */
function makeBridge(opts?: { restartOutcome?: OkServerRestartOutcome; restartReject?: boolean }): {
  bridge: OkDesktopBridge;
  fireDrift: (info: OkServerVersionDriftInfo) => void;
  fireRestarted: (appRuntime: string) => void;
  fireReclaimed: (appRuntime: string) => void;
  restartServer: ReturnType<typeof mock>;
  unsubDrift: ReturnType<typeof mock>;
  unsubRestarted: ReturnType<typeof mock>;
  unsubReclaimed: ReturnType<typeof mock>;
} {
  let driftCb: ((info: OkServerVersionDriftInfo) => void) | null = null;
  let restartedCb: ((info: { appRuntime: string }) => void) | null = null;
  let reclaimedCb: ((info: { appRuntime: string }) => void) | null = null;
  const unsubDrift = mock(() => {});
  const unsubRestarted = mock(() => {});
  const unsubReclaimed = mock(() => {});
  const restartServer = mock(async () => {
    if (opts?.restartReject) throw new Error('channel closed');
    return opts?.restartOutcome ?? { ok: true };
  });
  const bridge = {
    config: { projectPath: '/tmp/proj' },
    onServerVersionDrift: (cb: (info: OkServerVersionDriftInfo) => void) => {
      driftCb = cb;
      return unsubDrift;
    },
    onServerRestarted: (cb: (info: { appRuntime: string }) => void) => {
      restartedCb = cb;
      return unsubRestarted;
    },
    onServerReclaimed: (cb: (info: { appRuntime: string }) => void) => {
      reclaimedCb = cb;
      return unsubReclaimed;
    },
    restartServer,
  } as unknown as OkDesktopBridge;
  return {
    bridge,
    fireDrift: (info) => driftCb?.(info),
    fireRestarted: (appRuntime) => restartedCb?.({ appRuntime }),
    fireReclaimed: (appRuntime) => reclaimedCb?.({ appRuntime }),
    restartServer,
    unsubDrift,
    unsubRestarted,
    unsubReclaimed,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('drift copy', () => {
  test('older body names both versions and "older"', () => {
    const body = driftToastBody(olderInfo);
    expect(body).toContain('older');
    expect(body).toContain('0.8.0');
    expect(body).toContain('0.8.2');
  });

  test('newer body says the server is newer', () => {
    const body = driftToastBody({ ...olderInfo, relation: 'newer', serverRuntime: '0.9.0' });
    expect(body).toContain('newer');
    expect(body).toContain('0.9.0');
  });

  test('protocol drift with equal semver avoids "older v0.8.2 than v0.8.2"', () => {
    const body = driftToastBody({
      relation: 'older',
      dimension: 'protocol',
      serverRuntime: '0.8.2',
      appRuntime: '0.8.2',
    });
    expect(body).toContain('incompatible build');
    expect(body).not.toContain('older version');
  });

  test('disruption warning names MCP and the agent remedy', () => {
    expect(restartDisruptionWarning()).toContain('MCP');
    expect(restartDisruptionWarning().toLowerCase()).toContain('restart the agent');
    expect(restartDisruptionWarning()).toContain('Claude Code');
  });

  test('success message names the running version', () => {
    expect(restartSuccessMessage('0.8.2')).toContain('0.8.2');
  });

  test('reclaim notice names the dev session, the version, MCP, and the agent remedy', () => {
    const msg = reclaimNoticeMessage('0.8.2');
    expect(msg.toLowerCase()).toContain('dev session');
    expect(msg).toContain('0.8.2');
    expect(msg).toContain('terminated');
    expect(msg).toContain('MCP');
    expect(msg.toLowerCase()).toContain('restart the agent');
    expect(msg).toContain('Claude Code');
  });

  test('eperm failure points at a different account + reboot, never `ok stop all`', () => {
    const msg = restartFailureMessage('eperm');
    expect(msg.toLowerCase()).toContain('different account');
    expect(msg.toLowerCase()).toContain('restart your computer');
    expect(msg).not.toContain('ok stop all');
  });

  test('other failure suggests `ok stop all`', () => {
    expect(restartFailureMessage('other')).toContain('ok stop all');
  });
});

describe('installServerDriftListener', () => {
  test('no-op without a bridge (web / CLI)', () => {
    expect(installServerDriftListener({ bridge: undefined })).toBeUndefined();
  });

  test('subscribes to all three events and unsubscribes on teardown', () => {
    const h = makeBridge();
    const cleanup = installServerDriftListener({ bridge: h.bridge });
    expect(cleanup).toBeDefined();
    cleanup?.();
    expect(h.unsubDrift).toHaveBeenCalledTimes(1);
    expect(h.unsubRestarted).toHaveBeenCalledTimes(1);
    expect(h.unsubReclaimed).toHaveBeenCalledTimes(1);
  });

  // The drift toast renders a custom component via `toast.custom`; inspect the
  // element the render fn returns rather than rendering it (no DOM needed).
  type DriftNode = {
    props: { body: string; warning: string; onRestart: () => void; onDismiss: () => void };
  };
  function fireDriftAndRender(h: ReturnType<typeof makeBridge>, id = 'toast-1'): DriftNode {
    h.fireDrift(olderInfo);
    const render = toastCustom.mock.calls.at(-1)?.[0] as (id: unknown) => DriftNode;
    return render(id);
  }

  test('drift event renders the custom restart toast with wired actions', () => {
    toastCustom.mockClear();
    const h = makeBridge();
    installServerDriftListener({ bridge: h.bridge });
    const node = fireDriftAndRender(h);
    expect(toastCustom).toHaveBeenCalledTimes(1);
    expect(toastCustom.mock.calls[0]?.[1]).toMatchObject({ duration: Number.POSITIVE_INFINITY });
    expect(node.props.body).toBe(driftToastBody(olderInfo));
    expect(node.props.warning).toBe(restartDisruptionWarning());
    expect(typeof node.props.onRestart).toBe('function');
    expect(typeof node.props.onDismiss).toBe('function');
  });

  test('the restart action invokes the bridge; an eperm failure shows the failure toast', async () => {
    toastCustom.mockClear();
    toastError.mockClear();
    toastDismiss.mockClear();
    const h = makeBridge({ restartOutcome: { ok: false, reason: 'eperm' } });
    installServerDriftListener({ bridge: h.bridge });
    fireDriftAndRender(h).props.onRestart();
    await flush();
    expect(toastDismiss).toHaveBeenCalledWith('toast-1');
    expect(h.restartServer).toHaveBeenCalledWith('/tmp/proj');
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]?.[0]).toBe(restartFailureMessage('eperm'));
  });

  test('a restart that recreates the window (invoke rejects) shows no failure toast', async () => {
    toastCustom.mockClear();
    toastError.mockClear();
    const h = makeBridge({ restartReject: true });
    installServerDriftListener({ bridge: h.bridge });
    fireDriftAndRender(h).props.onRestart();
    await flush();
    expect(toastError).not.toHaveBeenCalled();
  });

  test('a restart that resolves ok:true still dismisses the loading toast', async () => {
    toastCustom.mockClear();
    toastDismiss.mockClear();
    toastError.mockClear();
    const h = makeBridge({ restartOutcome: { ok: true } });
    installServerDriftListener({ bridge: h.bridge });
    fireDriftAndRender(h).props.onRestart();
    await flush();
    // The loading toast clears on any resolved outcome, not just failure, so a
    // success reaching a still-live renderer can't strand it.
    expect(toastDismiss).toHaveBeenCalledWith('loading-id');
    expect(toastError).not.toHaveBeenCalled();
  });

  test('the cancel action dismisses the toast', () => {
    toastCustom.mockClear();
    toastDismiss.mockClear();
    const h = makeBridge();
    installServerDriftListener({ bridge: h.bridge });
    fireDriftAndRender(h, 'toast-9').props.onDismiss();
    expect(toastDismiss).toHaveBeenCalledWith('toast-9');
  });

  test('restarted event shows a success toast', () => {
    toastSuccess.mockClear();
    const h = makeBridge();
    installServerDriftListener({ bridge: h.bridge });
    h.fireRestarted('0.8.2');
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess.mock.calls[0]?.[0]).toBe(restartSuccessMessage('0.8.2'));
  });

  test('reclaimed event shows a transient warning (not a success) naming the side effect', () => {
    toastWarning.mockClear();
    toastSuccess.mockClear();
    const h = makeBridge();
    installServerDriftListener({ bridge: h.bridge });
    h.fireReclaimed('0.8.2');
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(toastWarning.mock.calls[0]?.[0]).toBe(reclaimNoticeMessage('0.8.2'));
    // Finite duration so it doesn't pile up on repeat dev launches, but long
    // enough to read the multi-sentence side-effect copy.
    expect(toastWarning.mock.calls[0]?.[1]).toMatchObject({ duration: 15_000 });
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
