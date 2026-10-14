import { basename } from 'node:path';
import type { Page } from '@playwright/test';
import {
  acpCatalogBody,
  contrastRatioOf,
  DESKTOP_HEADER_PLATFORM_NAMES,
  DESKTOP_HEADER_PLATFORMS,
  type DesktopHeaderHost,
  expect,
  MAC_WINDOW_BUTTONS_WIDTH_PX,
  MAC_WINDOW_BUTTONS_X_PX,
  openDesktopHeader,
  readContrastPair,
  settledHeaderFit,
  settleFrames,
  test,
  waitForActiveProviderSynced,
  windowControlsOf,
} from './_helpers';

const APP_HEADER_PX = 44;

async function measureShell(page: Page) {
  return await page.evaluate(() => {
    const rectOf = (selector: string) => {
      const el = document.querySelector(selector);
      if (el == null) throw new Error(`measureShell: ${selector} is not in the document`);
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, right: r.right, height: r.height };
    };
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      header: rectOf('header[data-app-header]'),
      shell: rectOf('[data-slot="sidebar-wrapper"]'),
      fileList: rectOf('[data-slot="sidebar-container"]'),
      editorCard: rectOf('[data-slot="pane-card"][data-pane="editor"]'),
      tabRow: rectOf('header[data-editor-header]'),
      filesCover: document.querySelector('[data-files-cover]')
        ? rectOf('[data-files-cover]')
        : null,
    };
  });
}

async function expectHeaderClaimsTheTop(page: Page, filesPresentation: 'cover' | 'none') {
  const m = await measureShell(page);
  expect(m.header).toMatchObject({ top: 0, height: APP_HEADER_PX, right: m.innerWidth });
  expect(m.shell.top).toBe(APP_HEADER_PX);
  expect(m.shell.bottom).toBe(m.innerHeight);
  expect(m.editorCard.top).toBe(APP_HEADER_PX);
  if (filesPresentation === 'none') {
    expect(m.filesCover).toBeNull();
    expect(m.fileList.top).toBe(APP_HEADER_PX);
    expect(m.fileList.bottom).toBe(m.editorCard.bottom);
  } else {
    expect(m.filesCover).toEqual(m.editorCard);
  }
  expect(m.editorCard.bottom).toBeLessThanOrEqual(m.innerHeight);
  expect(m.tabRow.top).toBe(APP_HEADER_PX);
  expect(m.scrollHeight).toBeLessThanOrEqual(m.clientHeight);
}

async function toggleFileList(page: Page) {
  const sidebar = page.locator('[data-slot="sidebar"]').first();
  const before = await sidebar.getAttribute('data-state');
  const filesCover = page.locator('[data-files-cover]');
  if ((await filesCover.count()) > 0) await filesCover.locator('[data-files-back]').click();
  else await page.locator('[data-sidebar="trigger"]').first().click();
  await expect(sidebar).not.toHaveAttribute('data-state', before ?? '');
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/acp/catalog', (route) => route.fulfill({ json: acpCatalogBody([]) }));
});
for (const viewport of [
  { width: 1280, height: 800, filesSteps: ['none', 'none', 'none'] as const },
  { width: 393, height: 852, filesSteps: ['none', 'cover', 'none'] as const },
]) {
  test(`the application header sits above the file list and the tab row at ${viewport.width}x${viewport.height}, with nothing overflowing`, async ({
    page,
    api,
  }) => {
    const name = `app-header-layout-${viewport.width}`;
    await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`/#/${name}`);
    await waitForActiveProviderSynced(page);
    await expect(page.getByRole('banner', { name: 'Application' })).toBeVisible();

    await expectHeaderClaimsTheTop(page, viewport.filesSteps[0]);
    await toggleFileList(page);
    await expectHeaderClaimsTheTop(page, viewport.filesSteps[1]);
    await toggleFileList(page);
    await expectHeaderClaimsTheTop(page, viewport.filesSteps[2]);
  });
}

const TAB_ROW_PX = 44;

test('the file list starts with its project row, which lines up with the 44px tab row', async ({
  page,
  api,
}) => {
  const name = 'app-header-project-row';
  await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/#/${name}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('[data-sidebar-project-row]')).toBeVisible();

  const m = await page.evaluate(() => {
    const rectOf = (selector: string) => {
      const el = document.querySelector(selector);
      if (el == null) throw new Error(`project row probe: ${selector} is not in the document`);
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height };
    };
    return {
      topBars: document.querySelectorAll(
        '[data-slot="sidebar-container"] [data-slot="sidebar-header"]',
      ).length,
      fileListTop: rectOf('[data-slot="sidebar-inner"]').top,
      projectRow: rectOf('[data-sidebar-project-row]'),
      tabRow: rectOf('header[data-editor-header]'),
      paneTabs: rectOf('[data-editor-pane-tabs]'),
    };
  });

  expect(m.topBars).toBe(0);
  expect(m.projectRow.top).toBe(m.fileListTop);
  expect(m.projectRow.height).toBe(TAB_ROW_PX);
  expect(m.tabRow.height).toBe(TAB_ROW_PX);
  expect(m.paneTabs.height).toBe(TAB_ROW_PX);
  expect(Math.abs(m.projectRow.top - m.tabRow.top)).toBeLessThanOrEqual(1);
  expect(m.tabRow.top).toBeGreaterThanOrEqual(APP_HEADER_PX);
});

