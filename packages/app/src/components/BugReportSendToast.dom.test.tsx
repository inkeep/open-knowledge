/**
 * `BugReportSendToast` layout + subscription tests.
 *
 * The component is driven by a real `createBugReportSendManager` over a
 * scripted bridge rather than by hand-built operation objects: the manager's
 * published shape is the contract under test, and a hand-built object would
 * keep passing after that shape drifted.
 *
 * Substrate: jsdom via `pnpm run test:dom`.
 */

import type { OkBugReportListRow, OkBugReportSendResult } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  BugReportSendToast,
  type BugReportSendToastActions,
} from '@/components/BugReportSendToast';
import {
  type BugReportSendManager,
  createBugReportSendManager,
} from '@/lib/bug-report-send-manager';

const ZIP_PATH = '/Users/tester/.ok/bug-reports/2026-07-10T00-00-00-bugreport.zip';
const OPERATION_ID = '2026-07-10T00-00-00-bugreport.zip';
const MAILTO = 'mailto:support@inkeep.com?subject=Bug%20report';

const ROW: OkBugReportListRow = {
  id: OPERATION_ID,
  createdAt: '2026-07-10T00:00:00.000Z',
  bundleLevel: 'standard',
  state: 'generated',
  zipBytes: 7130316, // renders as "6.8 MB"
  zipDeleted: false,
  zipExists: true,
  systemWide: false,
  projectSlug: 'demo-project',
  attemptsCount: 0,
  zipPath: ZIP_PATH,
  retryable: true,
  degraded: false,
};

const FAILED_RESULT: OkBugReportSendResult = {
  ok: false,
  reason: 'send-failed',
  fallback: { mailtoUrl: MAILTO, zipPath: ZIP_PATH },
};

/** Resolvers for every `send` the scripted bridge has been asked to make. */
let pendingSends: Array<(result: OkBugReportSendResult) => void> = [];

function startOperation(): BugReportSendManager {
  const manager = createBugReportSendManager(() => ({
    send: () =>
      new Promise<OkBugReportSendResult>((resolve) => {
        pendingSends.push(resolve);
      }),
  }));
  manager.startBugReportSend({ kind: 'history-row', row: ROW });
  return manager;
}

async function settleWith(result: OkBugReportSendResult): Promise<void> {
  const resolve = pendingSends.shift();
  if (resolve === undefined) throw new Error('no send is in flight');
  await act(async () => {
    resolve(result);
  });
}

/**
 * `satisfies` rather than an annotated return type: it holds the doubles to the
 * real action contract (a prop added to the interface fails here) while leaving
 * the inferred mock types intact for the call assertions.
 */
function makeActions() {
  return {
    dismiss: vi.fn(),
    retry: vi.fn(),
    openExternal: vi.fn(),
    revealInFileManager: vi.fn(),
    writeToClipboard: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
  } satisfies BugReportSendToastActions;
}

function renderToast(manager: BugReportSendManager, actions: ReturnType<typeof makeActions>) {
  return render(
    <BugReportSendToast
      operationId={OPERATION_ID}
      manager={manager}
      actions={actions}
      platform="darwin"
    />,
  );
}

afterEach(async () => {
  cleanup();
  // Any operation still 'sending' owns a live easing interval; settling it is
  // what clears that interval, so leave none behind for the next test file.
  const stragglers = pendingSends;
  pendingSends = [];
  for (const resolve of stragglers) resolve(FAILED_RESULT);
  await act(async () => {});
});

describe('while the send is in flight', () => {
  test('shows the bundle size over a bar that announces no percentage', async () => {
    const manager = startOperation();
    renderToast(manager, makeActions());

    expect(screen.getByText('Sending report')).toBeTruthy();
    expect(screen.getByText('6.8 MB total')).toBeTruthy();

    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(bar.getAttribute('data-state')).toBe('indeterminate');
    // The bar's accessible name comes from the visible title rather than a
    // second invented string.
    expect(bar.getAttribute('aria-labelledby')).toBeTruthy();

    await settleWith(FAILED_RESULT);
  });

  test('Dismiss asks the host to close the toast without touching the send', async () => {
    const manager = startOperation();
    const actions = makeActions();
    renderToast(manager, actions);

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(actions.dismiss).toHaveBeenCalledTimes(1);
    expect(manager.get(OPERATION_ID)?.status).toBe('sending');

    await settleWith(FAILED_RESULT);
  });

  test('the mounted toast swaps to the outcome without being re-rendered by its host', async () => {
    const manager = startOperation();
    renderToast(manager, makeActions());
    expect(screen.getByText('Sending report')).toBeTruthy();

    await settleWith({ ok: true, reference: 'OK-1234-ABCD' });

    expect(screen.queryByText('Sending report')).toBeNull();
    expect(screen.getByText('OK-1234-ABCD')).toBeTruthy();
  });
});

