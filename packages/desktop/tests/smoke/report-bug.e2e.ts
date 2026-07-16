/**
 * Report-a-bug entry-point smoke — drives the real Electron build through
 * both entry points (Help menu, ⌘K command palette) into the shared
 * ReportBugDialog, then through compose → create → review against the real
 * main-process bundling pipeline.
 *
 * This is the live-wire complement to the bun tiers, which mock at the
 * `window.okDesktop` bridge seam on the renderer side and at injected deps
 * on the main side. Here the whole chain is real: native menu click handler
 * → `ok:menu-action` push → preload bridge → dialog mount, and the dialog's
 * `bugReport.create` invoke → dispatch handler → `collectReportBundle` →
 * zip on disk under the test-isolated `~/.ok/bug-reports/`.
 *
 * The Help-menu drive calls `MenuItem.click()` programmatically via
 * `app.evaluate` — Playwright cannot click native macOS menu chrome. The
 * programmatic click fires the exact handler wired in `menu.ts`, so
 * everything from the click handler down is the production path; only the
 * OS-level mouse event on the native menu bar is simulated.
 *
 * Send and Reveal stay unexercised here by design: Send needs the intake
 * endpoint (ships separately; absent here), and Reveal opens a real Finder
 * window on the host running the suite.
 *
 * Skip gates mirror consent-dialog.e2e.ts — opt-in via OK_DESKTOP_E2E_SMOKE=1,
 * darwin-only, and build-must-exist.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);

test.describe('Report-a-bug entry points', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Smoke harness is darwin-only.');
  test.skip(
    !BUILD_EXISTS,
    `Main build missing at ${MAIN_ENTRY} — run "bun run build:desktop" first.`,
  );

  test('Help menu and palette open the dialog; create lands a zip shown in review', async ({
    captureStderrFor,
  }) => {
    // Isolated HOME: the create handler writes to `~/.ok/bug-reports/` via a
    // call-time homedir() lookup, so launching with HOME pointed at a tmpdir
    // keeps the real `~/.ok` untouched. Realpath per the consent-dialog
    // precedent (macOS tmpdir() is a symlink into /private/var/folders).
    const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), 'ok-report-bug-home-')));
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-report-bug-project-')));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
    writeFileSync(join(projectDir, 'start.md'), '# Start\n\nSeed document.\n');

    // Already-consented project restored via lastOpenedProject → the app
    // boots straight into an editor window (no Navigator/consent detour).
    const userDataDir = join(tmpHome, 'electron-userdata');
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(
      join(userDataDir, 'state.json'),
      JSON.stringify({
        recentProjects: [
          { path: projectDir, name: 'Report Bug Smoke', lastOpenedAt: new Date().toISOString() },
        ],
        lastOpenedProject: projectDir,
        versionPendingInstall: null,
        lastSeenVersion: null,
        lastSuccessfulCheckAt: null,
        stuckHintShown: false,
      }),
    );

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: tmpHome,
        OK_DESKTOP_E2E_SMOKE: '1',
      },
    });
    captureStderrFor(app, { cleanupDirs: [tmpHome, projectDir] });

    let editorPage: Page | undefined;
    await expect(async () => {
      for (const page of app.windows()) {
        const mode = await page
          .evaluate(() => window.okDesktop?.config?.mode)
          .catch(() => undefined);
        if (mode === 'editor') {
          editorPage = page;
          return;
        }
      }
      throw new Error('editor window not ready yet');
    }).toPass({ timeout: 30_000 });
    if (!editorPage) throw new Error('editor window vanished after readiness poll');
    const page = editorPage;

    // App-mounted gate: menu actions delivered before the renderer attaches
    // its onMenuAction subscription are dropped, so wait for stable App UI
    // (the sidebar toolbar) before driving the menu.
    await expect(page.getByRole('button', { name: 'New file' })).toBeVisible({ timeout: 30_000 });

    // Entry point 1 — Help menu. Label lookup walks every top-level submenu
    // rather than assuming the Help menu's resolved label/role shape.
    await app.evaluate(({ Menu }) => {
      const appMenu = Menu.getApplicationMenu();
      for (const top of appMenu?.items ?? []) {
        const item = top.submenu?.items.find((candidate) => candidate.label === 'Report a Bug…');
        if (item) {
          item.click();
          return;
        }
      }
      throw new Error('Report a Bug… menu item not found in any submenu');
    });
    const composeDialog = page.getByRole('dialog', { name: 'Report a bug' });
    await expect(composeDialog).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(composeDialog).not.toBeVisible();

    // Entry point 2 — ⌘K palette → "Report a bug" command.
    await page.keyboard.press('Meta+k');
    const paletteRow = page.getByTestId('command-palette-report-bug');
    await expect(paletteRow).toBeVisible({ timeout: 10_000 });
    await paletteRow.click();
    await expect(composeDialog).toBeVisible({ timeout: 10_000 });

    // The include-a-screenshot option is deliberately NOT asserted here:
    // `webContents.capturePage()` returns an empty image on the headless CI
    // runner (the window is never composited to a readable surface), so the
    // gate offers no screenshot and the checkbox/preview never appear. That
    // path is covered where it can run deterministically — the bun unit tier
    // (byte-identical staging at `extra/screenshot.png`) and the app DOM tier
    // (preview, default-on checkbox, opt-out, launcher-wait) — with mocked
    // capture. This smoke test stays scoped to the entry points + bundle flow.

    // Compose → create. The note rides into the bundle; typing it here
    // exercises the same field the crash variants relabel.
    await composeDialog
      .getByRole('textbox', { name: /What happened/ })
      .fill('Report-a-bug smoke note');
    await composeDialog.getByRole('button', { name: 'Create report' }).click();

    // Review: the dialog title flips per phase, and the card shows the
    // exact produced zip. Bundle creation runs the real capture pipeline,
    // so give it the generous end of the poll budget.
    const reviewDialog = page.getByRole('dialog', { name: 'Review your report' });
    await expect(reviewDialog).toBeVisible({ timeout: 30_000 });
    await expect(reviewDialog.getByText(/secrets redacted/)).toBeVisible();
    await expect(reviewDialog.getByRole('button', { name: 'Send report' })).toBeVisible();

    // The zip landed in the isolated home and the review card names it.
    const reportsDir = join(tmpHome, '.ok', 'bug-reports');
    const zips = readdirSync(reportsDir).filter((name) => name.endsWith('.zip'));
    expect(zips).toHaveLength(1);
    const zipName = zips[0];
    expect(zipName).toMatch(/-bugreport\.zip$/);
    const zipPath = join(reportsDir, zipName);
    expect(statSync(zipPath).size).toBeGreaterThan(0);
    await expect(reviewDialog.getByTitle(zipName)).toBeVisible();
  });
});