async function measureTabsAgainstEditorColumn(page: Page) {
  return await page.evaluate(() => {
    const find = (selector: string) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el == null) throw new Error(`tabs probe: ${selector} is not in the document`);
      return el;
    };
    const column = find('[data-editor-workspace-column]').getBoundingClientRect();
    const host = find('[data-editor-header-tabs]').getBoundingClientRect();
    const strips = Array.from(document.querySelectorAll<HTMLElement>('[data-editor-pane-tabs]'));
    const visibleStrip = strips.find((strip) =>
      strip.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
    );
    if (visibleStrip == null) throw new Error('tabs probe: no editor tab strip is visible');
    const toggleElement = visibleStrip.querySelector<HTMLElement>('[data-sidebar="trigger"]');
    const firstTab = visibleStrip.querySelector<HTMLElement>('[data-editor-tab-sortable]');
    if (toggleElement == null || firstTab == null) {
      throw new Error('tabs probe: the visible strip has no Files toggle or tab');
    }
    const toggle = toggleElement.getBoundingClientRect();
    const chat = document.querySelector('[data-agents-panel-mount]')?.getBoundingClientRect();
    const probeX = column.right + 4;
    const hitPastColumn =
      probeX < window.innerWidth
        ? document.elementFromPoint(probeX, host.top + host.height / 2)
        : null;
    return {
      columnLeft: column.left,
      columnRight: column.right,
      columnWidth: column.width,
      property: Number.parseFloat(
        find('[data-editor-area-header]').style.getPropertyValue('--editor-header-tabs-width'),
      ),
      hostRight: host.right,
      stripCount: strips.length,
      tabsPaintPastColumn: hitPastColumn?.closest('[data-editor-header-tabs]') != null,
      toggleRight: toggle.right,
      firstTabLeft: firstTab.getBoundingClientRect().left,
      chatLeft: chat && chat.width > 0 ? chat.left : null,
    };
  });
}

function expectTabsInsideEditorColumn(
  m: Awaited<ReturnType<typeof measureTabsAgainstEditorColumn>>,
) {
  expect(Math.abs(m.property - m.columnWidth)).toBeLessThanOrEqual(1);
  expect(m.hostRight).toBeLessThanOrEqual(m.columnRight + 1);
  expect(m.tabsPaintPastColumn).toBe(false);
  expect(m.firstTabLeft).toBeGreaterThanOrEqual(m.toggleRight);
  if (m.chatLeft !== null) expect(m.hostRight).toBeLessThanOrEqual(m.chatLeft + 1);
}

