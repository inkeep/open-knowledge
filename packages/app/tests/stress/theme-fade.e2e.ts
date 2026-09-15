import {
  expect,
  FADE_DURATION_MS,
  FADE_REPORT_WINDOW_MS,
  installThemeFadeProbe,
  openColorThemes,
  type ThemeFadeProbeWindow,
  test,
} from './_helpers';

const PROBE_REPORT_WINDOWS_TO_OUTLAST = 2;
const PROBE_DURATION_MS = FADE_REPORT_WINDOW_MS * PROBE_REPORT_WINDOWS_TO_OUTLAST;

async function paletteFadeProbe(button: import('@playwright/test').Locator) {
  return button.evaluate(
    async (element, { token }) => {
      if (!(element instanceof HTMLButtonElement)) throw new Error('Expected a palette button');
      const root = document.documentElement;
      const { armThemeFade } = window as typeof window & ThemeFadeProbeWindow;
      if (!armThemeFade) {
        throw new Error(
          'window.armThemeFade is absent; installThemeFadeProbe(page) must run after the last navigation',
        );
      }
      const armed = armThemeFade({
        token,
        read: { background: () => getComputedStyle(root).getPropertyValue(token).trim() },
      });
      element.click();
      return armed.report();
    },
    { token: '--background' },
  );
}

test('theme settings fade typed tokens and persist a same-mode palette switch', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as typeof window & { startupThemeTransitions: string[] }).startupThemeTransitions = [];
    document.addEventListener('transitionrun', (event) => {
      if (event.target !== document.documentElement || !event.propertyName.startsWith('--')) return;
      (
        window as typeof window & { startupThemeTransitions: string[] }
      ).startupThemeTransitions.push(event.propertyName);
    });
  });
  await openColorThemes(page);
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { startupThemeTransitions: string[] }).startupThemeTransitions,
    ),
  ).toEqual([]);

  await page.getByRole('button', { name: 'Use Dracula for the active light mode' }).click();
  await expect.poll(() => page.locator('html').getAttribute('data-color-theme')).toBe('dracula');
  await expect
    .poll(() => page.locator('html').evaluate((root) => root.classList.contains('dark')))
    .toBe(true);

  await expect
    .poll(() => page.locator('html').evaluate((root) => root.getAnimations().length))
    .toBe(0);
  await installThemeFadeProbe(page);
  const fade = await paletteFadeProbe(
    page.getByRole('button', { name: 'Use Monokai for the active light mode' }),
  );

  const detail = `\n${fade.token} fade report:\n${JSON.stringify(fade)}\n`;
  expect(fade.settle, `the fade did not reach transitionend.${detail}`).toBe('end');
  expect(fade.durationMs, `the :root transition is not the product's fade duration.${detail}`).toBe(
    FADE_DURATION_MS,
  );
  for (const [phase, value] of Object.entries({
    beforeClick: fade.beforeClick.background,
    atFadeStart: fade.atFadeStart.background,
    atMidpoint: fade.atMidpoint.background,
    afterSettle: fade.afterSettle.background,
  })) {
    expect(value, `the ${phase} --background read is empty or absent.${detail}`).toMatch(/\S/);
  }
  expect(
    fade.atFadeStart.background,
    `seeking to currentTime 0 did not reproduce the pre-click value.${detail}`,
  ).toBe(fade.beforeClick.background);
  expect(
    fade.atMidpoint.background,
    `the midpoint never left the pre-click value — the fade did not interpolate.${detail}`,
  ).not.toBe(fade.beforeClick.background);
  expect(
    fade.atMidpoint.background,
    `the midpoint already equals the settled value — the fade snapped.${detail}`,
  ).not.toBe(fade.afterSettle.background);
  expect(
    fade.afterSettle.background,
    `the settled token is not Monokai's background.${detail}`,
  ).toBe('rgb(39, 40, 34)');
  await expect.poll(() => page.locator('html').getAttribute('data-color-theme')).toBe('monokai');

  await page.reload();
  await expect.poll(() => page.locator('html').getAttribute('data-color-theme')).toBe('monokai');
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { startupThemeTransitions: string[] }).startupThemeTransitions,
    ),
  ).toEqual([]);
});

test('theme settings retarget rapidly and honor reduced motion', async ({ page }) => {
  await openColorThemes(page);

  await page.getByRole('button', { name: 'Use Dracula for the active light mode' }).click();
  await expect.poll(() => page.locator('html').getAttribute('data-color-theme')).toBe('dracula');
  await page.getByRole('button', { name: 'Use Monokai for the active light mode' }).click();
  await page.getByRole('button', { name: 'Use Gruvbox for the active light mode' }).click();
  await expect.poll(() => page.locator('html').getAttribute('data-color-theme')).toBe('gruvbox');
  await expect
    .poll(() =>
      page
        .locator('html')
        .evaluate((root) => getComputedStyle(root).getPropertyValue('--background').trim()),
    )
    .toBe('rgb(40, 40, 40)');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const search = page.getByTestId('settings-search-input');
  await search.focus();
  const focusedBefore = await page.evaluate(() =>
    document.activeElement?.getAttribute('data-testid'),
  );
  const transformBefore = await search.evaluate((element) => getComputedStyle(element).transform);
  await page
    .getByRole('button', { name: 'Use Monokai for the active light mode' })
    .evaluate((button) => button.click());
  await expect.poll(() => page.locator('html').getAttribute('data-color-theme')).toBe('monokai');
  const reducedMotionAnimations = await page.evaluate(() => document.getAnimations().length);
  expect(reducedMotionAnimations).toBe(0);
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
    focusedBefore,
  );
  expect(await search.evaluate((element) => getComputedStyle(element).transform)).toBe(
    transformBefore,
  );
});