describe('when the send succeeds', () => {
  test('offers the reference to the clipboard and no reveal action', async () => {
    const manager = startOperation();
    const actions = makeActions();
    await settleWith({ ok: true, reference: 'OK-1234-ABCD' });
    renderToast(manager, actions);

    // Labelled, and labelled *next to* the value: an unlabelled identifier
    // reads as a ticket the reporter should go open, rather than the handle
    // they quote back to support. A label parked elsewhere in the toast would
    // not do that job, so assert the row, not just the presence of the word.
    const reference = screen.getByText('OK-1234-ABCD');
    expect(reference.parentElement?.textContent).toContain('Reference');

    await userEvent.click(screen.getByRole('button', { name: 'Copy reference' }));
    expect(actions.writeToClipboard).toHaveBeenCalledWith('OK-1234-ABCD');

    // Retention reclaims the zip on a confirmed send, so there is no file left
    // to reveal.
    expect(screen.queryByRole('button', { name: 'Reveal in Finder' })).toBeNull();
    expect(actions.revealInFileManager).not.toHaveBeenCalled();
  });

  test('confirms the copy on the button that performed it', async () => {
    const manager = startOperation();
    const actions = makeActions();
    await settleWith({ ok: true, reference: 'OK-1234-ABCD' });
    renderToast(manager, actions);

    await userEvent.click(screen.getByRole('button', { name: 'Copy reference' }));

    expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy();
  });
});

describe('when the send resolves to an email draft', () => {
  test('opens the draft and reveals the bundle, claiming no upload', async () => {
    const manager = startOperation();
    const actions = makeActions();
    await settleWith({
      ok: false,
      reason: 'email-draft',
      fallback: { mailtoUrl: MAILTO, zipPath: ZIP_PATH },
    });
    renderToast(manager, actions);

    expect(screen.getByText(/Nothing was uploaded/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Open email draft' }));
    expect(actions.openExternal).toHaveBeenCalledWith(MAILTO);

    await userEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }));
    expect(actions.revealInFileManager).toHaveBeenCalledWith(ZIP_PATH);
  });
});

describe('when the send fails', () => {
  test('offers retry alongside the draft and the bundle', async () => {
    const manager = startOperation();
    const actions = makeActions();
    await settleWith(FAILED_RESULT);
    renderToast(manager, actions);

    expect(screen.getByText("Couldn't send the report")).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(actions.retry).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Open email draft' }));
    expect(actions.openExternal).toHaveBeenCalledWith(MAILTO);

    await userEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }));
    expect(actions.revealInFileManager).toHaveBeenCalledWith(ZIP_PATH);
  });

  test('omits the draft action when the transport never produced one', async () => {
    const manager = createBugReportSendManager(() => {
      throw new Error('bridge exploded');
    });
    manager.startBugReportSend({ kind: 'history-row', row: ROW });
    renderToast(manager, makeActions());

    expect(screen.getByText("Couldn't send the report")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open email draft' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('when the report is already being sent elsewhere', () => {
  test('reads as in progress and offers no draft for a live report', async () => {
    const manager = startOperation();
    const actions = makeActions();
    await settleWith({
      ok: false,
      reason: 'send-in-flight',
      fallback: { mailtoUrl: MAILTO, zipPath: ZIP_PATH },
    });
    renderToast(manager, actions);

    expect(screen.getByText('Already sending this report')).toBeTruthy();
    expect(screen.queryByText("Couldn't send the report")).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open email draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('when the operation is unknown', () => {
  test('renders nothing rather than an invented state', () => {
    const manager = createBugReportSendManager(() => undefined);
    const { container } = render(
      <BugReportSendToast
        operationId="never-started.zip"
        manager={manager}
        actions={makeActions()}
        platform="darwin"
      />,
    );

    expect(container.textContent).toBe('');
  });
});