test('the tabs stop at the editor column edge with the chat panel open and with the editor split', async ({
  page,
  api,
}) => {
  const first = 'app-header-tabs-bound-a';
  const second = 'app-header-tabs-bound-b';
  await api.seedDocs([
    { name: first, markdown: `# ${first}\n\nbody\n` },
    { name: second, markdown: `# ${second}\n\nbody\n` },
  ]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/${first}`);
  await waitForActiveProviderSynced(page);

  const chat = page.locator('[data-agents-panel-mount]');
  const agentsButton = page.getByTestId('header-pane-button-agents');
  await expect(agentsButton).toBeVisible({ timeout: 30_000 });
  if ((await agentsButton.getAttribute('aria-pressed')) !== 'true') await agentsButton.click();
  await expect(agentsButton).toHaveAttribute('aria-pressed', 'true');
  await expect(chat).toBeVisible({ timeout: 30_000 });
  await settleFrames(page);

  const withChat = await measureTabsAgainstEditorColumn(page);
  expect(withChat.chatLeft).not.toBeNull();
  expectTabsInsideEditorColumn(withChat);

  await page
    .locator('[data-editor-pane-focused] [data-editor-pane-tabs]')
    .getByTestId('editor-new-tab-button')
    .click();
  await page
    .locator('[data-slot="sidebar-container"]')
    .getByRole('treeitem', { name: `${second}.md`, exact: true })
    .click();
  await waitForActiveProviderSynced(page);
  const secondTab = page.locator(
    `[data-editor-pane-focused] [data-editor-tab-sortable][data-editor-tab-id="${second}"]`,
  );
  if ((await secondTab.getAttribute('data-preview-tab')) === 'true') {
    await secondTab.click({ button: 'right' });
    await page.getByTestId('editor-tab-context-keep-open').click();
  }
  await secondTab.focus();
  await secondTab.press('Shift+F10');
  await page.getByTestId('editor-tab-context-split-right').click();
  await expect(page.locator('[data-editor-pane-tabs]')).toHaveCount(2);
  await settleFrames(page);

  const split = await measureTabsAgainstEditorColumn(page);
  expect(split.stripCount).toBe(2);
  expectTabsInsideEditorColumn(split);
  await expect(
    page.locator('[data-editor-pane-tabs] [data-sidebar="trigger"]'),
    'only the first pane tab row carries the file list toggle',
  ).toHaveCount(1);

  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(async () => {
    expectTabsInsideEditorColumn(await measureTabsAgainstEditorColumn(page));
  }).toPass({ timeout: 5_000 });
});

test('a connection banner paints below the application header', async ({ page, api }) => {
  const name = 'app-header-layout-banner';
  await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route('**/api/config*', (route) => route.fulfill({ status: 503, body: 'down' }));
  await page.goto(`/#/${name}`);

  const banner = page.getByRole('status').filter({ hasText: 'waiting for collab server' });
  await expect(banner).toBeVisible();
  const header = await page.locator('header[data-app-header]').boundingBox();
  const bannerBox = await banner.boundingBox();
  expect(header?.y).toBe(0);
  expect(bannerBox?.y).toBeGreaterThanOrEqual((header?.y ?? 0) + (header?.height ?? 0));
});

test('the application header takes the shell chrome surface on web and under Electron vibrancy', async ({
  page,
  api,
}) => {
  const name = 'app-header-layout-surface';
  await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
  await page.goto(`/#/${name}`);
  await waitForActiveProviderSynced(page);
  const surfaces = () =>
    page.evaluate(() => {
      const bg = (selector: string) => {
        const el = document.querySelector(selector);
        if (el == null) throw new Error(`surfaces: ${selector} is not in the document`);
        return getComputedStyle(el).backgroundColor;
      };
      return {
        header: bg('header[data-app-header]'),
        shell: bg('[data-slot="sidebar-wrapper"]'),
      };
    });

  const web = await surfaces();
  expect(web.header).toBe(web.shell);

  await page.evaluate(() => document.documentElement.classList.add('electron-mode'));
  const electron = await surfaces();
  expect(electron.header).toBe(electron.shell);
  expect(electron.header).not.toBe(web.header);
});

test('every application header control is hit-testable at its own top edge', async ({
  page,
  api,
}) => {
  const name = 'app-header-layout-hit-test';
  await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/#/${name}`);
  await waitForActiveProviderSynced(page);
  await expect(page.getByRole('banner').getByRole('button', { name: 'Search' })).toBeVisible();

  const probes = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        'header[data-app-header] :is(button:not(:disabled), a[href])',
      ),
    ).map((control) => {
      const rect = control.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 0.5);
      return {
        name: control.getAttribute('aria-label') ?? control.textContent ?? '',
        hitsItself: hit !== null && control.contains(hit),
      };
    }),
  );

  expect(probes.length).toBeGreaterThan(0);
  expect(probes.filter((probe) => !probe.hitsItself)).toEqual([]);
});

test('keyboard focus reaches the application header before the file list and the tabs', async ({
  page,
  api,
}) => {
  const name = 'app-header-layout-tab-order';
  await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/#/${name}`);
  await waitForActiveProviderSynced(page);
  await expect(page.getByRole('banner').getByRole('button', { name: 'Search' })).toBeVisible();

  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  const zones: string[] = [];
  for (let press = 0; press < 40; press += 1) {
    await page.keyboard.press('Tab');
    zones.push(
      await page.evaluate(() => {
        const focused = document.activeElement;
        if (focused == null || focused === document.body) return 'none';
        if (focused.closest('header[data-app-header]')) return 'app-header';
        if (focused.closest('[data-slot="sidebar"]')) return 'file-list';
        if (focused.closest('header[data-editor-header]')) return 'tab-row';
        return 'other';
      }),
    );
    if (zones.includes('file-list') && zones.includes('tab-row')) break;
  }

  const firstHeader = zones.indexOf('app-header');
  const lastHeader = zones.lastIndexOf('app-header');
  expect(firstHeader).toBe(0);
  expect(zones.indexOf('file-list')).toBeGreaterThan(lastHeader);
  expect(zones.indexOf('tab-row')).toBeGreaterThan(lastHeader);
});

