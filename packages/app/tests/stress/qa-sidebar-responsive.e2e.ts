import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

const SIDEBAR_PINS_KEY = 'ok-sidebar-pins-v2';
const SIDEBAR_STATE_COOKIE_NAME = 'sidebar_state';

const CHROME_VANILLA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const CURSOR_UA = `${CHROME_VANILLA} Cursor/1.2.3`;
const CODEX_UA = `${CHROME_VANILLA} Codex(Dev)/26.513.31313`;
const CLAUDE_UA = `${CHROME_VANILLA} Claude(Canary)/1.0.0`;

const WIDE = { width: 1300, height: 800 } as const;
const NARROW = { width: 800, height: 800 } as const;
const VERY_NARROW = { width: 560, height: 800 } as const;
const ABOVE_1024_BELOW_1280 = { width: 1100, height: 800 } as const;

async function seedSidebarPinsBeforeLoad(page: Page, pins: object) {
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, value);
    },
    { key: SIDEBAR_PINS_KEY, value: JSON.stringify(pins) },
  );
}

async function readPinsFromPage(page: Page) {
  return await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  }, SIDEBAR_PINS_KEY);
}

async function leftSidebarState(page: Page): Promise<'expanded' | 'collapsed'> {
  const trigger = page.locator('[data-sidebar="trigger"]');
  const expanded = await trigger.getAttribute('aria-expanded');
  return expanded === 'true' ? 'expanded' : 'collapsed';
}

async function docPanelOpen(page: Page): Promise<boolean> {
  const toggle = page.locator('[data-doc-panel-toggle]');
  const expanded = await toggle.getAttribute('aria-expanded');
  return expanded === 'true';
}

async function seedDoc(
  api: { seedDocs: (d: Array<{ name: string; markdown: string }>) => Promise<void> },
  name: string,
) {
  await api.seedDocs([
    {
      name,
      markdown: `---
title: "${name}"
---

# ${name}

QA sweep body content for the responsive-sidebar feature. Provides enough
text to verify the editor renders and is not clipped at narrow widths.
`,
    },
  ]);
}

