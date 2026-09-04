import type { OkBugReportListRow, OkBugReportSendResult } from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import * as actualSonner from 'sonner';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { bugReportSendManager } from '@/lib/bug-report-send-manager';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: renderLinguiTemplate,
    i18n: { date: (value: Date) => value.toISOString() },
  }),
}));

type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

const toast = {
  custom: vi.fn((_render: (id: string | number) => unknown, _options?: unknown) => 'toast-id'),
  dismiss: vi.fn((_id?: unknown) => {}),
};
vi.doMock('sonner', () => ({ ...actualSonner, toast }));

const { BugReportHistoryList, BugReportPreviousReports } = await import('./BugReportHistory');
const { installBugReportSendToasts } = await import('@/lib/install-bug-report-send-toasts');

function mintsFor(operationId: string): unknown[] {
  return toast.custom.mock.calls.filter(
    (call) => (call[1] as { id?: unknown } | undefined)?.id === operationId,
  );
}

function latestActionsFor(operationId: string): { dismiss: () => void } {
  const mints = mintsFor(operationId);
  const render = mints[mints.length - 1]?.[0] as ((id: string) => unknown) | undefined;
  if (render === undefined) throw new Error(`no toast minted for ${operationId}`);
  return (render('unused') as { props: { actions: { dismiss: () => void } } }).props.actions;
}

interface BridgeLog {
  listCalls: number;
  sendCalls: { zipPath: string; metadata: unknown }[];
  deleteCalls: string[];
  revealed: string[];
  opened: string[];
}

function installBridge(handlers: {
  reports: OkBugReportListRow[] | (() => OkBugReportListRow[] | Promise<OkBugReportListRow[]>);
  send?: () => Promise<OkBugReportSendResult>;
}): BridgeLog {
  const log: BridgeLog = {
    listCalls: 0,
    sendCalls: [],
    deleteCalls: [],
    revealed: [],
    opened: [],
  };
  const bridge = {
    bugReport: {
      list: async () => {
        log.listCalls += 1;
        const reports =
          typeof handlers.reports === 'function' ? await handlers.reports() : handlers.reports;
        return { ok: true as const, reports };
      },
      send: (request: { zipPath: string; metadata: unknown }) => {
        log.sendCalls.push(request);
        return handlers.send
          ? handlers.send()
          : Promise.resolve({ ok: true as const, reference: 'OK-9' });
      },
      delete: (id: string) => {
        log.deleteCalls.push(id);
        return Promise.resolve({ ok: true as const });
      },
    },
    shell: {
      showItemInFolder: (path: string) => {
        log.revealed.push(path);
        return Promise.resolve();
      },
      openExternal: (url: string) => {
        log.opened.push(url);
        return Promise.resolve();
      },
    },
  };
  for (const host of [window, globalThis] as unknown as Array<Record<string, unknown>>) {
    Object.defineProperty(host, 'okDesktop', { configurable: true, writable: true, value: bridge });
  }
  return log;
}