async function measureHeaderTracks(page: Page) {
  return await page.evaluate(() => {
    const find = (selector: string) => {
      const el = document.querySelector(selector);
      if (el == null) throw new Error(`measureHeaderTracks: ${selector} is not in the document`);
      return el;
    };
    const header = find('header[data-app-header]').getBoundingClientRect();
    const leading = find('[data-app-header-leading]');
    const trailing = find('[data-app-header-trailing]');
    const switcherElement = find('[data-testid="project-switcher-trigger"]') as HTMLElement;
    const switcher = switcherElement.getBoundingClientRect();
    const name = find('[data-testid="project-switcher-name"]') as HTMLElement;
    const leadingRights = Array.from(leading.children).map((c) => c.getBoundingClientRect().right);
    const trailingLefts = Array.from(trailing.children).map((c) => c.getBoundingClientRect().left);
    return {
      headerCentre: header.left + header.width / 2,
      headerRight: header.right,
      leadingLeft: leading.getBoundingClientRect().left,
      leadingContentRight: Math.max(...leadingRights),
      trailingRight: trailing.getBoundingClientRect().right,
      trailingContentLeft: trailingLefts.length > 0 ? Math.min(...trailingLefts) : header.right,
      switcher: { left: switcher.left, right: switcher.right, width: switcher.width },
      switcherCentre: switcher.left + switcher.width / 2,
      nameTruncated: name.scrollWidth > name.clientWidth,
      nameOverflow: getComputedStyle(name).textOverflow,
      switcherIconsSpill: switcherElement.scrollWidth > switcherElement.clientWidth + 1,
      shareLeft: trailing.querySelector('[data-testid="share-button"]')?.getBoundingClientRect()
        .left,
    };
  });
}

const LONG_PROJECT_NAME =
  'quarterly-planning-archive-with-a-name-far-longer-than-the-header-middle-track';

for (const host of [
  { label: 'a bare leading group', value: {} },
  {
    label: 'the beta tag and a long instance badge',
    value: { channel: 'beta', instanceLabel: 'wt-app-header-centre-check' },
  },
] as const) {
  test(`the project switcher sits at the header's centre with ${host.label}`, async ({
    page,
    api,
    workerServer,
  }) => {
    const name = `app-header-switcher-centre-${host.label.length}`;
    await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await openDesktopHeader(page, workerServer, name, host.value);

    const m = await measureHeaderTracks(page);
    expect(Math.abs(m.switcherCentre - m.headerCentre)).toBeLessThanOrEqual(1);
    expect(m.switcher.left).toBeGreaterThanOrEqual(m.leadingContentRight);
  });
}

test('the header controls sit midway between the window top and the editor panel, clear of the macOS window buttons', async ({
  page,
  api,
  workerServer,
}) => {
  const name = 'app-header-even-spacing';
  await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openDesktopHeader(page, workerServer, name, {});
  const header = page.getByRole('banner', { name: 'Application' });
  const back = header.getByRole('button', { name: 'Back' });
  await expect(back).toBeVisible();
  await settleFrames(page);

  const headerBox = await header.boundingBox();
  const backBox = await back.boundingBox();
  const panelBox = await page.locator('[data-slot="sidebar-inset"]').first().boundingBox();
  const fileListBox = await page.locator('[data-slot="sidebar-inner"]').first().boundingBox();
  const reserve = await page.evaluate(() => {
    const appHeader = document.querySelector('header[data-app-header]');
    if (appHeader == null) throw new Error('even-spacing probe: the application header is missing');
    return Number.parseFloat(
      getComputedStyle(appHeader).getPropertyValue('--ok-titlebar-reserve-left'),
    );
  });
  if (headerBox == null || backBox == null || panelBox == null || fileListBox == null) {
    throw new Error('even-spacing probe: a measured element is not rendered');
  }

  const headerBottom = headerBox.y + headerBox.height;
  const backCentre = backBox.y + backBox.height / 2;
  expect(headerBox).toMatchObject({ y: 0, height: APP_HEADER_PX });
  expect(panelBox.y).toBe(headerBottom);
  expect(fileListBox.y).toBe(headerBottom);
  expect(Math.abs(backCentre - headerBox.y - (panelBox.y - backCentre))).toBeLessThanOrEqual(0.5);
  expect(reserve).toBe(78);
  expect(backBox.x).toBe(reserve + 10);
  expect(backBox.x - (MAC_WINDOW_BUTTONS_X_PX + MAC_WINDOW_BUTTONS_WIDTH_PX)).toBe(12);
});

test('the file list and the header keep the macOS window buttons 16px inset on both edges', async ({
  page,
  api,
  workerServer,
}) => {
  const name = 'app-header-edge-alignment';
  await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openDesktopHeader(page, workerServer, name, {});
  await expect(page.locator('[data-sidebar-project-row]')).toBeVisible();
  await settleFrames(page);

  const m = await page.evaluate(() => {
    const fileListIcon = document.querySelector('[data-sidebar-project-row] svg');
    const trailingControls = document.querySelectorAll('[data-app-header-trailing] :is(button, a)');
    const lastControl = trailingControls[trailingControls.length - 1];
    const lastIcon = lastControl?.querySelector('svg');
    if (fileListIcon == null || lastControl == null || lastIcon == null) {
      throw new Error('edge probe: the file list icon or the last header icon is missing');
    }
    const iconBox = lastIcon.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      fileListIconLeft: fileListIcon.getBoundingClientRect().left,
      lastControl: lastControl.getAttribute('data-testid'),
      lastIconRight: iconBox.right,
      lastIconSize: { width: iconBox.width, height: iconBox.height },
    };
  });

  expect(m.fileListIconLeft).toBe(MAC_WINDOW_BUTTONS_X_PX);
  expect(m.lastControl).toBe('header-pane-button-terminal');
  expect(m.lastIconSize).toEqual({ width: 16, height: 16 });
  expect(m.innerWidth - m.lastIconRight).toBe(MAC_WINDOW_BUTTONS_X_PX);
});