test.describe('non-embedded UA', () => {
  test.use({ userAgent: CHROME_VANILLA, viewport: WIDE });

  test('QA-003a: left sidebar expanded at 1200px (above threshold)', async ({ page, api }) => {
    await seedDoc(api, 'qa-003a');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-003a');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute('aria-expanded', 'true');
  });

  test('QA-003b + QA-008b: left sidebar collapsed at 800px with NO flash', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-003b');
    await page.setViewportSize(NARROW);
    await page.goto('/#/qa-003b');
    await waitForActiveProviderSynced(page);
    const state = await leftSidebarState(page);
    expect(state, 'left sidebar should be collapsed at narrow width with no pin').toBe('collapsed');
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('QA-003c: resize 900px → 1200px expands left sidebar', async ({ page, api }) => {
    await seedDoc(api, 'qa-003c');
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto('/#/qa-003c');
    await waitForActiveProviderSynced(page);
    expect(await leftSidebarState(page)).toBe('collapsed');
    await page.setViewportSize({ width: 1200, height: 800 });
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute('aria-expanded', 'true');
  });

  test('QA-004: right panel pushes (no Sheet/scrim) at 800px', async ({ page, api }) => {
    await seedDoc(api, 'qa-004');
    await page.setViewportSize({ width: 800, height: 800 });
    await page.goto('/#/qa-004');
    await waitForActiveProviderSynced(page);
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    const sheetCount = await page
      .locator(
        '[role="dialog"][data-state="open"], [data-radix-portal] [data-state="open"][role="dialog"]',
      )
      .count();
    expect(sheetCount, 'no Sheet dialog overlay (Sheet branch removed)').toBe(0);
    const docPanelInDialog = await page.locator('[role="dialog"] #doc-panel').count();
    expect(docPanelInDialog, 'doc-panel must not be wrapped in a role=dialog').toBe(0);
    await expect(page.locator('#doc-panel')).toBeVisible();
    const scrimCount = await page
      .locator('[data-state="open"][class*="bg-black"], [data-radix-dismissable-layer]')
      .count();
    expect(scrimCount, 'no Radix scrim / dismissable backdrop layer should exist').toBe(0);
  });

  test('QA-005: explicit collapse persists across reload at the same width', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-005');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-005');
    await waitForActiveProviderSynced(page);
    expect(await leftSidebarState(page)).toBe('expanded');
    await page.locator('[data-sidebar="trigger"]').click();
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    const pinsBefore = await readPinsFromPage(page);
    expect(pinsBefore).toEqual({ left: { above: 'collapsed' } });
    await page.reload();
    await waitForActiveProviderSynced(page);
    expect(await leftSidebarState(page)).toBe('collapsed');
  });

  test('QA-008a: non-embedded wide first paint — both expanded, no flash', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-008a');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-008a');
    const firstFrame = await page.locator('[data-sidebar="trigger"]').getAttribute('aria-expanded');
    await waitForActiveProviderSynced(page);
    const afterSettle = await page
      .locator('[data-sidebar="trigger"]')
      .getAttribute('aria-expanded');
    expect(firstFrame, 'no flash: first-frame state matches settled state').toBe('true');
    expect(afterSettle).toBe('true');
    expect(await docPanelOpen(page)).toBe(true);
  });

  test('QA-012a: left toggle exposes accessible name + aria-expanded reflecting state', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-012a');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-012a');
    await waitForActiveProviderSynced(page);
    const trigger = page.locator('[data-sidebar="trigger"]');
    const ariaLabel = await trigger.getAttribute('aria-label');
    expect(ariaLabel, 'left toggle must have an accessible name').toBeTruthy();
    expect(ariaLabel?.toLowerCase()).toMatch(/files|sidebar/);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('QA-012b: right toggle exposes accessible name + aria-expanded', async ({ page, api }) => {
    await seedDoc(api, 'qa-012b');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-012b');
    await waitForActiveProviderSynced(page);
    const toggle = page.locator('[data-doc-panel-toggle]');
    const ariaLabel = await toggle.getAttribute('aria-label');
    expect(ariaLabel, 'right toggle accessible name').toBeTruthy();
    expect(ariaLabel?.toLowerCase()).toMatch(/panel|document/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAttribute('aria-controls', 'doc-panel');
  });

  test('collapsed doc panel exposes a disabled resize handle; expanded stays interactive', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-doc-handle-collapse');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-doc-handle-collapse');
    await waitForActiveProviderSynced(page);

    const docPanelHandle = page.locator('[data-doc-panel-handle]');
    await expect(docPanelHandle).toHaveCount(1);

    expect(await docPanelOpen(page)).toBe(true);
    await expect(docPanelHandle).toHaveAttribute('tabindex', '0');
    await expect(docPanelHandle).not.toHaveAttribute('aria-disabled', 'true');

    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');

    await expect(docPanelHandle).toHaveAttribute('aria-disabled', 'true');
    await expect(docPanelHandle).not.toHaveAttribute('tabindex', '0');

    const box = await docPanelHandle.boundingBox();
    if (box) {
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX - 320, startY, { steps: 10 });
      await page.mouse.up();
    }
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');

    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    await expect(docPanelHandle).toHaveAttribute('tabindex', '0');
  });

  test('QA-013: focus inside left sidebar → narrow → focus on trigger (FR-9)', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-013');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-013');
    await waitForActiveProviderSynced(page);
    const sidebarFirstButton = page.locator('#app-file-sidebar button').first();
    await sidebarFirstButton.focus();
    await page.setViewportSize(NARROW);
    const trigger = page.locator('[data-sidebar="trigger"]');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    const focusOnTrigger = await page.evaluate(() => {
      const t = document.querySelector('[data-sidebar="trigger"]');
      return t === document.activeElement;
    });
    expect(
      focusOnTrigger,
      'focus must move to the trigger when sidebar collapses with focus inside',
    ).toBe(true);
  });

  test('QA-015: right panel is non-modal — no Radix focus-trap', async ({ page, api }) => {
    await seedDoc(api, 'qa-015');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-015');
    await waitForActiveProviderSynced(page);
    const focusGuards = await page.locator('[data-radix-focus-guard]').count();
    expect(focusGuards, 'no Radix focus-guard sentinels (Sheet→push)').toBe(0);
    const dialogWrappingDocPanel = await page.locator('[role="dialog"] #doc-panel').count();
    expect(dialogWrappingDocPanel, 'doc-panel is not wrapped in role=dialog').toBe(0);
  });

  test('QA-016a: prefers-reduced-motion disables left sidebar transition', async ({
    page,
    api,
    context,
  }) => {
    await context.addInitScript(() => {});
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await seedDoc(api, 'qa-016a');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-016a');
    await waitForActiveProviderSynced(page);
    const dur = await page.evaluate(() => {
      const el = document.querySelector('[data-slot="sidebar-container"]') as HTMLElement | null;
      if (!el) return null;
      return getComputedStyle(el).transitionDuration;
    });
    expect(dur, 'transition-duration under prefers-reduced-motion').not.toBeNull();
    expect(dur).toMatch(/0s/);
  });

  test('QA-016b: prefers-reduced-motion disables right panel transition', async ({ page, api }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await seedDoc(api, 'qa-016b');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-016b');
    await waitForActiveProviderSynced(page);
    const dur = await page.evaluate(() => {
      const el = document.querySelector('#doc-panel') as HTMLElement | null;
      if (!el) return null;
      return getComputedStyle(el).transitionDuration;
    });
    expect(dur).toMatch(/0s/);
  });

  test('QA-017: ⌥⌘S toggles left sidebar (web, non-Electron)', async ({ page, api }) => {
    await seedDoc(api, 'qa-017');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-017');
    await waitForActiveProviderSynced(page);
    expect(await leftSidebarState(page)).toBe('expanded');
    await page.keyboard.press('ControlOrMeta+Alt+KeyS');
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await page.keyboard.press('ControlOrMeta+Alt+KeyS');
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute('aria-expanded', 'true');
  });

  test('QA-018: ⌥⌘B toggles right doc-panel (web, non-Electron)', async ({ page, api }) => {
    await seedDoc(api, 'qa-018');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-018');
    await waitForActiveProviderSynced(page);
    expect(await docPanelOpen(page)).toBe(true);
    await page.keyboard.press('ControlOrMeta+Alt+KeyB');
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('ControlOrMeta+Alt+KeyB');
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
  });

  test('QA-020 + QA-033: SHOW_INSTALL_SKILL=false hides install entries; non-embedded shows AI handoff', async ({
    page,
    api,
  }) => {
    await page.setViewportSize(WIDE);
    await seedDoc(api, 'qa-033-seed');
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await expect(
      page.getByTestId('create-with-agent').or(page.getByTestId('create-no-agents')).first(),
      'empty-state AI surface (composer button or install nudge) visible when non-embedded',
    ).toBeVisible();
    await seedDoc(api, 'qa-020');
    await page.goto('/#/qa-020');
    await waitForActiveProviderSynced(page);
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.keyboard.type('install');
    const installResults = await page
      .locator('[role="option"], [role="menuitem"], [role="listbox"] *')
      .filter({ hasText: /install (for )?claude/i })
      .count();
    expect(installResults, 'no install-skill items in palette').toBe(0);
    await page.keyboard.press('Escape');
  });

  test('QA-021: right panel resizing does not animate', async ({ page, api }) => {
    await seedDoc(api, 'qa-021');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-021');
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator('#doc-panel')).toBeAttached({ timeout: 10_000 });
    const transitionDuration = await page
      .locator('#doc-panel')
      .evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(transitionDuration).toBe('0s');
  });

  test('QA-022: data-dragging attribute appears during handle drag', async ({ page, api }) => {
    await seedDoc(api, 'qa-022');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-022');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible({
      timeout: 30_000,
    });
    const handle = page
      .locator('[data-slot="resizable-handle"][aria-orientation="vertical"]')
      .first();
    await expect(handle).toBeVisible({ timeout: 10_000 });
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error('handle.boundingBox returned null');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2, { steps: 5 });
    const dragging = await page
      .locator('[data-slot="resizable-panel-group"]')
      .first()
      .getAttribute('data-dragging');
    expect(dragging, 'data-dragging while pointer is held on handle').toBeTruthy();
    await page.mouse.up();
    await expect(page.locator('[data-slot="resizable-panel-group"]').first()).not.toHaveAttribute(
      'data-dragging',
      /.+/,
    );
  });

  test('QA-024: no sidebar_state cookie after toggles', async ({ page, context, api }) => {
    await context.clearCookies();
    await seedDoc(api, 'qa-024');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-024');
    await waitForActiveProviderSynced(page);
    await page.locator('[data-sidebar="trigger"]').click();
    await page.locator('[data-sidebar="trigger"]').click();
    const cookies = await context.cookies();
    const sidebarState = cookies.find((c) => c.name === SIDEBAR_STATE_COOKIE_NAME);
    expect(sidebarState, 'no sidebar_state cookie written').toBeUndefined();
  });

  test('QA-025: 1100px → left sidebar EXPANDED (1024 threshold, not 1280)', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-025');
    await page.setViewportSize(ABOVE_1024_BELOW_1280);
    await page.goto('/#/qa-025');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute('aria-expanded', 'true');
  });

  test('QA-026: right pin persists independently of left', async ({ page, api }) => {
    await seedDoc(api, 'qa-026');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-026');
    await waitForActiveProviderSynced(page);
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');
    const pins = await readPinsFromPage(page);
    expect(pins).toEqual({ right: { above: 'collapsed' } });
    await page.reload();
    await waitForActiveProviderSynced(page);
    expect(await leftSidebarState(page)).toBe('expanded');
    expect(await docPanelOpen(page)).toBe(false);
  });

  test('QA-027: pinned-open right at 800px and 560px — T2 honored at both (constraint clash resolved)', async ({
    page,
    api,
  }) => {
    await seedSidebarPinsBeforeLoad(page, { right: { below: 'open' } });
    await seedDoc(api, 'qa-027');
    await page.setViewportSize({ width: 800, height: 800 });
    await page.goto('/#/qa-027');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible({
      timeout: 30_000,
    });
    const probe800 = await page.evaluate(() => {
      const panel = document.querySelector('#doc-panel') as HTMLElement | null;
      const toggle = document.querySelector('[data-doc-panel-toggle]') as HTMLElement | null;
      return {
        panelWidth: panel ? panel.getBoundingClientRect().width : null,
        toggleAriaExpanded: toggle?.getAttribute('aria-expanded') ?? null,
      };
    });
    expect(probe800.toggleAriaExpanded, '800px aria-expanded').toBe('true');
    expect(probe800.panelWidth, '800px panel ≥ minSize').toBeGreaterThanOrEqual(280);

    await page.setViewportSize(VERY_NARROW);
    await expect.poll(() => page.evaluate(() => window.innerWidth), { timeout: 2000 }).toBe(560);
    const probe560 = await page.evaluate(() => {
      const panel = document.querySelector('#doc-panel') as HTMLElement | null;
      const toggle = document.querySelector('[data-doc-panel-toggle]') as HTMLElement | null;
      return {
        panelWidth: panel ? panel.getBoundingClientRect().width : null,
        toggleAriaExpanded: toggle?.getAttribute('aria-expanded') ?? null,
      };
    });
    expect(probe560.toggleAriaExpanded, '560px aria-expanded (pin still honored)').toBe('true');
    expect(probe560.panelWidth, '560px panel ≥ minSize').toBeGreaterThanOrEqual(280);
  });

  test('QA-028: rapid resize across 1024 settles without thrash', async ({ page, api }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await seedDoc(api, 'qa-028');
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto('/#/qa-028');
    await waitForActiveProviderSynced(page);
    for (let i = 0; i < 6; i++) {
      await page.setViewportSize({ width: 800, height: 800 });
      await page.setViewportSize({ width: 1200, height: 800 });
    }
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute('aria-expanded', 'true');
    expect(
      errors.filter((e) => !e.includes('Hocuspocus') && !e.includes('WebSocket')),
      'no console errors from thrash',
    ).toEqual([]);
  });

  test('QA-031: right panel mounts collapsed at 800px with no pin (defaultSize from resolver)', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-031');
    await page.setViewportSize(NARROW);
    await page.goto('/#/qa-031');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('#doc-panel')).toBeAttached({ timeout: 10_000 });
    expect(await docPanelOpen(page)).toBe(false);
    const sizeProbe = await page.evaluate(() => {
      const panel = document.querySelector('#doc-panel') as HTMLElement | null;
      return {
        dataSize: panel?.getAttribute('data-panel-size') ?? null,
        width: panel ? panel.getBoundingClientRect().width : null,
      };
    });
    console.log('QA-031 size probe:', JSON.stringify(sizeProbe));
    expect(sizeProbe.width, 'doc-panel width is 0 at first paint').toBe(0);
  });

  test('QA-036: ⌥⌘B in folder view does NOT write a spurious right pin', async ({ page, api }) => {
    await api.seedDocs([{ name: 'qa-036-folder/qa-036-doc', markdown: '# qa-036\n\nbody' }]);
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-036-folder');
    await page.waitForLoadState('domcontentloaded');
    await page.keyboard.press('ControlOrMeta+Alt+KeyB');
    await expect
      .poll(() => readPinsFromPage(page), { timeout: 1000, intervals: [200, 200, 200] })
      .toBeNull();
  });

  test('QA-037: toggle accessible names contain spoken accelerator hints', async ({
    page,
    api,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel', configurable: true });
    });
    await seedDoc(api, 'qa-037');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-037');
    await waitForActiveProviderSynced(page);
    const leftLabel = await page.locator('[data-sidebar="trigger"]').getAttribute('aria-label');
    expect(leftLabel, 'left toggle aria-label includes spoken Option Command S').toContain(
      'Option Command S',
    );
    const rightLabel = await page.locator('[data-doc-panel-toggle]').getAttribute('aria-label');
    expect(rightLabel, 'right toggle aria-label includes spoken Option Command B').toContain(
      'Option Command B',
    );
    const leftTitle = await page.locator('[data-sidebar="trigger"]').getAttribute('title');
    expect(leftTitle).toBeNull();
  });

  test('QA-039: avatar-click expand still works (docPanelExpandSignal regression)', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-039');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-039');
    await waitForActiveProviderSynced(page);
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('ok:doc-panel:request-tab', { detail: 'timeline' }));
    });
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
  });

  test('QA-001: full responsive journey (narrow → toggle → reload → widen)', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-001');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-001');
    await waitForActiveProviderSynced(page);
    expect(await leftSidebarState(page)).toBe('expanded');
    expect(await docPanelOpen(page)).toBe(true);
    await page.setViewportSize(NARROW);
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('[data-sidebar="trigger"]').click();
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute('aria-expanded', 'true');
    await page.reload();
    await waitForActiveProviderSynced(page);
    expect(await leftSidebarState(page)).toBe('expanded');
    await page.setViewportSize(WIDE);
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible();
  });

  test('QA-041: right doc-panel pixel width sticky as window expands (Q-RIGHT-WIDTH)', async ({
    page,
    api,
  }) => {
    await page.addInitScript((value: string) => {
      localStorage.setItem('ok-doc-panel-width-v1', value);
    }, '340');
    await seedDoc(api, 'qa-041');
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto('/#/qa-041');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible({
      timeout: 30_000,
    });

    const widthAt1400 = await page.evaluate(() => {
      const panel = document.querySelector('#doc-panel') as HTMLElement | null;
      return panel ? panel.getBoundingClientRect().width : null;
    });
    expect(
      widthAt1400,
      '1400px viewport — panel at persisted ~340px (±10 layout slack)',
    ).toBeGreaterThanOrEqual(330);
    expect(widthAt1400 ?? Infinity).toBeLessThanOrEqual(360);

    await page.setViewportSize({ width: 1700, height: 800 });
    await expect.poll(() => page.evaluate(() => window.innerWidth), { timeout: 2000 }).toBe(1700);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const panel = document.querySelector('#doc-panel') as HTMLElement | null;
            return panel ? Math.round(panel.getBoundingClientRect().width) : null;
          }),
        {
          timeout: 3000,
          intervals: [50, 100, 200],
          message: '1700px viewport — panel STILL ~340px (sticky restored, NOT ~432 proportional)',
        },
      )
      .toBeLessThanOrEqual(360);
    const widthAt1700 = await page.evaluate(() => {
      const panel = document.querySelector('#doc-panel') as HTMLElement | null;
      return panel ? panel.getBoundingClientRect().width : null;
    });
    expect(
      widthAt1700 ?? 0,
      'sticky width lower bound (~340, not collapsed below)',
    ).toBeGreaterThanOrEqual(330);

    await page.setViewportSize({ width: 1400, height: 800 });
    await expect.poll(() => page.evaluate(() => window.innerWidth), { timeout: 2000 }).toBe(1400);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const panel = document.querySelector('#doc-panel') as HTMLElement | null;
            return panel ? Math.round(panel.getBoundingClientRect().width) : null;
          }),
        { timeout: 3000, intervals: [50, 100, 200] },
      )
      .toBeLessThanOrEqual(360);

    const handle = page
      .locator('[role="separator"][data-separator][aria-orientation="vertical"]')
      .first();
    const handleBox = await handle.boundingBox();
    if (handleBox == null) throw new Error('right handle not laid out');
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      handleBox.x + handleBox.width / 2 - 100,
      handleBox.y + handleBox.height / 2,
      { steps: 20 },
    );
    await page.mouse.up();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const panel = document.querySelector('#doc-panel') as HTMLElement | null;
            return panel ? Math.round(panel.getBoundingClientRect().width) : null;
          }),
        {
          timeout: 3000,
          intervals: [50, 100, 200],
          message: 'panel grew to ≥420px after drag',
        },
      )
      .toBeGreaterThanOrEqual(420);
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Number.parseInt(localStorage.getItem('ok-doc-panel-width-v1') ?? '0', 10),
          ),
        {
          timeout: 3000,
          intervals: [50, 100, 200],
          message: 'drag width persisted to localStorage',
        },
      )
      .toBeGreaterThanOrEqual(420);
  });

  test('QA-044: ESC closes the left sidebar at below-threshold widths (capture-phase handler)', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-044');
    await page.setViewportSize(NARROW);
    await page.goto('/#/qa-044');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await page.locator('[data-sidebar="trigger"]').click();
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute('aria-expanded', 'true');
    await page
      .locator('.ProseMirror:not(.composer-prosemirror)')
      .first()
      .click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  test('QA-042: staggered region 1100px — left expanded, right collapsed (NG2)', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-042');
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto('/#/qa-042');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');
  });

  test('QA-045: above slot does not apply to below partition → smartDefault collapses (D13)', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-045');
    await seedSidebarPinsBeforeLoad(page, { right: { above: 'open' } });
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-045');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    await page.setViewportSize(ABOVE_1024_BELOW_1280);
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');
    expect(await readPinsFromPage(page)).toEqual({ right: { above: 'open' } });
  });

  test('QA-046: narrow→toggle-open→toggle-collapse→wide → right auto-expands (below slot does NOT carry to above)', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-046');
    await page.setViewportSize(ABOVE_1024_BELOW_1280);
    await page.goto('/#/qa-046');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    expect(await readPinsFromPage(page)).toEqual({ right: { below: 'open' } });
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');
    expect(await readPinsFromPage(page)).toEqual({ right: { below: 'collapsed' } });
    await page.setViewportSize(WIDE);
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    expect(await readPinsFromPage(page)).toEqual({ right: { below: 'collapsed' } });
  });

  test('QA-047: D13 — narrow `open` pin survives a wide round-trip with a contradictory `above` pin', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-047');
    await page.setViewportSize(ABOVE_1024_BELOW_1280);
    await page.goto('/#/qa-047');
    await waitForActiveProviderSynced(page);
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    expect(await readPinsFromPage(page)).toEqual({ right: { below: 'open' } });
    await page.setViewportSize(WIDE);
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');
    expect(await readPinsFromPage(page)).toEqual({
      right: { above: 'collapsed', below: 'open' },
    });
    await page.setViewportSize(ABOVE_1024_BELOW_1280);
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    expect(await readPinsFromPage(page)).toEqual({
      right: { above: 'collapsed', below: 'open' },
    });
  });
});

