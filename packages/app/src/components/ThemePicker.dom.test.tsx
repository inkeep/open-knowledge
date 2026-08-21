import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ThemePicker, type ThemePreference } from './ThemePicker';

function renderPicker({
  value = 'system' as ThemePreference,
  disabled = false,
}: {
  value?: ThemePreference;
  disabled?: boolean;
} = {}) {
  const onValueChange = vi.fn();
  render(
    <ThemePicker
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      aria-label="Choose your theme"
    />,
  );
  return { onValueChange };
}

describe('ThemePicker', () => {
  afterEach(() => cleanup());

  test('exposes one radio per theme inside a labelled group', () => {
    renderPicker();

    expect(screen.getByRole('radiogroup', { name: 'Choose your theme' })).toBeTruthy();
    expect(screen.getAllByRole('radio').map((el) => el.textContent)).toEqual([
      'System',
      'Light',
      'Dark',
    ]);
  });

  test('checks the option matching `value`, and only that one', () => {
    renderPicker({ value: 'dark' });

    // Read off aria-checked rather than the check-badge element: the badge is
    // aria-hidden decoration, so a regression that dropped the radio semantics
    // while keeping the visual tick would still pass a badge-based assertion.
    expect(
      screen
        .getAllByRole('radio')
        .filter((el) => el.getAttribute('aria-checked') === 'true')
        .map((el) => el.textContent),
    ).toEqual(['Dark']);
  });

  test('reports the picked value on click', async () => {
    const { onValueChange } = renderPicker({ value: 'system' });

    await userEvent.click(screen.getByTestId('theme-picker-light'));

    expect(onValueChange).toHaveBeenCalledWith('light');
  });

  test('is operable by keyboard: arrows move, space commits', async () => {
    // The reason this is a Radix radio-group and not three buttons — a
    // hand-rolled card picker silently loses arrow-key navigation.
    //
    // Asserted as move-then-commit rather than select-on-arrow: in a real
    // browser Radix also selects as focus moves, but that path keys off a
    // document-level arrow-key flag that does not fire under jsdom. Space is
    // the part that reproduces here, and a user who can reach a card and
    // commit it has the affordance either way.
    const { onValueChange } = renderPicker({ value: 'system' });

    screen.getByTestId('theme-picker-system').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByTestId('theme-picker-light'));

    await userEvent.keyboard(' ');
    expect(onValueChange).toHaveBeenCalledWith('light');
  });

  test('reports nothing while disabled', async () => {
    const { onValueChange } = renderPicker({ value: 'system', disabled: true });

    await userEvent.click(screen.getByTestId('theme-picker-dark'));

    expect(onValueChange).not.toHaveBeenCalled();
  });
});
