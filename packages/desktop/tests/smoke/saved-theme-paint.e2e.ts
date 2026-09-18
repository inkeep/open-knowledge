import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { stringify } from 'yaml';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import {
  homeEnv,
  PLATFORM_SKIP_REASON,
  PLATFORM_SUPPORTED,
  SMOKE_ENABLED,
  userDataDirFor,
} from './_helpers/platform-gate';
import { openSettingsDialog } from './_helpers/settings-surface';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

const LIGHT_BACKGROUND = '#f1e2d3';
const DARK_BACKGROUND = '#102030';

function savedThemeYaml(name: string, variant: 'light' | 'dark', background: string): string {
  const foreground = variant === 'light' ? '#201810' : '#e8eef4';
  return `system: "base16"
name: "${name}"
variant: "${variant}"
palette:
  base00: "${background}"
  base01: "${variant === 'light' ? '#e7d5c3' : '#182838'}"
  base02: "${variant === 'light' ? '#d8c2ad' : '#304050'}"
  base03: "#657080"
  base04: "#8b96a6"
  base05: "${foreground}"
  base06: "${foreground}"
  base07: "${foreground}"
  base08: "#d24b4b"
  base09: "#d97931"
  base0A: "#c49a21"
  base0B: "#4d9b53"
  base0C: "#329b9b"
  base0D: "#397bd1"
  base0E: "#8756c5"
  base0F: "#a06445"
`;
}

interface SeededThemeHome {
  tmpHome: string;
  projectDir: string;
}

function seedThemeHome(
  appearance: {
    theme?: 'system' | 'light' | 'dark';
    colorThemeLight: string;
    colorThemeDark: string;
  } = {
    theme: 'system',
    colorThemeLight: 'saved-personal-light',
    colorThemeDark: 'saved-personal-dark',
  },
): SeededThemeHome {
  const tmpHome = mkdtempSync(join(tmpdir(), 'ok-saved-theme-paint-home-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'ok-saved-theme-paint-project-'));
  mkdirSync(join(projectDir, '.ok'), { recursive: true });
  writeFileSync(
    join(projectDir, '.ok', 'config.yml'),
    "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
  );
  writeFileSync(join(projectDir, 'paint.md'), '# Saved theme paint\n');

  const okDir = join(tmpHome, '.ok');
  const themesDir = join(okDir, 'themes');
  mkdirSync(themesDir, { recursive: true });
  writeFileSync(join(okDir, 'global.yml'), stringify({ appearance }));
  writeFileSync(
    join(themesDir, 'personal-light.yaml'),
    savedThemeYaml('Personal Light', 'light', LIGHT_BACKGROUND),
  );
  writeFileSync(
    join(themesDir, 'personal-dark.yaml'),
    savedThemeYaml('Personal Dark', 'dark', DARK_BACKGROUND),
  );

  const userDataDir = userDataDirFor(tmpHome);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [
        { path: projectDir, name: 'Saved Theme Paint', lastOpenedAt: new Date().toISOString() },
      ],
      lastOpenedProject: projectDir,
      versionPendingInstall: null,
      lastSeenVersion: null,
      lastSuccessfulCheckAt: null,
      stuckHintShown: false,
    }),
  );

  return { tmpHome, projectDir };
}

async function launchApp(tmpHome: string): Promise<ElectronApplication> {
  return electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args: [`--user-data-dir=${userDataDirFor(tmpHome)}`],
      env: {
        ...process.env,
        ...homeEnv(tmpHome),
        OK_DESKTOP_E2E_SMOKE: '1',
      },
      timeout: 30_000,
    }),
  );
}

async function findEditorWindow(app: ElectronApplication): Promise<Page> {
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          const mode = await page
            .evaluate(() => window.okDesktop?.config?.mode)
            .catch(() => undefined);
          if (mode === 'editor') return true;
        }
        return false;
      },
      { timeout: 20_000, message: 'editor window did not appear within timeout' },
    )
    .toBe(true);

  for (const page of app.windows()) {
    const mode = await page.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
    if (mode === 'editor') return page;
  }
  throw new Error('editor window vanished between poll resolution and read');
}

async function readPaintedBackground(page: Page): Promise<{
  themeId: string | null;
  backgroundColor: string;
}> {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--background)';
    document.body.appendChild(probe);
    try {
      return {
        themeId: document.documentElement.getAttribute('data-color-theme'),
        backgroundColor: getComputedStyle(probe).backgroundColor,
      };
    } finally {
      probe.remove();
    }
  });
}

