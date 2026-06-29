
import { describe, expect, mock, test } from 'bun:test';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import {
  addSchemaIncompatibilityNotice,
  appendErrorDetail,
  attachUpdateSubscribers,
  INSTALL_FAILED_DOWNLOAD_ACTION,
  INSTALL_FAILED_RETRY_ACTION,
  installFailedBody,
  pickActiveNotice,
  TOAST_A_ACTION,
  TOAST_A_ERROR_BODY,
  TOAST_A_PROGRESS_BODY,
  TOAST_B_ACTION,
  TOAST_C_ACTION,
  TOAST_C_BODY,
  TOAST_E_ACTION_RESET,
  TOAST_E_ERROR_BODY,
  toastABody,
  toastBBody,
  toastEBody,
  type UpdateNotice,
  WHATS_NEW_AUTO_DISMISS_MS,
} from './UpdateNotices';

type UpdateDownloadedCb = (info: { version: string }) => void;
type RelaunchingCb = (info: { version: string }) => void;
type RelaunchFailedCb = (info: { version: string; message?: string; downloadUrl?: string }) => void;
type WhatsNewCb = (info: { version: string; releaseUrl: string }) => void;
type WhatsNewDismissedCb = (info: { version: string }) => void;
type StuckHintCb = (info: { downloadUrl: string }) => void;

interface FakeBridge {
  onUpdateDownloaded: ReturnType<typeof mock>;
  onUpdateRelaunching: ReturnType<typeof mock>;
  onUpdateRelaunchFailed: ReturnType<typeof mock>;
  onWhatsNew: ReturnType<typeof mock>;
  onWhatsNewDismissed: ReturnType<typeof mock>;
  onUpdateStuckHint: ReturnType<typeof mock>;
  update: {
    relaunchNow: ReturnType<typeof mock>;
    dismissWhatsNew: ReturnType<typeof mock>;
  };
  state: {
    query: ReturnType<typeof mock>;
    resetIncompatible: ReturnType<typeof mock>;
  };
  shell: { openExternal: ReturnType<typeof mock> };
  _downloaded?: UpdateDownloadedCb;
  _relaunching?: RelaunchingCb;
  _relaunchFailed?: RelaunchFailedCb;
  _whatsNew?: WhatsNewCb;
  _whatsNewDismissed?: WhatsNewDismissedCb;
  _stuckHint?: StuckHintCb;
  _downloadedUnsub: ReturnType<typeof mock>;
  _relaunchingUnsub: ReturnType<typeof mock>;
  _relaunchFailedUnsub: ReturnType<typeof mock>;
  _whatsNewUnsub: ReturnType<typeof mock>;
  _whatsNewDismissedUnsub: ReturnType<typeof mock>;
  _stuckHintUnsub: ReturnType<typeof mock>;
}

function makeFakeBridge(): FakeBridge {
  const b: FakeBridge = {
    _downloadedUnsub: mock(() => {}),
    _relaunchingUnsub: mock(() => {}),
    _relaunchFailedUnsub: mock(() => {}),
    _whatsNewUnsub: mock(() => {}),
    _whatsNewDismissedUnsub: mock(() => {}),
    _stuckHintUnsub: mock(() => {}),
    onUpdateDownloaded: mock(() => {}),
    onUpdateRelaunching: mock(() => {}),
    onUpdateRelaunchFailed: mock(() => {}),
    onWhatsNew: mock(() => {}),
    onWhatsNewDismissed: mock(() => {}),
    onUpdateStuckHint: mock(() => {}),
    update: {
      relaunchNow: mock(() => Promise.resolve(undefined)),
      dismissWhatsNew: mock(() => Promise.resolve(undefined)),
    },
    state: {
      query: mock(() => Promise.resolve({ channel: 'latest', schemaIncompatibility: null })),
      resetIncompatible: mock(() => Promise.resolve(undefined)),
    },
    shell: { openExternal: mock(() => Promise.resolve(undefined)) },
  };
  b.onUpdateDownloaded = mock((cb: UpdateDownloadedCb) => {
    b._downloaded = cb;
    return b._downloadedUnsub;
  });
  b.onUpdateRelaunching = mock((cb: RelaunchingCb) => {
    b._relaunching = cb;
    return b._relaunchingUnsub;
  });
  b.onUpdateRelaunchFailed = mock((cb: RelaunchFailedCb) => {
    b._relaunchFailed = cb;
    return b._relaunchFailedUnsub;
  });
  b.onWhatsNew = mock((cb: WhatsNewCb) => {
    b._whatsNew = cb;
    return b._whatsNewUnsub;
  });
  b.onWhatsNewDismissed = mock((cb: WhatsNewDismissedCb) => {
    b._whatsNewDismissed = cb;
    return b._whatsNewDismissedUnsub;
  });
  b.onUpdateStuckHint = mock((cb: StuckHintCb) => {
    b._stuckHint = cb;
    return b._stuckHintUnsub;
  });
  return b;
}

