/**
 * Deep-link smoke test — proves that an `openknowledge://` URL arriving
 * after the desktop app is already running (warm-start) routes through the
 * main-process handler → `ok:deep-link` IPC event → renderer hash navigation.
 *
 * **Scope: warm-start only.**
 * `_electron.launch({ args: [url] })` on macOS delivers the URL via
 * `process.argv`, NOT via the `open-url` Apple Event. This means
 * `_electron.launch` args can exercise the `second-instance` argv parsing
 * path but cannot exercise the cold-start Apple Event path. For the
 * Apple-Event path, `execSync('open openknowledge://...')` is the canonical
 * driver because it dispatches through macOS Launch Services just like a
 * real user click. That's what this test uses.
 *
 * True cold-start Apple-Event simulation (launching a not-yet-running app
 * via `open(1)` and asserting the queue-then-flush path delivers the URL)
 * is a deferred gap — it requires a signed/notarized DMG so macOS Launch
 * Services binds the scheme to this specific app bundle, rather than the
 * generic Electron shell.
 *
 * Skip conditions:
 *   - Not on macOS (`process.platform !== 'darwin'`) — the `open` command
 *     is macOS-specific, and the URL-scheme handler is darwin-only in v0.
 *   - Main-process build output missing (`out/main/index.js` absent) — the
 *     app must be built via `bun run build:desktop` before this test runs.
 *     CI runs without a pre-build skip gracefully rather than misreporting.
 *   - `OK_DESKTOP_E2E_SMOKE !== '1'` — gate so `bunx playwright test` on the
 *     entire repo without explicit opt-in doesn't attempt to launch Electron
 *     (which crashes headless CI that lacks a display server).
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');

// Environment gate: opt-in only. Default-off keeps the test harmless on CI.
const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);

// Compute a per-test Electron userData dir under tmpHome. The Chromium
// `--user-data-dir=<path>` switch is the only mechanism that reliably
// isolates `app.getPath('userData')` in dev mode — Electron's default
// resolution reads `NSBundle.mainBundle`'s CFBundleName (which is
// "Electron" when launched via `Electron.app/Contents/MacOS/Electron`,
// regardless of `productName`). Without isolation, every smoke run shares
// the real user's `~/Library/Application Support/Electron/state.json`,
// which accumulates `lastOpenedProject` pointing at deleted tmpdirs and
// produces non-deterministic boot windows.
function userDataDirFor(tmpHome: string): string {
  return join(tmpHome, 'electron-userdata');
}

test.describe('deep-link warm-start smoke (M4 US-009 / AC7)', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Deep-link URL scheme is macOS-only in v0 (D51 NOT NOW).');
  test.skip(
    !BUILD_EXISTS,
    `Main build missing at ${MAIN_ENTRY} — run "bun run build:desktop" first.`,
  );

  // Explicit visibility of the coverage gap — appears in test-run output as
  // a named skip so the missing coverage can't be overlooked when scanning
  // CI logs (signed DMG + Launch Services binding required).
  test.skip('cold-start Apple-Event delivery — deferred until signed DMG enables Launch Services binding', () => {
    // Intentionally empty. Implementation requires:
    //   1. Signed + notarized DMG so macOS Launch Services binds
    //      `openknowledge://` to this bundle instead of the generic
    //      Electron shell.
    //   2. A harness that fires `open openknowledge://...` against a
    //      not-yet-running installed .app (i.e. no `_electron.launch`
    //      pre-boot) and asserts the queue-then-flush path catches the
    //      Apple Event that fires before `whenReady`.
  });

  test('open(1) shell-out post-launch routes extension-less docName to renderer hash', async ({
    captureStderrFor,
  }) => {
    // Regression: smoke must mirror the real MCP producer contract.
    // `preview-url.ts` normalizes docNames via `normalizeDocName` /
    // `docNameFromPath` → extension is stripped before encodeURIComponent.
    // Hardcoding `doc=target.md` here would exercise a path the producer
    // never emits, so a regression that strips / doesn't strip correctly
    // on the producer side would go uncaught. We seed `target.md` on disk
    // (the on-disk form) but fire the deep-link with `doc=target` (the
    // wire form) and assert the renderer hash matches the wire form.
    const tmpHome = mkdtempSync(join(tmpdir(), 'ok-m4-deep-link-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-m4-deep-link-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
    );
    writeFileSync(join(projectDir, 'target.md'), '# Target Doc\n\nDeep-link smoke content.\n');

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDirFor(tmpHome)}`],
      timeout: 30_000,
    });
    captureStderrFor(app, { cleanupDirs: [projectDir, tmpHome] });

    // Wait for the first window to appear — the Navigator spawns at boot in
    // v0 (no prior `lastOpenedProject`). Any window is sufficient for the
    // deep-link test since `open-url` → focus/spawn handles routing.
    const firstWindow = await app.firstWindow({ timeout: 15_000 });
    expect(firstWindow).toBeDefined();

    // Fire the deep-link via `open(1)` — dispatches through macOS Launch
    // Services → Apple Event → the app's `open-url` listener.  `-g` keeps
    // focus off to reduce flake under CI display servers.
    const deepLink = `openknowledge://open?project=${encodeURIComponent(projectDir)}&doc=target`;
    execSync(`open -g "${deepLink}"`, { stdio: 'pipe' });

    // Wait up to 5s for SOME window in the app to have a hash ending in
    // `target` (exact renderer-side form). The install-deep-link-listener
    // writes `#/<encodeURIComponent(doc)>` — no extension, matching the
    // producer. Cross-worker Playwright poll all windows because the main
    // process may have spawned a new window for the project.
    await expect(async () => {
      for (const page of app.windows()) {
        const hash = await page.evaluate(() => window.location.hash).catch(() => '');
        if (hash.endsWith('#/target')) return;
      }
      throw new Error('no window has hash matching the extension-less producer form yet');
    }).toPass({ timeout: 15_000 });
  });

  test('open(1) shell-out with nested docName round-trips encoded slash', async ({
    captureStderrFor,
  }) => {
    // Regression for the nested docNames
    // like `notes/meeting` are the common MCP producer shape. Guards
    // against any regression that would re-narrow the `doc` validator or
    // break encodeURIComponent round-tripping through the renderer's
    // hash-route listener.
    const tmpHome = mkdtempSync(join(tmpdir(), 'ok-m4-deep-link-nested-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-m4-deep-link-nested-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
    );
    mkdirSync(join(projectDir, 'notes'), { recursive: true });
    writeFileSync(
      join(projectDir, 'notes', 'meeting.md'),
      '# Meeting Notes\n\nNested doc smoke.\n',
    );

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDirFor(tmpHome)}`],
      timeout: 30_000,
    });
    captureStderrFor(app, { cleanupDirs: [projectDir, tmpHome] });

    const firstWindow = await app.firstWindow({ timeout: 15_000 });
    expect(firstWindow).toBeDefined();

    // Nested docName — `/` encoded as `%2F` on the wire. Matches what
    // `preview-url.ts` emits via `encodeURIComponent(docName)`.
    const deepLink = `openknowledge://open?project=${encodeURIComponent(projectDir)}&doc=notes%2Fmeeting`;
    execSync(`open -g "${deepLink}"`, { stdio: 'pipe' });

    // Renderer encodes via `encodeURIComponent(doc)` before setting hash,
    // so `notes/meeting` → `#/notes%2Fmeeting`. Alternative form `#/notes/meeting`
    // is also acceptable if the install-deep-link-listener ever switches to
    // per-segment encoding; assert either shape to avoid brittle coupling.
    await expect(async () => {
      for (const page of app.windows()) {
        const hash = await page.evaluate(() => window.location.hash).catch(() => '');
        if (hash === '#/notes%2Fmeeting' || hash === '#/notes/meeting') return;
      }
      throw new Error('no window has nested-doc hash yet');
    }).toPass({ timeout: 15_000 });
  });
});
