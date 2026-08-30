/**
 * Report-a-bug entry-point smoke — drives the real Electron build through
 * both entry points (Help menu, ⌘K / Ctrl+K command palette) into the shared
 * ReportBugDialog, then through compose → create → review against the real
 * main-process bundling pipeline.
 *
 * This is the live-wire complement to the in-process tiers, which mock at the
 * `window.okDesktop` bridge seam on the renderer side and at injected deps
 * on the main side. Here the whole chain is real: native menu click handler
 * → `ok:menu-action` push → preload bridge → dialog mount, and the dialog's
 * `bugReport.create` invoke → dispatch handler → `collectReportBundle` →
 * zip on disk under the test-isolated `~/.ok/bug-reports/`.
 *
 * The Help-menu drive calls `MenuItem.click()` programmatically via
 * `app.evaluate` — the menu bar is native chrome on every OS, outside any
 * page Playwright can drive. The programmatic click fires the exact handler
 * wired in `menu.ts`, so everything from the click handler down is the
 * production path; only the OS-level mouse event on the menu bar is
 * simulated. The lookup walks every submenu rather than assuming a
 * placement, so the per-platform template shape does not matter.
 *
 * The second spec is the only rung in this repo that can look at real capture
 * pixels. Every tier below it fakes `capturePage()`, so they can pin WHEN the
 * capture fires (while an overlay is still mounted) but never that the overlay
 * is IN the resulting picture. Here two captures are taken from the same
 * window — one with a Radix context menu open, one without — and compared as
 * decoded bitmaps.
 *
 * Two things it deliberately does not claim. It is NOT a regression test for
 * the gate's settle default: a context menu has nothing to dismiss it, so even
 * a gate that waits for every popper shoots at its deadline with the menu still
 * on screen and this spec stays green. Timing belongs to the dialog's dom
 * tier. And it cannot say the difference IS the menu rather than some other
 * repaint — the floor is derived from the menu's own measured footprint to make
 * that the overwhelmingly likely reading, and one human look closes the rest.
 *
 * Send and Reveal stay unexercised here by design: Send needs the intake
 * endpoint (ships separately; absent here), and Reveal opens a real Finder
 * window on the host running the suite.
 *
 * Skip gates mirror consent-dialog.e2e.ts — opt-in via OK_DESKTOP_E2E_SMOKE=1,
 * a supported host platform, and build-must-exist.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import {
  homeEnv,
  PLATFORM_SKIP_REASON,
  PLATFORM_SUPPORTED,
  SMOKE_ENABLED,
} from './_helpers/platform-gate';
import { expect, type SmokeFixtures, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

/**
 * Seed an already-consented project, launch against it, and hand back the
 * editor window once its UI is stable enough to drive.
 *
 * Both specs need their own isolated HOME (the create handler resolves
 * `~/.ok/bug-reports/` per call, so a shared one would let the specs read
 * each other's zips), which is why this boots a fresh app rather than
 * sharing one across the file.
 */
async function bootEditorWindow(
  captureStderrFor: SmokeFixtures['captureStderrFor'],
): Promise<{ app: ElectronApplication; page: Page; tmpHome: string }> {
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

  const app = await electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args: [`--user-data-dir=${userDataDir}`],
      timeout: 30_000,
      env: {
        ...process.env,
        ...homeEnv(tmpHome),
        OK_DESKTOP_E2E_SMOKE: '1',
      },
    }),
  );
  captureStderrFor(app, { cleanupDirs: [tmpHome, projectDir] });

  let editorPage: Page | undefined;
  await expect(async () => {
    for (const page of app.windows()) {
      const mode = await page.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
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
  // (the sidebar toolbar) before driving the menu. Scoped to the toolbar
  // because `name` matches a substring: the empty-state "or create a new
  // file" button also carries "new file" in its accessible name.
  await expect(
    page.getByTestId('sidebar-toolbar').getByRole('button', { name: 'New file' }),
  ).toBeVisible({ timeout: 30_000 });

  return { app, page, tmpHome };
}

/**
 * Fire the Help-menu leaf. This is the launcher-free entry: the click handler
 * reaches `sendMenuAction` with no renderer sender, so the gate underneath
 * captures on the first frame instead of waiting for open poppers to unmount.
 */
async function clickReportBugMenuItem(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const appMenu = Menu.getApplicationMenu();
    for (const top of appMenu?.items ?? []) {
      const item = top.submenu?.items.find((candidate) => candidate.label === 'Report a bug…');
      if (item) {
        item.click();
        return;
      }
    }
    throw new Error('Report a bug… menu item not found in any submenu');
  });
}

