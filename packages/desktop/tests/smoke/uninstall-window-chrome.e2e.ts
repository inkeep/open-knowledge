/**
 * The uninstall renderer's design-fidelity smoke — the assertion the whole
 * dedicated-entry migration exists to make true.
 *
 * The screens it replaces were inline `data:text/html` documents, which have
 * no base URL for a relative `@font-face` and shipped a `default-src 'none'`
 * CSP with no `font-src`; the app's Inter silently fell back to the macOS
 * system font. So the load-bearing assertion here is that the font actually
 * LOADED.
 *
 * Two obvious oracles are both worthless here, and a mutation run proved it:
 * `getComputedStyle().fontFamily` reads "Inter Variable, …" straight off the
 * declared stack whether or not anything loaded, and `document.fonts.check()`
 * answers "can text render without waiting for a download", which is TRUE for
 * an undefined family because the fallback is already available — a build with
 * the entry's font import stripped passed a `check()`-based version of this
 * test. Only the `FontFaceSet` entries discriminate: the family must be
 * REGISTERED (an `@font-face` reached this document) and at least one of its
 * faces must have reached `status === 'loaded'` (the file was really fetched).
 *
 * Design tokens are compared against the editor entry's own window in the same
 * launch rather than against a hardcoded value, so the two entries are proven
 * to resolve the same `globals.css`.
 *
 * Skip conditions match the other smokes: `OK_DESKTOP_E2E_SMOKE=1` opt-in,
 * darwin only, and a prior `pnpm run build:desktop`.
 */

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type Page } from '@playwright/test';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);

/** The family `packages/app` loads via `@fontsource-variable/inter`. */
const APP_FONT_FAMILY = 'Inter Variable';

async function findWindowByPath(
  app: import('@playwright/test').ElectronApplication,
  suffix: string,
): Promise<Page> {
  let match: Page | undefined;
  await expect(async () => {
    for (const page of app.windows()) {
      const pathname = await page.evaluate(() => window.location.pathname).catch(() => '');
      if (pathname.endsWith(suffix)) {
        match = page;
        return;
      }
    }
    throw new Error(`no window is at a path ending in ${suffix} yet`);
  }).toPass({ timeout: 20_000 });
  if (!match) throw new Error('unreachable');
  return match;
}

test.describe('uninstall renderer chrome smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'The uninstall flow is darwin-only.');
  test.skip(!BUILD_EXISTS, `Main build missing at ${MAIN_ENTRY} — run "pnpm run build:desktop".`);

  test('loads the app font, the app tokens, and the theme main resolved', async ({
    captureStderrFor,
  }) => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninstall-chrome-'));

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${join(home, 'electron-userdata')}`],
      // `renderer` opens the React uninstall window on its own — no picker, no
      // cleanup, nothing removed. Gated on `!app.isPackaged` in main.
      env: { ...process.env, OK_UNINSTALL_UI_PREVIEW: 'renderer' },
      timeout: 30_000,
    });
    captureStderrFor(app, { cleanupDirs: [home] });

    // Cold launch opens Navigator from `index.html`; the preview opens the
    // uninstall entry alongside it. Both are real `file://` documents off the
    // built bundle. Located by path rather than open order — `firstWindow()`
    // races between the two, and drawing the uninstall window for both halves
    // would make the token comparison below compare a value to itself.
    await app.firstWindow({ timeout: 20_000 });
    const editorWindow = await findWindowByPath(app, '/index.html');
    const uninstallWindow = await findWindowByPath(app, '/uninstall.html');

    // PRIMARY: the font is really loaded, not merely named in the cascade.
    const faceStatuses = await uninstallWindow.evaluate(async (family) => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((face) => face.family.replace(/["']/g, '') === family)
        .map((face) => face.status);
    }, APP_FONT_FAMILY);
    // Registered at all — an empty list is the "no @font-face reached this
    // document" failure, which is what the inline `data:` windows had.
    expect(faceStatuses.length).toBeGreaterThan(0);
    // Really fetched. Only the subsets whose glyphs are actually used load;
    // the rest stay 'unloaded', so one loaded face is the correct bar. A
    // failed fetch (bad base URL, CSP without font-src) lands on 'error'.
    expect(faceStatuses).toContain('loaded');

    // The window's theme is the one MAIN resolved, not an independent OS read
    // by the renderer. Asserted BEFORE the token comparison below, which is
    // itself theme-sensitive (`--primary` differs between light and dark) and
    // would otherwise absorb a theme regression into a confusing colour diff.
    const mainWantsDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
    const rendererIsDark = await uninstallWindow.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(rendererIsDark).toBe(mainWantsDark);

    // The app's design tokens resolve identically in both entries.
    const readPrimary = (page: Page) =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
      );
    const uninstallPrimary = await readPrimary(uninstallWindow);
    expect(uninstallPrimary).not.toBe('');
    expect(uninstallPrimary).toBe(await readPrimary(editorWindow));

    // The entry mounted — a resolved font on a blank page would prove nothing.
    await expect(uninstallWindow.locator('#root')).not.toBeEmpty();
  });
});
