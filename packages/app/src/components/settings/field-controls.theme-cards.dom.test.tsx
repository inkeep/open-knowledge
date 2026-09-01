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

function Harness({ theme }: { theme?: 'system' | 'light' | 'dark' }) {
  const form = useForm<Config>({
    defaultValues: { appearance: theme === undefined ? {} : { theme } } as Config,
  });
  return (
    <>
      {}
      <span data-testid="dirty-fields">{JSON.stringify(form.formState.dirtyFields)}</span>
      {}
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

    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy();
    expect(screen.getAllByRole('radio').map((el) => el.textContent)).toEqual([
      'System',
      'Light',
      'Dark',
    ]);
  });

  test('points the row label at a focusable card', () => {
    const { container } = render(<Harness theme="system" />);

    const forId = container.querySelector('label')?.getAttribute('for');
    expect(forId).toBeTruthy();
    expect(screen.getByTestId('theme-picker-system').id).toBe(forId);
  });

  test('lets the group carry the field description and invalid state', () => {
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
    commitField.mockReturnValue(false);
    render(<Harness theme="light" />);

    await userEvent.click(screen.getByTestId('theme-picker-dark'));

    expect(setTheme).toHaveBeenNthCalledWith(1, 'dark');
    expect(setTheme).toHaveBeenLastCalledWith('light');
    expect(checkedCard()).toBe('Light');
  });

  test('leaves an unset row clean after a rejected write, not permanently dirty', async () => {
    commitField.mockReturnValue(false);
    render(<Harness />);

    await userEvent.click(screen.getByTestId('theme-picker-dark'));

    expect(setTheme).toHaveBeenLastCalledWith('system');
    expect(screen.getByTestId('dirty-fields').textContent).toBe('{}');
  });

  test('moves the applied theme too when the row is reset', async () => {
    render(<Harness theme="dark" />);

    await userEvent.click(screen.getByRole('button', { name: 'Reset Theme to default' }));

    expect(setTheme).toHaveBeenCalledWith('system');
    expect(checkedCard()).toBe('System');
  });

  test("forwards 'system' verbatim instead of resolving it to a mode", async () => {
    render(<Harness theme="dark" />);

    await userEvent.click(screen.getByTestId('theme-picker-system'));

    expect(setTheme).toHaveBeenCalledWith('system');
  });
});
