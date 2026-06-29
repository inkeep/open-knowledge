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

    const firstWindow = await app.firstWindow({ timeout: 15_000 });
    expect(firstWindow).toBeDefined();

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

    const electronModeOnHtml = await editorPage.evaluate(() =>
      document.documentElement.classList.contains('electron-mode'),
    );
    expect(electronModeOnHtml).toBe(true);

    const bootSource = await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
    expect(bootSource).toBe('system');

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

    await editorPage.evaluate(async () => {
      const bridge = window.okDesktop;
      if (!bridge?.setThemeSource) return;
      const p1 = bridge.setThemeSource('dark');
      const p2 = bridge.setThemeSource('light');
      const p3 = bridge.setThemeSource('system');
      await Promise.all([p1, p2, p3]);
    });
    await expect(async () => {
      const after = await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
      expect(after).toBe('system');
    }).toPass({ timeout: 1_000 });

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

    const themeAppliedBefore = await app.evaluate(() => {
      const g = globalThis as unknown as { __okThemeAppliedCalls?: unknown[] };
      return g.__okThemeAppliedCalls?.length ?? 0;
    });

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
          const reducedTransparency = window.matchMedia(
            '(prefers-reduced-transparency: reduce)',
          ).matches;
          bridge.signalThemeApplied({ reducedTransparency });
        });
      return { drove: true, rejected };
    });
    expect(renderObserved.drove).toBe(true);
    expect(renderObserved.rejected).toBe(true);

    await expect(async () => {
      const themeAppliedAfter = await app.evaluate(() => {
        const g = globalThis as unknown as { __okThemeAppliedCalls?: unknown[] };
        return g.__okThemeAppliedCalls?.length ?? 0;
      });
      expect(themeAppliedAfter).toBeGreaterThan(themeAppliedBefore);
    }).toPass({ timeout: 2_000 });

    await editorPage.evaluate(async () => {
      await window.okDesktop?.setThemeSource?.('light');
    });
  });

  test('signalThemeApplied propagates reducedTransparency to vibrancy material', async ({
    captureStderrFor,
  }) => {
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

    await editorPage.evaluate(() => {
      window.okDesktop?.signalThemeApplied?.({ reducedTransparency: false });
    });
    await editorPage.waitForTimeout(600);

    const reducedTrueBefore = await app.evaluate(() => {
      const g = globalThis as unknown as { __okSetVibrancyCalls?: unknown[] };
      return g.__okSetVibrancyCalls?.length ?? 0;
    });

    await editorPage.evaluate(() => {
      window.okDesktop?.signalThemeApplied?.({ reducedTransparency: true });
    });

    await expect(async () => {
      const calls = await app.evaluate(() => {
        const g = globalThis as unknown as {
          __okSetVibrancyCalls?: Array<{ material: string | null }>;
        };
        return g.__okSetVibrancyCalls ?? [];
      });
      const newCalls = calls.slice(reducedTrueBefore);
      expect(newCalls.length).toBeGreaterThan(0);
      expect(newCalls.every((c) => c.material === null)).toBe(true);
    }).toPass({ timeout: 2_000 });

    const reducedFalseBefore = await app.evaluate(() => {
      const g = globalThis as unknown as { __okSetVibrancyCalls?: unknown[] };
      return g.__okSetVibrancyCalls?.length ?? 0;
    });

    await editorPage.evaluate(() => {
      window.okDesktop?.signalThemeApplied?.({ reducedTransparency: false });
    });

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

    await editorPage.evaluate(async () => {
      await window.okDesktop?.setThemeSource?.('light');
    });
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light');
  });
});