test('with the file list closed, the tab row leaves no room for the macOS window buttons', async ({
  page,
  api,
  workerServer,
}) => {
  const name = 'app-header-tab-row-no-reserve';
  await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openDesktopHeader(page, workerServer, name, {});
  const sidebar = page.locator('[data-slot="sidebar"]').first();
  if ((await sidebar.getAttribute('data-state')) !== 'collapsed') await toggleFileList(page);
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
  await settleFrames(page);

  const m = await page.evaluate(() => {
    const panel = document.querySelector('[data-slot="sidebar-inset"]');
    const toggle = document.querySelector('header[data-editor-header] [data-sidebar="trigger"]');
    if (panel == null || toggle == null) {
      throw new Error('tab row probe: the editor panel or the tab row file list toggle is missing');
    }
    return {
      offset: toggle.getBoundingClientRect().left - panel.getBoundingClientRect().left,
      reserve: Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--ok-titlebar-reserve-left'),
      ),
    };
  });

  expect(m.reserve).toBe(78);
  expect(m.offset).toBeLessThan(MAC_WINDOW_BUTTONS_X_PX);
});

test('a long project name truncates in the middle track without moving either side group', async ({
  page,
  api,
  workerServer,
  context,
}) => {
  const name = 'app-header-switcher-long-name';
  await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openDesktopHeader(page, workerServer, name, { instanceLabel: 'wt-long-name' });
  const short = await measureHeaderTracks(page);

  const longPage = await context.newPage();
  await longPage.setViewportSize({ width: 1280, height: 800 });
  await openDesktopHeader(longPage, workerServer, name, {
    instanceLabel: 'wt-long-name',
    projectName: LONG_PROJECT_NAME,
  });
  const long = await measureHeaderTracks(longPage);

  expect(short.nameTruncated).toBe(false);
  expect(long.nameTruncated).toBe(true);
  expect(long.nameOverflow).toBe('ellipsis');
  expect(long.switcher.width).toBeLessThanOrEqual(240);
  expect(Math.abs(long.switcherCentre - long.headerCentre)).toBeLessThanOrEqual(1);
  expect(long.leadingLeft).toBe(short.leadingLeft);
  expect(long.leadingContentRight).toBe(short.leadingContentRight);
  expect(long.trailingRight).toBe(short.trailingRight);
  expect(long.shareLeft).toBeDefined();
  expect(long.shareLeft).toBe(short.shareLeft);
  await longPage.close();
});

for (const platform of DESKTOP_HEADER_PLATFORMS) {
  test(`on ${DESKTOP_HEADER_PLATFORM_NAMES[platform]} at the narrowest editor window the project switcher gives way instead of running under the leading group, with the BETA and instance badges`, async ({
    page,
    api,
    workerServer,
  }) => {
    const name = `app-header-switcher-narrow-${platform}`;
    await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
    const host: DesktopHeaderHost = {
      platform,
      channel: 'beta',
      instanceLabel: 'wt-a-deliberately-wide-instance-badge',
      projectName: LONG_PROJECT_NAME,
    };
    await page.setViewportSize({ width: 1280, height: 800 });
    await openDesktopHeader(page, workerServer, name, host);
    await page.setViewportSize({ width: 720, height: 600 });

    const fit = await settledHeaderFit(page, windowControlsOf(host));
    expect(fit).toMatchObject({ overlapping: [], underWindowControls: [] });
    const m = await measureHeaderTracks(page);
    expect(m.switcher.left).toBeGreaterThanOrEqual(m.leadingContentRight);
    expect(m.switcher.right).toBeLessThanOrEqual(m.trailingContentLeft);
    expect(m.trailingRight).toBeLessThanOrEqual(m.headerRight);
    expect(m.nameTruncated).toBe(true);

    const header = page.locator('header[data-app-header]');
    const leading = header.locator('[data-app-header-leading]');
    if (platform === 'darwin') {
      await expect(leading.getByTestId('beta-badge')).toBeVisible();
      await expect(leading.getByTestId('instance-badge')).toBeVisible();
      return;
    }
    await expect(leading.getByTestId('beta-badge')).toHaveCount(0);
    await expect(leading.getByTestId('instance-badge')).toHaveCount(0);
    await header.getByTestId('header-overflow-actions-trigger').click();
    const panel = page.locator('[data-header-overflow-actions]');
    await expect(panel.getByTestId('beta-badge')).toBeVisible();
    await expect(panel.getByTestId('instance-badge')).toBeVisible();
  });
}