function castBridge(fake: FakeBridge): OkDesktopBridge {
  return fake as unknown as OkDesktopBridge;
}


describe('copy helpers (minimal-wording revision)', () => {
  test('toastABody formats the version-specific pending-install string', () => {
    expect(toastABody('0.1.1')).toBe('Version 0.1.1 ready to install');
    expect(toastABody('2.0.0-beta.1')).toBe('Version 2.0.0-beta.1 ready to install');
  });

  test('toastBBody formats the "Updated to Version <X>" string', () => {
    expect(toastBBody('0.1.1')).toBe('Updated to Version 0.1.1');
    expect(toastBBody('2.0.0-beta.1')).toBe('Updated to Version 2.0.0-beta.1');
  });

  test('canonical copy strings match the single-card minimal revision', () => {
    expect(TOAST_A_ACTION).toBe('Relaunch');
    expect(TOAST_B_ACTION).toBe('Release notes');
    expect(TOAST_C_BODY).toBe('Updates paused');
    expect(TOAST_C_ACTION).toBe('Download');
  });

  test('TOAST_A_PROGRESS_BODY is the immediate in-progress feedback for a Relaunch click', () => {
    expect(TOAST_A_PROGRESS_BODY).toBe('Relaunching to install the update…');
  });

  test('toastEBody interpolates the running build version into the refuse-downgrade body', () => {
    expect(toastEBody('0.3.0')).toBe(
      'Your settings and recent projects were saved by a newer build than this one (v0.3.0). Reset to defaults to continue.',
    );
    expect(toastEBody('0.4.0-beta.3')).toBe(
      'Your settings and recent projects were saved by a newer build than this one (v0.4.0-beta.3). Reset to defaults to continue.',
    );
  });

  test('Notice E action copy names the consequence honestly', () => {
    expect(TOAST_E_ACTION_RESET).toBe('Reset to defaults');
  });

  test('TOAST_E_ERROR_BODY is the retry message for a Reset failure', () => {
    expect(TOAST_E_ERROR_BODY).toBe('Recovery action failed — please try again');
  });
});

describe('appendErrorDetail', () => {
  test('Error with non-empty message → "{base}: {message}"', () => {
    const result = appendErrorDetail('Reset failed', new Error('disk full'));
    expect(result).toBe('Reset failed: disk full');
  });

  test('Error with empty message → base only (no trailing colon)', () => {
    const result = appendErrorDetail('Reset failed', new Error(''));
    expect(result).toBe('Reset failed');
  });

  test('non-Error rejection (string) → base only', () => {
    const result = appendErrorDetail('Reset failed', 'string-throw');
    expect(result).toBe('Reset failed');
  });

  test('undefined rejection → base only', () => {
    const result = appendErrorDetail('Reset failed', undefined);
    expect(result).toBe('Reset failed');
  });
});


