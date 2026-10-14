import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, JSHandle, Locator, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { CHROME_BG } from '../../src/main/window-chrome.ts';
import { WINDOW_MIN_SIZE } from '../../src/main/window-min-size.ts';
import { configureDesktopGitRepositories } from '../support/git-fixture.test-helper.ts';
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

const HEADER_SETTLE_FRAMES = 4;

const PROBE_INSET_PX = 4;

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

async function appRegionOfButton(scope: Locator, name: string): Promise<string> {
  return scope
    .getByRole('button', { name, exact: true })
    .evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region'));
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

interface HeaderFitReading {
  headerHeight: number;
  outsideRow: string[];
  outsideWindow: string[];
  overlapping: string[];
  paneControls: string[];
  underWindowControls: string[];
}

function readSettledHeaderFit(frames: number): Promise<HeaderFitReading | null> {
  const read = (): HeaderFitReading | null => {
    const header = document.querySelector<HTMLElement>('header[data-app-header]');
    if (!header) return null;
    const headerRect = header.getBoundingClientRect();
    const isShown = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    const labelOf = (element: Element) =>
      element.getAttribute('aria-label') ??
      element.getAttribute('data-testid') ??
      (element.textContent ?? '').trim().slice(0, 32);
    const controls = [
      ...header.querySelectorAll(
        'button, a[href], [data-slot="badge"], [data-testid$="-badge"], [data-testid="header-pane-divider"]',
      ),
    ]
      .filter(isShown)
      .map((element) => ({
        element,
        label: labelOf(element),
        rect: element.getBoundingClientRect(),
      }));
    const overlapping: string[] = [];
    for (const [index, a] of controls.entries()) {
      for (const b of controls.slice(index + 1)) {
        if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
        const across = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const down = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (across > 0.5 && down > 0.5) overlapping.push(`${a.label} x ${b.label}`);
      }
    }
    const overlay = (
      navigator as Navigator & {
        windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect };
      }
    ).windowControlsOverlay;
    const titlebar = overlay?.visible === true ? overlay.getTitlebarAreaRect() : null;
    return {
      headerHeight: Math.round(headerRect.height),
      outsideRow: controls
        .filter(
          ({ rect }) => rect.top < headerRect.top - 0.5 || rect.bottom > headerRect.bottom + 0.5,
        )
        .map(({ label }) => label),
      outsideWindow: controls
        .filter(({ rect }) => rect.left < -0.5 || rect.right > window.innerWidth + 0.5)
        .map(({ label }) => label),
      overlapping,
      paneControls: [
        ...header.querySelectorAll(
          '[data-testid="header-pane-divider"], [data-testid^="header-pane-button-"]',
        ),
      ]
        .filter(isShown)
        .map((element) => element.getAttribute('data-testid') ?? ''),
      underWindowControls:
        titlebar === null
          ? []
          : controls
              .filter(
                ({ rect }) =>
                  rect.left < titlebar.x - 0.5 || rect.right > titlebar.x + titlebar.width + 0.5,
              )
              .map(({ label }) => label),
    };
  };
  return new Promise((resolve) => {
    const readings = [JSON.stringify(read())];
    const sample = () => {
      readings.push(JSON.stringify(read()));
      if (readings.length > frames) {
        const settled = readings.every((reading) => reading === readings[0]);
        resolve(settled ? read() : null);
        return;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
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
    captureStderrFor(app, { home: tmpHome, cleanupDirs: [tmpHome, projectDir] });

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
      await expect(editor.locator('header[data-app-header]')).toBeVisible();
      const heights = await editor.evaluate(() => {
        const wco = (
          navigator as Navigator & { windowControlsOverlay?: { getTitlebarAreaRect(): DOMRect } }
        ).windowControlsOverlay;
        const header = document.querySelector('header[data-app-header]');
        return {
          titlebarArea: wco?.getTitlebarAreaRect().height ?? null,
          appHeader: header?.getBoundingClientRect().height ?? null,
        };
      });
      expect(heights.titlebarArea).toBe(heights.appHeader);
    }
    await configureDesktopGitRepositories(editor, projectDir);
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
    captureStderrFor(app, { home: tmpHome, cleanupDirs: [tmpHome, projectDir] });

    const editor = await findEditorWindow(app);
    await configureDesktopGitRepositories(editor, projectDir);
    const filesToggle = editor
      .locator('header[data-editor-header] [data-file-list-toggle]')
      .locator('[data-sidebar="trigger"]');
    await expect(filesToggle).toBeVisible();
    await filesToggle.click();
    await expect
      .poll(
        () =>
          editor.evaluate(
            (frames) =>
              new Promise<string>((resolve) => {
                const headerGeometrySignature = () => {
                  const sidebar = document.querySelector('[data-slot="sidebar"]');
                  const toggleZone = document.querySelector('[data-file-list-toggle]');
                  const overflowRoot = document.querySelector('[data-editor-tab-overflow-root]');
                  if (!sidebar || !toggleZone || !overflowRoot) return 'header chrome not mounted';
                  const leading = toggleZone.getBoundingClientRect();
                  const overflow = overflowRoot.getBoundingClientRect();
                  return `${sidebar.getAttribute('data-state')} leadingRight=${leading.right} overflowLeft=${overflow.left} overflowWidth=${overflow.width}`;
                };
                const readings = [headerGeometrySignature()];
                const sample = () => {
                  readings.push(headerGeometrySignature());
                  if (readings.length > frames) {
                    const settled = readings.every((reading) => reading === readings[0]);
                    resolve(
                      settled
                        ? readings[0]
                        : `still moving after ${frames} frames: ${readings[0]} -> ${readings[readings.length - 1]}`,
                    );
                    return;
                  }
                  requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);
              }),
            HEADER_SETTLE_FRAMES,
          ),
        {
          timeout: 5_000,
          message: 'editor header geometry did not settle after the sidebar collapsed',
        },
      )
      .toMatch(/^collapsed /);
    await expect(
      editor
        .locator('header[data-app-header]')
        .getByRole('button', { name: 'Agents', exact: true }),
    ).toBeVisible();

    const appRegions = await editor.evaluate((probeInsetPx) => {
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

      const toggleZone = requireElement('[data-file-list-toggle]');
      const filesTrigger = requireElement('[data-file-list-toggle] [data-sidebar="trigger"]');
      const appHeader = requireElement('header[data-app-header][data-electron-drag]');
      const shareButton = requireElement(
        'header[data-app-header] [data-app-header-trailing] [data-testid="share-button"]',
      );
      const filesTriggerRect = filesTrigger.getBoundingClientRect();
      const overflowRootRect = overflowRoot.getBoundingClientRect();
      const shareButtonRect = shareButton.getBoundingClientRect();
      const appHeaderRect = appHeader.getBoundingClientRect();
      const leadingGapPx = overflowRootRect.left - filesTriggerRect.right;
      const effectiveRegionAt = (x: number, y: number, what: string) => {
        let probeElement = document.elementFromPoint(x, y);
        if (!(probeElement instanceof HTMLElement)) return `${what} covered by no element`;
        while (probeElement instanceof HTMLElement && appRegion(probeElement) === 'none') {
          probeElement = probeElement.parentElement;
        }
        return probeElement instanceof HTMLElement ? appRegion(probeElement) : 'none';
      };
      const probeLeadingGapRegion = () => {
        const measured = `${leadingGapPx.toFixed(2)}px`;
        if (leadingGapPx <= 0) return `tab strip reaches the files toggle (${measured})`;
        if (leadingGapPx <= probeInsetPx) return `leading gap too narrow to probe (${measured})`;
        const probeX = filesTriggerRect.right + Math.min(probeInsetPx, leadingGapPx / 2);
        const probeY = (filesTriggerRect.top + filesTriggerRect.bottom) / 2;
        return effectiveRegionAt(probeX, probeY, 'leading gap');
      };
      const paneDivider = requireElement(
        'header[data-app-header] [data-testid="header-pane-divider"]',
      );
      const paneDividerRect = paneDivider.getBoundingClientRect();
      const probePaneDividerGap = (side: 'before' | 'after') => {
        const neighbour =
          side === 'before'
            ? paneDivider.parentElement?.previousElementSibling
            : paneDivider.nextElementSibling;
        if (!(neighbour instanceof HTMLElement)) return `nothing ${side} the pane divider`;
        const neighbourRect = neighbour.getBoundingClientRect();
        const [left, right] =
          side === 'before' ? [neighbourRect, paneDividerRect] : [paneDividerRect, neighbourRect];
        const gapPx = right.left - left.right;
        if (gapPx <= 0) return `no gap ${side} the pane divider (${gapPx.toFixed(2)}px)`;
        return effectiveRegionAt(
          left.right + gapPx / 2,
          (appHeaderRect.top + appHeaderRect.bottom) / 2,
          `gap ${side} the pane divider`,
        );
      };

      return {
        filesButton: appRegion(filesTrigger),
        headerCanvas: appRegionFor('header[data-editor-header][data-electron-drag]'),
        leadingGapRegion: probeLeadingGapRegion(),
        filesToggleZone: appRegion(toggleZone),
        newTabButton: appRegionFor('[data-testid="editor-new-tab-button"]'),
        overflowRoot: appRegion(overflowRoot),
        paneDivider: effectiveRegionAt(
          (paneDividerRect.left + paneDividerRect.right) / 2,
          (paneDividerRect.top + paneDividerRect.bottom) / 2,
          'pane divider',
        ),
        paneDividerGapAfter: probePaneDividerGap('after'),
        paneDividerGapBefore: probePaneDividerGap('before'),
        paneTabs: appRegion(paneTabs),
        scrollViewport: appRegion(scrollViewport),
        shareButton: appRegion(shareButton),
        shareHasDraggableVerticalGutter:
          shareButtonRect.top > appHeaderRect.top &&
          shareButtonRect.bottom < appHeaderRect.bottom &&
          appRegion(appHeader) === 'drag',
        tabRowHoldsNoShare:
          document.querySelector('header[data-editor-header] [data-testid="share-button"]') ===
          null,
        tabsHost: appRegion(tabsHost),
        toggleLeadsFirstPaneRow:
          paneTabs.contains(toggleZone) && precedes(toggleZone, overflowRoot),
        appHeaderCanvas: appRegion(appHeader),
      };
    }, PROBE_INSET_PX);

    const appHeader = editor.locator('header[data-app-header]');
    const ptyAvailable = await editor.evaluate(
      () => window.okDesktop?.config.ptyAvailable === true,
    );
    const namedButtonRegions = {
      agentsButton: await appRegionOfButton(appHeader, 'Agents'),
      editorButton: await appRegionOfButton(appHeader, 'Editor'),
      resourcesButton: await appRegionOfButton(appHeader, 'Resources'),
      terminalButton: ptyAvailable
        ? await appRegionOfButton(appHeader, 'Terminal')
        : 'no terminal on this host',
    };

    expect({ ...appRegions, ...namedButtonRegions }).toEqual({
      agentsButton: 'no-drag',
      editorButton: 'no-drag',
      filesButton: 'no-drag',
      headerCanvas: 'drag',
      leadingGapRegion: 'drag',
      filesToggleZone: 'drag',
      newTabButton: 'no-drag',
      overflowRoot: 'drag',
      paneDivider: 'drag',
      paneDividerGapAfter: 'drag',
      paneDividerGapBefore: 'drag',
      paneTabs: 'drag',
      resourcesButton: 'no-drag',
      terminalButton: ptyAvailable ? 'no-drag' : 'no terminal on this host',
      scrollViewport: 'no-drag',
      shareButton: 'no-drag',
      shareHasDraggableVerticalGutter: true,
      tabRowHoldsNoShare: true,
      tabsHost: 'drag',
      toggleLeadsFirstPaneRow: true,
      appHeaderCanvas: 'drag',
    });

    const newTabButton = editor.getByTestId('editor-new-tab-button');
    const newTabPlaceholders = editor.getByTestId('editor-new-tab-placeholder-button');
    const placeholderCountBefore = await newTabPlaceholders.count();
    await newTabButton.click();
    await expect(newTabPlaceholders).toHaveCount(placeholderCountBefore + 1);

    const agentsButton = appHeader.getByRole('button', { name: 'Agents', exact: true });
    await expect(agentsButton).toHaveAttribute('aria-pressed', 'false');
    await agentsButton.click();
    await expect(agentsButton).toHaveAttribute('aria-pressed', 'true');

    const resourcesButton = editor.getByRole('button', { name: 'Resources' });
    await resourcesButton.click();
    await expect(editor.getByRole('link', { name: 'Docs' })).toBeVisible();
  });

  test('keeps one 44px row with the divider and pane buttons in view', async ({
    captureStderrFor,
  }) => {
    const { tmpHome, projectDir } = seedHomeWithLastOpenedProject();
    const app = await launchApp(tmpHome);
    captureStderrFor(app, { home: tmpHome, cleanupDirs: [tmpHome, projectDir] });

    const editor = await findEditorWindow(app);
    const appHeader = editor.locator('header[data-app-header]');
    await expect(appHeader.getByRole('button', { name: 'Agents', exact: true })).toBeVisible({
      timeout: 20_000,
    });
    const ptyAvailable = await editor.evaluate(
      () => window.okDesktop?.config.ptyAvailable === true,
    );

    const winHandle: JSHandle = await app.browserWindow(editor);
    await winHandle.evaluate((win: unknown, size) => {
      (win as { setSize: (width: number, height: number, animate: boolean) => void }).setSize(
        size.width,
        size.height,
        false,
      );
    }, WINDOW_MIN_SIZE.EDITOR);
    await expect
      .poll(() => editor.evaluate(() => window.innerWidth), {
        timeout: 10_000,
        message: 'the editor window never narrowed to its minimum width',
      })
      .toBeLessThanOrEqual(WINDOW_MIN_SIZE.EDITOR.width);

    await expect
      .poll(() => editor.evaluate(readSettledHeaderFit, HEADER_SETTLE_FRAMES), {
        timeout: 10_000,
        message: 'the app header did not settle into one clean row at the minimum width',
      })
      .toEqual({
        headerHeight: 44,
        outsideRow: [],
        outsideWindow: [],
        overlapping: [],
        paneControls: [
          'header-pane-divider',
          'header-pane-button-editor',
          'header-pane-button-agents',
          ...(ptyAvailable ? ['header-pane-button-terminal'] : []),
        ],
        underWindowControls: [],
      });

    const widths = await editor.evaluate(() => {
      const overlay = (
        navigator as Navigator & {
          windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect };
        }
      ).windowControlsOverlay;
      const titlebar = overlay?.visible === true ? overlay.getTitlebarAreaRect() : null;
      return {
        innerWidth: window.innerWidth,
        captionWidth: titlebar === null ? null : window.innerWidth - (titlebar.x + titlebar.width),
      };
    });
    console.log(`[window-chrome] minimum-width header: ${JSON.stringify(widths)}`);
  });
});