for (const host of ['web', 'desktop'] as const) {
  test(`on ${host} the editor footer drops the project name and names no branch outside a git repository, with the file list open and closed`, async ({
    page,
    api,
    workerServer,
  }) => {
    const name = `app-header-footer-branch-${host}`;
    await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
    await page.setViewportSize({ width: 1280, height: 800 });
    const projectName =
      host === 'desktop' ? 'footer-branch-project' : basename(workerServer.contentDir);
    if (host === 'desktop') {
      await openDesktopHeader(page, workerServer, name, { projectName });
    } else {
      await page.goto(`/#/${name}`);
      await waitForActiveProviderSynced(page);
    }

    const footer = page.getByRole('region', { name: 'Document statistics' });
    const states: Array<string | null> = [];
    for (let pass = 0; pass < 2; pass += 1) {
      states.push(await page.locator('[data-slot="sidebar"]').first().getAttribute('data-state'));
      await expect(footer).toBeVisible();
      await expect(footer.getByTestId('editor-footer-branch')).toHaveCount(0);
      await expect(footer).not.toContainText(projectName);
      await toggleFileList(page);
    }
    expect(new Set(states)).toEqual(new Set(['expanded', 'collapsed']));
  });
}

for (const host of ['web', 'desktop'] as const) {
  test(`on ${host} the trailing group holds Share, settings, resources, the divider and the pane buttons in that order, and the tab row holds none of them`, async ({
    page,
    api,
    workerServer,
  }) => {
    const name = `app-header-trailing-order-${host}`;
    await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
    await page.setViewportSize({ width: 1280, height: 800 });
    if (host === 'desktop') {
      await openDesktopHeader(page, workerServer, name, {});
    } else {
      await page.goto(`/#/${name}`);
      await waitForActiveProviderSynced(page);
    }

    const trailing = page.locator('header[data-app-header] [data-app-header-trailing]');
    const paneButtons =
      host === 'desktop'
        ? [
            trailing.getByTestId('header-pane-button-agents'),
            trailing.getByTestId('header-pane-button-terminal'),
          ]
        : [trailing.getByTestId('header-pane-button-agents')];
    const controls = [
      trailing.getByTestId('share-button'),
      trailing.getByTestId('header-settings-button'),
      trailing.getByRole('button', { name: 'Resources' }),
      trailing.getByTestId('header-pane-divider'),
      ...paneButtons,
    ];
    const lefts: number[] = [];
    for (const control of controls) {
      await expect(control).toBeVisible();
      lefts.push((await control.boundingBox())?.x ?? Number.NaN);
    }
    expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
    expect(new Set(lefts).size).toBe(lefts.length);
    if (host === 'web')
      await expect(page.getByTestId('header-pane-button-terminal')).toHaveCount(0);

    const tabRow = page.locator('header[data-editor-header]');
    await expect(tabRow.getByTestId('share-button')).toHaveCount(0);
    await expect(tabRow.getByTestId('header-settings-button')).toHaveCount(0);
    await expect(tabRow.getByRole('button', { name: 'Resources' })).toHaveCount(0);
    await expect(tabRow.locator('[data-slot="presence-bar"]')).toHaveCount(0);
    await expect(tabRow.getByTestId('header-overflow-actions-trigger')).toHaveCount(0);
    await expect(tabRow.locator('[data-testid^="header-pane-"]')).toHaveCount(0);
  });
}

test('Share opens the publish dialog from the application header, clear of the header', async ({
  page,
  api,
}) => {
  const name = 'app-header-share-dialog';
  await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/#/${name}`);
  await waitForActiveProviderSynced(page);

  await page.locator('header[data-app-header]').getByTestId('share-button').click();

  const dialog = page.getByRole('dialog', { name: 'Publish to GitHub' });
  await expect(dialog).toBeVisible();
  const reach = await dialog.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 4);
    return {
      top: rect.top,
      bottom: rect.bottom,
      innerHeight: window.innerHeight,
      topEdgeIsDialog: hit !== null && el.contains(hit),
    };
  });
  expect(reach.top).toBeGreaterThanOrEqual(0);
  expect(reach.bottom).toBeLessThanOrEqual(reach.innerHeight);
  expect(reach.topEdgeIsDialog).toBe(true);
});

