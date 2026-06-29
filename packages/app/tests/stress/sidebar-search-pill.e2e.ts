import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;

const pill = (page: Page) => page.locator('[data-telemetry-event="ok.sidebar.search_pill.click"]');
const cmdkRoot = (page: Page) => page.locator('[cmdk-root]');
const cmdkInput = (page: Page) => page.locator('[data-slot="command-input"]');
const sidebarHeader = (page: Page) => page.locator('[data-slot="sidebar-header"]');

async function deletePathIfExists(baseURL: string, kind: 'file' | 'folder', path: string) {
  const response = await fetch(`${baseURL}/api/delete-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, path }),
  });
  if (response.ok || response.status === 404) return;
  throw new Error(`delete-path failed for ${kind}:${path}: ${response.status}`);
}

async function clearVisibleContentEntries(baseURL: string, contentDir: string) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const entry of fs.readdirSync(contentDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      await deletePathIfExists(baseURL, 'folder', entry.name);
      continue;
    }
    const docPath = entry.name.replace(/\.(md|mdx)$/i, '');
    if (docPath !== entry.name) {
      await deletePathIfExists(baseURL, 'file', docPath);
      continue;
    }
    fs.rmSync(path.join(contentDir, entry.name), { recursive: true, force: true });
  }
}

async function restoreRequiredFixtureEntries({
  api,
  baseURL,
}: {
  api: { createPage(path: string): Promise<void> };
  baseURL: string;
}) {
  const folderResponse = await fetch(`${baseURL}/api/create-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'sidebar-folder' }),
  });
  if (!folderResponse.ok && folderResponse.status !== 409) {
    throw new Error(
      `create-folder failed while restoring sidebar-folder: ${folderResponse.status}`,
    );
  }

  await api.createPage('test-doc.md');
  await api.createPage('sidebar-folder/nested-doc.md');
  await expect
    .poll(async () => {
      const response = await fetch(`${baseURL}/api/documents`);
      const body = (await response.json()) as {
        documents?: Array<{ docName?: string; kind?: string; path?: string }>;
      };
      const documents = body.documents ?? [];
      return (
        documents.some((entry) => entry.kind === 'folder' && entry.path === 'sidebar-folder') &&
        documents.some((entry) => entry.kind === 'document' && entry.docName === 'test-doc')
      );
    })
    .toBe(true);
}

