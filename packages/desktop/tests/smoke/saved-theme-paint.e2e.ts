/**
 * Real-Electron coverage for user-global saved palettes. The fixture redirects
 * both the app home and Chromium user data, then reads a computed color from a
 * live CSS probe; checking only the theme attribute would not prove cascade.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import {
  homeEnv,
  PLATFORM_SKIP_REASON,
  PLATFORM_SUPPORTED,
  SMOKE_ENABLED,
  userDataDirFor,
} from './_helpers/platform-gate';
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

function seedThemeHome(): SeededThemeHome {
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
  writeFileSync(
    join(okDir, 'global.yml'),
    [
      'appearance:',
      '  theme: system',
      '  colorThemeLight: saved-personal-light',
      '  colorThemeDark: saved-personal-dark',
      '',
    ].join('\n'),
  );
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
    captureStderrFor(app, { cleanupDirs: [tmpHome, projectDir] });
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
});
