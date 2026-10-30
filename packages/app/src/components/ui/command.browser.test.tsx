import { THEME_PLUGINS } from '@inkeep/open-knowledge-core/theme/theme-plugins';
import { cleanup, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { commands } from 'vitest/browser';
import { captureBugReport } from '@/lib/bug-report-capture';
import { renderWithI18n } from '../../../tests/foundation/render-with-i18n.test-helper';
import { textMeasurement } from '../../../tests/foundation/theme-contrast.test-helper';
import { Command, CommandDialog, CommandItem, CommandList, CommandShortcut } from './command';

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

const HIGHLIGHT_THEMES = [
  { id: 'default', kind: 'light' },
  { id: 'default', kind: 'dark' },
  ...THEME_PLUGINS.filter((theme) => theme.toTokens).map(({ id, kind }) => ({ id, kind })),
];

describe('the highlighted command row', () => {
  let stylesheet: HTMLStyleElement | undefined;

  beforeAll(async () => {
    stylesheet = document.createElement('style');
    stylesheet.textContent = await commands.buildAppStylesheet();
    document.head.append(stylesheet);
  });

  afterAll(() => stylesheet?.remove());

  afterEach(() => {
    delete document.documentElement.dataset.colorTheme;
    document.documentElement.classList.remove('dark');
  });

  for (const theme of HIGHLIGHT_THEMES) {
    test(`keeps its label readable and above its secondary text in ${theme.id} ${theme.kind}`, async () => {
      if (theme.id !== 'default') document.documentElement.dataset.colorTheme = theme.id;
      document.documentElement.classList.toggle('dark', theme.kind === 'dark');
      renderWithI18n(
        <Command>
          <CommandList>
            <CommandItem value="open-plan">
              <span>
                Open <span className="font-semibold text-foreground">plan</span>
              </span>
              <span className="text-muted-foreground">notes/plan.md</span>
              <CommandShortcut>Ctrl O</CommandShortcut>
            </CommandItem>
          </CommandList>
        </Command>,
      );
      await vi.waitFor(() =>
        expect(
          screen.getByText('Ctrl O').closest<HTMLElement>('[data-slot="command-item"]')?.dataset
            .selected,
        ).toBe('true'),
      );
      const ratios = (texts: string[]) =>
        texts.map((text) => {
          const { ratio } = textMeasurement(screen.getByText(text));
          expect(ratio, `${theme.id} ${theme.kind} ${text}`).toBeGreaterThanOrEqual(4.5);
          return ratio;
        });
      const label = ratios(['Open', 'plan']);
      const secondary = ratios(['notes/plan.md', 'Ctrl O']);
      expect(
        Math.min(...label),
        `${theme.id} ${theme.kind} label against its secondary text`,
      ).toBeGreaterThanOrEqual(Math.max(...secondary));
    });
  }
});
