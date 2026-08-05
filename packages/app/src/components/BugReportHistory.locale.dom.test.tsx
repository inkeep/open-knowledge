/**
 * The bug-report timestamp follows the PICKED interface language, not the
 * machine's.
 *
 * Deliberately does NOT mock `@lingui/react/macro` — the sibling suite does, and
 * its stub supplies an `i18n` with no `locale`, which would make this assertion
 * vacuous. Here `useLingui()` resolves through the config-wide macro shim, whose
 * `i18n` IS the real `@lingui/core` singleton, so activating a locale moves the
 * same value the component reads.
 *
 * `Intl.DateTimeFormat` is the platform, not Lingui, so its output is one of the
 * few user-visible things that genuinely varies by locale under a shim that
 * renders every message in English.
 *
 * Substrate: jsdom via `pnpm run test:dom`.
 */
import type { OkBugReportListRow } from '@inkeep/open-knowledge-core';
import { i18n } from '@lingui/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { BugReportHistoryList } from './BugReportHistory';

const CREATED_AT = '2026-07-15T18:30:00.000Z';
const DATE_FORMAT = { dateStyle: 'medium', timeStyle: 'short' } as const;

const ROW: OkBugReportListRow = {
  id: 'report-1',
  createdAt: CREATED_AT,
  bundleLevel: 'standard',
  state: 'generated',
  zipBytes: 4096,
  zipDeleted: false,
  zipExists: true,
  systemWide: false,
  projectSlug: 'demo',
  attemptsCount: 0,
  zipPath: '/Users/tester/.ok/bug-reports/report-1',
  retryable: true,
  degraded: false,
};

function installBridge(): void {
  const bridge = {
    bugReport: {
      list: () => Promise.resolve({ ok: true as const, reports: [ROW] }),
    },
  };
  for (const host of [window, globalThis] as unknown as Array<Record<string, unknown>>) {
    Object.defineProperty(host, 'okDesktop', { configurable: true, writable: true, value: bridge });
  }
}

/** Mount the list and return the row's rendered timestamp. */
async function renderTimestampUnder(locale: string): Promise<string> {
  i18n.load(locale, {});
  i18n.activate(locale);
  installBridge();
  render(<BugReportHistoryList />);
  const expected = new Intl.DateTimeFormat(locale, DATE_FORMAT).format(new Date(CREATED_AT));
  await waitFor(() => {
    expect(screen.queryByText(expected)).not.toBeNull();
  });
  return expected;
}

afterEach(() => {
  cleanup();
  for (const host of [window, globalThis] as unknown as Array<Record<string, unknown>>) {
    Object.defineProperty(host, 'okDesktop', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  }
  i18n.activate('en');
});

describe('bug-report timestamps follow the selected interface language', () => {
  test('renders the date in the active locale, and a different locale moves it', async () => {
    const english = await renderTimestampUnder('en');
    cleanup();
    const spanish = await renderTimestampUnder('es');
    // The differ-assertion is what kills a reverted `undefined` argument: both
    // renders would agree on whatever the runtime's own locale produces.
    expect(spanish).not.toBe(english);
  });
});