test('default light and dark modes fade surfaces without losing selection', async ({ page }) => {
  await page.goto('/#settings');
  await page.getByTestId('settings-sidebar-item-preferences').click();
  await page.getByTestId('theme-picker-light').click();
  expect(
    await page
      .locator('html')
      .evaluate((root) => getComputedStyle(root).getPropertyValue('--radius').trim()),
  ).toBe('0.625rem');
  expect(
    await page
      .getByTestId('theme-picker-light')
      .evaluate((button) => getComputedStyle(button).borderRadius),
  ).not.toBe('0px');
  await expect
    .poll(() => page.locator('html').evaluate((root) => root.getAnimations().length))
    .toBe(0);
  const search = page.getByTestId('settings-search-input');
  await search.fill('theme');
  await expect(search).toHaveValue('theme');
  await installThemeFadeProbe(page);
  const fade = await page.evaluate(
    async ({ token, probeDurationMs }) => {
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="settings-search-input"]',
      );
      if (!input) {
        throw new Error('settings-search-input not found; cannot pin the caret before the fade');
      }
      input.setSelectionRange(2, 2);
      const transformProbe = document.createElement('div');
      const opacityProbe = document.createElement('div');
      const sizeProbe = document.createElement('div');
      const shadowProbe = document.createElement('div');
      const colorProbe = document.createElement('div');
      transformProbe.style.transition = `transform ${probeDurationMs}ms linear`;
      opacityProbe.style.transition = `opacity ${probeDurationMs}ms linear`;
      sizeProbe.style.transition = `width ${probeDurationMs}ms linear`;
      shadowProbe.style.transition = `box-shadow ${probeDurationMs}ms linear`;
      colorProbe.style.transition = `color ${probeDurationMs}ms linear`;
      opacityProbe.style.opacity = '1';
      sizeProbe.style.width = '1px';
      shadowProbe.style.boxShadow = '0 0 0 transparent';
      colorProbe.style.color = 'rgb(0, 0, 0)';
      const probes = [transformProbe, opacityProbe, sizeProbe, shadowProbe, colorProbe];
      document.body.append(...probes);
      void getComputedStyle(sizeProbe).width;
      try {
        const root = document.documentElement;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas unavailable');
        const acceptedFrom = (seed: string, value: string): string => {
          context.fillStyle = seed;
          context.fillStyle = value;
          return context.fillStyle;
        };
        const normalize = (value: string): string => {
          if (acceptedFrom('#000000', value) !== acceptedFrom('#ffffff', value)) {
            throw new Error(`Canvas rejected the color ${JSON.stringify(value)}`);
          }
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data].join(',');
        };
        const darkPicker = document.querySelector<HTMLButtonElement>(
          '[data-testid="theme-picker-dark"]',
        );
        if (!darkPicker) {
          throw new Error('theme-picker-dark not found; the fade was never triggered');
        }
        const { armThemeFade } = window as typeof window & ThemeFadeProbeWindow;
        if (!armThemeFade) {
          throw new Error(
            'window.armThemeFade is absent; installThemeFadeProbe(page) must run after the last navigation',
          );
        }
        const armed = armThemeFade({
          token,
          read: {
            body: () => normalize(getComputedStyle(document.body).backgroundColor),
            sidebar: () => getComputedStyle(root).getPropertyValue(token).trim(),
          },
        });
        darkPicker.click();
        transformProbe.style.transform = 'translateX(1px)';
        opacityProbe.style.opacity = '0.5';
        sizeProbe.style.width = '2px';
        shadowProbe.style.boxShadow = '0 0 1px black';
        colorProbe.style.color = 'rgb(1, 1, 1)';
        const report = await armed.report();
        return {
          ...report,
          connected: input.isConnected,
          focused: document.activeElement === input,
          activeTestId: document.activeElement?.getAttribute('data-testid') ?? null,
          activeTag: document.activeElement?.tagName ?? null,
          value: input.value,
          selectionStart: input.selectionStart,
          selectionEnd: input.selectionEnd,
          probeTransitionProperties: [transformProbe, opacityProbe, sizeProbe, shadowProbe].flatMap(
            (probe) =>
              probe
                .getAnimations()
                .map((animation) => (animation as CSSTransition).transitionProperty),
          ),
          colorTransitionProperties: colorProbe
            .getAnimations()
            .map((animation) => (animation as CSSTransition).transitionProperty),
        };
      } finally {
        probes.forEach((probe) => {
          probe.remove();
        });
      }
    },
    { token: '--sidebar', probeDurationMs: PROBE_DURATION_MS },
  );
  const detail = `\n${fade.token} fade report (body samples are r,g,b,a):\n${JSON.stringify(fade)}\n`;
  expect(fade.settle, `the fade did not reach transitionend.${detail}`).toBe('end');
  expect(fade.durationMs, `the :root transition is not the product's fade duration.${detail}`).toBe(
    FADE_DURATION_MS,
  );
  for (const [phase, value] of Object.entries({
    beforeClick: fade.beforeClick.body,
    atFadeStart: fade.atFadeStart.body,
    atMidpoint: fade.atMidpoint.body,
    afterSettle: fade.afterSettle.body,
  })) {
    expect(value, `the ${phase} body sample is not an r,g,b,a byte join.${detail}`).toMatch(
      /^\d{1,3},\d{1,3},\d{1,3},\d{1,3}$/,
    );
  }
  expect(
    fade.atFadeStart.body,
    `seeking to currentTime 0 did not reproduce the pre-click surface.${detail}`,
  ).toBe(fade.beforeClick.body);
  expect(
    fade.atMidpoint.body,
    `the midpoint never left the light surface — the fade did not interpolate.${detail}`,
  ).not.toBe(fade.beforeClick.body);
  expect(
    fade.atMidpoint.body,
    `the midpoint already equals the settled surface — the fade snapped.${detail}`,
  ).not.toBe(fade.afterSettle.body);
  expect(
    fade.afterSettle.body,
    `the settled surface equals the light one — the mode never switched.${detail}`,
  ).not.toBe(fade.beforeClick.body);
  expect(fade.afterSettle.sidebar, `the settled token is not dark --sidebar.${detail}`).toBe(
    'oklch(0.205 0 0)',
  );
  expect(
    fade.connected,
    `the search input node was replaced during the theme switch.${detail}`,
  ).toBe(true);
  expect(
    fade.focused,
    `the search input no longer holds focus after the theme switch.${detail}`,
  ).toBe(true);
  expect(fade.value, `the theme switch discarded the search query.${detail}`).toBe('theme');
  expect(fade.selectionStart, `the theme switch moved the caret.${detail}`).toBe(2);
  expect(fade.selectionEnd, `the theme switch extended the selection.${detail}`).toBe(2);
  for (const property of ['transform', 'opacity', 'width', 'box-shadow']) {
    expect(
      fade.probeTransitionProperties,
      `the fade guard cancelled the non-color ${property} transition it must leave running.${detail}`,
    ).toContain(property);
  }
  expect(
    fade.colorTransitionProperties,
    `the fade guard left a descendant color transition running during the theme fade.${detail}`,
  ).toEqual([]);
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-color-fading');
  const selectionColor = await page.evaluate(async () => {
    const modulePath = '/src/components/terminal-theme.ts';
    const { computeLiveXtermTheme } = await import(modulePath);
    return computeLiveXtermTheme('dark').selectionBackground;
  });
  expect(selectionColor).toMatch(/^#[0-9a-f]{6}52$/);

  await search.fill('');
  await expect(search).toHaveValue('');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedMotion = await page.evaluate(async () => {
    const lightPicker = document.querySelector<HTMLButtonElement>(
      '[data-testid="theme-picker-light"]',
    );
    if (!lightPicker) {
      throw new Error('theme-picker-light not found; the mode switch was never triggered');
    }
    const colorProbe = document.createElement('div');
    const flashProbe = document.createElement('div');
    const opacityProbe = document.createElement('div');
    colorProbe.style.transition = 'color 1s linear';
    colorProbe.style.color = 'rgb(0, 0, 0)';
    opacityProbe.style.cssText = 'opacity:1;transition:opacity 1s linear';
    document.body.append(colorProbe, flashProbe, opacityProbe);
    void getComputedStyle(colorProbe).color;
    void getComputedStyle(flashProbe).boxShadow;
    lightPicker.click();
    colorProbe.style.color = 'rgb(1, 1, 1)';
    flashProbe.className = 'ok-landing-flash';
    opacityProbe.style.opacity = '0.5';
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const transitionProperties = document
      .getAnimations()
      .map((animation) => (animation as CSSTransition).transitionProperty);
    const flashTransitions = flashProbe
      .getAnimations()
      .map((animation) => (animation as CSSTransition).transitionProperty);
    const opacityTransitions = opacityProbe
      .getAnimations()
      .map((animation) => (animation as CSSTransition).transitionProperty);
    colorProbe.remove();
    flashProbe.remove();
    opacityProbe.remove();
    return { transitionProperties, flashTransitions, opacityTransitions };
  });
  expect(reducedMotion.flashTransitions).toContain('box-shadow');
  expect(reducedMotion.opacityTransitions).toContain('opacity');
  expect(
    reducedMotion.transitionProperties.filter(
      (property) => !['transform', 'opacity', 'box-shadow'].includes(property),
    ),
  ).toEqual([]);
});