/**
 * The captured picture as the renderer received it, or null when main
 * returned none. `handleBugReportCaptureScreenshot` resolves null for a
 * zero-byte capture, and the dialog then renders no screenshot section at
 * all — which is how a host with no readable compositing surface reports
 * itself. Callers turn that null into a skip rather than a failure.
 */
async function readScreenshotPreview(dialog: Locator): Promise<string | null> {
  const img = dialog.getByRole('img', { name: 'Preview of the screenshot' });
  if ((await img.count()) === 0) return null;
  return await img.getAttribute('src');
}

/**
 * A host that composites no readable surface hands `capturePage()` an empty
 * image, so there are never any pixels to compare there. Skip rather than fail
 * — and rather than quietly asserting something weaker under the same test
 * name. Declared as an assertion so the narrowing the skip performs at runtime
 * is visible to the type checker too.
 *
 * Whether the `desktop-smoke` runner is such a host is UNMEASURED. It is a real
 * macOS VM rather than a headless container, so it may well composite — but
 * nobody has read the skip count out of a run. Until someone does, treat this
 * spec as proven on developer machines and UNKNOWN on CI, and do not read the
 * required aggregate as covering the pixel claim. Verified locally on macOS
 * with a display: menu open changes 4.767% of the preview against a 4.893%
 * menu footprint, and a planted negative that dismisses the menu first changes
 * 0.687% and reds.
 */
function skipWhenHostCannotCapture(preview: string | null): asserts preview is string {
  test.skip(
    preview === null,
    'This host composites no readable surface for capturePage(), so main returns an empty image and the dialog offers no screenshot — there are no pixels to compare.',
  );
}

