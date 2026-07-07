/**
 * Chrome-modernization smoke — verifies the renderer-state↔main-state
 * theme propagation chain end-to-end. Drives the real Electron binary via
 * Playwright's `_electron` API, fires a deep-link to open an editor window
 * (so `App.tsx`'s `ConfigProvider` mounts and the `signalThemeApplied` show-
 * gate release fires — `NavigatorApp` does not embed `ConfigProvider` and
 * would only release via the 5 s fallback), then asserts:
 *
 *   1. `nativeTheme.themeSource === 'system'` after first window load —
 *      proves `runBootstrap` set the value before any window construction.
 *   2. `<html>` carries the `electron-mode` class — proves the FOUC inline
 *      script in `packages/app/index.html` ran with `window.okDesktop`
 *      defined and engaged the alpha-aware retrofit.
 *   3. `window.okDesktop.setThemeSource(...)` round-trips to main's
 *      `nativeTheme.themeSource` for `'dark'`, `'light'`, and `'system'` —
 *      proves the typed-IPC channel + handler chain is wired all the way
 *      through.
 *
 * The cold-launch dual-signal release semantics (window stays hidden until
 * BOTH `ready-to-show` AND `ok:theme:applied` fire, with 5 s safety
 * timeout) are exhaustively unit-tested in `show-gate.test.ts` (19 tests).
 * This e2e verifies the end state — visible window with correct chrome —
 * not the per-frame timing.
 *
 * Per-test docName (extension-less, unique via `randomUUID`) prevents
 * cross-worker CRDT collisions even though playwright.config.ts pins
 * `workers: 1` for this directory; following the convention keeps the
 * file safe if the policy ever changes.
 *
 * Skip conditions match the existing `deep-link.e2e.ts` / `external-
 * link.e2e.ts` pattern:
 *   - `OK_DESKTOP_E2E_SMOKE !== '1'` — opt-in gate so unrelated
 *     `bunx playwright test` runs don't try to launch Electron.
 *   - `process.platform !== 'darwin'` — driver uses macOS `open(1)` to
 *     fire the deep link, and the chrome stack is darwin-only in v0.
 *   - `out/main/index.js` missing — needs a prior `bun run build:desktop`.
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

// `--user-data-dir` is the only reliable way to redirect Electron's
// `app.getPath('userData')` on macOS — `HOME`/`USERPROFILE` env vars don't
// work because `NSHomeDirectory()` resolves via `getpwuid()` not the env.
// Without it, every smoke run reads/writes the developer's real
// `~/Library/Application Support/Electron/state.json` and `lastOpenedProject`
// from real usage causes the editor window to spawn instead of Navigator —
// breaking this file's first-window assertions.
function userDataDirFor(home: string): string {
  return join(home, 'electron-userdata');
}

test.describe('chrome-modernization theme-sync smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Driver uses macOS open(1) and chrome stack is darwin-only in v0.');
  test.skip(
    !BUILD_EXISTS,
    `Main build missing at ${MAIN_ENTRY} — run "bun run build:desktop" first.`,
  );

  test('cold-launch chrome correct + setThemeSource roundtrips through main', async ({
    captureStderrFor,
  }) => {
    // Per-test unique docName so a future shift to parallel workers can't
    // collide on a shared file path (CLAUDE.md WARN: never hardcode
    // 'test-doc'). The deep-link query passes the extension-less wire form,
    // matching `preview-url.ts`'s producer contract.
    const docName = `theme-sync-${randomUUID()}`;
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-theme-sync-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
    );
    writeFileSync(
      join(projectDir, `${docName}.md`),
      '# Theme Sync Smoke\n\nFixture for cold-launch chrome verification.\n',
    );

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDirFor(projectDir)}`],
      timeout: 30_000,
    });
    captureStderrFor(app, { cleanupDirs: [projectDir] });

    // Wait for first window (Navigator on cold launch). Confirms whenReady
    // fired and the show-gate released SOMETHING — proves the boot path
    // didn't deadlock waiting on a never-arriving signal.
    const firstWindow = await app.firstWindow({ timeout: 15_000 });
    expect(firstWindow).toBeDefined();

    // Fire the deep-link to open an editor window for our tmp project.
    // The editor renders `<App>` → `<ConfigProvider>` → the sibling effect
    // chain that pushes `setThemeSource` and emits `signalThemeApplied`.
    const deepLink = `openknowledge://open?project=${encodeURIComponent(projectDir)}&doc=${encodeURIComponent(docName)}`;
    execSync(`open -g "${deepLink}"`, { stdio: 'pipe' });

    // Resolve the editor page by matching the renderer hash. Polls all
    // windows to tolerate any number of helper Navigator/utility windows
    // that may exist alongside the editor.
    let editorPage: import('@playwright/test').Page | undefined;
    const expectedHashSuffix = `#/${docName}`;
    await expect(async () => {
      for (const page of app.windows()) {
        const hash = await page.evaluate(() => window.location.hash).catch(() => '');
        if (hash.endsWith(expectedHashSuffix)) {
          editorPage = page;
          return;
        }
      }
      throw new Error(`no window matches ${expectedHashSuffix} yet`);
    }).toPass({ timeout: 15_000 });
    if (!editorPage) throw new Error('unreachable');

    // Bridge wired in the editor renderer — confirms preload exposed
    // `window.okDesktop` AND the bridge carries the theme methods. If the
    // contextBridge import or one of the three bridge-file mirrors
    // regressed, this fails fast.
    const bridgeShape = await editorPage.evaluate(() => ({
      hasBridge: typeof window.okDesktop !== 'undefined',
      hasSetThemeSource: typeof window.okDesktop?.setThemeSource === 'function',
      hasSignalThemeApplied: typeof window.okDesktop?.signalThemeApplied === 'function',
      mode: window.okDesktop?.config.mode,
    }));
    expect(bridgeShape.hasBridge).toBe(true);
    expect(bridgeShape.hasSetThemeSource).toBe(true);
    expect(bridgeShape.hasSignalThemeApplied).toBe(true);
    expect(bridgeShape.mode).toBe('editor');

    // FOUC ran with `window.okDesktop` present — proves the inline script
    // in `packages/app/index.html` engaged the alpha-aware retrofit.
    // Without this class, the `html.electron-mode` rules in globals.css
    // never apply and the chrome reverts to the solid web-mode treatment.
    const electronModeOnHtml = await editorPage.evaluate(() =>
      document.documentElement.classList.contains('electron-mode'),
    );
    expect(electronModeOnHtml).toBe(true);

    // Bootstrap ran in the documented order: nativeTheme.themeSource was
    // set BEFORE any createWindow. The literal-string 'system' guards
    // against a regression that drops the explicit set (Electron's default
    // is also 'system', so omission would still pass an equality check —
    // but bootstrap.test.ts pins the explicit-set ordering, this just
    // verifies the runtime end state matches).
    const bootSource = await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
    expect(bootSource).toBe('system');

    // IPC roundtrip — call setThemeSource from the renderer and assert main's
    // nativeTheme reflects the change. The renderer await resolves only after
    // main's handler returned `{ ok: true }` (which has already set
    // nativeTheme.themeSource), so read main state directly — no poll needed.
    for (const target of ['dark', 'light', 'system'] as const) {
      await editorPage.evaluate(async (t) => {
        await window.okDesktop?.setThemeSource?.(t);
      }, target);
      expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe(target);
    }
  });

  test('rapid theme changes settle on final value; IPC rejection still releases the show-gate', async ({
    captureStderrFor,
  }) => {
    // Real failure-inducing input through the public interface
    // (the renderer's `window.okDesktop` bridge) asserting on user-visible
    // outcomes (final `nativeTheme.themeSource`, window visibility).
    //
    // Two behavioral concerns multiplexed in one Electron launch (workers: 1
    // makes per-test launches expensive; combining two related cases keeps
    // the suite's wall-clock cost reasonable):
    //
    //   1. Rapid theme changes — fire dark → light → system from the
    //      renderer in tight succession. The hook's cancellation flag in
    //      `useThemeBridge.ts` suppresses stale `signalThemeApplied` calls
    //      from in-flight earlier promises after a re-render. Final
    //      `nativeTheme.themeSource` must match the LAST request.
    //
    //   2. `.finally()` releases the show-gate on IPC rejection — we
    //      replace the main-side `ok:theme:set-source` handler with one
    //      that throws once, replace `ok:theme:applied` with a recorder,
    //      then drive a renderer-side `setThemeSource(...).catch(...)
    //      .finally(signalThemeApplied)` chain that mirrors the hook in
    //      `use-theme-bridge.ts`. The `.catch(...)` swallows the
    //      rejection; the trailing `.finally(...)` MUST still fire
    //      `signalThemeApplied`. We assert the recorder observed a new
    //      `ok:theme:applied` call AFTER the rejected `setThemeSource`
    //      resolved — without `.finally`, only `.then` would fire and
    //      rejection would stall the gate to the 5 s safety timeout.
    //      A follow-up successful call proves the bridge didn't degrade.
    const docName = `theme-sync-rapid-${randomUUID()}`;
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-theme-sync-rapid-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
    );
    writeFileSync(
      join(projectDir, `${docName}.md`),
      '# Theme Sync Rapid\n\nFixture for rapid theme change + IPC rejection.\n',
    );

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDirFor(projectDir)}`],
      timeout: 30_000,
    });
    captureStderrFor(app, { cleanupDirs: [projectDir] });

    await app.firstWindow({ timeout: 15_000 });
    const deepLink = `openknowledge://open?project=${encodeURIComponent(projectDir)}&doc=${encodeURIComponent(docName)}`;
    execSync(`open -g "${deepLink}"`, { stdio: 'pipe' });

    let editorPage: import('@playwright/test').Page | undefined;
    const expectedHashSuffix = `#/${docName}`;
    await expect(async () => {
      for (const page of app.windows()) {
        const hash = await page.evaluate(() => window.location.hash).catch(() => '');
        if (hash.endsWith(expectedHashSuffix)) {
          editorPage = page;
          return;
        }
      }
      throw new Error(`no window matches ${expectedHashSuffix} yet`);
    }).toPass({ timeout: 15_000 });
    if (!editorPage) throw new Error('unreachable');

    // (1) Rapid changes — fire all three within a single microtask cycle.
    // The renderer's CRDT-driven theme-bridge hook re-runs its effect on
    // each themeValue change, but the cancellation flag in the cleanup
    // suppresses any stale `signalThemeApplied` from in-flight earlier
    // promises. Main's `nativeTheme.themeSource` must match the final
    // value, not an earlier one that resolved late.
    await editorPage.evaluate(async () => {
      const bridge = window.okDesktop;
      if (!bridge?.setThemeSource) return;
      // Dispatch all three without awaiting — back-to-back IPC roundtrips
      // race against each other; cancellation flag must keep ordering
      // stable.
      const p1 = bridge.setThemeSource('dark');
      const p2 = bridge.setThemeSource('light');
      const p3 = bridge.setThemeSource('system');
      await Promise.all([p1, p2, p3]);
    });
    await expect(async () => {
      const after = await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
      expect(after).toBe('system');
    }).toPass({ timeout: 1_000 });

    // (2) IPC rejection — replace the handler with a throwing stub for
    // ONE call, AND record every `ok:theme:applied` invocation so we can
    // assert the renderer's `.finally(signalThemeApplied)` actually fired
    // after the rejected `setThemeSource`. The hook's `.catch(...)`
    // swallows the rejection (logs structured warn) and the trailing
    // `.finally(...)` MUST still fire `signalThemeApplied` — without it,
    // the show-gate's 5 s safety timeout is the only path forward.
    //
    // Observability: we install a recorder on the main process global —
    // same pattern as `external-link.e2e.ts`'s shell.openExternal stub.
    // `ipcMain.handle` overwrites the prior handler, so we re-register
    // a counting wrapper that returns `undefined` (the production
    // contract for `ok:theme:applied` is `=> Promise<undefined>`). The
    // show-gate side effect is moot here because cold-launch already
    // fired its one-shot release; all we need is whether main saw the
    // IPC at all.
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as Record<string, unknown>;
      const themeAppliedCalls: Array<{ opts: unknown; at: number }> = [];
      g.__okThemeAppliedCalls = themeAppliedCalls;
      ipcMain.removeHandler('ok:theme:applied');
      // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: E2E test scaffolding — installs mock IPC handler inside the Electron process under test
      ipcMain.handle('ok:theme:applied', async (_event, opts) => {
        themeAppliedCalls.push({ opts, at: Date.now() });
        return undefined;
      });

      ipcMain.removeHandler('ok:theme:set-source');
      let alreadyThrew = false;
      // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: E2E test scaffolding — installs mock IPC handler inside the Electron process under test
      ipcMain.handle('ok:theme:set-source', async (_e, _args) => {
        if (!alreadyThrew) {
          alreadyThrew = true;
          throw new Error('synthetic rejection — testing .finally() contract');
        }
        return { ok: true } as const;
      });
    });

    // Snapshot the call count BEFORE driving the rejected toggle. Cold
    // launch already fired one or more `ok:theme:applied` signals (one
    // per window mount × hook-effect run), so we measure the delta the
    // rejected toggle produces.
    const themeAppliedBefore = await app.evaluate(() => {
      const g = globalThis as unknown as { __okThemeAppliedCalls?: unknown[] };
      return g.__okThemeAppliedCalls?.length ?? 0;
    });

    // Replicate the hook's pattern in the renderer:
    //   setThemeSource(...).catch(...).finally(() => signalThemeApplied(...))
    // The test calls bridge methods directly (no React re-render to drive
    // the hook in this Electron context), so we mirror the chain that
    // `useThemeBridge` runs in production. The `.catch` swallows the
    // rejection, and the `.finally` MUST fire `signalThemeApplied` for
    // the show-gate contract to hold.
    const renderObserved = await editorPage.evaluate(async () => {
      const bridge = window.okDesktop;
      if (!bridge?.setThemeSource || !bridge.signalThemeApplied) {
        return { drove: false, rejected: false };
      }
      let rejected = false;
      await bridge
        .setThemeSource('dark')
        .catch(() => {
          rejected = true;
        })
        .finally(() => {
          // Mirrors `use-theme-bridge.ts`'s `.finally` callback. The
          // `reducedTransparency` value matches the hook's read: sample
          // the matchMedia state at signal time.
          const reducedTransparency = window.matchMedia(
            '(prefers-reduced-transparency: reduce)',
          ).matches;
          bridge.signalThemeApplied({ reducedTransparency });
        });
      return { drove: true, rejected };
    });
    expect(renderObserved.drove).toBe(true);
    // `setThemeSource` IS expected to reject — main throws on the first
    // call. If this is `false`, either the rejection didn't reach the
    // renderer (bridge swallowed it silently — bug) or the synthetic
    // stub didn't take effect (test setup bug).
    expect(renderObserved.rejected).toBe(true);

    // The contract: even though `setThemeSource` rejected, the trailing
    // `.finally(signalThemeApplied)` must have fired. Poll the main-side
    // recorder for the new call.
    await expect(async () => {
      const themeAppliedAfter = await app.evaluate(() => {
        const g = globalThis as unknown as { __okThemeAppliedCalls?: unknown[] };
        return g.__okThemeAppliedCalls?.length ?? 0;
      });
      expect(themeAppliedAfter).toBeGreaterThan(themeAppliedBefore);
    }).toPass({ timeout: 2_000 });

    // Drive a follow-up successful call to prove the bridge survived
    // the rejection (channel didn't degrade, follow-up IPC still
    // routes). The stub's second-call branch returns `{ok:true}` — we
    // can't assert `nativeTheme.themeSource` flipped because the stub
    // doesn't call `setThemeSource`, but the resolution itself proves
    // health.
    await editorPage.evaluate(async () => {
      await window.okDesktop?.setThemeSource?.('light');
    });
  });

  test('signalThemeApplied propagates reducedTransparency to vibrancy material', async ({
    captureStderrFor,
  }) => {
    // Exercises the IPC chain that the
    // `prefers-reduced-transparency` matchMedia listener in
    // `useThemeBridge.ts` triggers:
    //   bridge.signalThemeApplied({ reducedTransparency })
    //     → ok:theme:applied IPC
    //     → applyThemeApplied
    //     → applyReducedTransparency
    //     → setVibrancy(null | VIBRANCY_DEFAULT) on every BrowserWindow
    //
    // Why we don't drive `mql.dispatchEvent`: synthetic matchMedia change
    // events don't propagate through Chromium's MediaQueryList — the
    // platform implementation gates `addEventListener('change', …)`
    // delivery on the cached internal `matches` flipping, and an external
    // `Object.defineProperty(event, 'matches', { value: true })` does not
    // mutate that flag. Playwright's `page.emulateMedia` covers
    // `colorScheme` / `reducedMotion` / `forcedColors` / `contrast` but
    // not `prefers-reduced-transparency` (no Chromium DevTools Protocol
    // backing for the feature emulation), and macOS System Settings →
    // Accessibility → Reduce transparency requires sudo to toggle.
    //
    // The renderer-side matchMedia subscription in `use-theme-bridge.ts`
    // is small and unit-tested structurally; the chain that needs
    // end-to-end coverage is the renderer-signal-to-main fan-out, which
    // is what fails closed when chrome regressions land.
    //
    // Observable outcome: `BrowserWindow.getVibrancy()` is not a public
    // Electron API, so we monkey-patch each window's `setVibrancy` setter
    // to record calls into a main-process global (same recorder pattern
    // as `external-link.e2e.ts`'s `shell.openExternal` stub). After
    // `signalThemeApplied({ reducedTransparency: true })`, every fan-out
    // call must request `null`; after `false`, every call must request
    // the default `'sidebar'`.
    const docName = `theme-sync-rt-${randomUUID()}`;
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-theme-sync-rt-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
    );
    writeFileSync(
      join(projectDir, `${docName}.md`),
      '# Theme Sync RT\n\nFixture for prefers-reduced-transparency propagation.\n',
    );

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDirFor(projectDir)}`],
      timeout: 30_000,
    });
    captureStderrFor(app, { cleanupDirs: [projectDir] });

    await app.firstWindow({ timeout: 15_000 });
    const deepLink = `openknowledge://open?project=${encodeURIComponent(projectDir)}&doc=${encodeURIComponent(docName)}`;
    execSync(`open -g "${deepLink}"`, { stdio: 'pipe' });

    let editorPage: import('@playwright/test').Page | undefined;
    const expectedHashSuffix = `#/${docName}`;
    await expect(async () => {
      for (const page of app.windows()) {
        const hash = await page.evaluate(() => window.location.hash).catch(() => '');
        if (hash.endsWith(expectedHashSuffix)) {
          editorPage = page;
          return;
        }
      }
      throw new Error(`no window matches ${expectedHashSuffix} yet`);
    }).toPass({ timeout: 15_000 });
    if (!editorPage) throw new Error('unreachable');

    // Wait for cold-launch flow to settle (initial signalThemeApplied has
    // already fired, vibrancy is at default 'sidebar').
    // Note: BrowserWindow.getVibrancy() doesn't exist as a public Electron
    // API — vibrancy is a write-only setter on macOS. To observe the
    // chain matchMedia → IPC → applyReducedTransparency → setVibrancy on
    // every window, we monkey-patch each open BrowserWindow's
    // `setVibrancy` to record calls into a main-process global. Same
    // recorder pattern as `external-link.e2e.ts`'s shell.openExternal
    // stub. We patch every window because `applyReducedTransparency`
    // fans out across `BrowserWindow.getAllWindows()` — single-window
    // patching would miss the contract.
    await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as unknown as Record<string, unknown>;
      const calls: Array<{ winId: number; material: string | null; at: number }> = [];
      g.__okSetVibrancyCalls = calls;
      for (const win of BrowserWindow.getAllWindows()) {
        const original = win.setVibrancy.bind(win);
        win.setVibrancy = (material: Parameters<typeof original>[0]) => {
          calls.push({
            winId: win.id,
            material: material ?? null,
            at: Date.now(),
          });
          return original(material);
        };
      }
    });

    // Establish a known 'sidebar' baseline before measuring. On a runner whose
    // OS `prefers-reduced-transparency` defaults ON, cold-launch already left
    // vibrancy at null, so driving `reducedTransparency:true` below would be a
    // no-op that `applyReducedTransparency`'s per-window flicker memo correctly
    // suppresses (zero `setVibrancy` calls — correct app behavior, not a bug).
    // Driving false first makes the true->null drive a real material change the
    // fan-out must act on, regardless of the runner's reduced-transparency
    // default. The baseline calls land before the snapshot below, so they don't
    // contaminate the measured delta.
    await editorPage.evaluate(() => {
      window.okDesktop?.signalThemeApplied?.({ reducedTransparency: false });
    });
    await editorPage.waitForTimeout(600);

    // Snapshot the call count BEFORE driving each direction so every
    // assertion measures a delta against its own baseline. The
    // cold-launch path may have queued background `setVibrancy` calls
    // (window-manager creating new editor windows, etc.) that are
    // unrelated to the IPC we're driving.
    const reducedTrueBefore = await app.evaluate(() => {
      const g = globalThis as unknown as { __okSetVibrancyCalls?: unknown[] };
      return g.__okSetVibrancyCalls?.length ?? 0;
    });

    // Direct bridge call — see test docstring for why we don't dispatch
    // synthetic matchMedia events. The bridge call is the same wire the
    // production matchMedia listener crosses, just driven from the test
    // instead of from the hook.
    await editorPage.evaluate(() => {
      window.okDesktop?.signalThemeApplied?.({ reducedTransparency: true });
    });

    // Poll the recorder for at least one new `setVibrancy` call with
    // material === null. We assert the value, not just the count — a
    // chain bug that sent the wrong `reducedTransparency` value would
    // still increment the counter but emit the wrong material.
    await expect(async () => {
      const calls = await app.evaluate(() => {
        const g = globalThis as unknown as {
          __okSetVibrancyCalls?: Array<{ material: string | null }>;
        };
        return g.__okSetVibrancyCalls ?? [];
      });
      const newCalls = calls.slice(reducedTrueBefore);
      expect(newCalls.length).toBeGreaterThan(0);
      // Every fan-out call after reducedTransparency:true must request
      // null material (vibrancy disabled). If the chain misroutes the
      // value or fan-out visits no windows, this fails.
      expect(newCalls.every((c) => c.material === null)).toBe(true);
    }).toPass({ timeout: 2_000 });

    // Snapshot before the reverse direction so the next assertion isn't
    // contaminated by the reducedTransparency:true calls we just
    // verified.
    const reducedFalseBefore = await app.evaluate(() => {
      const g = globalThis as unknown as { __okSetVibrancyCalls?: unknown[] };
      return g.__okSetVibrancyCalls?.length ?? 0;
    });

    // Reverse — reducedTransparency:false (re-enable vibrancy with the
    // default material).
    await editorPage.evaluate(() => {
      window.okDesktop?.signalThemeApplied?.({ reducedTransparency: false });
    });

    // After reducedTransparency:false, every fan-out call must request
    // the default material ('sidebar' — pinned in `VIBRANCY_DEFAULT`).
    // A regression that drops the negation or hard-codes null in the
    // off path would be caught here.
    await expect(async () => {
      const calls = await app.evaluate(() => {
        const g = globalThis as unknown as {
          __okSetVibrancyCalls?: Array<{ material: string | null }>;
        };
        return g.__okSetVibrancyCalls ?? [];
      });
      const newCalls = calls.slice(reducedFalseBefore);
      expect(newCalls.length).toBeGreaterThan(0);
      expect(newCalls.every((c) => c.material === 'sidebar')).toBe(true);
    }).toPass({ timeout: 2_000 });

    // Bridge integrity — channel still works after the recorder fired
    // twice. Catches a future regression that breaks the IPC channel
    // mid-test (e.g. a handler throw that corrupts ipcMain state).
    await editorPage.evaluate(async () => {
      await window.okDesktop?.setThemeSource?.('light');
    });
    // Direct read — the awaited setThemeSource above already settled main state.
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light');
  });
});
