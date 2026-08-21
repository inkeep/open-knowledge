/**
 * The Settings appearance row renders the shared light/dark/system card picker
 * and keeps the two-step commit the plain toggle it replaced had: flip
 * next-themes immediately (so the app repaints on click rather than after the
 * config round-trip), then persist through the form harness.
 */

import type { Config } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

function translateLingui(
  message: TemplateStringsArray | string | { message?: string },
  ...values: unknown[]
): string {
  if (typeof message === 'object' && 'message' in message) return message.message ?? '';
  return renderLinguiTemplate(message, ...values);
}

vi.doMock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  msg: renderLinguiTemplate,
  useLingui: () => ({ t: translateLingui }),
}));

const setTheme = vi.fn();
vi.doMock('next-themes', () => ({ useTheme: () => ({ setTheme, systemTheme: 'light' }) }));

const { SettingsField } = await import('./field-controls');
const { FIELDS_USER_PREFERENCES } = await import('./settings-fields');

const THEME_FIELD = FIELDS_USER_PREFERENCES.find(
  (f) => f.path.join('.') === 'appearance.theme',
) as (typeof FIELDS_USER_PREFERENCES)[number];

const commitField = vi.fn(() => true);

/**
 * Seeds the form the way the real dialog does — from the merged config — so
 * `ctl.value` is the stored preference rather than a resolved mode.
 */
function Harness({ theme }: { theme?: 'system' | 'light' | 'dark' }) {
  const form = useForm<Config>({
    defaultValues: { appearance: theme === undefined ? {} : { theme } } as Config,
  });
  return (
    <>
      {/* `dirtyFields`, not `isDirty`: the remote-update bridge keeps values for
          the fields listed here, while RHF's form-level `isDirty` stays true
          after a field-level reset even once nothing is actually dirty. */}
      <span data-testid="dirty-fields">{JSON.stringify(form.formState.dirtyFields)}</span>
      {/* The row's reset button is a Radix Tooltip trigger, which throws
          without a provider — the real dialog wraps its whole body in one. */}
      <TooltipProvider>
        <FormProvider {...form}>
          <SettingsField
            field={THEME_FIELD}
            scope="user"
            commitField={commitField}
            isFlashed={false}
          />
        </FormProvider>
      </TooltipProvider>
    </>
  );
}

function checkedCard(): string | null {
  return (
    screen.getAllByRole('radio').find((el) => el.getAttribute('aria-checked') === 'true')
      ?.textContent ?? null
  );
}

describe('Settings appearance theme row', () => {
  beforeEach(() => {
    setTheme.mockClear();
    commitField.mockClear();
    commitField.mockReturnValue(true);
  });
  afterEach(() => cleanup());

  test('renders the card picker rather than a plain toggle', () => {
    render(<Harness theme="system" />);

    // The row is labelled by the field label, which is also what the reset
    // button and the search index key off.
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy();
    expect(screen.getAllByRole('radio').map((el) => el.textContent)).toEqual([
      'System',
      'Light',
      'Dark',
    ]);
  });

  test('points the row label at a focusable card', () => {
    // The group root is a <div>, so `<label htmlFor>` pointing at it would
    // focus nothing on click. Asserted against the first card's own id, which
    // is the only reason `firstItemId` exists — without this, blanking that
    // prop is a silent no-op to the whole suite.
    const { container } = render(<Harness theme="system" />);

    const forId = container.querySelector('label')?.getAttribute('for');
    expect(forId).toBeTruthy();
    expect(screen.getByTestId('theme-picker-system').id).toBe(forId);
  });

  test('lets the group carry the field description and invalid state', () => {
    // `<FormControl>` is a Radix Slot: it merges these onto its single child,
    // so they only reach the DOM if the picker names them. A picker that
    // silently drops them leaves the description rendered but referenced by
    // nothing — which reads to assistive tech as no description at all.
    const { container } = render(<Harness theme="system" />);

    const description = container.querySelector('[data-slot="form-description"]');
    expect(description?.id).toBeTruthy();
    const group = screen.getByRole('radiogroup');
    expect(group.getAttribute('aria-describedby')).toContain(description?.id as string);
    expect(group.getAttribute('aria-invalid')).toBe('false');
  });

  test('checks the card matching the stored preference', () => {
    render(<Harness theme="dark" />);

    expect(checkedCard()).toBe('Dark');
  });

  test('shows System for an unset preference, which is how unset behaves', () => {
    // `appearance.theme` has no schema default and is absent from a fresh
    // config.yml. The toggle this replaced rendered nothing selected; the OS is
    // what an unset value actually follows, so System is the honest card.
    render(<Harness />);

    expect(checkedCard()).toBe('System');
  });

  test('flips next-themes and commits the pick', async () => {
    render(<Harness theme="system" />);

    await userEvent.click(screen.getByTestId('theme-picker-dark'));

    expect(setTheme).toHaveBeenCalledWith('dark');
    expect(commitField).toHaveBeenCalledWith('appearance.theme');
    expect(checkedCard()).toBe('Dark');
  });

  test('paints back to the committed theme when the write is rejected', async () => {
    // The flip is optimistic, so a refused write would otherwise leave the app
    // showing a theme nothing persisted until a later merged-effect quietly
    // undid it. Both legs have to come back: the applied mode AND the checked
    // card, or the two disagree.
    commitField.mockReturnValue(false);
    render(<Harness theme="light" />);

    await userEvent.click(screen.getByTestId('theme-picker-dark'));

    expect(setTheme).toHaveBeenNthCalledWith(1, 'dark');
    expect(setTheme).toHaveBeenLastCalledWith('light');
    expect(checkedCard()).toBe('Light');
  });

  test('leaves an unset row clean after a rejected write, not permanently dirty', async () => {
    // `appearance.theme` has no schema default, so a fresh config carries no
    // such key. Reverting by writing the NARROWED value back puts 'system'
    // over that absent baseline and leaves the row in `dirtyFields` for good —
    // measured, not assumed: that version reports
    // `{"appearance":{"theme":true}}` here. Remote updates skip dirty fields,
    // so the row would stop absorbing theme changes from other windows with
    // nothing on screen to say so.
    commitField.mockReturnValue(false);
    render(<Harness />);

    await userEvent.click(screen.getByTestId('theme-picker-dark'));

    expect(setTheme).toHaveBeenLastCalledWith('system');
    expect(screen.getByTestId('dirty-fields').textContent).toBe('{}');
  });

  test('moves the applied theme too when the row is reset', async () => {
    // Reset clears the stored value, which the cards render as System — the
    // mode an unset preference follows. Without moving next-themes, the window
    // stays in the mode the cleared value forced, so the checked card and the
    // theme on screen disagree with nothing to explain it.
    render(<Harness theme="dark" />);

    await userEvent.click(screen.getByRole('button', { name: 'Reset Theme to default' }));

    expect(setTheme).toHaveBeenCalledWith('system');
    expect(checkedCard()).toBe('System');
  });

  test("forwards 'system' verbatim instead of resolving it to a mode", async () => {
    // Resolving here would write 'light'/'dark' into config and strand the
    // user's choice to track the OS — the whole point of the System card.
    render(<Harness theme="dark" />);

    await userEvent.click(screen.getByTestId('theme-picker-system'));

    expect(setTheme).toHaveBeenCalledWith('system');
  });
});
