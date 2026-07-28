import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { COLOR_THEMES, defaultThemeTokens } from '@/lib/color-themes';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

async function renderPicker(
  value: string,
  onSelect: (id: string) => void,
  defaultMode?: 'light' | 'dark',
) {
  const { ColorThemePicker } = await import('./ColorThemePicker');
  return render(
    <ColorThemePicker
      value={value}
      onSelect={onSelect}
      defaultMode={defaultMode}
      aria-label="Color theme"
    />,
  );
}

/** Every inline `style` attribute inside a tile's preview, concatenated. */
function swatchStyles(themeLabel: RegExp): string {
  const tile = screen.getByRole('radio', { name: themeLabel });
  return Array.from(tile.querySelectorAll<HTMLElement>('[style]'))
    .map((el) => el.getAttribute('style') ?? '')
    .join(' ');
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

  test('paints the Default tile from literal base tokens, not cascaded CSS vars', async () => {
    // The regression: the preview used to read `var(--sidebar)` & co. Those are
    // exactly the properties a selected palette overrides on <html>, so the
    // Default tile inherited the override and mirrored the chosen theme.
    await renderPicker('default', () => {});
    const styles = swatchStyles(/Default/);
    expect(styles).not.toContain('var(--');
    const tokens = defaultThemeTokens('light');
    expect(styles).toContain(tokens.background);
    expect(styles).toContain(tokens.primary);
    expect(styles).toContain(tokens['syntax-keyword']);
  });

  test('follows defaultMode for the Default tile only', async () => {
    await renderPicker('default', () => {}, 'light');
    const lightDefault = swatchStyles(/Default/);
    const lightDracula = swatchStyles(/Dracula/);
    cleanup();
    await renderPicker('default', () => {}, 'dark');
    // The base palette flips with the user's light/dark mode; an authored
    // palette is mode-independent.
    expect(swatchStyles(/Default/)).not.toBe(lightDefault);
    expect(swatchStyles(/Default/)).toContain(defaultThemeTokens('dark').background);
    expect(swatchStyles(/Dracula/)).toBe(lightDracula);
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
