import { expect, SETTINGS_PANEL_TIMEOUT_MS, test } from './_helpers';

async function openColorThemes(page: import('@playwright/test').Page) {
  await page.goto('/#settings');
  await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('settings-search-input').fill('Color theme');
  await page.getByTestId('settings-search-results').getByText('Color theme').first().click();
  await expect(page.getByRole('group', { name: 'Dracula' })).toBeVisible({
    timeout: SETTINGS_PANEL_TIMEOUT_MS,
  });
}

async function backgroundSamples(button: import('@playwright/test').Locator): Promise<string[]> {
  return button.evaluate(async (element) => {
    if (!(element instanceof HTMLButtonElement)) throw new Error('Expected a palette button');
    const values = new Set<string>();
    element.click();
    for (let index = 0; index < 20; index += 1) {
      values.add(
        getComputedStyle(document.documentElement).getPropertyValue('--background').trim(),
      );
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    return [...values];
  });
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
  const samples = await backgroundSamples(
    page.getByRole('button', { name: 'Use Monokai for the active light mode' }),
  );

  expect(samples).toContain('rgb(39, 40, 34)');
  expect(new Set(samples).size).toBeGreaterThan(2);
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
  await search.focus();
  const samples = await page.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="settings-search-input"]');
    input?.setSelectionRange(0, 0);
    const transformProbe = document.createElement('div');
    const opacityProbe = document.createElement('div');
    const sizeProbe = document.createElement('div');
    const shadowProbe = document.createElement('div');
    const colorProbe = document.createElement('div');
    transformProbe.style.transition = 'transform 1s linear';
    opacityProbe.style.transition = 'opacity 1s linear';
    sizeProbe.style.transition = 'width 1s linear';
    shadowProbe.style.transition = 'box-shadow 1s linear';
    colorProbe.style.transition = 'color 1s linear';
    opacityProbe.style.opacity = '1';
    sizeProbe.style.width = '1px';
    shadowProbe.style.boxShadow = '0 0 0 transparent';
    colorProbe.style.color = 'rgb(0, 0, 0)';
    const probes = [transformProbe, opacityProbe, sizeProbe, shadowProbe, colorProbe];
    document.body.append(...probes);
    void getComputedStyle(sizeProbe).width;
    const initial = getComputedStyle(document.body).backgroundColor;
    document.querySelector<HTMLButtonElement>('[data-testid="theme-picker-dark"]')?.click();
    transformProbe.style.transform = 'translateX(1px)';
    opacityProbe.style.opacity = '0.5';
    sizeProbe.style.width = '2px';
    shadowProbe.style.boxShadow = '0 0 1px black';
    colorProbe.style.color = 'rgb(1, 1, 1)';
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const transitionProperties = document
      .getAnimations()
      .map((animation) => (animation as CSSTransition).transitionProperty);
    const colorTransitionProperties = colorProbe
      .getAnimations()
      .map((animation) => (animation as CSSTransition).transitionProperty);
    const colors = [initial];
    for (let index = 0; index < 24; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      colors.push(getComputedStyle(document.body).backgroundColor);
    }
    probes.forEach((probe) => {
      probe.remove();
    });
    return {
      colors,
      focused: document.activeElement === input,
      selection: input?.selectionStart,
      transitionProperties,
      colorTransitionProperties,
    };
  });
  expect(new Set(samples.colors).size).toBeGreaterThan(2);
  expect(samples.colors[0]).not.toBe(samples.colors.at(-1));
  expect(samples.focused).toBe(true);
  expect(samples.selection).toBe(0);
  expect(samples.transitionProperties).toContain('transform');
  expect(samples.transitionProperties).toContain('opacity');
  expect(samples.transitionProperties).toContain('width');
  expect(samples.transitionProperties).toContain('box-shadow');
  expect(samples.colorTransitionProperties).toEqual([]);
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-color-fading');
  const selectionColor = await page.evaluate(async () => {
    const modulePath = '/src/components/terminal-theme.ts';
    const { computeLiveXtermTheme } = await import(modulePath);
    return computeLiveXtermTheme('dark').selectionBackground;
  });
  expect(selectionColor).toMatch(/^#[0-9a-f]{6}52$/);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedMotion = await page.evaluate(async () => {
    const colorProbe = document.createElement('div');
    const flashProbe = document.createElement('div');
    const opacityProbe = document.createElement('div');
    colorProbe.style.transition = 'color 1s linear';
    colorProbe.style.color = 'rgb(0, 0, 0)';
    opacityProbe.style.cssText = 'opacity:1;transition:opacity 1s linear';
    document.body.append(colorProbe, flashProbe, opacityProbe);
    void getComputedStyle(colorProbe).color;
    void getComputedStyle(flashProbe).boxShadow;
    document.querySelector<HTMLButtonElement>('[data-testid="theme-picker-light"]')?.click();
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
    colorProbe.remove();
    flashProbe.remove();
    opacityProbe.remove();
    return { transitionProperties, flashTransitions };
  });
  expect(reducedMotion.flashTransitions).toContain('box-shadow');
  expect(reducedMotion.transitionProperties).toContain('opacity');
  expect(
    reducedMotion.transitionProperties.filter(
      (property) => !['transform', 'opacity', 'box-shadow'].includes(property),
    ),
  ).toEqual([]);
});