describe('attachUpdateSubscribers — registration', () => {
  test('subscribes to all six update channels on the bridge', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    expect(bridge.onUpdateDownloaded).toHaveBeenCalledTimes(1);
    expect(bridge.onUpdateRelaunching).toHaveBeenCalledTimes(1);
    expect(bridge.onUpdateRelaunchFailed).toHaveBeenCalledTimes(1);
    expect(bridge.onWhatsNew).toHaveBeenCalledTimes(1);
    expect(bridge.onWhatsNewDismissed).toHaveBeenCalledTimes(1);
    expect(bridge.onUpdateStuckHint).toHaveBeenCalledTimes(1);
  });

  test('returns a single unsubscribe closure that detaches ALL six listeners', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    const unsubscribe = attachUpdateSubscribers(castBridge(bridge), addNotice);
    unsubscribe();
    expect(bridge._downloadedUnsub).toHaveBeenCalledTimes(1);
    expect(bridge._relaunchingUnsub).toHaveBeenCalledTimes(1);
    expect(bridge._relaunchFailedUnsub).toHaveBeenCalledTimes(1);
    expect(bridge._whatsNewUnsub).toHaveBeenCalledTimes(1);
    expect(bridge._whatsNewDismissedUnsub).toHaveBeenCalledTimes(1);
    expect(bridge._stuckHintUnsub).toHaveBeenCalledTimes(1);
  });
});


describe('Notice A cross-window relaunch — ok:update:relaunching', () => {
  test('swaps the update-downloaded card to the button-less in-progress card', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);

    bridge._relaunching?.({ version: '0.1.1' });
    expect(addNotice).toHaveBeenCalledTimes(1);
    const inProgress = addNotice.mock.calls[0]?.[0] as UpdateNotice;
    expect(inProgress.id).toBe('update-downloaded');
    expect(inProgress.body).toBe(TOAST_A_PROGRESS_BODY);
    expect(inProgress.action).toBeUndefined();
    expect(inProgress.priority).toBe(2);
    expect(inProgress.dismissible).toBe(false);
  });

  test('does NOT invoke relaunchNow — it is the echo, not the trigger (no loop)', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    bridge._relaunching?.({ version: '0.1.1' });
    expect(bridge.update.relaunchNow).not.toHaveBeenCalled();
  });

  test('onUpdateRelaunchFailed → error notice with detail, same id as the rejection path', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    bridge._relaunchFailed?.({ version: '0.1.1', message: 'App Still Running Error' });
    const errorNotice = addNotice.mock.calls.at(-1)?.[0] as UpdateNotice;
    expect(errorNotice.id).toBe('relaunch-error-0.1.1');
    expect(errorNotice.body).toBe(`${TOAST_A_ERROR_BODY}: App Still Running Error`);
    expect(errorNotice.variant).toBe('error');
    expect(errorNotice.priority).toBe(1);
    expect(errorNotice.action).toBeUndefined();
  });

  test('onUpdateRelaunchFailed without message → canonical body, no trailing colon', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    bridge._relaunchFailed?.({ version: '0.1.1' });
    const errorNotice = addNotice.mock.calls.at(-1)?.[0] as UpdateNotice;
    expect(errorNotice.body).toBe(TOAST_A_ERROR_BODY);
  });

  test('boot-detected failed install (downloadUrl present) → richer two-action card', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    bridge._relaunchFailed?.({
      version: '0.16.0-beta.3',
      downloadUrl: 'https://inkeep.com/open-knowledge/download',
    });
    const notice = addNotice.mock.calls.at(-1)?.[0] as UpdateNotice;
    expect(notice.id).toBe('install-failed-0.16.0-beta.3');
    expect(notice.body).toBe(installFailedBody('0.16.0-beta.3'));
    expect(notice.variant).toBe('error');
    expect(notice.action?.label).toBe(INSTALL_FAILED_RETRY_ACTION);
    expect(notice.secondaryAction?.label).toBe(INSTALL_FAILED_DOWNLOAD_ACTION);
  });

  test('failed-install Retry invokes relaunchNow; Download manually opens the URL', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    const url = 'https://inkeep.com/open-knowledge/download';
    bridge._relaunchFailed?.({ version: '0.16.0-beta.3', downloadUrl: url });
    const notice = addNotice.mock.calls.at(-1)?.[0] as UpdateNotice;
    notice.action?.onClick();
    expect(bridge.update.relaunchNow).toHaveBeenCalledTimes(1);
    notice.secondaryAction?.onClick();
    expect(bridge.shell.openExternal).toHaveBeenCalledWith(url);
  });

  test('relaunch-failed WITHOUT downloadUrl keeps the plain error notice (no actions)', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    bridge._relaunchFailed?.({ version: '0.16.0-beta.3' });
    const notice = addNotice.mock.calls.at(-1)?.[0] as UpdateNotice;
    expect(notice.id).toBe('relaunch-error-0.16.0-beta.3');
    expect(notice.action).toBeUndefined();
    expect(notice.secondaryAction).toBeUndefined();
  });

  test('a downloaded re-broadcast after a failed relaunch replaces the stuck in-progress card in place', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    bridge._relaunching?.({ version: '0.1.1' });
    bridge._downloaded?.({ version: '0.1.1' });
    const reArmed = addNotice.mock.calls.at(-1)?.[0] as UpdateNotice;
    expect(reArmed.id).toBe('update-downloaded');
    expect(reArmed.body).toBe(toastABody('0.1.1'));
    expect(reArmed.action?.label).toBe(TOAST_A_ACTION);
    expect(reArmed.dismissible).toBeUndefined();
  });
});


