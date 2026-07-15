import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { COLOR_THEMES } from '@/lib/color-themes';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

async function renderPicker(value: string, onSelect: (id: string) => void) {
  const { ColorThemePicker } = await import('./ColorThemePicker');
  return render(<ColorThemePicker value={value} onSelect={onSelect} aria-label="Color theme" />);
}

describe('ColorThemePicker', () => {
  afterEach(cleanup);

  test('renders one radio tile per registered theme, labelled by name', async () => {
    await renderPicker('default', () => {});
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBe(COLOR_THEMES.length);
    for (const theme of COLOR_THEMES) {
      expect(screen.getByText(theme.label)).toBeDefined();
    }
  });

  test('marks the selected theme as checked', async () => {
    await renderPicker('dracula', () => {});
    const dracula = screen.getByRole('radio', { name: /Dracula/ });
    expect(dracula.getAttribute('data-state')).toBe('checked');
    const mocha = screen.getByRole('radio', { name: /Catppuccin Frappé/ });
    expect(mocha.getAttribute('data-state')).toBe('unchecked');
  });

  test('falls back to default when value is empty or unknown', async () => {
    await renderPicker('', () => {});
    const def = screen.getByRole('radio', { name: /Default/ });
    expect(def.getAttribute('data-state')).toBe('checked');
  });

  test('fires onSelect with the theme id when a tile is activated', async () => {
    const picks: string[] = [];
    await renderPicker('default', (id) => picks.push(id));
    fireEvent.click(screen.getByRole('radio', { name: /Catppuccin Frappé/ }));
    expect(picks).toEqual(['catppuccin-frappe']);
  });

  test('tags themes by their forced mode: default is Auto, Latte is Light, the rest Dark', async () => {
    await renderPicker('default', () => {});
    // Default is the only Auto; Catppuccin Latte is the only Light palette; every
    // other palette (the dark IDE themes + the default-seed custom) is Dark.
    expect(screen.getAllByText('Auto').length).toBe(1);
    expect(screen.getAllByText('Light').length).toBe(1);
    expect(screen.getAllByText('Dark').length).toBe(COLOR_THEMES.length - 2);
  });
});