test.describe('saved theme paint smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('different user-global saved themes paint in light and dark modes', async ({
    captureStderrFor,
  }) => {
    const { tmpHome, projectDir } = seedThemeHome();
    const app = await launchApp(tmpHome);
    captureStderrFor(app, { home: tmpHome, cleanupDirs: [tmpHome, projectDir] });
    const editor = await findEditorWindow(app);

    await editor.emulateMedia({ colorScheme: 'light' });
    await expect
      .poll(() => readPaintedBackground(editor), { timeout: 10_000 })
      .toEqual({
        themeId: 'saved-personal-light',
        backgroundColor: 'rgb(241, 226, 211)',
      });

    await editor.emulateMedia({ colorScheme: 'dark' });
    await expect
      .poll(() => readPaintedBackground(editor), { timeout: 10_000 })
      .toEqual({
        themeId: 'saved-personal-dark',
        backgroundColor: 'rgb(16, 32, 48)',
      });
  });

  test('palette assignments preserve the system slot and Default restores system appearance', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(180_000);
    const { tmpHome, projectDir } = seedThemeHome({
      colorThemeLight: 'default',
      colorThemeDark: 'default',
    });
    const app = await launchApp(tmpHome);
    captureStderrFor(app, { home: tmpHome, cleanupDirs: [tmpHome, projectDir] });
    const editor = await findEditorWindow(app);
    await editor.emulateMedia({ colorScheme: null });
    const systemDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
    const activeSlot = systemDark ? 'dark' : 'light';
    const inactiveSlot = systemDark ? 'light' : 'dark';
    const paletteName = systemDark ? 'Catppuccin Latte' : 'Dracula';
    const paletteId = systemDark ? 'catppuccin-latte' : 'dracula';
    const inactivePaletteName = systemDark ? 'Dracula' : 'Catppuccin Latte';
    const inactivePaletteId = systemDark ? 'dracula' : 'catppuccin-latte';
    const inactivePreference = systemDark ? 'light' : 'dark';

    await openSettingsDialog(editor);
    await editor.getByTestId('settings-sidebar-item-plugin:theme').click();
    await editor
      .getByRole('button', { name: `Use ${paletteName} as the ${activeSlot} theme`, exact: true })
      .click();
    await expect
      .poll(() => editor.locator('html').getAttribute('data-color-theme'))
      .toBe(paletteId);
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe('system');
    await expect
      .poll(() => editor.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
      .toBe(systemDark);

    await editor
      .getByRole('button', {
        name: `Use ${inactivePaletteName} as the ${inactiveSlot} theme`,
        exact: true,
      })
      .click();
    await expect
      .poll(() => editor.locator('html').getAttribute('data-color-theme'))
      .toBe(paletteId);
    await expect
      .poll(() => editor.locator('html').evaluate((root) => root.classList.contains('dark')))
      .toBe(!systemDark);

    const observations: Array<{ palette: string | null; dark: boolean; source: string }> = [];
    for (let index = 0; index < 30; index += 1) {
      observations.push({
        palette: await editor.locator('html').getAttribute('data-color-theme'),
        dark: await editor.locator('html').evaluate((root) => root.classList.contains('dark')),
        source: await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
      });
      await editor.waitForTimeout(100);
    }
    expect(observations).toEqual(
      Array.from({ length: 30 }, () => ({
        palette: paletteId,
        dark: !systemDark,
        source: 'system',
      })),
    );

    await editor.getByTestId('settings-sidebar-item-preferences').click();
    await editor.getByTestId(`theme-picker-${inactivePreference}`).click();
    await expect
      .poll(() => editor.locator('html').getAttribute('data-color-theme'))
      .toBe(inactivePaletteId);
    await expect
      .poll(() => editor.locator('html').evaluate((root) => root.classList.contains('dark')))
      .toBe(systemDark);
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe(inactivePreference);
    await editor.getByTestId('theme-picker-system').click();
    await expect
      .poll(() => editor.locator('html').getAttribute('data-color-theme'))
      .toBe(paletteId);
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe('system');

    await editor.reload();
    await expect
      .poll(() => editor.locator('html').getAttribute('data-color-theme'))
      .toBe(paletteId);
    await expect(editor.getByTestId('settings-dialog')).toBeVisible({ timeout: 20_000 });
    await editor.getByTestId('settings-sidebar-item-plugin:theme').click();
    await editor
      .getByRole('button', { name: `Use Default as the ${activeSlot} theme`, exact: true })
      .click();
    await expect(editor.locator('html')).not.toHaveAttribute('data-color-theme');
    await expect
      .poll(() => editor.locator('html').evaluate((root) => root.classList.contains('dark')))
      .toBe(systemDark);
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe('system');
    await editor
      .getByRole('button', { name: `Use Default as the ${inactiveSlot} theme`, exact: true })
      .click();
    await editor.getByTestId('settings-sidebar-item-preferences').click();
    for (const preference of ['light', 'dark', 'system'] as const) {
      await editor.getByTestId(`theme-picker-${preference}`).click();
      await expect
        .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
        .toBe(preference);
      await expect
        .poll(() => editor.locator('html').evaluate((root) => root.classList.contains('dark')))
        .toBe(preference === 'system' ? systemDark : preference === 'dark');
    }
  });
});