describe('Notice A — ok:update:downloaded', () => {
  test('emits notice with canonical copy + relaunch action on dispatch', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);

    bridge._downloaded?.({ version: '0.1.1' });
    expect(addNotice).toHaveBeenCalledTimes(1);
    const [notice] = addNotice.mock.calls[0] as [UpdateNotice];
    expect(notice.body).toBe(toastABody('0.1.1'));
    expect(notice.id).toBe('update-downloaded');
    expect(notice.action?.label).toBe(TOAST_A_ACTION);
    expect(notice.variant).toBeUndefined();
    expect(notice.priority).toBe(2); // update-downloaded = A
    expect(notice.dismissible).toBeUndefined();
  });

  test('action onClick invokes bridge.update.relaunchNow', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    bridge._downloaded?.({ version: '0.1.1' });
    const notice = addNotice.mock.calls[0]?.[0] as UpdateNotice;
    notice.action?.onClick();
    expect(bridge.update.relaunchNow).toHaveBeenCalledTimes(1);
  });

  test('action onClick synchronously swaps Toast A in-place to a button-less, non-dismissible in-progress card', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    bridge._downloaded?.({ version: '0.1.1' });
    const armed = addNotice.mock.calls[0]?.[0] as UpdateNotice;
    armed.action?.onClick();
    const inProgress = addNotice.mock.calls[1]?.[0] as UpdateNotice;
    expect(inProgress.id).toBe('update-downloaded');
    expect(inProgress.body).toBe(TOAST_A_PROGRESS_BODY);
    expect(inProgress.action).toBeUndefined();
    expect(inProgress.priority).toBe(2);
    expect(inProgress.dismissible).toBe(false);
  });

  test('relaunchNow rejection → error notice with appended detail + armed card restored for retry', async () => {
    const bridge = makeFakeBridge();
    bridge.update.relaunchNow = mock(() => Promise.reject(new Error('quitAndInstall failed')));
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    bridge._downloaded?.({ version: '0.1.1' });
    const noticeA = addNotice.mock.calls[0]?.[0] as UpdateNotice;
    noticeA.action?.onClick();
    await Promise.resolve();
    await Promise.resolve();
    expect(addNotice).toHaveBeenCalledTimes(4);
    const reArmed = addNotice.mock.calls[2]?.[0] as UpdateNotice;
    expect(reArmed.id).toBe('update-downloaded');
    expect(reArmed.body).toBe(toastABody('0.1.1'));
    expect(reArmed.action?.label).toBe(TOAST_A_ACTION); // Relaunch retry restored
    const errorNotice = addNotice.mock.calls.at(-1)?.[0] as UpdateNotice;
    expect(errorNotice.body).toBe(`${TOAST_A_ERROR_BODY}: quitAndInstall failed`);
    expect(errorNotice.id).toBe('relaunch-error-0.1.1');
    expect(errorNotice.variant).toBe('error');
    expect(errorNotice.action).toBeUndefined();
    expect(errorNotice.priority).toBe(1); // relaunch-error = higher than A
  });

  test('relaunchNow non-Error rejection (string throw) → error notice without trailing colon', async () => {
    const bridge = makeFakeBridge();
    bridge.update.relaunchNow = mock(() => Promise.reject('not-an-error'));
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    bridge._downloaded?.({ version: '0.1.1' });
    const noticeA = addNotice.mock.calls[0]?.[0] as UpdateNotice;
    noticeA.action?.onClick();
    await Promise.resolve();
    await Promise.resolve();
    const errorNotice = addNotice.mock.calls.at(-1)?.[0] as UpdateNotice;
    expect(errorNotice.body).toBe(TOAST_A_ERROR_BODY);
  });

  test('relaunchNow success → no error notice (armed card + in-progress swap only)', async () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    bridge._downloaded?.({ version: '0.1.1' });
    const notice = addNotice.mock.calls[0]?.[0] as UpdateNotice;
    notice.action?.onClick();
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.update.relaunchNow).toHaveBeenCalledTimes(1);
    expect(addNotice).toHaveBeenCalledTimes(2);
    const variants = addNotice.mock.calls.map((c) => (c[0] as UpdateNotice).variant);
    expect(variants).not.toContain('error');
  });

  test('relaunchNow success → dismissNotice fires with the Toast A id (dev-mode feedback)', async () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    const dismissNotice = mock<(id: string) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice, dismissNotice);
    bridge._downloaded?.({ version: '0.1.1' });
    const notice = addNotice.mock.calls[0]?.[0] as UpdateNotice;
    notice.action?.onClick();
    await Promise.resolve();
    await Promise.resolve();
    expect(dismissNotice).toHaveBeenCalledTimes(1);
    expect(dismissNotice).toHaveBeenCalledWith('update-downloaded');
  });

  test('relaunchNow rejection → dismissNotice does NOT fire (error notice takes over)', async () => {
    const bridge = makeFakeBridge();
    bridge.update.relaunchNow = mock(() => Promise.reject(new Error('quitAndInstall failed')));
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    const dismissNotice = mock<(id: string) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice, dismissNotice);
    bridge._downloaded?.({ version: '0.1.1' });
    const notice = addNotice.mock.calls[0]?.[0] as UpdateNotice;
    notice.action?.onClick();
    await Promise.resolve();
    await Promise.resolve();
    expect(dismissNotice).not.toHaveBeenCalled();
    expect(addNotice).toHaveBeenCalledTimes(4);
  });

  test('a newer download supersedes the prior notice in place — single stable id, body advances to the latest version', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    bridge._downloaded?.({ version: '0.1.1' });
    bridge._downloaded?.({ version: '0.1.2' });
    const calls = addNotice.mock.calls.map((c) => c[0] as UpdateNotice);
    expect(calls.map((n) => n.id)).toEqual(['update-downloaded', 'update-downloaded']);
    expect(calls[1]?.body).toBe(toastABody('0.1.2'));
  });

  test('error notice after supersession carries latest version (closure freshness)', async () => {
    const bridge = makeFakeBridge();
    bridge.update.relaunchNow = mock(() => Promise.reject(new Error('quitAndInstall failed')));
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    bridge._downloaded?.({ version: '0.1.1' });
    bridge._downloaded?.({ version: '0.1.2' });
    const latest = addNotice.mock.calls[1]?.[0] as UpdateNotice;
    latest.action?.onClick();
    await Promise.resolve();
    await Promise.resolve();
    const errorNotice = addNotice.mock.calls.at(-1)?.[0] as UpdateNotice;
    expect(errorNotice.id).toBe('relaunch-error-0.1.2');
  });

  test('same version dispatched twice keeps the same id (in-place dedup at the store)', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    bridge._downloaded?.({ version: '0.1.1' });
    bridge._downloaded?.({ version: '0.1.1' });
    const ids = addNotice.mock.calls.map((c) => (c[0] as UpdateNotice).id);
    expect(ids).toEqual(['update-downloaded', 'update-downloaded']);
  });
});


