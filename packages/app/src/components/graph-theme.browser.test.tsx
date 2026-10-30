import { render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { COLOR_THEME_ATTRIBUTE } from '@/lib/use-apply-config-color-theme';
import { useGraphPalette } from './graph-theme';

function Palette() {
  const palette = useGraphPalette();
  return <output data-testid="palette">{[palette.primary, ...palette.clusters].join(' ')}</output>;
}

afterEach(() => {
  const root = document.documentElement;
  root.removeAttribute(COLOR_THEME_ATTRIBUTE);
  root.style.removeProperty('--primary');
  root.style.removeProperty('--chart-1');
});

test('an open graph takes the new theme colors when the theme changes', async () => {
  const root = document.documentElement;
  root.style.setProperty('--primary', '#112233');
  root.style.setProperty('--chart-1', '#445566');
  render(<Palette />);
  expect(screen.getByTestId('palette').textContent).toContain('#112233');
  expect(screen.getByTestId('palette').textContent).toContain('#445566');

  root.style.setProperty('--primary', '#553311');
  root.style.setProperty('--chart-1', '#335577');
  root.setAttribute(COLOR_THEME_ATTRIBUTE, 'graph-palette-test');

  await expect.poll(() => screen.getByTestId('palette').textContent).toContain('#553311');
  expect(screen.getByTestId('palette').textContent).toContain('#335577');
});
