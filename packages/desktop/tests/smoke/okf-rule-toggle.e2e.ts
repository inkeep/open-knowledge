import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);

const RULE = 'no-wiki-links';
const TOGGLE = `settings-okf-rule-toggle-${RULE}`;

test.describe('okf per-rule toggle round-trip', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Deep-link project open is macOS-only in v0.');
  test.skip(!BUILD_EXISTS, `Main build missing at ${MAIN_ENTRY} — run "pnpm run build:desktop".`);

  test('a rule switched off can be switched back on, and config records only the deviation', async ({
    captureStderrFor,
  }) => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'ok-okf-toggle-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-okf-toggle-'));
    const configPath = join(projectDir, '.ok', 'config.yml');
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(
      configPath,
      "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\ncontentRules:\n  okf:\n    enabled: true\n",
    );
    writeFileSync(join(projectDir, 'note.md'), '# Note\n\nA [[WikiLink]] to flag.\n');

    const userDataDir = join(tmpHome, 'electron-userdata');
    mkdirSync(userDataDir, { recursive: true });
    const deepLink = `openknowledge://open?project=${encodeURIComponent(projectDir)}&doc=note`;

    const app = await electron.launch({
      args: [MAIN_ENTRY, deepLink, `--user-data-dir=${userDataDir}`],
      timeout: 30_000,
    });
    captureStderrFor(app, { home: tmpHome, cleanupDirs: [projectDir, tmpHome] });
    await app.firstWindow({ timeout: 15_000 });

    const settingsPage = await (async () => {
      for (let i = 0; i < 60; i++) {
        for (const page of app.windows()) {
          const hash = await page.evaluate(() => window.location.hash).catch(() => '');
          if (hash.includes('note')) return page;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('project window never mounted from the argv deep-link');
    })();

    await settingsPage.getByTestId('header-settings-button').click({ timeout: 15_000 });
    await settingsPage.getByTestId('settings-sidebar-item-plugin:okf').click({ timeout: 15_000 });

    const toggle = settingsPage.getByTestId(TOGGLE);
    await expect(toggle).toBeVisible({ timeout: 15_000 });

    expect(await toggle.getAttribute('aria-checked')).toBe('true');
    expect(readFileSync(configPath, 'utf8')).not.toContain(RULE);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 10_000 });
    await expect(async () => {
      expect(readFileSync(configPath, 'utf8')).toMatch(new RegExp(`${RULE}:\\s*false`));
    }).toPass({ timeout: 15_000 });

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
    await expect(async () => {
      expect(readFileSync(configPath, 'utf8')).not.toMatch(new RegExp(`${RULE}:\\s*false`));
    }).toPass({ timeout: 15_000 });

    expect(readFileSync(configPath, 'utf8')).toMatch(/enabled:\s*true/);
  });
});