describe('Notice B — ok:update:whats-new', () => {
  test('emits notice with version-specific copy + release URL action', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    const releaseUrl = 'https://github.com/inkeep/open-knowledge/releases/tag/v0.3.1';
    bridge._whatsNew?.({ version: '0.3.1', releaseUrl });
    expect(addNotice).toHaveBeenCalledTimes(1);
    const notice = addNotice.mock.calls[0]?.[0] as UpdateNotice;
    expect(notice.body).toBe('Updated to Version 0.3.1');
    expect(notice.id).toBe('whats-new-0.3.1');
    expect(notice.action?.label).toBe(TOAST_B_ACTION);
    expect(notice.variant).toBe('success'); // green card — distinct from the gray "ready to install"
    expect(notice.priority).toBe(3); // whats-new = lowest
    notice.action?.onClick();
    expect(bridge.shell.openExternal).toHaveBeenCalledWith(releaseUrl);
  });

  test('canonical auto-dismiss window is one minute', () => {
    expect(WHATS_NEW_AUTO_DISMISS_MS).toBe(60_000);
  });

  test('notice self-dismisses after the auto-dismiss window', async () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    const dismissNotice = mock<(id: string) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice, dismissNotice, 15);
    bridge._whatsNew?.({ version: '0.3.1', releaseUrl: 'https://example.com/r' });
    expect(dismissNotice).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(dismissNotice).toHaveBeenCalledWith('whats-new-0.3.1');
  });

  test('unsubscribe clears the pending auto-dismiss timer', async () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    const dismissNotice = mock<(id: string) => void>(() => {});
    const unsubscribe = attachUpdateSubscribers(castBridge(bridge), addNotice, dismissNotice, 15);
    bridge._whatsNew?.({ version: '0.3.1', releaseUrl: 'https://example.com/r' });
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(dismissNotice).not.toHaveBeenCalled();
  });

  test('two whats-new events each schedule an independent auto-dismiss timer', async () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    const dismissNotice = mock<(id: string) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice, dismissNotice, 15);
    bridge._whatsNew?.({ version: '0.3.0', releaseUrl: 'https://example.com/r0' });
    bridge._whatsNew?.({ version: '0.3.1', releaseUrl: 'https://example.com/r1' });
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(dismissNotice).toHaveBeenCalledWith('whats-new-0.3.0');
    expect(dismissNotice).toHaveBeenCalledWith('whats-new-0.3.1');
    expect(dismissNotice).toHaveBeenCalledTimes(2);
  });

  test('dismissing the notice (X) notifies main so every window can clear', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    bridge._whatsNew?.({ version: '0.3.1', releaseUrl: 'https://example.com/r' });
    const notice = addNotice.mock.calls[0]?.[0] as UpdateNotice;
    notice.onDismiss?.();
    expect(bridge.update.dismissWhatsNew).toHaveBeenCalledWith('0.3.1');
  });

  test('auto-dismiss also notifies main so the other windows clear in lockstep', async () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    const dismissNotice = mock<(id: string) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice, dismissNotice, 15);
    bridge._whatsNew?.({ version: '0.3.1', releaseUrl: 'https://example.com/r' });
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(bridge.update.dismissWhatsNew).toHaveBeenCalledWith('0.3.1');
  });

  test('onWhatsNewDismissed echo clears the card by id without re-notifying main (no loop)', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    const dismissNotice = mock<(id: string) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice, dismissNotice);
    bridge._whatsNewDismissed?.({ version: '0.3.1' });
    expect(dismissNotice).toHaveBeenCalledWith('whats-new-0.3.1');
    expect(bridge.update.dismissWhatsNew).not.toHaveBeenCalled();
  });
});


