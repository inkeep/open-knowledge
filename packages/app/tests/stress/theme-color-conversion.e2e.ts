import { PREVIEW_THEME_TOKENS } from '@inkeep/open-knowledge-core';
import {
  expect,
  FADE_DURATION_MS,
  installThemeFadeProbe,
  openColorThemes,
  type ThemeFadeProbeWindow,
  test,
} from './_helpers';

test('painted comment underlines retain their sRGB contrast in both default modes', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const samples = await page.evaluate(async () => {
    const modulePath = '/src/comments/anchor-layers.ts';
    const { buildAnchorSegments, commentColor } = await import(modulePath);
    const root = document.documentElement;
    const originalClass = root.className;
    const surface = document.createElement('div');
    surface.className = 'bg-background';
    const probe = document.createElement('span');
    surface.append(probe);
    document.body.append(surface);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    try {
      return ['light', 'dark'].map((mode) => {
        root.classList.toggle('dark', mode === 'dark');
        root.classList.toggle('light', mode === 'light');
        const segment = buildAnchorSegments([{ id: 'comment', from: 0, to: 1 }])[0];
        probe.style.cssText = segment.style;
        const shadow = getComputedStyle(probe).boxShadow;
        probe.style.backgroundColor = commentColor(0.7);
        const lineColor = getComputedStyle(probe).backgroundColor;
        const background = getComputedStyle(surface).backgroundColor;
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = background;
        context.fillRect(0, 0, 1, 1);
        const backgroundPixels = [...context.getImageData(0, 0, 1, 1).data];
        const backgroundRgb = backgroundPixels.slice(0, 3);
        context.fillStyle = lineColor;
        context.fillRect(0, 0, 1, 1);
        const paintedRgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
        return {
          mode,
          shadow,
          lineColor,
          background,
          backgroundRgb,
          backgroundAlpha: backgroundPixels[3],
          paintedRgb,
        };
      });
    } finally {
      root.className = originalClass;
      surface.remove();
    }
  });
  const luminance = (rgb: number[]) =>
    rgb.reduce((sum, value, index) => {
      const channel = value / 255;
      const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      return sum + linear * [0.2126, 0.7152, 0.0722][index];
    }, 0);
  for (const sample of samples) {
    expect(sample.backgroundAlpha, JSON.stringify(sample)).toBe(255);
    expect(sample.shadow).toContain(sample.lineColor);
    const [low, high] = [luminance(sample.paintedRgb), luminance(sample.backgroundRgb)].sort(
      (a, b) => a - b,
    );
    expect((high + 0.05) / (low + 0.05), JSON.stringify(sample)).toBeGreaterThanOrEqual(3);
  }
});

test('converts CSS Color 4 tokens for live xterm themes without losing alpha channels', async ({
  page,
}) => {
  await openColorThemes(page);
  const converted = await page.evaluate(async () => {
    const modulePath = '/src/lib/css-color-to-hex.ts';
    const { cssColorToHex } = await import(modulePath);
    return {
      transparentRgb: cssColorToHex('rgb(80 120 255 / 0)', { alpha: true }),
      translucentRgb: cssColorToHex('rgb(80 120 255 / 0.18)', { alpha: true }),
      color4White: cssColorToHex('oklch(1 0 0)', { alpha: true }),
      color4Black: cssColorToHex('oklch(0 0 0)', { alpha: true }),
      color4Translucent: cssColorToHex('oklch(0.66 0.18 259 / 0.18)', { alpha: true }),
      color4Reference: (() => {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.fillStyle = 'oklch(0.66 0.18 259 / 0.18)';
        context.fillRect(0, 0, 1, 1);
        return `#${Array.from(context.getImageData(0, 0, 1, 1).data, (channel) =>
          channel.toString(16).padStart(2, '0'),
        ).join('')}`;
      })(),
    };
  });

  expect(converted.transparentRgb).toBe('#5078ff00');
  expect(converted.translucentRgb).toBe('#5078ff2e');
  expect(converted.color4White).toBe('#ffffffff');
  expect(converted.color4Black).toBe('#000000ff');
  expect(converted.color4Translucent).toBe(converted.color4Reference);

  const invalidRegisteredTokens = await page.evaluate(async (tokens) => {
    const modulePath = '/src/lib/theme-color-properties.ts';
    const { THEME_COLOR_PROPERTIES } = await import(modulePath);
    return tokens
      .filter(
        (token) =>
          THEME_COLOR_PROPERTIES.includes(token.name) &&
          (!CSS.supports('color', token.light) || !CSS.supports('color', token.dark)),
      )
      .map((token) => token.name);
  }, PREVIEW_THEME_TOKENS);
  expect(invalidRegisteredTokens).toEqual([]);

  const dracula = page.getByRole('button', { name: 'Use Dracula for the active light mode' });
  await dracula.click();
  await expect.poll(() => page.locator('html').getAttribute('data-color-theme')).toBe('dracula');
  await expect
    .poll(() => page.locator('html').evaluate((root) => root.getAnimations().length))
    .toBe(0);

  const monokai = page.getByRole('button', { name: 'Use Monokai for the active light mode' });
  await installThemeFadeProbe(page);
  const fade = await monokai.evaluate(
    async (element, { token }) => {
      if (!(element instanceof HTMLButtonElement)) throw new Error('Expected a palette button');
      const modulePath = '/src/components/terminal-theme.ts';
      const { computeLiveXtermTheme } = await import(modulePath);
      const { armThemeFade } = window as typeof window & ThemeFadeProbeWindow;
      if (!armThemeFade) {
        throw new Error(
          'window.armThemeFade is absent; installThemeFadeProbe(page) must run after the last navigation',
        );
      }
      const armed = armThemeFade({
        token,
        read: {
          selection: (): string => computeLiveXtermTheme('dark').selectionBackground ?? '',
        },
      });
      element.click();
      return armed.report();
    },
    { token: '--selection-soft' },
  );

  const detail = `\n${fade.token} fade report:\n${JSON.stringify(fade)}\n`;
  expect(fade.settle, `the fade did not reach transitionend.${detail}`).toBe('end');
  expect(fade.durationMs, `the :root transition is not the product's fade duration.${detail}`).toBe(
    FADE_DURATION_MS,
  );
  for (const [phase, value] of Object.entries({
    beforeClick: fade.beforeClick.selection,
    atFadeStart: fade.atFadeStart.selection,
    atMidpoint: fade.atMidpoint.selection,
    afterSettle: fade.afterSettle.selection,
  })) {
    expect(value, `the ${phase} xterm selection is not an 8-digit hex.${detail}`).toMatch(
      /^#[0-9a-f]{8}$/,
    );
  }
  expect(
    fade.atFadeStart.selection,
    `seeking to currentTime 0 did not reproduce the pre-click selection.${detail}`,
  ).toBe(fade.beforeClick.selection);
  expect(
    fade.atMidpoint.selection,
    `the midpoint never left the pre-click selection — the fade did not interpolate.${detail}`,
  ).not.toBe(fade.beforeClick.selection);
  expect(
    fade.atMidpoint.selection,
    `the midpoint already equals the settled selection — the fade snapped.${detail}`,
  ).not.toBe(fade.afterSettle.selection);
  expect(
    fade.afterSettle.selection,
    `the settled selection equals the pre-click one — the palette never changed.${detail}`,
  ).not.toBe(fade.beforeClick.selection);
  await expect.poll(() => page.locator('html').getAttribute('data-color-theme')).toBe('monokai');
});