test.describe('Report-a-bug entry points', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('Help menu and palette open the dialog; create lands a zip shown in review', async ({
    captureStderrFor,
  }) => {
    // Inside the body on purpose: the calibration parser reads
    // `test.setTimeout` out of a test's own arrow-function body, so a
    // describe-scope call is invisible to it and the guard silently falls back
    // to the config's looser CI ceiling while Playwright runs the file under
    // this one. `bootEditorWindow` also hides three sequential 30s waits
    // (launch, window poll, toolbar visible) the parser does not trace, so the
    // budget is declared rather than inferred.
    test.setTimeout(140_000);
    const { app, page, tmpHome } = await bootEditorWindow(captureStderrFor);

    // Entry point 1 — Help menu.
    await clickReportBugMenuItem(app);
    const composeDialog = page.getByRole('dialog', { name: 'Report a bug' });
    await expect(composeDialog).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(composeDialog).not.toBeVisible();

    // Entry point 2 — palette → "Report a bug" command. The app registers the
    // opener as a `mod` chord (⌘K on mac, Ctrl+K elsewhere), so the chord this
    // presses has to resolve per-platform the same way.
    await page.keyboard.press('ControlOrMeta+k');
    const paletteRow = page.getByTestId('command-palette-report-bug');
    await expect(paletteRow).toBeVisible({ timeout: 10_000 });
    await paletteRow.click();
    await expect(composeDialog).toBeVisible({ timeout: 10_000 });

    // The include-a-screenshot option is deliberately NOT asserted here: this
    // is the palette path, which holds the capture until the launcher unmounts,
    // and a host whose `capturePage()` returns an empty image offers no
    // screenshot at all. The spec below owns that surface and carries the skip
    // for hosts that cannot composite; this one stays scoped to the entry
    // points + bundle flow.

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

  test('a report filed with a context menu open captures the menu', async ({
    captureStderrFor,
  }) => {
    // Same budget, same reason as the spec above — declared in the body so the
    // calibration guard scores this test against what it actually runs under.
    test.setTimeout(140_000);
    const { app, page } = await bootEditorWindow(captureStderrFor);

    const composeDialog = page.getByRole('dialog', { name: 'Report a bug' });

    // Park the pointer on the row both passes use and never move it again.
    // The gate draws a marker at the last known pointer position, so a fixed
    // pointer makes that marker identical in the two captures and leaves the
    // menu as the difference between them.
    const row = page.getByRole('treeitem', { name: /start\.md/ });
    await expect(row).toBeVisible({ timeout: 15_000 });
    const rowBox = await row.boundingBox();
    if (!rowBox) throw new Error('start.md tree row reported no bounding box');
    const pointerX = rowBox.x + rowBox.width / 2;
    const pointerY = rowBox.y + rowBox.height / 2;
    await page.mouse.move(pointerX, pointerY);

    // Control pass — nothing open but the app itself.
    await clickReportBugMenuItem(app);
    await expect(composeDialog).toBeVisible({ timeout: 10_000 });
    const withoutMenu = await readScreenshotPreview(composeDialog);
    await page.keyboard.press('Escape');
    await expect(composeDialog).not.toBeVisible();

    skipWhenHostCannotCapture(withoutMenu);

    // Second pass — same window, same pointer, context menu open. A native
    // menu click steals no focus from the renderer and dispatches no pointer
    // event, so the menu is still mounted when the gate shoots.
    await page.mouse.click(pointerX, pointerY, { button: 'right' });
    const contextMenu = page
      .getByRole('menu')
      .filter({ has: page.getByRole('menuitem', { name: /rename/i }) });
    await expect(contextMenu).toBeVisible({ timeout: 10_000 });
    const menuBox = await contextMenu.boundingBox();
    if (!menuBox) throw new Error('context menu reported no bounding box');

    await clickReportBugMenuItem(app);
    await expect(composeDialog).toBeVisible({ timeout: 10_000 });
    const withMenu = await readScreenshotPreview(composeDialog);
    // Not a skip: the control pass already proved this host captures, so a
    // second pass that captures nothing is a regression, not an unsupported
    // host. The throw narrows the type as well.
    if (withMenu === null) throw new Error('the second pass captured nothing while the first did');
    expect(withMenu).not.toEqual(withoutMenu);

    // Decode in main, where `nativeImage` lives. Comparing decoded pixels
    // rather than the encoded PNGs is what makes "non-trivial" mean anything:
    // PNG is compressed, so a single changed pixel already rewrites most of
    // the byte stream and any byte-level difference count would read huge.
    const diff = await app.evaluate(
      ({ nativeImage }, images) => {
        const a = nativeImage.createFromDataURL(images.a).toBitmap();
        const b = nativeImage.createFromDataURL(images.b).toBitmap();
        if (a.length !== b.length || a.length === 0) {
          return { comparable: false, changedPixels: 0, totalPixels: 0 };
        }
        let changedPixels = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) changedPixels += 1;
        }
        return { comparable: true, changedPixels, totalPixels: a.length / 4 };
      },
      { a: withoutMenu, b: withMenu },
    );
    expect(diff.comparable, 'the two previews did not decode to comparable bitmaps').toBe(true);

    // Floor derived from the menu's own measured footprint rather than picked:
    // the preview is a downscale of the whole viewport, so the menu covers the
    // same FRACTION of it that it covers of the window. A quarter of that
    // fraction separates the two regimes with margin on both sides — a run
    // with the menu dismissed just before the shot lands under the floor
    // (ambient repaint is the row's own hover/selection state and the caret),
    // while a run with it open changes nearly the menu's whole footprint.
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    const menuFraction = (menuBox.width * menuBox.height) / (viewport.width * viewport.height);
    const changedFraction = diff.changedPixels / diff.totalPixels;
    expect(
      changedFraction,
      `changed ${(changedFraction * 100).toFixed(3)}% of the preview; the menu covers ` +
        `${(menuFraction * 100).toFixed(3)}% of the viewport`,
    ).toBeGreaterThan(menuFraction * 0.25);
  });
});