const PHONE_STANDARD = { width: 393, height: 852 } as const;
const ROOMY_BELOW_THRESHOLD = { width: 900, height: 900 } as const;
const LAYOUT_SETTLE_FRAME_BUDGET = 240;
const RESIDUAL_WORKSPACE_SLACK_PX = 16;
const HEADER_CONTROL_SELECTOR = 'button,[role="button"],a';
const REVEALED_CONTROL_SELECTOR =
  'button,[role="button"],a,[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"]';
const NAME_CONTAINMENT_MIN_LENGTH = 3;

type HeaderControlProbe = {
  index: number;
  key: string;
  name: string;
  directlyReachable: boolean;
  occludedBy: string | null;
  occluderInTrailingRail: boolean;
  inTrailingRail: boolean;
};

type HeaderProbe = {
  viewportWidth: number;
  headerWidth: number;
  navigatorExpanded: boolean;
  toggle: HeaderControlProbe | null;
  controls: HeaderControlProbe[];
};

type ShellGeometry = {
  viewportWidth: number;
  workspaceWidth: number;
  workspaceLeft: number;
  navigatorWidth: number;
};

async function waitForShellLayoutSettled(page: Page) {
  await page.evaluate(
    (frameBudget) =>
      new Promise<void>((resolve) => {
        const sample = () => {
          const widthOf = (selector: string) =>
            Math.round(document.querySelector(selector)?.getBoundingClientRect().width ?? 0);
          return [
            widthOf('[data-slot="sidebar-inset"]'),
            widthOf('[data-slot="sidebar-container"]'),
            widthOf('[data-slot="sidebar-gap"]'),
            widthOf('header'),
          ].join(':');
        };
        let previous = '';
        let stableFrames = 0;
        let frames = 0;
        const tick = () => {
          const current = sample();
          if (current === previous) {
            stableFrames += 1;
          } else {
            stableFrames = 0;
            previous = current;
          }
          frames += 1;
          if (stableFrames >= 5 || frames >= frameBudget) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    LAYOUT_SETTLE_FRAME_BUDGET,
  );
}

async function openFileNavigator(page: Page) {
  const toggle = page.locator('[data-sidebar="trigger"]');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await waitForShellLayoutSettled(page);
}

async function probeHeader(page: Page, controlSelector: string): Promise<HeaderProbe> {
  return await page.evaluate((selector) => {
    const nameOf = (el: Element | null) => {
      if (el == null) return null;
      const raw = el.getAttribute('aria-label') ?? el.textContent ?? '';
      const normalized = raw.replace(/\s+/g, ' ').trim();
      return normalized.length > 0 ? normalized : null;
    };
    const keyOf = (el: Element) => {
      const testId = el.getAttribute('data-testid');
      if (testId != null && testId.length > 0) return `testid:${testId}`;
      const label = el.getAttribute('aria-label');
      if (label != null && label.replace(/\s+/g, ' ').trim().length > 0) {
        return `aria:${label.replace(/\s+/g, ' ').trim()}`;
      }
      const text = nameOf(el);
      return text == null ? '' : `text:${text}`;
    };
    const header = document.querySelector('header');
    if (header == null) {
      throw new Error('probeHeader: no <header> in the document, so every probe below is vacuous');
    }
    const trailingRail = document.querySelector('[data-editor-header-actions]');
    if (trailingRail == null) {
      throw new Error(
        'probeHeader: [data-editor-header-actions] is missing, so inTrailingRail would be ' +
          'false for every control and the overflow guards would pass without probing anything',
      );
    }
    const toggleElement = header.querySelector('[data-sidebar="trigger"]');
    const all = Array.from(header.querySelectorAll(selector));
    const probeOf = (el: Element, index: number) => {
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      const owner = hit?.closest(selector) ?? null;
      const reachable = owner != null && (owner === el || el.contains(owner) || owner.contains(el));
      return {
        index,
        key: keyOf(el),
        name: nameOf(el) ?? '',
        directlyReachable: reachable,
        occludedBy: reachable ? null : (nameOf(owner) ?? hit?.tagName.toLowerCase() ?? null),
        occluderInTrailingRail: !reachable && owner != null && trailingRail.contains(owner),
        inTrailingRail: trailingRail.contains(el),
      };
    };
    const rendered = all
      .map((el, index) => ({ el, index }))
      .filter(({ el }) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
    const toggleEntry = rendered.find(({ el }) => el === toggleElement) ?? null;
    return {
      viewportWidth: window.innerWidth,
      headerWidth: Math.round(header.getBoundingClientRect().width),
      navigatorExpanded: toggleElement?.getAttribute('aria-expanded') === 'true',
      toggle: toggleEntry == null ? null : probeOf(toggleEntry.el, toggleEntry.index),
      controls: rendered.map(({ el, index }) => probeOf(el, index)),
    };
  }, controlSelector);
}

async function measureShellGeometry(page: Page): Promise<ShellGeometry> {
  return await page.evaluate(() => {
    const rectOf = (selector: string) =>
      document.querySelector(selector)?.getBoundingClientRect() ?? null;
    const workspace = rectOf('[data-slot="sidebar-inset"]');
    if (workspace == null) {
      throw new Error(
        'measureShellGeometry: [data-slot="sidebar-inset"] is missing, so a zero substituted ' +
          'here would read as overlay geometry rather than as a stale selector',
      );
    }
    const container = rectOf('[data-slot="sidebar-container"]');
    const gap = rectOf('[data-slot="sidebar-gap"]');
    if (container == null && gap == null) {
      throw new Error(
        'measureShellGeometry: neither [data-slot="sidebar-container"] nor ' +
          '[data-slot="sidebar-gap"] is present, so navigatorWidth would be a fabricated zero',
      );
    }
    return {
      viewportWidth: window.innerWidth,
      workspaceWidth: Math.round(workspace.width),
      workspaceLeft: Math.round(workspace.x),
      navigatorWidth: Math.round(Math.max(container?.width ?? 0, gap?.width ?? 0)),
    };
  });
}

async function visibleControlKeys(page: Page, selector: string): Promise<string[]> {
  return await page.evaluate(
    (sel) =>
      Array.from(document.querySelectorAll(sel))
        .filter((el) => {
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        })
        .map((el) => {
          const testId = el.getAttribute('data-testid');
          if (testId != null && testId.length > 0) return `testid:${testId}`;
          const label = (el.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim();
          if (label.length > 0) return `aria:${label}`;
          const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
          return text.length > 0 ? `text:${text}` : '';
        })
        .filter((key) => key.length > 0),
    selector,
  );
}

function keysReferToSameAction(a: string, b: string) {
  if (a === b) return true;
  if (!a.startsWith('text:') || !b.startsWith('text:')) return false;
  const left = a.slice('text:'.length).toLowerCase();
  const right = b.slice('text:'.length).toLowerCase();
  if (left.length < NAME_CONTAINMENT_MIN_LENGTH || right.length < NAME_CONTAINMENT_MIN_LENGTH) {
    return false;
  }
  return left.includes(right) || right.includes(left);
}

function actionsMissingFrom(available: string[], required: string[]) {
  return required.filter(
    (key) => !available.some((candidate) => keysReferToSameAction(candidate, key)),
  );
}

test.describe('phone-width header layout — controls must not occlude one another', () => {
  test.use({ userAgent: CHROME_VANILLA, viewport: PHONE_STANDARD });

  test('MOBILE-HEADER-1: 393x852 — the file-navigator toggle stays hit-testable with the navigator open', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'mobile-header-toggle');
    await page.setViewportSize(PHONE_STANDARD);
    await page.goto('/#/mobile-header-toggle');
    await waitForActiveProviderSynced(page);
    await openFileNavigator(page);

    const probe = await probeHeader(page, HEADER_CONTROL_SELECTOR);
    expect(probe.toggle, 'the file-navigator toggle must be rendered in the header').not.toBeNull();
    expect(
      probe.toggle?.occluderInTrailingRail ?? false,
      `393x852 (header ${probe.headerWidth}px): the file-navigator toggle's own centre is owned ` +
        `by trailing header action "${probe.toggle?.occludedBy ?? ''}"`,
    ).toBe(false);
    expect(
      probe.toggle?.directlyReachable ?? false,
      `393x852 (header ${probe.headerWidth}px): the file-navigator toggle's own centre resolves ` +
        `to "${probe.toggle?.occludedBy ?? ''}" instead of the toggle`,
    ).toBe(true);

    const toggle = page.locator('[data-sidebar="trigger"]');
    await toggle.click({ timeout: 5_000 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('MOBILE-HEADER-2: 393x852 — no header action is lost when the header cannot fit both rails', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'mobile-header-overflow');
    await page.setViewportSize(ROOMY_BELOW_THRESHOLD);
    await page.goto('/#/mobile-header-overflow');
    await waitForActiveProviderSynced(page);
    await openFileNavigator(page);

    const roomy = await probeHeader(page, HEADER_CONTROL_SELECTOR);
    const roomyTrailing = roomy.controls.filter((control) => control.inTrailingRail);
    expect(
      roomyTrailing.filter((control) => control.key.length === 0).map((control) => control.index),
      'baseline: an unnamed trailing control can never be matched back, so it would sit in ' +
        '`missing` forever and read as a flake rather than as the a11y defect it is',
    ).toEqual([]);
    const roomyActions = roomyTrailing.map((control) => control.key);
    expect(
      roomyActions.length,
      'baseline: the roomy header must expose trailing actions',
    ).toBeGreaterThan(0);

    await page.setViewportSize(PHONE_STANDARD);
    await waitForShellLayoutSettled(page);
    const cramped = await probeHeader(page, HEADER_CONTROL_SELECTOR);
    expect(cramped.navigatorExpanded, 'the navigator must still be open after the resize').toBe(
      true,
    );
    await expect(
      page.getByTestId('header-overflow-actions-trigger'),
      `393x852 (header ${cramped.headerWidth}px): the trailing rail did not collapse, so this ` +
        `test never exercised the overflow recovery path it exists to guard`,
    ).toBeVisible();

    const directlyReachable = cramped.controls
      .filter((control) => control.directlyReachable)
      .map((control) => control.key);
    let missing = actionsMissingFrom(directlyReachable, roomyActions);

    const before = await visibleControlKeys(page, REVEALED_CONTROL_SELECTOR);
    await page.getByTestId('header-overflow-actions-trigger').click({ timeout: 5_000 });
    const after = await visibleControlKeys(page, REVEALED_CONTROL_SELECTOR);
    const revealed = after.filter(
      (key) => !before.some((existing) => keysReferToSameAction(existing, key)),
    );
    expect(
      revealed.length,
      `393x852 (header ${cramped.headerWidth}px): opening the overflow trigger revealed nothing, ` +
        `so the recovery affordance is empty`,
    ).toBeGreaterThan(0);
    missing = actionsMissingFrom(revealed, missing);
    await page.keyboard.press('Escape');
    await waitForShellLayoutSettled(page);

    expect(
      missing,
      `393x852 (header ${cramped.headerWidth}px): header actions available at 900px are neither ` +
        `directly hit-testable nor reachable through an overflow affordance. ` +
        `Directly reachable now: [${directlyReachable.join(', ')}]`,
    ).toEqual([]);
  });

  test('MOBILE-HEADER-3 (control): 900x900 — a header with room for both rails collapses nothing', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'mobile-header-roomy');
    await page.setViewportSize(ROOMY_BELOW_THRESHOLD);
    await page.goto('/#/mobile-header-roomy');
    await waitForActiveProviderSynced(page);
    await waitForShellLayoutSettled(page);

    const collapsed = await probeHeader(page, HEADER_CONTROL_SELECTOR);
    const collapsedActions = collapsed.controls
      .filter((control) => control.inTrailingRail)
      .map((control) => control.key)
      .sort();
    expect(
      collapsedActions.length,
      'baseline: the roomy header must expose trailing actions',
    ).toBeGreaterThan(0);
    await expect(
      page.getByTestId('header-overflow-actions-trigger'),
      `900x900 (header ${collapsed.headerWidth}px, navigator closed): there is room for both ` +
        `rails, so nothing may collapse behind an overflow affordance`,
    ).toHaveCount(0);

    await openFileNavigator(page);
    const expanded = await probeHeader(page, HEADER_CONTROL_SELECTOR);
    const expandedActions = expanded.controls
      .filter((control) => control.inTrailingRail)
      .map((control) => control.key)
      .sort();

    expect(
      expandedActions,
      `900x900 (header ${expanded.headerWidth}px): opening the navigator must not move trailing ` +
        `header actions behind an overflow affordance while there is room for both rails`,
    ).toEqual(collapsedActions);
    expect(
      expanded.controls
        .filter((control) => !control.directlyReachable)
        .map((control) => control.name),
      `900x900 (header ${expanded.headerWidth}px): every header control must be hit-testable`,
    ).toEqual([]);
    await expect(
      page.getByTestId('header-overflow-actions-trigger'),
      `900x900 (header ${expanded.headerWidth}px, navigator open): there is room for both rails, ` +
        `so nothing may collapse behind an overflow affordance`,
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => {
        const host = document.querySelector('[data-editor-header-tabs]');
        if (host == null) throw new Error('[data-editor-header-tabs] is missing from the header');
        return getComputedStyle(host).visibility;
      }),
      `900x900 (header ${expanded.headerWidth}px): the tab strip has room for both header ` +
        `reservations here, so it must still be painted`,
    ).not.toBe('hidden');
  });
});

test.describe('phone-width shell geometry — characterization of the shipped responsive model', () => {
  test.use({ userAgent: CHROME_VANILLA, viewport: PHONE_STANDARD });

  test('MOBILE-PUSH-1: 393x852 — the open navigator displaces the workspace in flow (spec JR2)', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'mobile-push-393');
    await page.setViewportSize(PHONE_STANDARD);
    await page.goto('/#/mobile-push-393');
    await waitForActiveProviderSynced(page);
    await openFileNavigator(page);

    const geometry = await measureShellGeometry(page);
    expect(geometry.navigatorWidth, 'the open navigator occupies width').toBeGreaterThan(0);
    expect(
      geometry.workspaceLeft,
      `393x852: the workspace starts at x=${geometry.workspaceLeft}, so the navigator ` +
        `(${geometry.navigatorWidth}px) no longer displaces it. Overlay geometry is deferred ` +
        `scope, not this fix — update this characterization deliberately, with a spec.`,
    ).toBeGreaterThanOrEqual(geometry.navigatorWidth - 1);
    expect(
      geometry.workspaceWidth,
      `393x852: the workspace must keep the residual width beside the navigator`,
    ).toBeGreaterThanOrEqual(
      geometry.viewportWidth - geometry.navigatorWidth - RESIDUAL_WORKSPACE_SLACK_PX,
    );
    expect(
      geometry.workspaceLeft + geometry.workspaceWidth,
      `393x852: the workspace must not extend past the viewport`,
    ).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  });
});

