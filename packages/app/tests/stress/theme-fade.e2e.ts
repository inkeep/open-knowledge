import type { Page } from '@playwright/test';
import {
  expect,
  FADE_DURATION_MS,
  FADE_REPORT_WINDOW_MS,
  installThemeFadeProbe,
  openColorThemes,
  runningRootAnimations,
  switchColorThemeAndSettleFade,
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
  const rootAnimations = await runningRootAnimations(page);
  expect(
    rootAnimations,
    'under reduced motion a palette switch must start no transition on the document root',
  ).toEqual([]);
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

interface RootFadeWitnessWindow {
  okRootFadeWitness?: { startedRootTransitions: number };
  okRootFadeHold?: AbortController;
}

async function installRootFadeWitness(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.documentElement;
    const witness = { startedRootTransitions: 0 };
    (window as typeof window & RootFadeWitnessWindow).okRootFadeWitness = witness;
    root.addEventListener('transitionrun', (event) => {
      if (event.target !== root || !event.propertyName.startsWith('--')) return;
      witness.startedRootTransitions += 1;
    });
  });
}

async function holdRootFadeOpen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.documentElement;
    const scope = window as typeof window & RootFadeWitnessWindow;
    if (scope.okRootFadeHold && !scope.okRootFadeHold.signal.aborted) {
      throw new Error(
        'holdRootFadeOpen(page) was called while a hold is still open; releaseRootFade(page) must run first, or the earlier hold can never be revoked',
      );
    }
    const controller = new AbortController();
    scope.okRootFadeHold = controller;
    root.addEventListener(
      'transitionrun',
      (event) => {
        if (event.target !== root || !event.propertyName.startsWith('--')) return;
        for (const animation of root.getAnimations({ subtree: false })) animation.pause();
      },
      { signal: controller.signal },
    );
  });
}

async function releaseRootFade(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { okRootFadeHold } = window as typeof window & RootFadeWitnessWindow;
    if (!okRootFadeHold) {
      throw new Error(
        'window.okRootFadeHold is absent; holdRootFadeOpen(page) must run before releaseRootFade(page)',
      );
    }
    if (okRootFadeHold.signal.aborted) {
      throw new Error(
        'releaseRootFade(page) was called on an already-released hold, so it would resume whatever happens to be running rather than the fade a hold was keeping open',
      );
    }
    okRootFadeHold.abort();
    for (const animation of document.documentElement.getAnimations({ subtree: false })) {
      animation.play();
    }
  });
}

function readStartedRootTransitions(page: Page): Promise<number> {
  return page.evaluate(() => {
    const { okRootFadeWitness } = window as typeof window & RootFadeWitnessWindow;
    if (!okRootFadeWitness) {
      throw new Error(
        'window.okRootFadeWitness is absent; installRootFadeWitness(page) must run after the last navigation',
      );
    }
    return okRootFadeWitness.startedRootTransitions;
  });
}

test('switching the color theme hands control back only once the :root fade has settled, and releasing the hold lets a later switch settle', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme-color-transitions');
  await expect.poll(() => runningRootAnimations(page)).toEqual([]);
  await installRootFadeWitness(page);
  await holdRootFadeOpen(page);

  let switchOutcome = 'pending';
  const switching = switchColorThemeAndSettleFade(page, 'solarized').then(
    () => {
      switchOutcome = 'returned';
    },
    (error: Error) => {
      switchOutcome = `failed: ${error.message}`;
    },
  );

  await expect.poll(() => readStartedRootTransitions(page)).toBeGreaterThan(0);
  const held = await runningRootAnimations(page);
  expect(
    held,
    'the color theme write started :root animations but none are held open, so the switch not having returned yet would prove nothing',
  ).not.toEqual([]);
  expect(
    switchOutcome,
    `the color theme switch handed control back while ${held.length} :root animations were held mid-fade, so every color read taken after it samples a frame of the fade rather than the theme`,
  ).toBe('pending');

  await releaseRootFade(page);
  await switching;
  expect(
    switchOutcome,
    'releasing the held :root fade did not let the color theme switch return',
  ).toBe('returned');

  const startedBeforeAfterRelease = await readStartedRootTransitions(page);
  let afterReleaseOutcome = 'pending';
  await switchColorThemeAndSettleFade(page, 'dracula').then(
    () => {
      afterReleaseOutcome = 'returned';
    },
    (error: Error) => {
      afterReleaseOutcome = `failed: ${error.message}`;
    },
  );
  expect(
    await readStartedRootTransitions(page),
    'the post-release color theme write started no :root transition, so it exercised no hold and its settling would prove nothing',
  ).toBeGreaterThan(startedBeforeAfterRelease);
  expect(
    afterReleaseOutcome,
    'a color theme switch started after the release did not settle; if the reason is that the hold was never disarmed, every :root transition started after the release is paused on arrival with nothing left to play it',
  ).toBe('returned');
});

