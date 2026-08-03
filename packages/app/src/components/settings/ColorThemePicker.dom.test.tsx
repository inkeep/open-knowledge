import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { COLOR_THEMES, type ColorThemeSelection, defaultThemeTokens } from '@/lib/color-themes';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

type Assignment = [slot: 'light' | 'dark', id: string];

async function renderPicker(
  selection: ColorThemeSelection,
  onAssign: (slot: 'light' | 'dark', id: string) => void = () => {},
  slotMode?: 'light' | 'dark',
) {
  const { ColorThemePicker } = await import('./ColorThemePicker');
  return render(
    <ColorThemePicker
      selection={selection}
      onAssign={onAssign}
      slotMode={slotMode}
      aria-label="Color theme"
    />,
  );
}

const DEFAULTS: ColorThemeSelection = { light: 'default', dark: 'default' };

/** Every inline `style` attribute inside a tile's preview, concatenated. */
function swatchStyles(themeLabel: RegExp): string {
  const tile = screen.getByRole('group', { name: themeLabel });
  return Array.from(
    tile.querySelectorAll<HTMLElement>('[data-theme-swatch] [style], [data-theme-swatch]'),
  )
    .map((el) => el.getAttribute('style') ?? '')
    .join(' ');
}

describe('ColorThemePicker', () => {
  afterEach(cleanup);

  test('renders one tile per registered theme, each with a sun and a moon', async () => {
    await renderPicker(DEFAULTS);
    for (const theme of COLOR_THEMES) {
      expect(screen.getByText(theme.label)).toBeDefined();
      expect(screen.getByLabelText(`Use ${theme.label} as the light theme`)).toBeDefined();
      expect(screen.getByLabelText(`Use ${theme.label} as the dark theme`)).toBeDefined();
    }
  });

  test('presses the sun on the light palette and the moon on the dark one', async () => {
    await renderPicker({ light: 'catppuccin-latte', dark: 'dracula' });
    expect(
      screen.getByLabelText('Use Catppuccin Latte as the light theme').getAttribute('data-state'),
    ).toBe('on');
    expect(
      screen.getByLabelText('Use Catppuccin Latte as the dark theme').getAttribute('data-state'),
    ).toBe('off');
    expect(screen.getByLabelText('Use Dracula as the dark theme').getAttribute('data-state')).toBe(
      'on',
    );
    expect(screen.getByLabelText('Use Dracula as the light theme').getAttribute('data-state')).toBe(
      'off',
    );
  });

  test('an assigned icon is visually distinct from an unassigned one, not just data-state', async () => {
    // The regression this pins: the icons carried the correct `data-state`
    // while rendering identically, because the stock Toggle pressed state is a
    // `bg-muted` wash that disappears against a themed tile. Assigning the mode
    // you are not currently in changes nothing else on screen, so if the icon
    // does not visibly change, the control reads as dead.
    await renderPicker({ light: 'catppuccin-latte', dark: 'dracula' });
    const on = screen.getByLabelText('Use Catppuccin Latte as the light theme');
    const off = screen.getByLabelText('Use Dracula as the light theme');
    expect(on.className).not.toBe(off.className);
    expect(on.className).toContain('border-primary');
    expect(off.className).not.toContain('border-primary');
    // The glyph itself fills in, so the state survives at icon size.
    expect(on.querySelector('svg')?.getAttribute('class')).toContain('fill-current');
    expect(off.querySelector('svg')?.getAttribute('class')).not.toContain('fill-current');
  });

  test('one palette can hold both modes at once', async () => {
    await renderPicker({ light: 'gruvbox', dark: 'gruvbox' });
    expect(screen.getByLabelText('Use Gruvbox as the light theme').getAttribute('data-state')).toBe(
      'on',
    );
    expect(screen.getByLabelText('Use Gruvbox as the dark theme').getAttribute('data-state')).toBe(
      'on',
    );
  });

  test('clicking the tile body assigns only the mode on screen', async () => {
    // The old picker made the whole tile the target; a click still has to do
    // something. It must NOT set both slots — that would drop the other mode's
    // palette without the user asking.
    const calls: Assignment[] = [];
    await renderPicker(
      { light: 'catppuccin-latte', dark: 'monokai' },
      (slot, id) => calls.push([slot, id]),
      'dark',
    );
    const swatch = screen
      .getByRole('group', { name: /Dracula/ })
      .querySelector('[data-theme-swatch]');
    expect(swatch).not.toBeNull();
    fireEvent.click(swatch as Element);
    expect(calls).toEqual([['dark', 'dracula']]);
  });

  test('fires onAssign with the slot the pressed icon owns', async () => {
    const calls: Assignment[] = [];
    await renderPicker(DEFAULTS, (slot, id) => calls.push([slot, id]));
    fireEvent.click(screen.getByLabelText('Use Catppuccin Frappé as the dark theme'));
    fireEvent.click(screen.getByLabelText('Use Catppuccin Latte as the light theme'));
    expect(calls).toEqual([
      ['dark', 'catppuccin-frappe'],
      ['light', 'catppuccin-latte'],
    ]);
  });

  test('re-pressing the icon of an already-assigned palette does not clear the slot', async () => {
    // Every mode must resolve to some palette — "no palette" is the `default`
    // tile, not an empty slot — so an un-press is ignored rather than written.
    const calls: Assignment[] = [];
    await renderPicker({ light: 'default', dark: 'dracula' }, (slot, id) => calls.push([slot, id]));
    fireEvent.click(screen.getByLabelText('Use Dracula as the dark theme'));
    expect(calls).toEqual([]);
  });

  test('paints the Default tile from literal base tokens, not cascaded CSS vars', async () => {
    // The regression: the preview used to read `var(--sidebar)` & co. Those are
    // exactly the properties a selected palette overrides on <html>, so the
    // Default tile inherited the override and mirrored the chosen theme.
    await renderPicker(DEFAULTS);
    const styles = swatchStyles(/Default/);
    expect(styles).not.toContain('var(--');
    const tokens = defaultThemeTokens('light');
    expect(styles).toContain(tokens.background);
    expect(styles).toContain(tokens.primary);
    expect(styles).toContain(tokens['syntax-keyword']);
  });

  test('follows slotMode for the Default tile only', async () => {
    await renderPicker(DEFAULTS, () => {}, 'light');
    const lightDefault = swatchStyles(/Default/);
    const lightDracula = swatchStyles(/Dracula/);
    cleanup();
    await renderPicker(DEFAULTS, () => {}, 'dark');
    // The base palette flips with the mode on screen; an authored palette is
    // mode-independent.
    expect(swatchStyles(/Default/)).not.toBe(lightDefault);
    expect(swatchStyles(/Default/)).toContain(defaultThemeTokens('dark').background);
    expect(swatchStyles(/Dracula/)).toBe(lightDracula);
  });

  test('rings the palette in effect for the mode on screen, not the other slot', async () => {
    const selection: ColorThemeSelection = { light: 'catppuccin-latte', dark: 'dracula' };
    await renderPicker(selection, () => {}, 'dark');
    expect(screen.getByRole('group', { name: /Dracula/ }).className).toContain('border-primary');
    expect(screen.getByRole('group', { name: /Catppuccin Latte/ }).className).not.toContain(
      'border-primary',
    );
  });
});