test.describe('Cursor UA (embedded)', () => {
  test.use({ userAgent: CURSOR_UA, viewport: WIDE });

  test('QA-002 + QA-007a: Cursor UA → both collapsed; toggle persists across reload', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-002');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-002');
    await waitForActiveProviderSynced(page);
    expect(await leftSidebarState(page)).toBe('collapsed');
    expect(await docPanelOpen(page)).toBe(false);
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    const pins = await readPinsFromPage(page);
    expect(pins).toEqual({ right: { embedded: 'open' } });
    await page.reload();
    await waitForActiveProviderSynced(page);
    expect(await docPanelOpen(page)).toBe(true);
  });

  test('QA-043: embedded + collapsed — drag is a no-op for both rail and right handle (FR-18/D12)', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-043');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-043');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible({
      timeout: 30_000,
    });
    expect(await leftSidebarState(page)).toBe('collapsed');
    expect(await docPanelOpen(page)).toBe(false);

    const before = await page.evaluate(() => {
      const editor = document.querySelector(
        '.ProseMirror:not(.composer-prosemirror)',
      ) as HTMLElement | null;
      const sidebarWidth = getComputedStyle(document.documentElement)
        .getPropertyValue('--sidebar-width')
        .trim();
      return {
        sidebarWidth,
        editorWidth: editor ? editor.getBoundingClientRect().width : null,
      };
    });

    const railButton = page.locator('[data-sidebar="rail"]');
    await expect(railButton).toHaveCount(1);
    await railButton.hover();
    await page.mouse.down();
    await page.mouse.move(500, 400, { steps: 10 });
    await page.mouse.up();

    const rightHandle = page.locator('[role="separator"][data-separator]').first();
    if ((await rightHandle.count()) === 1) {
      const box = await rightHandle.boundingBox();
      if (box != null) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x - 200, box.y + box.height / 2, { steps: 10 });
        await page.mouse.up();
      }
    }

    const after = await page.evaluate(() => {
      const editor = document.querySelector(
        '.ProseMirror:not(.composer-prosemirror)',
      ) as HTMLElement | null;
      const sidebarWidth = getComputedStyle(document.documentElement)
        .getPropertyValue('--sidebar-width')
        .trim();
      return {
        sidebarWidth,
        editorWidth: editor ? editor.getBoundingClientRect().width : null,
      };
    });
    expect(after.sidebarWidth, 'left --sidebar-width unchanged after drag attempt').toBe(
      before.sidebarWidth,
    );
    expect(after.editorWidth, 'editor width unchanged (right handle drag was a no-op)').toBe(
      before.editorWidth,
    );
  });

  test('QA-019: AI-handoff affordances hidden when embedded (palette + empty-state)', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await expect(
      page.getByTestId(/^copy-prompt-/).first(),
      'embedded empty state shows copy-to-paste prompts',
    ).toBeVisible();
    await expect(page.getByTestId('create-with-agent')).toHaveCount(0);
    await expect(page.getByTestId('create-no-agents')).toHaveCount(0);
  });
});

