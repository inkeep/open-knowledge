import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, JSHandle, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { CHROME_BG } from '../../src/main/window-chrome.ts';
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

interface SeededHome {
  tmpHome: string;
  projectDir: string;
}

function seedHomeWithLastOpenedProject(): SeededHome {
  const tmpHome = mkdtempSync(join(tmpdir(), 'ok-window-chrome-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'ok-window-chrome-project-'));
  mkdirSync(join(projectDir, '.ok'), { recursive: true });
  writeFileSync(
    join(projectDir, '.ok', 'config.yml'),
    "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
  );
  const userDataDir = userDataDirFor(tmpHome);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [
        { path: projectDir, name: 'Window Chrome Smoke', lastOpenedAt: new Date().toISOString() },
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
      timeout: 30_000,
      env: {
        ...process.env,
        ...homeEnv(tmpHome),
        OK_DESKTOP_E2E_SMOKE: '1',
      },
    }),
  );
}

async function findEditorWindow(app: ElectronApplication, timeoutMs = 20_000): Promise<Page> {
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
      { timeout: timeoutMs, message: 'editor window did not appear within timeout' },
    )
    .toBe(true);
  for (const page of app.windows()) {
    const mode = await page.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
    if (mode === 'editor') return page;
  }
  throw new Error('editor window vanished between poll resolution and read');
}

test.describe('Windows/Linux window chrome smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(DARWIN, 'macOS composes its own vibrancy/hiddenInset chrome, not this branch.');
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('editor window applies the non-darwin chrome: solid background, overlay controls, hidden menu bar', async ({
    captureStderrFor,
  }) => {
    const { tmpHome, projectDir } = seedHomeWithLastOpenedProject();
    const app = await launchApp(tmpHome);
    captureStderrFor(app, { cleanupDirs: [tmpHome, projectDir] });

    const editor = await findEditorWindow(app);
    const winHandle: JSHandle = await app.browserWindow(editor);

    const isDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);

    const chrome = await winHandle.evaluate((win: unknown) => {
      const w = win as { getBackgroundColor: () => string; isMenuBarAutoHide: () => boolean };
      return { backgroundColor: w.getBackgroundColor(), menuBarAutoHide: w.isMenuBarAutoHide() };
    });

    expect(chrome.backgroundColor.toLowerCase()).toBe(isDark ? CHROME_BG.dark : CHROME_BG.light);
    expect(chrome.menuBarAutoHide).toBe(true);

    const overlay = await editor.evaluate(() => {
      const wco = (navigator as Navigator & { windowControlsOverlay?: { visible: boolean } })
        .windowControlsOverlay;
      return { supported: wco !== undefined, visible: wco?.visible ?? false };
    });
    console.log(`[window-chrome] windowControlsOverlay: ${JSON.stringify(overlay)}`);
    expect(overlay.supported).toBe(true);

    if (process.platform === 'win32') {
      expect(overlay.visible).toBe(true);
    }
  });
});

test.describe('Editor header drag-region smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('keeps the full header canvas draggable and its controls clickable', async ({
    captureStderrFor,
  }) => {
    const { tmpHome, projectDir } = seedHomeWithLastOpenedProject();
    const app = await launchApp(tmpHome);
    captureStderrFor(app, { cleanupDirs: [tmpHome, projectDir] });

    const editor = await findEditorWindow(app);
    const filesToggle = editor
      .locator('[data-editor-header-leading-actions]')
      .locator('[data-sidebar="trigger"]');
    await expect(filesToggle).toBeVisible();
    await filesToggle.click();
    await expect
      .poll(() =>
        editor.evaluate(() =>
          document.querySelector('[data-slot="sidebar"]')?.getAttribute('data-state'),
        ),
      )
      .toBe('collapsed');

    const appRegions = await editor.evaluate(() => {
      const requireElement = (selector: string): HTMLElement => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`Missing drag-region fixture: ${selector}`);
        return element;
      };
      const appRegion = (element: HTMLElement) =>
        getComputedStyle(element).getPropertyValue('-webkit-app-region');
      const appRegionFor = (selector: string) => appRegion(requireElement(selector));
      const precedes = (element: HTMLElement, sibling: HTMLElement) =>
        Boolean(element.compareDocumentPosition(sibling) & Node.DOCUMENT_POSITION_FOLLOWING);

      const tabsHost = requireElement('[data-editor-header-tabs]');
      const paneTabs = requireElement('[data-editor-pane-tabs]');
      const overflowRoot = requireElement('[data-editor-tab-overflow-root]');
      const scrollStrip = requireElement('[data-editor-tab-scroll]');
      const scrollViewport = scrollStrip.parentElement;
      if (!scrollViewport) throw new Error('Missing editor tab scroll viewport');

      const leadingActions = requireElement('[data-editor-header-leading-actions]');
      const shareButton = requireElement('[data-testid="share-button"]');
      const trailingActions = requireElement('[data-editor-header-actions]');
      const leadingActionsRect = leadingActions.getBoundingClientRect();
      const overflowRootRect = overflowRoot.getBoundingClientRect();
      const shareButtonRect = shareButton.getBoundingClientRect();
      const trailingActionsRect = trailingActions.getBoundingClientRect();

      return {
        filesButton: appRegionFor('[data-editor-header-leading-actions] [data-sidebar="trigger"]'),
        headerCanvas: appRegionFor('header[data-electron-drag]'),
        leadingGapIsDraggable:
          overflowRootRect.left > leadingActionsRect.right && appRegion(paneTabs) === 'drag',
        leadingActions: appRegion(leadingActions),
        newTabButton: appRegionFor('[data-testid="editor-new-tab-button"]'),
        overflowRoot: appRegion(overflowRoot),
        paneTabs: appRegion(paneTabs),
        resourcesButton: appRegionFor('[data-editor-header-actions] button:last-of-type'),
        scrollViewport: appRegion(scrollViewport),
        shareButton: appRegion(shareButton),
        shareHasDraggableVerticalGutter:
          shareButtonRect.top > trailingActionsRect.top &&
          shareButtonRect.bottom < trailingActionsRect.bottom &&
          appRegion(trailingActions) === 'drag',
        tabsHost: appRegion(tabsHost),
        tabsPaintBeforeControls:
          precedes(tabsHost, leadingActions) && precedes(tabsHost, trailingActions),
        trailingActions: appRegion(trailingActions),
      };
    });

    expect(appRegions).toEqual({
      filesButton: 'no-drag',
      headerCanvas: 'drag',
      leadingGapIsDraggable: true,
      leadingActions: 'drag',
      newTabButton: 'no-drag',
      overflowRoot: 'drag',
      paneTabs: 'drag',
      resourcesButton: 'no-drag',
      scrollViewport: 'no-drag',
      shareButton: 'no-drag',
      shareHasDraggableVerticalGutter: true,
      tabsHost: 'drag',
      tabsPaintBeforeControls: true,
      trailingActions: 'drag',
    });

    const newTabButton = editor.getByTestId('editor-new-tab-button');
    const newTabPlaceholders = editor.getByTestId('editor-new-tab-placeholder-button');
    const placeholderCountBefore = await newTabPlaceholders.count();
    await newTabButton.click();
    await expect(newTabPlaceholders).toHaveCount(placeholderCountBefore + 1);

    const resourcesButton = editor.getByRole('button', { name: 'Resources' });
    await resourcesButton.click();
    await expect(editor.getByRole('link', { name: 'Docs' })).toBeVisible();
  });
});
