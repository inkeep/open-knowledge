/**
 * QA smoke: the OKF per-rule toggle round-trip, driven through the real settings
 * pane in a live Electron instance.
 *
 * This exists because the bug it covers was invisible to a payload-shaped test.
 * The pane originally re-enabled a rule by omitting its key from the map it sent;
 * a DOM test asserting "the payload was `{rules: {}}`" passed, while the config
 * walker treats an absent key as "leave alone" and only deletes on an explicit
 * `null` — so a rule switched off could never be switched back on. Only driving
 * the real pane and then reading the resulting `.ok/config.yml` catches that.
 *
 * Runs against its own tmp project and userData dir, so it never collides with a
 * developer's running app.
 */

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

/** The rule the round-trip drives. Any registered id would do. */
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
    // Plugin already enabled so the panel is reachable from the sidebar; no
    // `rules` block, which is the shape a user has before touching a switch.
    writeFileSync(
      configPath,
      "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\ncontentRules:\n  okf:\n    enabled: true\n",
    );
    writeFileSync(join(projectDir, 'note.md'), '# Note\n\nA [[WikiLink]] to flag.\n');

    // Open the project by passing the deep-link as ARGV, not via `open(1)`:
    // macOS Launch Services binds the `openknowledge://` scheme to the
    // REGISTERED bundle (a developer's installed app), so shelling out to
    // `open` would drive the wrong process entirely. Argv delivery routes
    // through the same second-instance URL parsing without leaving this
    // `_electron.launch()` instance. The state.json restore path is avoided
    // deliberately — under a git worktree it intermittently loses the forked
    // server (Yjs double-instance) and the project never mounts.
    const userDataDir = join(tmpHome, 'electron-userdata');
    mkdirSync(userDataDir, { recursive: true });
    const deepLink = `openknowledge://open?project=${encodeURIComponent(projectDir)}&doc=note`;

    const app = await electron.launch({
      args: [MAIN_ENTRY, deepLink, `--user-data-dir=${userDataDir}`],
      timeout: 30_000,
    });
    captureStderrFor(app, { cleanupDirs: [projectDir, tmpHome] });
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
    // The sidebar only lists a plugin's panel while that plugin is enabled,
    // which the seeded config guarantees.
    await settingsPage.getByTestId('settings-sidebar-item-plugin:okf').click({ timeout: 15_000 });

    const toggle = settingsPage.getByTestId(TOGGLE);
    await expect(toggle).toBeVisible({ timeout: 15_000 });

    // Baseline: absent from config means enabled.
    expect(await toggle.getAttribute('aria-checked')).toBe('true');
    expect(readFileSync(configPath, 'utf8')).not.toContain(RULE);

    // Off — the deviation is recorded.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 10_000 });
    await expect(async () => {
      expect(readFileSync(configPath, 'utf8')).toMatch(new RegExp(`${RULE}:\\s*false`));
    }).toPass({ timeout: 15_000 });

    // Back on — THE REGRESSION. Before the fix the switch stayed off and the
    // `false` never left the file, because the patch omitted the key instead of
    // sending null.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
    await expect(async () => {
      expect(readFileSync(configPath, 'utf8')).not.toMatch(new RegExp(`${RULE}:\\s*false`));
    }).toPass({ timeout: 15_000 });

    // The plugin itself is untouched by a per-rule toggle.
    expect(readFileSync(configPath, 'utf8')).toMatch(/enabled:\s*true/);
  });
});
