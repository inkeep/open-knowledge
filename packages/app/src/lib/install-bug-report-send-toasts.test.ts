import type { OkBugReportSendResult } from '@inkeep/open-knowledge-core';
import * as actualSonner from 'sonner';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { BugReportSendToastActions } from '@/components/BugReportSendToast';
import {
  type BugReportSendBridge,
  type BugReportSendRequest,
  createBugReportSendManager,
} from '@/lib/bug-report-send-manager';

const ZIP_PATH = '/Users/x/Library/ok/reports/ok-report-2026-08-18-120000.zip';
const OPERATION_ID = 'ok-report-2026-08-18-120000.zip';
const OTHER_ZIP_PATH = '/Users/x/Library/ok/reports/ok-report-2026-08-18-130000.zip';
const OTHER_OPERATION_ID = 'ok-report-2026-08-18-130000.zip';

const toast = {
  custom: vi.fn((_render: (id: string | number) => unknown, _opts?: unknown) => 'toast-id'),
  dismiss: vi.fn((_id?: unknown) => {}),
};

vi.doMock('sonner', () => ({ ...actualSonner, toast }));

function mintedIds(): unknown[] {
  return toast.custom.mock.calls.map((call) => (call[1] as { id?: unknown } | undefined)?.id);
}

function durationOf(index: number): number | undefined {
  return (toast.custom.mock.calls[index]?.[1] as { duration?: number } | undefined)?.duration;
}

function actionsOf(index: number): BugReportSendToastActions {
  const render = toast.custom.mock.calls[index]?.[0];
  if (render === undefined) throw new Error(`no toast minted at index ${index}`);
  const element = render('unused') as { props: { actions: BugReportSendToastActions } };
  return element.props.actions;
}

