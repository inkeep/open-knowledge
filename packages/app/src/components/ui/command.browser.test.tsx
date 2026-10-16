import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { captureBugReport } from '@/lib/bug-report-capture';
import { renderWithI18n } from '../../../tests/foundation/render-with-i18n.test-helper';
import { CommandDialog } from './command';

type Visibility = { content: string; overlay: string };

function overlayOf(content: HTMLElement): HTMLElement {
  const overlay = content.parentElement?.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
  if (overlay == null) throw new Error('the dialog content has no sibling overlay');
  return overlay;
}

function recordVisibilityAtCapture(content: HTMLElement): { seen: Visibility | null } {
  const record: { seen: Visibility | null } = { seen: null };
  (window as unknown as { okDesktop?: unknown }).okDesktop = {
    bugReport: {
      captureScreenshot: async () => {
        record.seen = {
          content: getComputedStyle(content).visibility,
          overlay: getComputedStyle(overlayOf(content)).visibility,
        };
        return null;
      },
    },
  };
  return record;
}

function renderLauncherDialog(): HTMLElement {
  renderWithI18n(
    <CommandDialog open title="Palette" contentAttributes={{ 'data-bug-report-launcher': '' }}>
      <p>palette body</p>
    </CommandDialog>,
  );
  return screen.getByRole('dialog', { name: 'Palette' });
}

afterEach(async () => {
  cleanup();
  (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
  await vi.waitFor(() =>
    expect(document.documentElement.hasAttribute('data-bug-report-capturing')).toBe(false),
  );
});

describe('CommandDialog marked as a bug-report launcher', () => {
  test('a report started from inside it leaves the dialog and its backdrop out of the shot', async () => {
    const content = renderLauncherDialog();
    const record = recordVisibilityAtCapture(content);

    await captureBugReport({ launcherBorne: true });

    expect(record.seen).toEqual({ content: 'hidden', overlay: 'hidden' });
  });

  test('the report shortcut photographs the open dialog and its backdrop', async () => {
    const content = renderLauncherDialog();
    const record = recordVisibilityAtCapture(content);

    await captureBugReport({ launcherBorne: false });

    expect(record.seen).toEqual({ content: 'visible', overlay: 'visible' });
  });
});