test('narrowing the window never runs the trailing group into the project switcher; it collapses first, then comes back', async ({
  page,
  api,
  workerServer,
}) => {
  const name = 'app-header-trailing-collapse';
  await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openDesktopHeader(page, workerServer, name, {});
  const header = page.locator('header[data-app-header]');
  const trigger = header.getByTestId('header-overflow-actions-trigger');
  await expect(trigger).toHaveCount(0);

  let collapsedAt: number | null = null;
  for (let width = 1280; width >= 240; width -= 20) {
    await page.setViewportSize({ width, height: 800 });
    await settleFrames(page);
    const m = await measureHeaderTracks(page);
    expect(
      m.switcher.left,
      `${width}px: switcher starts inside the leading group`,
    ).toBeGreaterThanOrEqual(m.leadingContentRight - 0.5);
    expect(
      m.switcher.right,
      `${width}px: switcher runs into the trailing group`,
    ).toBeLessThanOrEqual(m.trailingContentLeft + 0.5);
    expect(m.switcherIconsSpill, `${width}px: switcher squeezed below its icons`).toBe(false);
    await expect(header.getByTestId('header-pane-divider')).toBeVisible();
    await expect(header.getByTestId('header-pane-button-agents')).toBeVisible();
    await expect(header.getByTestId('header-pane-button-terminal')).toBeVisible();
    if ((await trigger.count()) > 0) {
      collapsedAt = width;
      break;
    }
  }
  expect(collapsedAt, 'the trailing group never collapsed down to 240px').not.toBeNull();

  for (const control of ['Back', 'Forward', 'Search']) {
    await expect(
      header.locator('[data-app-header-leading]').getByRole('button', { name: control }),
    ).toBeVisible();
  }
  await expect(header.getByTestId('share-button')).toHaveCount(0);
  await expect(header.getByTestId('header-settings-button')).toHaveCount(0);

  await trigger.click();
  const panel = page.locator('[data-header-overflow-actions]');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('share-button')).toBeVisible();
  await expect(panel.getByTestId('header-settings-button')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Resources' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Search' })).toHaveCount(0);
  await expect(panel.locator('[data-testid^="header-pane-"]')).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(trigger).toHaveCount(0);
  await expect(panel).toHaveCount(0);
  const trailing = header.locator('[data-app-header-trailing]');
  await expect(trailing.getByTestId('share-button')).toBeVisible();
  await expect(trailing.getByTestId('header-settings-button')).toBeVisible();
  await expect(trailing.getByRole('button', { name: 'Resources' })).toBeVisible();
});

test('on the web, narrowing from 1280px to 240px keeps the divider and the Agents button in the one-row header, outside More actions and clear of every other control', async ({
  page,
  api,
}) => {
  const name = 'app-header-web-sweep';
  await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/#/${name}`);
  await waitForActiveProviderSynced(page);
  const header = page.locator('header[data-app-header]');
  const trigger = header.getByTestId('header-overflow-actions-trigger');
  const panel = page.locator('[data-header-overflow-actions]');
  await expect(header.getByTestId('header-pane-button-agents')).toBeVisible();
  await expect(trigger).toHaveCount(0);

  const foldedWidths: number[] = [];
  for (let width = 1280; width >= 240; width -= 20) {
    await page.setViewportSize({ width, height: 800 });
    const fit = await settledHeaderFit(page, null);
    expect(fit, `${width}px`).toMatchObject({
      top: 0,
      height: APP_HEADER_PX,
      outsideRow: [],
      overlapping: [],
    });
    await expect(header.getByTestId('header-pane-divider')).toBeVisible();
    await expect(header.getByTestId('header-pane-button-agents')).toBeVisible();
    await expect(page.getByTestId('header-pane-button-terminal')).toHaveCount(0);
    if ((await trigger.count()) === 0) continue;

    foldedWidths.push(width);
    await trigger.click();
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('share-button')).toBeVisible();
    await expect(panel.locator('[data-testid^="header-pane-"]')).toHaveCount(0);
    await trigger.click();
    await expect(panel).toHaveCount(0);
  }
  expect(foldedWidths, 'the header never folded on the way down to 240px').toContain(240);
  expect(foldedWidths.length, 'the sweep stopped at the first fold').toBeGreaterThan(1);
});

test('a presence avatar joining the trailing group leaves the project switcher at the header centre', async ({
  page,
  api,
  workerServer,
}) => {
  const name = 'app-header-presence-centre';
  await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openDesktopHeader(page, workerServer, name, {});
  const before = await measureHeaderTracks(page);

  await api.writeAsAgent(name, `# ${name}\n\nan agent was here\n`, {
    agentId: `app-header-centre-probe-${Date.now()}`,
    agentName: 'Centre Probe',
    clientName: 'claude-code',
  });
  await expect(
    page.locator('header[data-app-header] [data-app-header-trailing] [data-slot="presence-bar"]'),
  ).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await measureHeaderTracks(page)).trailingContentLeft, { timeout: 30_000 })
    .toBeLessThan(before.trailingContentLeft);
  await settleFrames(page);
  const after = await measureHeaderTracks(page);

  expect(after.trailingContentLeft).toBeLessThan(before.trailingContentLeft);
  expect(Math.abs(before.switcherCentre - before.headerCentre)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.switcherCentre - after.headerCentre)).toBeLessThanOrEqual(1);
});