test.describe('sidebar-search-pill — discovery, click, keyboard, semantics', () => {
  test('pill renders above FileTree on initial sidebar load with the locked telemetry attribute', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'q001', markdown: '# q001\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/q001');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    await expect(pill(page)).toBeVisible();

    const childCount = await pill(page).evaluate((el) => ({
      hasSvg: !!el.querySelector('svg'),
      hasKbd: !!el.querySelector('kbd'),
      hasLabelSpan: Array.from(el.querySelectorAll('span')).some(
        (sp) => sp.textContent === 'Search',
      ),
    }));
    expect(childCount.hasSvg).toBe(true);
    expect(childCount.hasKbd).toBe(true);
    expect(childCount.hasLabelSpan).toBe(true);

    await expect(pill(page)).toHaveAttribute(
      'data-telemetry-event',
      'ok.sidebar.search_pill.click',
    );
  });

  test('clicking the pill opens the CommandPalette and focuses its input', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'q002', markdown: '# q002\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/q002');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    await expect(cmdkRoot(page)).toHaveCount(0);

    await pill(page).click();
    await expect(cmdkRoot(page)).toBeVisible({ timeout: 2_000 });
    await expect(cmdkInput(page)).toBeFocused();
  });

  test('⌘K / Ctrl+K (platform-aware) opens CommandPalette (regression guard for the global keydown listener)', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'q003', markdown: '# q003\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/q003');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    await page.keyboard.press('ControlOrMeta+k');
    await expect(cmdkRoot(page)).toBeVisible({ timeout: 2_000 });
  });

  test('clicking pill while CommandPalette is OPEN is a no-op (mirrors the legacy icon, NOT a toggle)', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'q004', markdown: '# q004\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/q004');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    await pill(page).click();
    await expect(cmdkRoot(page)).toBeVisible({ timeout: 2_000 });

    await page.evaluate(() => {
      const btn = document.querySelector(
        'button[data-telemetry-event="ok.sidebar.search_pill.click"]',
      );
      if (!(btn instanceof HTMLElement)) {
        throw new Error('pill button not found in DOM');
      }
      btn.click();
    });

    await expect
      .poll(
        async () => ({
          visible: await cmdkRoot(page).isVisible(),
          focused: await cmdkInput(page).evaluate((el) => el === document.activeElement),
        }),
        { intervals: [50, 50, 50, 50], timeout: 500 },
      )
      .toEqual({ visible: true, focused: true });
  });

  test('⌘K while CommandPalette is OPEN closes it (preserves divergent toggle semantics vs. pill click)', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'q005', markdown: '# q005\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/q005');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    await page.keyboard.press('ControlOrMeta+k');
    await expect(cmdkRoot(page)).toBeVisible({ timeout: 2_000 });

    await page.keyboard.press('ControlOrMeta+k');
    await expect(cmdkRoot(page)).toBeHidden({ timeout: 2_000 });
  });

  test('legacy Search ToolbarButton is gone from SidebarHeader (no two redundant entry points)', async ({
    page,
    api,
    workerServer,
  }) => {
    await api.seedDocs([{ name: 'q006', markdown: '# q006\n\nBody.' }]);
    const folderRes = await fetch(`${workerServer.baseURL}/api/create-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'sidebar-folder' }),
    });
    if (!folderRes.ok && folderRes.status !== 409) {
      throw new Error(`create-folder failed: ${folderRes.status}`);
    }
    const templateRes = await fetch(`${workerServer.baseURL}/api/template`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: '',
        name: 'q006-template',
        frontmatter: { title: 'Q006 template' },
        body: 'Template body',
      }),
    });
    if (!templateRes.ok) {
      throw new Error(`PUT /api/template failed: ${templateRes.status}`);
    }
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/q006');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    await expect(page.getByRole('button', { name: 'Tree view options' })).toBeVisible({
      timeout: 15_000,
    });

    const searchInsideHeader = sidebarHeader(page).getByRole('button', { name: 'Search' });
    await expect(searchInsideHeader).toHaveCount(0);

    await expect(
      sidebarHeader(page).getByRole('button', { name: 'Tree view options' }),
    ).toBeVisible();
    await expect(sidebarHeader(page).getByRole('button', { name: 'New file' })).toBeVisible();
    await expect(
      sidebarHeader(page).getByRole('button', { name: 'New from template' }),
    ).toBeVisible();
    await expect(sidebarHeader(page).getByRole('button', { name: 'New folder' })).toBeVisible();
  });

  test('pill has accessible name "Search" with no aria-label override; lucide icon is aria-hidden', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'q007', markdown: '# q007\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/q007');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    const matchingPills = page.getByRole('button', { name: /^Search/ });
    await expect(matchingPills).toHaveCount(1);

    const ariaLabel = await pill(page).getAttribute('aria-label');
    expect(ariaLabel).toBeNull();

    const labelText = await pill(page).locator('span', { hasText: 'Search' }).first().textContent();
    expect(labelText?.trim()).toBe('Search');

    const svgAriaHidden = await pill(page).locator('svg').first().getAttribute('aria-hidden');
    expect(svgAriaHidden).toBe('true');

    const accessibleName = await pill(page).evaluate((el) => {
      const clone = el.cloneNode(true) as HTMLElement;
      for (const n of clone.querySelectorAll('[aria-hidden="true"]')) {
        n.remove();
      }
      return (clone.textContent || '').trim();
    });
    expect(accessibleName).toMatch(/^Search/);
  });

  test('compositional journey — discovery → click → query → result selection navigates to the matching doc', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'aa', markdown: '# aa\n\nThe queue manager handles items.' },
      { name: 'bb', markdown: '# bb\n\nUnrelated body.' },
    ]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/bb');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    await pill(page).click();
    await expect(cmdkRoot(page)).toBeVisible({ timeout: 2_000 });
    await expect(cmdkInput(page)).toBeFocused();

    await page.keyboard.type('queue');

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              document.querySelectorAll(
                '[data-slot="command-list"] [data-testid^="command-palette-nav-"]',
              ).length,
          ),
        { timeout: 10_000, intervals: [50, 100, 200] },
      )
      .toBeGreaterThanOrEqual(1);

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(cmdkRoot(page)).toBeHidden({ timeout: 2_000 });

    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/aa');
  });
});

test.describe('sidebar-search-pill — visual anatomy and layout', () => {
  test('pill border-radius is rounded-lg (~10px) — NOT rounded-full, NOT rounded-md', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'q009', markdown: '# q009\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/q009');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    const styles = await pill(page).evaluate((el) => {
      const cs = window.getComputedStyle(el as HTMLElement);
      return {
        borderRadius: cs.borderRadius,
        radiusTopLeft: cs.borderTopLeftRadius,
        radiusTopRight: cs.borderTopRightRadius,
      };
    });

    const r = Number.parseFloat(styles.radiusTopLeft);
    expect(r).toBeGreaterThanOrEqual(7);
    expect(r).toBeLessThanOrEqual(12);
  });

  test('kbd hint adapts to platform — Mac shows ⌘ K, non-Mac shows Ctrl K', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'q010', markdown: '# q010\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/q010');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    const isMac = await page.evaluate(() => navigator.userAgent.includes('Mac'));
    const kbdText = await pill(page).locator('kbd').textContent();

    if (isMac) {
      expect(kbdText).toBe('⌘ K');
    } else {
      expect(kbdText).toBe('Ctrl K');
    }
  });

  test('visual anatomy — DOM order is svg → label-span → kbd; LTR positions; ~36px tall; full-width', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'q011', markdown: '# q011\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/q011');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    const layout = await pill(page).evaluate((el) => {
      const button = el as HTMLElement;
      const rect = button.getBoundingClientRect();
      const svg = button.querySelector('svg');
      const span = button.querySelector('span');
      const kbd = button.querySelector('kbd');
      if (!svg || !span || !kbd) {
        return { ok: false as const };
      }
      const svgRect = svg.getBoundingClientRect();
      const spanRect = span.getBoundingClientRect();
      const kbdRect = kbd.getBoundingClientRect();
      const svgBeforeSpan =
        (svg.compareDocumentPosition(span) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      const spanBeforeKbd =
        (span.compareDocumentPosition(kbd) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      return {
        ok: true as const,
        height: rect.height,
        width: rect.width,
        svgRight: svgRect.right,
        spanLeft: spanRect.left,
        spanRight: spanRect.right,
        kbdLeft: kbdRect.left,
        svgBeforeSpan,
        spanBeforeKbd,
      };
    });
    if (!layout.ok) throw new Error('pill structural children missing');

    expect(layout.svgBeforeSpan).toBe(true);
    expect(layout.spanBeforeKbd).toBe(true);
    expect(layout.svgRight).toBeLessThanOrEqual(layout.spanLeft + 1);
    expect(layout.spanRight).toBeLessThanOrEqual(layout.kbdLeft + 1);
    expect(layout.height).toBeGreaterThanOrEqual(34);
    expect(layout.height).toBeLessThanOrEqual(40);
    expect(layout.width).toBeGreaterThan(200);
  });

  test('desktop viewport (≥1280px) renders the pill cleanly within sidebar bounds', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'q012', markdown: '# q012\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/q012');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    const fit = await pill(page).evaluate((el) => {
      const pillEl = el as HTMLElement;
      let parent: HTMLElement | null = pillEl.parentElement;
      while (parent && parent.dataset.slot !== 'sidebar') {
        parent = parent.parentElement;
      }
      if (!parent) return { ok: false as const };
      const pillRect = pillEl.getBoundingClientRect();
      const sidebarRect = parent.getBoundingClientRect();
      const sidebarStyles = window.getComputedStyle(parent);
      return {
        ok: true as const,
        pillLeft: pillRect.left,
        pillRight: pillRect.right,
        sidebarLeft: sidebarRect.left,
        sidebarRight: sidebarRect.right,
        overflowX: sidebarStyles.overflowX,
      };
    });
    if (!fit.ok) throw new Error('sidebar container not found in DOM');

    expect(fit.pillLeft + 0.5).toBeGreaterThanOrEqual(fit.sidebarLeft);
    expect(fit.pillRight - 0.5).toBeLessThanOrEqual(fit.sidebarRight);
  });

  test('small viewport (<1024px below partition) renders the pill cleanly without overflow', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'q013', markdown: '# q013\n\nBody.' }]);
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto('/#/q013');

    await page.locator('[data-sidebar="trigger"]').first().click();
    await page
      .locator('[data-slot="sidebar"][data-state="expanded"]')
      .waitFor({ state: 'attached', timeout: 5_000 });
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    await expect(pill(page)).toBeVisible();

    const fit = await pill(page).evaluate((el) => {
      const pillEl = el as HTMLElement;
      const parent = pillEl.parentElement;
      if (!parent) return { ok: false as const };
      const pillRect = pillEl.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      return {
        ok: true as const,
        pillWidth: pillRect.width,
        parentWidth: parentRect.width,
        leftDelta: pillRect.left - parentRect.left,
        rightDelta: parentRect.right - pillRect.right,
      };
    });
    if (!fit.ok) throw new Error('pill parent wrapper not found');
    expect(fit.leftDelta).toBeGreaterThanOrEqual(-1);
    expect(fit.rightDelta).toBeGreaterThanOrEqual(-1);
    expect(fit.pillWidth).toBeGreaterThan(150);
    expect(fit.pillWidth).toBeLessThanOrEqual(280);

    const kbd = pill(page).locator('kbd');
    await expect(kbd).toBeVisible();
    const kbdOverflow = await kbd.evaluate((el) => {
      const cs = window.getComputedStyle(el as HTMLElement);
      return { textOverflow: cs.textOverflow, overflow: cs.overflow };
    });
    expect(kbdOverflow.textOverflow === 'clip' || kbdOverflow.textOverflow === '').toBeTruthy();
  });

  test('hover and focus-visible states render via shadcn Button cva (not suppressed by pill overrides)', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'q014', markdown: '# q014\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/q014');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    const baseline = await pill(page).evaluate(
      (el) => window.getComputedStyle(el as HTMLElement).backgroundColor,
    );

    await pill(page).hover();
    await expect
      .poll(
        async () =>
          pill(page).evaluate((el) => window.getComputedStyle(el as HTMLElement).backgroundColor),
        { intervals: [16, 32, 64, 128], timeout: 1_000 },
      )
      .not.toBe(baseline);
    const hovered = await pill(page).evaluate(
      (el) => window.getComputedStyle(el as HTMLElement).backgroundColor,
    );
    expect(hovered).not.toBe(baseline);

    await page
      .locator('body')
      .click({ position: { x: 500, y: 500 } })
      .catch(() => {});
    await page
      .locator('body')
      .focus()
      .catch(() => {});

    const baselineBoxShadow = await pill(page).evaluate(
      (el) => window.getComputedStyle(el as HTMLElement).boxShadow,
    );

    await page.keyboard.press('Shift');
    await pill(page).focus();

    await expect
      .poll(
        async () =>
          pill(page).evaluate((el) => window.getComputedStyle(el as HTMLElement).boxShadow),
        { intervals: [16, 32, 64, 128], timeout: 1_000 },
      )
      .not.toBe(baselineBoxShadow);
  });
});

test.describe('sidebar-search-pill — Electron host & sidebar-state', () => {
  test('pill is interactive in browser mode (companion to source-level Electron no-drag class guard)', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'q017', markdown: '# q017\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/q017');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    await pill(page).click();
    await expect(cmdkRoot(page)).toBeVisible({ timeout: 2_000 });
  });

  test('sidebar collapse changes sidebar state and moves the pill off-canvas (sidebar carries it away)', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'q020', markdown: '# q020\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/q020');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    await expect(pill(page)).toBeVisible();
    const startLeft = await pill(page).evaluate((el) => el.getBoundingClientRect().left);
    expect(startLeft).toBeGreaterThanOrEqual(0);

    await page.locator('[data-sidebar="trigger"]').first().click();

    const sidebarLoc = page.locator('[data-slot="sidebar"]:not([data-mobile])').first();
    await expect
      .poll(async () => await sidebarLoc.getAttribute('data-state'), {
        timeout: 5_000,
      })
      .toBe('collapsed');

    await expect
      .poll(
        async () =>
          await pill(page).evaluate((el) => (el as HTMLElement).getBoundingClientRect().right),
        { timeout: 5_000 },
      )
      .toBeLessThanOrEqual(1);
  });

  test('web-mode renders the "Files" label alongside the pill', async ({ page, api }) => {
    await api.seedDocs([{ name: 'q022', markdown: '# q022\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/q022');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    const filesLabel = page.getByText('Files', { exact: true });
    await expect(filesLabel).toBeVisible();
    const klass = (await filesLabel.getAttribute('class')) ?? '';
    expect(klass).toContain('font-mono');
    expect(klass).toContain('text-sm');
    expect(klass).toContain('uppercase');
    expect(klass).toContain('tracking-wider');

    await expect(pill(page)).toBeVisible();
  });

  test('web mode toggles the sidebar via ⌥⌘S (renderer keyboard parity with the Electron menu)', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'q023', markdown: '# q023\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/q023');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    const sidebar = page.locator('[data-slot="sidebar"]:not([data-mobile])').first();
    await expect
      .poll(async () => sidebar.getAttribute('data-state'), { timeout: 5_000 })
      .toBe('expanded');

    await page.keyboard.press('Alt+Meta+s');
    await expect
      .poll(async () => sidebar.getAttribute('data-state'), { timeout: 5_000 })
      .toBe('collapsed');

    await page.keyboard.press('Alt+Meta+s');
    await expect
      .poll(async () => sidebar.getAttribute('data-state'), { timeout: 5_000 })
      .toBe('expanded');
  });

  test('empty workspace — pill renders alongside the 3-button toolbar (Tree view options hidden by hasFolders gate)', async ({
    page,
    api,
    workerServer,
  }) => {
    try {
      await clearVisibleContentEntries(workerServer.baseURL, workerServer.contentDir);
      await api.testReset();

      const templateRes = await fetch(`${workerServer.baseURL}/api/template`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder: '',
          name: 'empty-workspace-template',
          frontmatter: { title: 'Empty workspace template' },
          body: 'Template body',
        }),
      });
      if (!templateRes.ok) {
        throw new Error(`PUT /api/template failed: ${templateRes.status}`);
      }

      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto('/');

      await expect(sidebarHeader(page).getByRole('button', { name: 'New file' })).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        sidebarHeader(page).getByRole('button', { name: 'New from template' }),
      ).toBeVisible();
      await expect(sidebarHeader(page).getByRole('button', { name: 'New folder' })).toBeVisible();

      await expect
        .poll(
          async () =>
            await sidebarHeader(page).getByRole('button', { name: 'Tree view options' }).count(),
          { timeout: 10_000 },
        )
        .toBe(0);

      await expect(pill(page)).toBeVisible();
      await expect(pill(page).locator('svg')).toBeVisible();
      await expect(pill(page).locator('kbd')).toBeVisible();
    } finally {
      await restoreRequiredFixtureEntries({ api, baseURL: workerServer.baseURL });
    }
  });

  test('CommandPalette functionality unchanged — typing a query still yields results from the multi-scope backend', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'guide', markdown: '# guide\n\nSetup instructions.' },
      { name: 'notes', markdown: '# notes\n\nMisc thoughts.' },
    ]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/guide');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    await pill(page).click();
    await expect(cmdkRoot(page)).toBeVisible({ timeout: 2_000 });
    await page.keyboard.type('guide');

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              document.querySelectorAll(
                '[data-slot="command-list"] [data-testid^="command-palette-nav-"]',
              ).length,
          ),
        { timeout: 10_000, intervals: [50, 100, 200] },
      )
      .toBeGreaterThanOrEqual(1);
  });
});