describe('Notice C — ok:update:stuck-hint', () => {
  test('emits notice with D12 copy + download URL action', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    const downloadUrl = 'https://inkeep.com/open-knowledge/download';
    bridge._stuckHint?.({ downloadUrl });
    expect(addNotice).toHaveBeenCalledTimes(1);
    const notice = addNotice.mock.calls[0]?.[0] as UpdateNotice;
    expect(notice.body).toBe(TOAST_C_BODY);
    expect(notice.id).toBe('update-stuck-hint');
    expect(notice.action?.label).toBe(TOAST_C_ACTION);
    expect(notice.priority).toBe(0); // stuck-hint = highest
    notice.action?.onClick();
    expect(bridge.shell.openExternal).toHaveBeenCalledWith(downloadUrl);
  });

  test('stuck-hint uses a fixed id — second dispatch from main hits the list-level dedup', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    attachUpdateSubscribers(castBridge(bridge), addNotice);
    bridge._stuckHint?.({ downloadUrl: 'https://x/y' });
    bridge._stuckHint?.({ downloadUrl: 'https://x/y' });
    const ids = addNotice.mock.calls.map((c) => (c[0] as UpdateNotice).id);
    expect(ids).toEqual(['update-stuck-hint', 'update-stuck-hint']);
  });
});


