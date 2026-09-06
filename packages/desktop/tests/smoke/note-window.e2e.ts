import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

const DARWIN = process.platform === 'darwin';

interface Seed {
  tmpHome: string;
  userDataDir: string;
  projectDir: string;
}

function seed(prefix: string): Seed {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), `ok-notewin-${prefix}-home-`)));
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), `ok-notewin-${prefix}-proj-`)));
  mkdirSync(join(projectDir, '.ok', 'local'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
  writeFileSync(join(projectDir, 'start.md'), '# Start\n\nSeed document.\n');
  writeFileSync(join(projectDir, 'second.md'), '# Second\n\nAnother document.\n');

  const userDataDir = userDataDirFor(tmpHome);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [
        { path: projectDir, name: 'Note Window Smoke', lastOpenedAt: new Date().toISOString() },
      ],
      lastOpenedProject: projectDir,
      versionPendingInstall: null,
      lastSeenVersion: null,
      lastSuccessfulCheckAt: null,
      stuckHintShown: false,
    }),
  );
  return { tmpHome, userDataDir, projectDir };
}

async function launchApp(s: Seed, opts: { deepLink?: boolean } = {}): Promise<ElectronApplication> {
  const args = [`--user-data-dir=${s.userDataDir}`];
  if (opts.deepLink !== false) {
    args.push(`openknowledge://open?project=${encodeURIComponent(s.projectDir)}&doc=start`);
  }
  return electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args,
      timeout: 30_000,
      env: {
        ...process.env,
        ...homeEnv(s.tmpHome),
        ...(process.platform === 'win32' ? {} : { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }),
        OK_DESKTOP_E2E_SMOKE: '1',
        OK_RECLAIM_DISABLE: '1',
      },
    }),
  );
}

async function findWindowByMode(
  app: ElectronApplication,
  mode: 'editor' | 'note' | 'terminal',
  timeoutMs = 15_000,
): Promise<Page> {
  let page: Page | undefined;
  await expect(async () => {
    for (const p of app.windows()) {
      const m = await p.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
      if (m === mode) {
        page = p;
        return;
      }
    }
    throw new Error(`no ${mode} window yet`);
  }).toPass({ timeout: timeoutMs });
  if (!page) throw new Error(`${mode} window vanished after readiness poll`);
  return page;
}

async function windowCountByMode(
  app: ElectronApplication,
  mode: 'editor' | 'note' | 'terminal',
): Promise<number> {
  let count = 0;
  for (const p of app.windows()) {
    const m = await p.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
    if (m === mode) count += 1;
  }
  return count;
}

async function webContentsIdFor(app: ElectronApplication, page: Page): Promise<number> {
  const win = await app.browserWindow(page);
  return win.evaluate((w: unknown) => (w as { webContents: { id: number } }).webContents.id);
}

async function clickOpenInNewWindow(
  app: ElectronApplication,
  sourceWebContentsId: number,
): Promise<boolean> {
  return app.evaluate(async ({ BrowserWindow, Menu }, expectedSourceId) => {
    const item = Menu.getApplicationMenu()
      ?.items.find((i) => i.label === 'Window')
      ?.submenu?.items.find((i) => i.label === 'Open in New Window');
    if (!item?.enabled) return false;
    const source = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === expectedSourceId,
    );
    if (!source) return false;
    const getFocusedWindow = BrowserWindow.getFocusedWindow;
    Reflect.set(BrowserWindow, 'getFocusedWindow', () => source);
    try {
      item.click();
    } finally {
      Reflect.set(BrowserWindow, 'getFocusedWindow', getFocusedWindow);
    }
    return true;
  }, sourceWebContentsId);
}

function editorBody(page: Page) {
  return page.locator('.ProseMirror[contenteditable="true"]:not(.composer-prosemirror)').first();
}

async function openDocument(page: Page, docName: string): Promise<void> {
  await page.evaluate((name) => {
    window.location.hash = `#/${name}`;
  }, docName);
  await expect(editorBody(page)).toContainText(docName === 'start' ? 'Start' : 'Second', {
    timeout: 25_000,
  });
}

async function popOutFrom(app: ElectronApplication, source: Page): Promise<void> {
  const sourceId = await webContentsIdFor(app, source);
  await expect(async () => {
    if (!(await clickOpenInNewWindow(app, sourceId))) throw new Error('menu item not enabled yet');
  }).toPass({ timeout: 15_000 });
}

const cleanup: string[] = [];
function track(...paths: string[]): void {
  cleanup.push(...paths);
}