const WINDOW_BUTTONS = {
  darwin: 'the macOS window buttons',
  win32: 'the Windows caption buttons',
  linux: 'the Linux window controls',
} as const;

for (const platform of DESKTOP_HEADER_PLATFORMS) {
  for (const dir of ['ltr', 'rtl'] as const) {
    test(`in a ${dir} interface no header control sits under ${WINDOW_BUTTONS[platform]}`, async ({
      page,
      api,
      workerServer,
    }) => {
      const name = `app-header-window-buttons-${platform}-${dir}`;
      await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
      await page.setViewportSize({ width: 1280, height: 800 });
      const host: DesktopHeaderHost = {
        platform,
        channel: 'beta',
        instanceLabel: 'wt-window-buttons',
      };
      await openDesktopHeader(page, workerServer, name, host);
      await page.evaluate((direction) => {
        document.documentElement.dir = direction;
      }, dir);
      await expect(page.locator('html')).toHaveAttribute('dir', dir);

      const fit = await settledHeaderFit(page, windowControlsOf(host));
      expect(fit.controls).toBeGreaterThan(0);
      expect(fit.underWindowControls).toEqual([]);
    });
  }
}

test('on the web the header names the open project in its centre track', async ({ page, api }) => {
  const name = 'app-header-web-project-name';
  await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/#/${name}`);
  await expect(page.locator('header[data-app-header]')).toBeVisible();

  const label = page.getByTestId('web-project-name');
  await expect(label).toBeVisible();
  expect((await label.textContent())?.trim().length).toBeGreaterThan(0);

  const centred = await page.evaluate(() => {
    const header = document.querySelector('header[data-app-header]');
    const el = document.querySelector('[data-testid="web-project-name"]');
    if (!header || !el) throw new Error('web project name probe: missing header or label');
    const h = header.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return {
      offsetFromCentre: Math.abs((r.left + r.right) / 2 - (h.left + h.right) / 2),
      insideHeader: r.top >= h.top && r.bottom <= h.bottom,
    };
  });

  expect(centred.insideHeader).toBe(true);
  expect(centred.offsetFromCentre).toBeLessThanOrEqual(1);

  const header = page.locator('header[data-app-header]');
  const nameText = page.getByTestId('web-project-name-label');
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect
      .poll(async () => contrastRatioOf(await readContrastPair(nameText, header)), {
        message: `the project name against the ${colorScheme} header`,
      })
      .toBeGreaterThanOrEqual(4.5);
  }
});

test('back, forward and search live only in the header, across collapsing and reopening the file list', async ({
  page,
  api,
  workerServer,
}) => {
  const name = 'app-header-nav-single-home';
  await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openDesktopHeader(page, workerServer, name, {});

  const appHeader = page.locator('header[data-app-header]');
  const fileList = page.locator('[data-slot="sidebar-container"]');
  const tabRow = page.locator('header[data-editor-header]');
  const named = (name: string) => ({ name, exact: true }) as const;

  const expectControlsInHeaderOnly = async () => {
    await expect(appHeader.getByRole('button', named('Back'))).toHaveCount(1);
    await expect(appHeader.getByRole('button', named('Forward'))).toHaveCount(1);
    await expect(appHeader.getByRole('button', named('Search'))).toHaveCount(1);
    await expect(page.getByRole('button', named('Back'))).toHaveCount(1);
    await expect(page.getByRole('button', named('Forward'))).toHaveCount(1);
    await expect(page.getByRole('button', { name: /^Search/ })).toHaveCount(1);
    await expect(fileList.getByRole('button', named('Back'))).toHaveCount(0);
    await expect(tabRow.getByRole('button', named('Back'))).toHaveCount(0);
    await expect(tabRow.getByRole('button', { name: /^Search/ })).toHaveCount(0);
  };

  const controlRects = async () => {
    const rects: Record<string, { x: number; y: number }> = {};
    for (const label of ['Back', 'Forward', 'Search']) {
      const box = await appHeader.getByRole('button', named(label)).boundingBox();
      expect(box, `${label} must be on screen to compare its position`).not.toBeNull();
      rects[label] = { x: box?.x ?? -1, y: box?.y ?? -1 };
    }
    return rects;
  };

  await expectControlsInHeaderOnly();
  const seated = await controlRects();

  const toggle = page.locator('[data-sidebar="trigger"]');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await settleFrames(page);
  await expectControlsInHeaderOnly();
  expect(await controlRects(), 'closing the file list moved a header control').toEqual(seated);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await settleFrames(page);
  await expectControlsInHeaderOnly();
  expect(await controlRects(), 'reopening the file list moved a header control').toEqual(seated);
});