describe('Notice E — schema-incompatibility refuse-downgrade', () => {
  const diagnostic = {
    currentBuild: '0.3.0',
    persistedSchemaVersion: 2,
    maxSupported: 1,
  };

  test('emits notice with spec body, a single Reset action, and priority 0', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    addSchemaIncompatibilityNotice(castBridge(bridge), diagnostic, addNotice);
    expect(addNotice).toHaveBeenCalledTimes(1);
    const notice = addNotice.mock.calls[0]?.[0] as UpdateNotice;
    expect(notice.id).toBe('schema-incompatibility-2');
    expect(notice.body).toBe(toastEBody('0.3.0'));
    expect(notice.priority).toBe(0);
    expect(notice.action?.label).toBe(TOAST_E_ACTION_RESET);
    expect(notice.secondaryAction).toBeUndefined();
  });

  test('Reset action invokes bridge.state.resetIncompatible', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    addSchemaIncompatibilityNotice(castBridge(bridge), diagnostic, addNotice);
    const notice = addNotice.mock.calls[0]?.[0] as UpdateNotice;
    notice.action?.onClick();
    expect(bridge.state.resetIncompatible).toHaveBeenCalledTimes(1);
  });

  test('Reset success → dismissNotice fires for the active id', async () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    const dismissNotice = mock<(id: string) => void>(() => {});
    addSchemaIncompatibilityNotice(castBridge(bridge), diagnostic, addNotice, dismissNotice);
    const notice = addNotice.mock.calls[0]?.[0] as UpdateNotice;
    notice.action?.onClick();
    await Promise.resolve();
    expect(dismissNotice).toHaveBeenCalledTimes(1);
    expect(dismissNotice).toHaveBeenCalledWith('schema-incompatibility-2');
  });

  test('Reset rejection → parent dismissed + error notice with spec shape and appended detail', async () => {
    const bridge = makeFakeBridge();
    bridge.state.resetIncompatible = mock(() => Promise.reject(new Error('disk fail')));
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    const dismissNotice = mock<(id: string) => void>(() => {});
    addSchemaIncompatibilityNotice(castBridge(bridge), diagnostic, addNotice, dismissNotice);
    const initial = addNotice.mock.calls[0]?.[0] as UpdateNotice;
    initial.action?.onClick();
    await Promise.resolve();
    await Promise.resolve();
    expect(dismissNotice).toHaveBeenCalledTimes(1);
    expect(dismissNotice).toHaveBeenCalledWith(initial.id);
    const errorNotice = addNotice.mock.calls.at(-1)?.[0] as UpdateNotice;
    expect(errorNotice.id).toBe('schema-incompatibility-error-2');
    expect(errorNotice.body).toBe(`${TOAST_E_ERROR_BODY}: disk fail`);
    expect(errorNotice.variant).toBe('error');
    expect(errorNotice.priority).toBe(0);
    expect(errorNotice.action).toBeUndefined();
  });

  test('different persistedSchemaVersion produces distinct notice ids', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    addSchemaIncompatibilityNotice(castBridge(bridge), diagnostic, addNotice);
    addSchemaIncompatibilityNotice(
      castBridge(bridge),
      { ...diagnostic, persistedSchemaVersion: 7 },
      addNotice,
    );
    const ids = addNotice.mock.calls.map((c) => (c[0] as UpdateNotice).id);
    expect(ids).toEqual(['schema-incompatibility-2', 'schema-incompatibility-7']);
  });

  test('repeat call with same diagnostic reuses the same id (list-level dedup)', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    addSchemaIncompatibilityNotice(castBridge(bridge), diagnostic, addNotice);
    addSchemaIncompatibilityNotice(castBridge(bridge), diagnostic, addNotice);
    const ids = addNotice.mock.calls.map((c) => (c[0] as UpdateNotice).id);
    expect(ids).toEqual(['schema-incompatibility-2', 'schema-incompatibility-2']);
  });
});