test('switching to a color theme the attribute write cannot select fails the call', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme-color-transitions');
  const before = await page.locator('html').getAttribute('data-color-theme');

  for (const unselectable of ['default', 'custom', 'solarised']) {
    await expect(
      switchColorThemeAndSettleFade(page, unselectable),
      `no stylesheet rule targets html[data-color-theme="${unselectable}"], so switching to it must fail rather than resolve as a settled switch that changed nothing`,
    ).rejects.toThrow(/cannot apply/);
  }

  expect(
    await page.locator('html').getAttribute('data-color-theme'),
    'a rejected color theme switch must leave the attribute the product owns untouched',
  ).toBe(before);
});

test('switching the color theme under reduced motion returns with no fade to wait for', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme-color-transitions');
  await installRootFadeWitness(page);

  await switchColorThemeAndSettleFade(page, 'solarized');
  const startedAtReturn = await readStartedRootTransitions(page);
  const runningAtReturn = await runningRootAnimations(page);

  await expect(
    page.locator('html'),
    'the switch returned without applying the color theme, so "no fade was running" proves nothing',
  ).toHaveAttribute('data-color-theme', 'solarized');
  expect(
    startedAtReturn,
    'reduced motion must suppress the fade entirely, so this test no longer exercises the nothing-to-wait-for path the barrier has to return from',
  ).toBe(0);
  expect(
    runningAtReturn,
    'the color theme switch returned with animations still running on :root under reduced motion',
  ).toEqual([]);
});

test('switching the color theme with its fade retargeted mid-flight still hands control back on a settled tree', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme-color-transitions');
  await expect.poll(() => runningRootAnimations(page)).toEqual([]);
  await installRootFadeWitness(page);
  await holdRootFadeOpen(page);

  let firstOutcome = 'pending';
  const firstSwitch = switchColorThemeAndSettleFade(page, 'solarized').then(
    () => {
      firstOutcome = 'returned';
    },
    (error: Error) => {
      firstOutcome = `failed: ${error.message}`;
    },
  );

  await expect.poll(() => readStartedRootTransitions(page)).toBeGreaterThan(0);
  const startedBeforeRetarget = await readStartedRootTransitions(page);
  expect(
    await runningRootAnimations(page),
    'the first color theme write started no :root animations that are still held open, so retargeting them would prove nothing',
  ).not.toEqual([]);

  let secondOutcome = 'pending';
  const secondSwitch = switchColorThemeAndSettleFade(page, 'dracula').then(
    () => {
      secondOutcome = 'returned';
    },
    (error: Error) => {
      secondOutcome = `failed: ${error.message}`;
    },
  );

  await expect
    .poll(() => readStartedRootTransitions(page), {
      message:
        'the second color theme write started no new :root token transitions, so the first switch had no fade in flight to retarget and this test does not exercise the case it exists for',
    })
    .toBeGreaterThan(startedBeforeRetarget);

  await releaseRootFade(page);
  await firstSwitch;
  await secondSwitch;

  expect(
    firstOutcome,
    'a second color theme switch retargeted the first switch’s fade, which cancels every :root token transition the first call was waiting on; the barrier must read the live animation list rather than hold promises for specific animation instances, or it surfaces that cancellation as the first call’s own failure',
  ).toBe('returned');
  expect(
    secondOutcome,
    'the color theme switch that retargeted the fade did not hand control back once its own wave settled',
  ).toBe('returned');
  expect(
    await runningRootAnimations(page),
    'both color theme switches returned with animations still running on :root',
  ).toEqual([]);
  await expect(
    page.locator('html'),
    'the retargeting switch did not leave its own color theme on the attribute the product owns, so the settled tree is not the one the second call asked for',
  ).toHaveAttribute('data-color-theme', 'dracula');
});