function clearBridge() {
  for (const host of [window, globalThis] as unknown as Array<Record<string, unknown>>) {
    Object.defineProperty(host, 'okDesktop', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  }
}

function makeRow(overrides: Partial<OkBugReportListRow> & { id: string }): OkBugReportListRow {
  return {
    createdAt: '2026-07-15T18:30:00.000Z',
    bundleLevel: 'standard',
    state: 'generated',
    zipBytes: 4096,
    zipDeleted: false,
    zipExists: true,
    systemWide: false,
    projectSlug: 'demo',
    attemptsCount: 0,
    zipPath: `/Users/tester/.ok/bug-reports/${overrides.id}`,
    retryable: true,
    degraded: false,
    ...overrides,
  };
}

function deferredSend() {
  let resolve: (result: OkBugReportSendResult) => void = () => {};
  return {
    send: () =>
      new Promise<OkBugReportSendResult>((r) => {
        resolve = r;
      }),
    finish: (result: OkBugReportSendResult) => resolve(result),
  };
}

afterEach(async () => {
  cleanup();
  await vi.waitFor(() => {
    expect(bugReportSendManager.getSnapshot().some((op) => op.status === 'sending')).toBe(false);
  });
  clearBridge();
});

describe('BugReportHistoryList', () => {
  test('renders each report with its state badge, reference, and failure reason', async () => {
    installBridge({
      reports: [
        makeRow({
          id: 'a-bugreport.zip',
          state: 'sent',
          reference: 'OK-42',
          zipDeleted: true,
          zipExists: false,
          retryable: false,
        }),
        makeRow({
          id: 'b-bugreport.zip',
          state: 'upload-failed',
          lastError: { reason: 'complete-rejected: 503', at: 'x' },
        }),
      ],
    });

    render(<BugReportHistoryList />);

    expect(await screen.findByText('Sent')).toBeDefined();
    expect(screen.getByText('OK-42')).toBeDefined();
    expect(screen.getByText('Failed')).toBeDefined();
    expect(screen.getByText('complete-rejected: 503')).toBeDefined();
  });

  test('shows the empty state with a Report-a-bug CTA that fires the callback', async () => {
    installBridge({ reports: [] });
    let cta = 0;

    render(<BugReportHistoryList onReportABug={() => (cta += 1)} />);

    expect(await screen.findByText('No bug reports yet.')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    expect(cta).toBe(1);
  });

  test('a degraded row renders as Unknown without breaking the list', async () => {
    installBridge({
      reports: [
        makeRow({
          id: 'c-bugreport.zip',
          state: 'unknown',
          degraded: true,
          bundleLevel: 'unknown',
        }),
      ],
    });

    render(<BugReportHistoryList />);
    expect(await screen.findByText('Unknown')).toBeDefined();
    expect(screen.getByText('Report from demo')).toBeDefined();
  });

  test('Retry resends the existing bundle with reconstructed send metadata', async () => {
    const log = installBridge({
      reports: [
        makeRow({
          id: 'd-bugreport.zip',
          state: 'upload-failed',
          bundleLevel: 'full',
          systemWide: true,
          projectSlug: null,
          lastError: { reason: 'offline', at: 'x' },
        }),
      ],
    });

    render(<BugReportHistoryList />);
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(log.sendCalls).toHaveLength(1);
    expect(log.sendCalls[0]).toEqual({
      zipPath: '/Users/tester/.ok/bug-reports/d-bugreport.zip',
      metadata: { level: 'full', systemWide: true, projectSlug: null },
    });
  });

  test('a retry that resolves to the email-draft path leaves the draft unopened', async () => {
    const log = installBridge({
      reports: [makeRow({ id: 'e-bugreport.zip', state: 'upload-failed' })],
      send: async () => ({
        ok: false as const,
        reason: 'email-draft' as const,
        fallback: { mailtoUrl: 'mailto:support@inkeep.com?subject=x' },
      }),
    });

    render(<BugReportHistoryList />);
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    await vi.waitFor(() => {
      expect(bugReportSendManager.get('e-bugreport.zip')?.status).toBe('email-draft');
    });
    expect(log.opened).toEqual([]);
  });

  test('Reveal opens the zip location and Delete removes by id', async () => {
    const log = installBridge({
      reports: [makeRow({ id: 'f-bugreport.zip', state: 'generated' })],
    });

    render(<BugReportHistoryList />);
    await userEvent.click(await screen.findByLabelText('Reveal in Finder'));
    expect(log.revealed).toEqual(['/Users/tester/.ok/bug-reports/f-bugreport.zip']);

    await userEvent.click(screen.getByLabelText('Delete report'));
    expect(log.deleteCalls).toEqual(['f-bugreport.zip']);
  });

  test('an open pane flips a row to its terminal badge when a background send lands', async () => {
    let landed = false;
    const pending = deferredSend();
    installBridge({
      reports: () => [
        makeRow({
          id: 'g-bugreport.zip',
          state: landed ? 'sent' : 'uploading',
          ...(landed ? { reference: 'OK-77' } : {}),
          retryable: false,
        }),
      ],
      send: pending.send,
    });

    render(<BugReportHistoryList />);
    expect(await screen.findByText('Sending')).toBeDefined();

    bugReportSendManager.startBugReportSend({
      kind: 'history-row',
      row: makeRow({ id: 'g-bugreport.zip', state: 'uploading' }),
    });
    landed = true;
    pending.finish({ ok: true, reference: 'OK-77' });

    expect(await screen.findByText('Sent')).toBeDefined();
    expect(screen.queryByText('Sending')).toBeNull();
  });

  test('Retry on a report this window is already sending issues no second send', async () => {
    const pending = deferredSend();
    const log = installBridge({
      reports: [makeRow({ id: 'j-bugreport.zip', state: 'upload-failed' })],
      send: pending.send,
    });

    render(<BugReportHistoryList />);
    const retry = await screen.findByRole('button', { name: 'Retry' });

    bugReportSendManager.startBugReportSend({
      kind: 'history-row',
      row: makeRow({ id: 'j-bugreport.zip', state: 'upload-failed' }),
    });
    await vi.waitFor(() => {
      expect(log.sendCalls).toHaveLength(1);
    });

    await userEvent.click(retry);
    expect(log.sendCalls).toHaveLength(1);

    pending.finish({ ok: true, reference: 'OK-3' });
    await vi.waitFor(() => {
      expect(bugReportSendManager.get('j-bugreport.zip')?.status).toBe('sent');
    });
  });

  test('a list reply that lost the race cannot overwrite the newer one', async () => {
    const replies: Array<(rows: OkBugReportListRow[]) => void> = [];
    const pending = deferredSend();
    installBridge({
      reports: () =>
        new Promise<OkBugReportListRow[]>((resolve) => {
          replies.push(resolve);
        }),
      send: pending.send,
    });

    render(<BugReportHistoryList />);
    await vi.waitFor(() => {
      expect(replies).toHaveLength(1);
    });

    bugReportSendManager.startBugReportSend({
      kind: 'history-row',
      row: makeRow({ id: 'l-bugreport.zip', state: 'uploading' }),
    });
    pending.finish({ ok: true, reference: 'OK-5' });
    await vi.waitFor(() => {
      expect(replies).toHaveLength(2);
    });

    replies[1]([
      makeRow({
        id: 'l-bugreport.zip',
        state: 'sent',
        reference: 'OK-5',
        zipExists: false,
        retryable: false,
      }),
    ]);
    expect(await screen.findByText('Sent')).toBeDefined();

    await act(async () => {
      replies[0]([makeRow({ id: 'l-bugreport.zip', state: 'uploading', retryable: false })]);
    });
    expect(screen.getByText('Sent')).toBeDefined();
    expect(screen.queryByText('Sending')).toBeNull();
  });

  test('Retry re-surfaces the toast for a send already in flight, even after Dismiss', async () => {
    const pending = deferredSend();
    installBridge({
      reports: [makeRow({ id: 'm-bugreport.zip', state: 'upload-failed' })],
      send: pending.send,
    });
    const uninstallToasts = installBugReportSendToasts();

    try {
      render(<BugReportHistoryList />);
      const retry = await screen.findByRole('button', { name: 'Retry' });

      bugReportSendManager.startBugReportSend({
        kind: 'history-row',
        row: makeRow({ id: 'm-bugreport.zip', state: 'upload-failed' }),
      });
      await vi.waitFor(() => {
        expect(mintsFor('m-bugreport.zip')).toHaveLength(1);
      });
      latestActionsFor('m-bugreport.zip').dismiss();
      expect(toast.dismiss).toHaveBeenCalledWith('m-bugreport.zip');

      await userEvent.click(retry);

      expect(mintsFor('m-bugreport.zip')).toHaveLength(2);

      pending.finish({ ok: true, reference: 'OK-8' });
      await vi.waitFor(() => {
        expect(bugReportSendManager.get('m-bugreport.zip')?.status).toBe('sent');
      });
    } finally {
      uninstallToasts();
    }
  });

  test('a sent row offers the support follow-up only when it carries a reference', async () => {
    const log = installBridge({
      reports: [
        makeRow({
          id: 'h-bugreport.zip',
          state: 'sent',
          reference: 'OK-77',
          zipDeleted: true,
          zipExists: false,
          retryable: false,
        }),
        makeRow({
          id: 'i-bugreport.zip',
          state: 'sent',
          zipDeleted: true,
          zipExists: false,
          retryable: false,
        }),
      ],
    });

    render(<BugReportHistoryList />);
    const followUps = await screen.findAllByLabelText('Email support about this report');
    expect(followUps).toHaveLength(1);

    await userEvent.click(followUps[0]);
    expect(log.opened).toEqual(['mailto:support@inkeep.com?subject=Bug%20report%20OK-77']);
  });

  test('renders an error state when the bridge is absent', async () => {
    clearBridge();
    render(<BugReportHistoryList />);
    expect(await screen.findByText("Couldn't load your bug reports.")).toBeDefined();
  });
});

describe('report row titles', () => {
  test('a row carrying a note is titled by the note first useful line', async () => {
    installBridge({
      reports: [
        makeRow({
          id: 'n1-bugreport.zip',
          note: 'The editor froze after I pasted a large table\nSteps: paste, wait',
        }),
      ],
    });

    render(<BugReportHistoryList />);

    expect(await screen.findByText('The editor froze after I pasted a large table')).toBeDefined();
    expect(screen.queryByText(/Steps: paste, wait/)).toBeNull();
  });

  test('a titled row still drafts support mail with a title-free subject', async () => {
    const log = installBridge({
      reports: [
        makeRow({
          id: 'n2-bugreport.zip',
          note: 'Autosave stopped writing to disk',
          state: 'sent',
          reference: 'OK-54',
          zipDeleted: true,
          zipExists: false,
          retryable: false,
        }),
      ],
    });

    render(<BugReportHistoryList />);
    expect(await screen.findByText('Autosave stopped writing to disk')).toBeDefined();

    await userEvent.click(await screen.findByLabelText('Email support about this report'));

    expect(log.opened).toEqual(['mailto:support@inkeep.com?subject=Bug%20report%20OK-54']);
  });
});

describe('report row list semantics', () => {
  test('the reports render as a list, each item leading with its title', async () => {
    installBridge({
      reports: [
        makeRow({ id: 's1-bugreport.zip', note: 'Sync hangs on a large vault' }),
        makeRow({ id: 's2-bugreport.zip', note: 'Paste of a wide table locks the editor' }),
      ],
    });

    render(<BugReportHistoryList />);

    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent?.startsWith('Sync hangs on a large vault')).toBe(true);
    expect(items[1]?.textContent?.startsWith('Paste of a wide table locks the editor')).toBe(true);
  });
});

describe('report row title fallbacks', () => {
  test('a note-less row from a project is titled by the project', async () => {
    installBridge({ reports: [makeRow({ id: 'f1-bugreport.zip' })] });

    render(<BugReportHistoryList />);

    expect(await screen.findByText('Report from demo')).toBeDefined();
  });

  test('a row with no project and no note is untitled, before and after a retry synthesizes a sidecar', async () => {
    installBridge({
      reports: [
        makeRow({
          id: 'f2-bugreport.zip',
          projectSlug: null,
          systemWide: true,
          bundleLevel: 'unknown',
        }),
      ],
    });

    const { unmount } = render(<BugReportHistoryList />);
    expect(await screen.findByText('Untitled report')).toBeDefined();
    unmount();

    installBridge({
      reports: [
        makeRow({
          id: 'f2-bugreport.zip',
          state: 'sent',
          reference: 'OK-12',
          projectSlug: null,
          systemWide: true,
          bundleLevel: 'standard',
          retryable: false,
        }),
      ],
    });

    render(<BugReportHistoryList />);
    expect(await screen.findByText('Untitled report')).toBeDefined();
  });

  test('a project slug outranks a system-wide claim on the same row', async () => {
    installBridge({
      reports: [makeRow({ id: 'f6-bugreport.zip', projectSlug: 'demo', systemWide: true })],
    });

    render(<BugReportHistoryList />);

    expect(await screen.findByText('Report from demo')).toBeDefined();
  });

  test('a row whose send is in flight is still titled by its own note', async () => {
    installBridge({
      reports: [
        makeRow({
          id: 'f3-bugreport.zip',
          state: 'uploading',
          note: 'Search returns nothing after a rename',
          retryable: false,
        }),
      ],
    });

    render(<BugReportHistoryList />);

    expect(await screen.findByText('Search returns nothing after a rename')).toBeDefined();
    expect(screen.getByText('Sending')).toBeDefined();
  });

  test('the title exposes its full string as a tooltip and resolves its own direction', async () => {
    const note =
      'The editor froze after I pasted a large table and stayed frozen for about thirty seconds';
    installBridge({ reports: [makeRow({ id: 'f4-bugreport.zip', note })] });

    render(<BugReportHistoryList />);

    const title = await screen.findByText(note);
    expect(title.getAttribute('title')).toBe(note);
    expect(title.getAttribute('dir')).toBe('auto');
  });

  test('a fallback title carries a tooltip too', async () => {
    installBridge({ reports: [makeRow({ id: 'f5-bugreport.zip' })] });

    render(<BugReportHistoryList />);

    expect((await screen.findByText('Report from demo')).getAttribute('title')).toBe(
      'Report from demo',
    );
  });
});

describe('report row metadata line', () => {
  test('a sent row with a reference still shows its bundle size', async () => {
    installBridge({
      reports: [
        makeRow({
          id: 'm1-bugreport.zip',
          state: 'sent',
          reference: 'OK-42',
          zipDeleted: true,
          zipExists: false,
          retryable: false,
        }),
      ],
    });

    render(<BugReportHistoryList />);

    expect(await screen.findByText('4 KB')).toBeDefined();
    expect(screen.getByText('OK-42')).toBeDefined();
  });

  test('an upload-failed row shows its size alongside the failure reason', async () => {
    installBridge({
      reports: [
        makeRow({
          id: 'm2-bugreport.zip',
          state: 'upload-failed',
          lastError: { reason: 'complete-rejected: 503', at: 'x' },
        }),
      ],
    });

    render(<BugReportHistoryList />);

    expect(await screen.findByText('4 KB')).toBeDefined();
    expect(screen.getByText('complete-rejected: 503')).toBeDefined();
  });

  test('a row with no bundle size on record shows no size segment', async () => {
    installBridge({
      reports: [makeRow({ id: 'm3-bugreport.zip', zipBytes: 0, zipExists: false })],
    });

    render(<BugReportHistoryList />);

    await screen.findByText('Report from demo');
    expect(screen.queryByText('0 B')).toBeNull();
  });
});

describe('BugReportPreviousReports', () => {
  test('renders nothing when there is no history to disclose', async () => {
    const log = installBridge({ reports: [] });

    const { container } = render(<BugReportPreviousReports />);
    await waitFor(() => {
      expect(log.listCalls).toBeGreaterThan(0);
    });

    expect(container.textContent).toBe('');
  });

  test('discloses the count collapsed, and the rows once expanded', async () => {
    installBridge({
      reports: [
        makeRow({ id: 'a-bugreport.zip', state: 'upload-failed' }),
        makeRow({ id: 'b-bugreport.zip', state: 'generated' }),
      ],
    });

    render(<BugReportPreviousReports />);
    const trigger = await screen.findByRole('button', { name: /Previous reports/ });
    expect(trigger.textContent).toContain('(2)');
    expect(screen.queryByLabelText('Reveal in Finder')).toBeNull();

    await userEvent.click(trigger);

    expect(await screen.findAllByLabelText('Reveal in Finder')).toHaveLength(2);
  });

  test('the compose-step disclosure carries the same sent-row follow-up', async () => {
    const log = installBridge({
      reports: [
        makeRow({
          id: 'k-bugreport.zip',
          state: 'sent',
          reference: 'OK-31',
          zipDeleted: true,
          zipExists: false,
          retryable: false,
        }),
      ],
    });

    render(<BugReportPreviousReports />);
    await userEvent.click(await screen.findByRole('button', { name: /Previous reports/ }));
    await userEvent.click(await screen.findByLabelText('Email support about this report'));

    expect(log.opened).toEqual(['mailto:support@inkeep.com?subject=Bug%20report%20OK-31']);
  });

  test('the disclosure renders the same titled list rows as the standalone pane', async () => {
    installBridge({
      reports: [makeRow({ id: 'p1-bugreport.zip', note: 'Search returns stale results' })],
    });

    render(<BugReportPreviousReports />);
    await userEvent.click(await screen.findByRole('button', { name: /Previous reports/ }));

    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent?.startsWith('Search returns stale results')).toBe(true);
  });

  test('renders nothing when the bridge is absent', async () => {
    clearBridge();
    const { container } = render(<BugReportPreviousReports />);
    await waitFor(() => {
      expect(container.textContent).toBe('');
    });
  });
});