test.describe('Codex(Dev) UA — parenthetical-tolerant embedded', () => {
  test.use({ userAgent: CODEX_UA, viewport: WIDE });

  test('QA-007b + QA-023: Codex(Dev)/26.x → embedded, both collapsed at 1600px', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-023');
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/#/qa-023');
    await waitForActiveProviderSynced(page);
    expect(await leftSidebarState(page)).toBe('collapsed');
    expect(await docPanelOpen(page)).toBe(false);
  });

  test('QA-008c: Codex UA first-paint no flash (both collapsed)', async ({ page, api }) => {
    await seedDoc(api, 'qa-008c');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-008c');
    const firstFrame = await page.locator('[data-sidebar="trigger"]').getAttribute('aria-expanded');
    expect(firstFrame).toBe('false');
    await waitForActiveProviderSynced(page);
    const afterSettle = await page
      .locator('[data-sidebar="trigger"]')
      .getAttribute('aria-expanded');
    expect(afterSettle).toBe('false');
  });

  test('QA-035: embedded pin persists across width change on reload', async ({ page, api }) => {
    await seedDoc(api, 'qa-035');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-035');
    await waitForActiveProviderSynced(page);
    await page.locator('[data-sidebar="trigger"]').click();
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute('aria-expanded', 'true');
    const pins = await readPinsFromPage(page);
    expect(pins).toEqual({ left: { embedded: 'open' } });
    await page.setViewportSize(NARROW);
    await page.reload();
    await waitForActiveProviderSynced(page);
    expect(await leftSidebarState(page)).toBe('expanded');
  });

  test('QA-038: embedded + install hidden + handoff hidden composite', async ({ page, api }) => {
    await seedDoc(api, 'qa-038');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-038');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible({
      timeout: 30_000,
    });
    expect(await leftSidebarState(page)).toBe('collapsed');
    expect(await docPanelOpen(page)).toBe(false);
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.keyboard.type('install');
    const installCount = await page
      .locator('[role="option"], [role="menuitem"]')
      .filter({ hasText: /install (for )?claude/i })
      .count();
    expect(installCount, 'no install items in embedded palette').toBe(0);
    await page.keyboard.press('Escape');
  });
});

test.describe('Claude(Canary) UA — embedded', () => {
  test.use({ userAgent: CLAUDE_UA, viewport: WIDE });

  test('QA-007c + QA-023b: Claude(Canary)/1.0.0 → embedded both collapsed', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-023b');
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/#/qa-023b');
    await waitForActiveProviderSynced(page);
    expect(await leftSidebarState(page)).toBe('collapsed');
    expect(await docPanelOpen(page)).toBe(false);
  });
});
