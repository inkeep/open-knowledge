/**
 * BugReportHistoryList DOM tests: the persisted report list renders rows with
 * state badges, an empty state with the Report-a-bug CTA, a degraded unknown
 * row, and the Retry / Reveal / Delete actions dispatching the right bridge
 * calls (Retry reconstructs the send metadata from the row).
 *
 * Substrate: jsdom via `pnpm run test:dom`.
 */
import type { OkBugReportListRow, OkBugReportSendResult } from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

// Superset factory: spreading the real module keeps every export the component
// tree may reach for, so a sibling suite mocking the same specifier in the same
// worker can't be left with a hole.
vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: renderLinguiTemplate,
    i18n: { date: (value: Date) => value.toISOString() },
  }),
}));

// Radix (Collapsible in the sibling disclosure) reaches for DOM globals the
// jsdom preload does not expose on globalThis. Same hoist as the dialog test.
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

// Imported after the macro mock so the component binds to the shim.
const { BugReportHistoryList, BugReportPreviousReports } = await import('./BugReportHistory');

interface BridgeLog {
  listCalls: number;
  sendCalls: { zipPath: string; metadata: unknown }[];
  deleteCalls: string[];
  revealed: string[];
  opened: string[];
}

function installBridge(handlers: {
  reports: OkBugReportListRow[] | (() => OkBugReportListRow[]);
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
      list: () => {
        log.listCalls += 1;
        const reports =
          typeof handlers.reports === 'function' ? handlers.reports() : handlers.reports;
        return Promise.resolve({ ok: true as const, reports });
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

afterEach(() => {
  cleanup();
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

  test('a retry that resolves to the email-draft path opens the prefilled draft', async () => {
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

    expect(log.opened).toEqual(['mailto:support@inkeep.com?subject=x']);
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

  test('renders an error state when the bridge is absent', async () => {
    clearBridge();
    render(<BugReportHistoryList />);
    expect(await screen.findByText("Couldn't load your bug reports.")).toBeDefined();
  });
});

describe('BugReportPreviousReports', () => {
  test('renders nothing when there is no history to disclose', async () => {
    const log = installBridge({ reports: [] });

    const { container } = render(<BugReportPreviousReports />);
    await waitFor(() => {
      expect(log.listCalls).toBeGreaterThan(0);
    });

    // An empty history must not put an empty disclosure in the compose step.
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
    // Collapsed: the trigger is the only affordance, no report actions yet.
    expect(screen.queryByLabelText('Reveal in Finder')).toBeNull();

    await userEvent.click(trigger);

    expect(await screen.findAllByLabelText('Reveal in Finder')).toHaveLength(2);
  });

  test('renders nothing when the bridge is absent', async () => {
    clearBridge();
    const { container } = render(<BugReportPreviousReports />);
    // Unlike the standalone list, the compose-step disclosure stays silent on a
    // load failure rather than showing an error inside the report form.
    await waitFor(() => {
      expect(container.textContent).toBe('');
    });
  });
});