describe('pickActiveNotice', () => {
  const a: UpdateNotice = { id: 'a', body: 'A', priority: 2 };
  const b: UpdateNotice = { id: 'b', body: 'B', priority: 3 };
  const c: UpdateNotice = { id: 'c', body: 'C', priority: 0 };
  const err: UpdateNotice = { id: 'err', body: 'Err', priority: 1, variant: 'error' };

  test('empty list → null', () => {
    expect(pickActiveNotice([])).toBeNull();
  });

  test('single notice → returns it', () => {
    expect(pickActiveNotice([a])).toBe(a);
  });

  test('C > A > B — stuck-hint wins over everything', () => {
    expect(pickActiveNotice([b, a, c])).toBe(c);
  });

  test('A + B coexist → A wins', () => {
    expect(pickActiveNotice([b, a])).toBe(a);
  });

  test('relaunch-error (1) wins over A (2) and B (3) but not C (0)', () => {
    expect(pickActiveNotice([a, b, err])).toBe(err);
    expect(pickActiveNotice([a, b, err, c])).toBe(c);
  });
});

describe('unsubscribe semantics', () => {
  test('after unsubscribe, all six per-channel unsub closures fire', () => {
    const bridge = makeFakeBridge();
    const addNotice = mock<(notice: UpdateNotice) => void>(() => {});
    const unsubscribe = attachUpdateSubscribers(castBridge(bridge), addNotice);
    unsubscribe();
    expect(bridge._downloadedUnsub).toHaveBeenCalledTimes(1);
    expect(bridge._relaunchingUnsub).toHaveBeenCalledTimes(1);
    expect(bridge._relaunchFailedUnsub).toHaveBeenCalledTimes(1);
    expect(bridge._whatsNewUnsub).toHaveBeenCalledTimes(1);
    expect(bridge._whatsNewDismissedUnsub).toHaveBeenCalledTimes(1);
    expect(bridge._stuckHintUnsub).toHaveBeenCalledTimes(1);
  });
});