test.describe('Popped-out note window — live Electron', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);
  test.afterEach(() => {
    for (const target of cleanup.splice(0)) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {}
    }
  });

  test('opens one document full-window with attach-mode collab and reduced chrome', async ({
    captureStderrFor,
  }) => {
    const s = seed('open');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const editor = await findWindowByMode(app, 'editor');
    await openDocument(editor, 'start');

    await popOutFrom(app, editor);
    const note = await findWindowByMode(app, 'note');

    expect(await note.evaluate(() => window.okDesktop?.config.collabUrl)).not.toBe('');
    expect(await note.evaluate(() => window.okDesktop?.config.projectPath)).toBe(s.projectDir);

    await expect(editorBody(note)).toBeVisible({ timeout: 15_000 });
    await expect(note.locator('[data-sidebar="trigger"]')).toHaveCount(0);
    await expect(note.locator('[data-editor-tab-scroll]')).toHaveCount(0);
    await expect(note.locator('[data-doc-panel-toggle]')).toHaveCount(0);
    await expect(note.getByRole('button', { name: 'Open agents panel' })).toHaveCount(0);
    await expect(note.getByRole('button', { name: 'Resources' })).toHaveCount(0);
    await expect(note.locator('[data-note-window-mode-toggle]')).toBeVisible();

    const noteWindow = await app.browserWindow(note);
    const titlebar = await note.evaluate(() => {
      const header = document.querySelector('header');
      const current = document.querySelector('[data-slot="breadcrumb-page"][aria-current="page"]');
      const modeToggle = document.querySelector('[data-note-window-mode-toggle]');
      if (!(header instanceof HTMLElement)) throw new Error('note titlebar missing');
      if (!(current instanceof HTMLElement)) throw new Error('current breadcrumb missing');
      if (!(modeToggle instanceof HTMLElement)) throw new Error('mode toggle missing');
      const headerRect = header.getBoundingClientRect();
      const currentRect = current.getBoundingClientRect();
      const toggleRect = modeToggle.getBoundingClientRect();
      return {
        headerHeight: headerRect.height,
        headerCenterY: headerRect.top + headerRect.height / 2,
        breadcrumb: current.textContent,
        breadcrumbCenterY: currentRect.top + currentRect.height / 2,
        toggleCenterY: toggleRect.top + toggleRect.height / 2,
      };
    });
    expect(titlebar.headerHeight).toBe(48);
    expect(titlebar.breadcrumb).toBe('start');
    expect(Math.abs(titlebar.breadcrumbCenterY - titlebar.headerCenterY)).toBeLessThan(1);
    expect(Math.abs(titlebar.toggleCenterY - titlebar.headerCenterY)).toBeLessThan(1);

    expect(
      await noteWindow.evaluate((w: unknown) => (w as { getTitle(): string }).getTitle()),
    ).toContain('start');
  });

  test('conversation and comments actions cross IPC into the owning project window', async ({
    captureStderrFor,
  }) => {
    const s = seed('handoff');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const editor = await findWindowByMode(app, 'editor');
    await openDocument(editor, 'start');

    await popOutFrom(app, editor);
    const note = await findWindowByMode(app, 'note');

    await editor.evaluate(() => {
      const probe = window as unknown as { __noteWindowActiveInput?: unknown };
      window.addEventListener(
        'open-knowledge:active-terminal-input',
        (event) => {
          probe.__noteWindowActiveInput = (event as CustomEvent).detail;
        },
        { once: true },
      );
    });
    expect(
      await note.evaluate(() =>
        window.okDesktop?.noteWindow.dispatchToMain({
          kind: 'active-input',
          text: 'Review this passage',
          newTab: true,
          submit: true,
          target: 'agents',
        }),
      ),
    ).toEqual({ ok: true });
    await expect
      .poll(
        () =>
          editor.evaluate(
            () =>
              (window as unknown as { __noteWindowActiveInput?: unknown }).__noteWindowActiveInput,
          ),
        { timeout: 15_000 },
      )
      .toEqual({
        text: 'Review this passage',
        newTab: true,
        submit: true,
        target: 'agents',
      });

    expect(
      await note.evaluate(() =>
        window.okDesktop?.noteWindow.dispatchToMain({
          kind: 'reveal-comments',
          docName: 'second',
          scope: 'doc',
        }),
      ),
    ).toEqual({ ok: true });
    await expect(editorBody(editor)).toContainText('Second', { timeout: 15_000 });
    await expect(editor.locator('#doc-panel')).toBeVisible({ timeout: 15_000 });
  });

  test('edits cross both live editor UIs in one app instance', async ({ captureStderrFor }) => {
    const s = seed('sync');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const editor = await findWindowByMode(app, 'editor');
    await openDocument(editor, 'start');

    await popOutFrom(app, editor);
    const note = await findWindowByMode(app, 'note');
    await expect(editorBody(note)).toBeVisible({ timeout: 15_000 });

    const fromPopOut = `pop-out-${Date.now()}`;
    await editorBody(note).click();
    await note.keyboard.type(fromPopOut);
    await expect(editorBody(editor)).toContainText(fromPopOut, { timeout: 15_000 });

    const fromMain = `main-${Date.now()}`;
    await editorBody(editor).click();
    await editor.keyboard.type(fromMain);
    await expect(editorBody(note)).toContainText(fromMain, { timeout: 15_000 });
  });

  test('re-popping the same document focuses the existing window', async ({ captureStderrFor }) => {
    const s = seed('dedup');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const editor = await findWindowByMode(app, 'editor');
    await openDocument(editor, 'start');

    await popOutFrom(app, editor);
    await findWindowByMode(app, 'note');
    await popOutFrom(app, editor);

    await expect.poll(() => windowCountByMode(app, 'note'), { timeout: 15_000 }).toBe(1);
  });

  test('New Terminal Window from a focused pop-out inherits its project', async ({
    captureStderrFor,
  }) => {
    test.skip(!DARWIN, 'node-pty is excluded from Windows and Linux packages.');
    const s = seed('menu');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const editor = await findWindowByMode(app, 'editor');
    await openDocument(editor, 'start');

    await popOutFrom(app, editor);
    const note = await findWindowByMode(app, 'note');
    const noteId = await webContentsIdFor(app, note);

    const clicked = await app.evaluate(async ({ BrowserWindow, Menu }, expectedSourceId) => {
      const item = Menu.getApplicationMenu()
        ?.items.find((i) => i.label === 'Terminal')
        ?.submenu?.items.find((i) => i.label === 'New Terminal Window');
      if (!item) return false;
      const source = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === expectedSourceId,
      );
      if (!source) return false;
      const getFocusedWindow = BrowserWindow.getFocusedWindow;
      Reflect.set(BrowserWindow, 'getFocusedWindow', () => source);
      try {
        item.click();
      } finally {
        Reflect.set(BrowserWindow, 'getFocusedWindow', getFocusedWindow);
      }
      return true;
    }, noteId);
    expect(clicked).toBe(true);

    const term = await findWindowByMode(app, 'terminal');
    expect(await term.evaluate(() => window.okDesktop?.config.projectPath)).toBe(s.projectDir);
  });

  test('closing the project window closes its pop-outs, leaving no orphan', async ({
    captureStderrFor,
  }) => {
    const s = seed('cascade');
    track(s.tmpHome, s.projectDir);
    const app = await launchApp(s);
    captureStderrFor(app, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });
    const editor = await findWindowByMode(app, 'editor');
    await openDocument(editor, 'start');

    await popOutFrom(app, editor);
    await findWindowByMode(app, 'note');

    const editorId = await webContentsIdFor(app, editor);
    await app.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.getAllWindows()
        .find((candidate) => candidate.webContents.id === id)
        ?.close();
    }, editorId);

    await expect.poll(() => windowCountByMode(app, 'note'), { timeout: 15_000 }).toBe(0);
  });

  test('a pop-out returns after quit and relaunch, attached and on its document', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(200_000);
    const s = seed('restore');
    track(s.tmpHome, s.projectDir);

    const first = await launchApp(s);
    captureStderrFor(first, { home: s.tmpHome, cleanupDirs: [] });
    const editor = await findWindowByMode(first, 'editor');
    await openDocument(editor, 'start');
    await popOutFrom(first, editor);
    await findWindowByMode(first, 'note');
    await first.close();

    const second = await launchApp(s, { deepLink: false });
    captureStderrFor(second, { home: s.tmpHome, cleanupDirs: [s.tmpHome, s.projectDir] });

    const restored = await findWindowByMode(second, 'note', 30_000);
    expect(await restored.evaluate(() => window.okDesktop?.config.projectPath)).toBe(s.projectDir);
    expect(await restored.evaluate(() => window.okDesktop?.config.collabUrl)).not.toBe('');
    await expect(editorBody(restored)).toBeVisible({ timeout: 20_000 });
  });
});
