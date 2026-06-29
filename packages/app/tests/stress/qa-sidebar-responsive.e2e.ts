
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
    await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 10_000 });
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
    await context.addInitScript(() => {
    });
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
    await expect
      .poll(() => page.locator('text=With AI').count(), {
        timeout: 10_000,
        intervals: [200, 500, 1000],
        message: 'With AI section visible in non-embedded empty state',
      })
      .toBeGreaterThan(0);
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

  test('QA-021: right panel has a transition class (animated, gated on drag)', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-021');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-021');
    await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#doc-panel')).toBeAttached({ timeout: 10_000 });
    const probe = await page.evaluate(() => {
      const root = document.querySelector('#doc-panel');
      if (!root) return { rootExists: false };
      const allWithClass = [root, ...root.querySelectorAll('*')].map((el) => ({
        tag: el.tagName,
        id: el.id || null,
        slot: (el as HTMLElement).getAttribute('data-slot'),
        className: (el as HTMLElement).className,
      }));
      const match = allWithClass.find(
        (e) => typeof e.className === 'string' && e.className.includes('transition-[flex-grow]'),
      );
      return {
        rootExists: true,
        rootClassName: (root as HTMLElement).className,
        rootSlot: root.getAttribute('data-slot'),
        match,
        descendantCount: allWithClass.length,
      };
    });
    console.log('QA-021 className probe:', JSON.stringify(probe, null, 2));
    expect(probe.rootExists, '#doc-panel mounted').toBe(true);
    const className = probe.match?.className ?? probe.rootClassName ?? '';
    expect(className, 'transition class located somewhere in doc-panel subtree').toBeTruthy();
    expect(className).toContain('transition-[flex-grow]');
    expect(className).toContain('duration-200');
    expect(className).toContain('ease-out');
    expect(className).toContain('motion-reduce:transition-none');
  });

  test('QA-022: data-dragging attribute appears during handle drag', async ({ page, api }) => {
    await seedDoc(api, 'qa-022');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-022');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 30_000 });
    const handle = page.locator('[data-slot="resizable-handle"]').first();
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
    await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 30_000 });
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
    await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 30_000 });
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
    await expect(page.locator('.ProseMirror').first()).toBeVisible();
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
    await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 30_000 });

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

    const handle = page.locator('[role="separator"][data-separator]').first();
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
      .locator('.ProseMirror')
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
    await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 30_000 });
    expect(await leftSidebarState(page)).toBe('collapsed');
    expect(await docPanelOpen(page)).toBe(false);

    const before = await page.evaluate(() => {
      const editor = document.querySelector('.ProseMirror') as HTMLElement | null;
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
      const editor = document.querySelector('.ProseMirror') as HTMLElement | null;
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
    const handoffBlock = await page.locator('text=Open in Cursor').count();
    expect(handoffBlock, 'no AgentHandoffView "Open in Cursor" in embedded empty state').toBe(0);
    const handoffClaude = await page.locator('text=Open in Claude').count();
    expect(handoffClaude, 'no "Open in Claude" affordance in embedded mode').toBe(0);
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
    await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 30_000 });
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
    const handoffOpenCursor = await page.locator('text="Open in Cursor"').count();
    expect(handoffOpenCursor, 'no Open in Cursor handoff text on embedded page').toBe(0);
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