function createDeferredBridge() {
  const resolvers: ((result: OkBugReportSendResult) => void)[] = [];
  const calls: unknown[] = [];
  const bridge: BugReportSendBridge = {
    send(sendRequest) {
      calls.push(sendRequest);
      return new Promise<OkBugReportSendResult>((resolve) => {
        resolvers.push(resolve);
      });
    },
  };
  return {
    bridge,
    calls,
    async settle(result: OkBugReportSendResult, index = resolvers.length - 1) {
      resolvers[index]?.(result);
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

function request(zipPath = ZIP_PATH): BugReportSendRequest {
  return {
    kind: 'created-report',
    report: {
      zipPath,
      zipSizeBytes: 2_048,
      summary: {
        level: 'full',
        systemWide: false,
        projectSlug: 'open-knowledge',
        files: ['logs/app.log'],
        redactions: [],
        redactedLineCount: 0,
        generatedAt: '2026-08-18T12:00:00.000Z',
      },
    },
    note: 'the editor froze',
    includeScreenshot: true,
  };
}

function createShellRecorder() {
  const openedExternal: string[] = [];
  const revealed: string[] = [];
  const desktop = {
    shell: {
      openExternal: (url: string) => {
        openedExternal.push(url);
        return Promise.resolve();
      },
      showItemInFolder: (zipPath: string) => {
        revealed.push(zipPath);
        return Promise.resolve();
      },
    },
  };
  return { openedExternal, revealed, desktop };
}

async function setup(desktop?: unknown) {
  const { installBugReportSendToasts } = await import('./install-bug-report-send-toasts');
  const deferred = createDeferredBridge();
  const manager = createBugReportSendManager(() => deferred.bridge);
  const uninstall = installBugReportSendToasts({
    manager,
    ...(desktop === undefined ? {} : { bridge: desktop as never }),
  });
  return { ...deferred, manager, uninstall };
}

describe('installBugReportSendToasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    toast.custom.mockClear();
    toast.dismiss.mockClear();
  });

  test('a started send mints one toast keyed by its operation id', async () => {
    const { manager, uninstall } = await setup();

    manager.startBugReportSend(request());

    expect(toast.custom).toHaveBeenCalledTimes(1);
    expect(mintedIds()).toEqual([OPERATION_ID]);
    uninstall();
  });

  test('progress ticks re-render the body in place rather than minting again', async () => {
    const { manager, uninstall } = await setup();
    manager.startBugReportSend(request());

    await vi.advanceTimersByTimeAsync(2_000);

    expect(manager.get(OPERATION_ID)?.status).toBe('sending');
    expect(toast.custom).toHaveBeenCalledTimes(1);
    uninstall();
  });

  test('an outcome re-mints at the same id so sonner re-measures the new layout', async () => {
    const { manager, settle, uninstall } = await setup();
    manager.startBugReportSend(request());

    await settle({ ok: true, reference: 'OK-1234' });

    expect(manager.get(OPERATION_ID)?.status).toBe('sent');
    expect(mintedIds()).toEqual([OPERATION_ID, OPERATION_ID]);
    uninstall();
  });

  test('a successful send auto-dismisses while a failure holds until dismissed', async () => {
    const { manager, settle, uninstall } = await setup();

    manager.startBugReportSend(request());
    expect(durationOf(0)).toBe(Number.POSITIVE_INFINITY);
    await settle({ ok: true, reference: 'OK-1234' });
    expect(durationOf(1)).toBeGreaterThan(0);
    expect(durationOf(1)).toBeLessThan(Number.POSITIVE_INFINITY);

    manager.startBugReportSend(request(OTHER_ZIP_PATH));
    await settle({
      ok: false,
      reason: 'send-failed',
      fallback: { mailtoUrl: 'mailto:support@inkeep.com?subject=failed' },
    });

    expect(mintedIds()).toEqual([
      OPERATION_ID,
      OPERATION_ID,
      OTHER_OPERATION_ID,
      OTHER_OPERATION_ID,
    ]);
    expect(durationOf(3)).toBe(Number.POSITIVE_INFINITY);
    uninstall();
  });

  test('retrying a send already in flight re-surfaces the toast the reporter dismissed', async () => {
    const { calls, manager, uninstall } = await setup();
    manager.startBugReportSend(request());
    actionsOf(0).dismiss();
    expect(toast.dismiss).toHaveBeenCalledWith(OPERATION_ID);

    manager.startBugReportSend(request());

    expect(mintedIds()).toEqual([OPERATION_ID, OPERATION_ID]);
    expect(calls).toHaveLength(1);
    uninstall();
  });

  test('each toast action reaches the bridge method that action names', async () => {
    const shell = createShellRecorder();
    const { manager, settle, uninstall } = await setup(shell.desktop);
    manager.startBugReportSend(request());
    await settle({
      ok: false,
      reason: 'send-failed',
      fallback: { mailtoUrl: 'mailto:support@inkeep.com?subject=failed' },
    });

    actionsOf(1).openExternal('mailto:support@inkeep.com?subject=failed');
    actionsOf(1).revealInFileManager(ZIP_PATH);

    expect(shell.openedExternal).toEqual(['mailto:support@inkeep.com?subject=failed']);
    expect(shell.revealed).toEqual([ZIP_PATH]);
    uninstall();
  });

  test('a transport that throws replaces the endless in-flight toast', async () => {
    const { installBugReportSendToasts } = await import('./install-bug-report-send-toasts');
    const throwing: BugReportSendBridge = {
      send() {
        throw new Error('IPC channel closed');
      },
    };
    const manager = createBugReportSendManager(() => throwing);
    const uninstall = installBugReportSendToasts({ manager });

    manager.startBugReportSend(request());
    await vi.advanceTimersByTimeAsync(0);

    expect(durationOf(0)).toBe(Number.POSITIVE_INFINITY);
    expect(mintedIds()).toEqual([OPERATION_ID, OPERATION_ID]);
    expect(manager.get(OPERATION_ID)?.status).not.toBe('sending');
    uninstall();
  });

  test('a cross-window refusal auto-dismisses instead of holding on screen', async () => {
    const { manager, settle, uninstall } = await setup();
    manager.startBugReportSend(request());
    await settle({
      ok: false,
      reason: 'send-in-flight',
      fallback: { mailtoUrl: 'mailto:support@inkeep.com?subject=inflight' },
    });

    const duration = durationOf(1);
    expect(duration).toBeGreaterThan(0);
    expect(Number.isFinite(duration)).toBe(true);
    uninstall();
  });

  test('an email draft holds on screen the way a failure does', async () => {
    const { manager, settle, uninstall } = await setup();
    manager.startBugReportSend(request());
    await settle({
      ok: false,
      reason: 'email-draft',
      fallback: { mailtoUrl: 'mailto:support@inkeep.com?subject=draft' },
    });

    expect(durationOf(1)).toBe(Number.POSITIVE_INFINITY);
    uninstall();
  });

  test('Try again on a failed send updates the same toast rather than adding one', async () => {
    const { calls, manager, settle, uninstall } = await setup();
    manager.startBugReportSend(request());
    await settle({
      ok: false,
      reason: 'send-failed',
      fallback: { mailtoUrl: 'mailto:support@inkeep.com?subject=failed' },
    });

    actionsOf(1).retry();

    expect(manager.get(OPERATION_ID)?.status).toBe('sending');
    expect(mintedIds()).toEqual([OPERATION_ID, OPERATION_ID, OPERATION_ID]);
    expect(calls).toHaveLength(2);
    uninstall();
  });

  test('a second report gets its own toast without replacing the first', async () => {
    const { manager, settle, uninstall } = await setup();
    manager.startBugReportSend(request());
    manager.startBugReportSend(request(OTHER_ZIP_PATH));

    expect(mintedIds()).toEqual([OPERATION_ID, OTHER_OPERATION_ID]);

    await settle({ ok: true, reference: 'OK-5678' }, 1);

    expect(manager.get(OPERATION_ID)?.status).toBe('sending');
    expect(manager.get(OTHER_OPERATION_ID)?.status).toBe('sent');
    expect(mintedIds()).toEqual([OPERATION_ID, OTHER_OPERATION_ID, OTHER_OPERATION_ID]);
    uninstall();
  });
});
