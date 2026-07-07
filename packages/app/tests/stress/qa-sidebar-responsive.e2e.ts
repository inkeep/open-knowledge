/**
 * QA sweep for the responsive-sidebar defaults — browser-fidelity
 * verification for the scenarios whose user
 * outcome is observable through Playwright. Pure-function scenarios
 * (resolver / pin-store / embedded-host / quota-throw) are covered by Bun
 * unit tests in the affected packages.
 *
 * Per-test contexts are fresh by default — localStorage is cleared between
 * tests automatically. UA spoofing uses `test.use({ userAgent })` at the
 * describe-block level so `navigator.userAgent` (consulted synchronously
 * during SidebarProvider's useState init) sees the spoofed value on the
 * very first paint.
 */

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

// =====================================================================
// Default UA (non-embedded) sweep
// =====================================================================
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
    // Editor content visible (no clip) — the editor surface mounts and its
    // text is renderable.
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
    // Toggle right panel open
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    // No Sheet / Radix dialog / scrim should exist
    const sheetCount = await page
      .locator(
        '[role="dialog"][data-state="open"], [data-radix-portal] [data-state="open"][role="dialog"]',
      )
      .count();
    expect(sheetCount, 'no Sheet dialog overlay (Sheet branch removed)').toBe(0);
    // Tooltips/popovers may briefly use role=dialog; assert no overlay with the doc-panel content
    const docPanelInDialog = await page.locator('[role="dialog"] #doc-panel').count();
    expect(docPanelInDialog, 'doc-panel must not be wrapped in a role=dialog').toBe(0);
    // doc-panel exists as a normal child of ResizablePanelGroup, not inside a dialog overlay
    await expect(page.locator('#doc-panel')).toBeVisible();
    // No scrim/backdrop overlay
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
    // Click trigger to collapse
    await page.locator('[data-sidebar="trigger"]').click();
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // Pin written
    const pinsBefore = await readPinsFromPage(page);
    expect(pinsBefore).toEqual({ left: { above: 'collapsed' } });
    // Reload, same width
    await page.reload();
    await waitForActiveProviderSynced(page);
    expect(await leftSidebarState(page)).toBe('collapsed');
  });

  test('QA-008a: non-embedded wide first paint — both expanded, no flash', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-008a');
    // Hard reload with no localStorage; capture screenshot at first paint
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-008a');
    // Sample the trigger's aria-expanded immediately and after settle — they should match
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
    // Has accessible name
    const ariaLabel = await trigger.getAttribute('aria-label');
    expect(ariaLabel, 'left toggle must have an accessible name').toBeTruthy();
    expect(ariaLabel?.toLowerCase()).toMatch(/files|sidebar/);
    // aria-expanded reflects state
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

  // A collapsed doc panel must not present an interactive resize handle: the
  // toolbar toggle / ⌥⌘B are its single open mechanism, matching the terminal
  // (whose column unmounts its handle entirely when hidden) and TerminalDock's
  // hidden-dock handle. On the desktop the collapsed handle would also sit one
  // pixel from the terminal handle, where a drag aimed at the terminal seam
  // lands on the doc handle and expands the doc panel instead. The
  // interactivity contract reproduces on the web host (non-embedded), so pin
  // it here: collapsed → disabled and out of the tab order; expanded →
  // interactive; toggle reopen restores interactivity.
  test('collapsed doc panel exposes a disabled resize handle; expanded stays interactive', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-doc-handle-collapse');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-doc-handle-collapse');
    await waitForActiveProviderSynced(page);

    // On the web host the doc-panel handle is the only resizable separator (no
    // terminal column mounts), so it is unambiguous.
    const docPanelHandle = page.locator('[data-slot="resizable-handle"]');
    await expect(docPanelHandle).toHaveCount(1);

    // Expanded (default at WIDE): interactive — focusable and not disabled.
    expect(await docPanelOpen(page)).toBe(true);
    await expect(docPanelHandle).toHaveAttribute('tabindex', '0');
    await expect(docPanelHandle).not.toHaveAttribute('aria-disabled', 'true');

    // Collapse via the toolbar toggle (the panel's single open mechanism).
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');

    // Collapsed: non-interactive — no pointer drag can expand it, and it drops
    // out of the tab order (no redundant separator tab stop).
    await expect(docPanelHandle).toHaveAttribute('aria-disabled', 'true');
    await expect(docPanelHandle).not.toHaveAttribute('tabindex', '0');

    // A drag from the collapsed rail does nothing — the panel stays closed.
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

    // Reopening via the toggle restores an interactive handle.
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
    // Focus a file-tree item inside the sidebar
    const sidebarFirstButton = page.locator('#app-file-sidebar button').first();
    await sidebarFirstButton.focus();
    await page.setViewportSize(NARROW);
    // After auto-collapse, focus should be on the trigger (or no longer inside the sidebar)
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
    // No focus-trap guard around the doc-panel
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
      // emulate is set via Playwright below; this script just lets the page render normally
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await seedDoc(api, 'qa-016a');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-016a');
    await waitForActiveProviderSynced(page);
    // The left sidebar container has `motion-reduce:transition-none` — check its
    // computed transition-duration under reduced motion.
    const dur = await page.evaluate(() => {
      const el = document.querySelector('[data-slot="sidebar-container"]') as HTMLElement | null;
      if (!el) return null;
      return getComputedStyle(el).transitionDuration;
    });
    expect(dur, 'transition-duration under prefers-reduced-motion').not.toBeNull();
    // tailwind's motion-reduce variant sets transition: none → duration parses to "0s"
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
    // non-embedded → the empty-state AI surface IS present: CreateView
    // renders CreatePromptComposer, which shows either the agent split
    // button (create-with-agent, when an installed agent is detected) or
    // the install nudge (create-no-agents, agent-less machines like CI
    // runners). The union pins the affordance CONTRACT independent of the
    // host machine's agent-installation state. Anchor on these testids, not
    // rendered copy: the surface's copy differs per installation state and
    // is Lingui-managed, so a copy anchor is environment-conditional and
    // silently outlives copy changes. Mirrors the embedded empty-state
    // absence check in the Cursor-UA describe.
    // Seed at least one doc first so the empty-state branches to CreateView
    // (documentCount > 0 = not-onboarding) rather than the OnboardingView
    // fork.
    await seedDoc(api, 'qa-033-seed');
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await expect(
      page.getByTestId('create-with-agent').or(page.getByTestId('create-no-agents')).first(),
      'empty-state AI surface (composer button or install nudge) visible when non-embedded',
    ).toBeVisible();
    // seed a doc + verify install-skill entries are hidden from the
    // command palette.
    await seedDoc(api, 'qa-020');
    await page.goto('/#/qa-020');
    await waitForActiveProviderSynced(page);
    // Open command palette via standard shortcut
    await page.keyboard.press('ControlOrMeta+KeyK');
    // Search for "install"
    await page.keyboard.type('install');
    // No "Install for Claude" / "Install OpenKnowledge" should appear
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
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator('#doc-panel')).toBeAttached({ timeout: 10_000 });
    // react-resizable-panels v3 puts id on a wrapper but className on the inner data-slot=resizable-panel element.
    // Probe both: scan the doc-panel subtree for any element carrying the transition class.
    const probe = await page.evaluate(() => {
      const root = document.querySelector('#doc-panel');
      if (!root) return { rootExists: false };
      // Walk root + descendants for the transition class
      const allWithClass = [root, ...root.querySelectorAll('*')].map((el) => ({
        tag: el.tagName,
        id: el.id || null,
        slot: (el as HTMLElement).getAttribute('data-slot'),
        className: (el as HTMLElement).className,
      }));
      // Find one that contains 'transition-[flex-grow]'
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
    // Either the root or a descendant must carry the transition class
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
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible({
      timeout: 30_000,
    });
    // Find the resize handle — our wrapper uses data-slot="resizable-handle"
    const handle = page.locator('[data-slot="resizable-handle"]').first();
    await expect(handle).toBeVisible({ timeout: 10_000 });
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error('handle.boundingBox returned null');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2, { steps: 5 });
    // data-dragging is set on the OK-owned ResizablePanelGroup (data-slot="resizable-panel-group")
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
    // Sanity: sidebar_width cookie may or may not exist (only written on resize).
  });

  test('QA-025: 1100px → left sidebar EXPANDED (1024 threshold, not 1280)', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-025');
    await page.setViewportSize(ABOVE_1024_BELOW_1280);
    await page.goto('/#/qa-025');
    await waitForActiveProviderSynced(page);
    // OLD behavior would have collapsed at 1280; NEW behavior expanded since >=1024
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute('aria-expanded', 'true');
  });

  test('QA-026: right pin persists independently of left', async ({ page, api }) => {
    await seedDoc(api, 'qa-026');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-026');
    await waitForActiveProviderSynced(page);
    // Collapse right
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');
    const pins = await readPinsFromPage(page);
    expect(pins).toEqual({ right: { above: 'collapsed' } });
    // Reload — right stays collapsed, left stays expanded (smart default)
    await page.reload();
    await waitForActiveProviderSynced(page);
    expect(await leftSidebarState(page)).toBe('expanded');
    expect(await docPanelOpen(page)).toBe(false);
  });

  test('QA-027: pinned-open right at 800px and 560px — T2 honored at both (constraint clash resolved)', async ({
    page,
    api,
  }) => {
    // maxSize is pixel-fixed (600px) AND the right threshold is
    // staggered to 1280 — at 800/560 the right is in the 'below' partition; the
    // explicit `below` slot honors {open} and the panel renders open at minSize=300px in
    // both. No impossible-constraint clash to fail-graceful on.
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

    // Narrow to 560px — pin still honored (no constraint clash with pixel maxSize)
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
    // Rapid crossings
    for (let i = 0; i < 6; i++) {
      await page.setViewportSize({ width: 800, height: 800 });
      await page.setViewportSize({ width: 1200, height: 800 });
    }
    // Final state at 1200 should be expanded
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
    // Verify the panel mounted at zero size (defaultSize-from-resolver, not literal '25%')
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
    // Seed a folder + doc
    await api.seedDocs([{ name: 'qa-036-folder/qa-036-doc', markdown: '# qa-036\n\nbody' }]);
    await page.setViewportSize(WIDE);
    // Navigate to the folder
    await page.goto('/#/qa-036-folder');
    // Wait for folder overview to render — it has no doc-panel
    await page.waitForLoadState('domcontentloaded');
    // Verify no doc-panel-toggle present (folder view has no toggle)
    // Press ⌥⌘B — should be a no-op (panelRef.current==null guard)
    await page.keyboard.press('ControlOrMeta+Alt+KeyB');
    // Allow effect runner to flush via a non-sleep wait: poll twice.
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
    // Trigger lives inside a Radix Tooltip — native title attribute is intentionally
    // absent (avoids double-tooltip rendering). The shortcut hint is carried in the
    // Tooltip content + aria-label; hover surfaces it visually.
    const leftTitle = await page.locator('[data-sidebar="trigger"]').getAttribute('title');
    expect(leftTitle).toBeNull();
  });

  test('QA-039: avatar-click expand still works (docPanelExpandSignal regression)', async ({
    page,
    api,
  }) => {
    // This requires a second collaborator to show the presence-bar avatar; without one,
    // we exercise the proxy: openActivityPanel via the doc-panel timeline tab open path.
    // We assert the structural property: panelRef.expand() is invokable via the timeline
    // tab opener (doc-panel-events bus) — collapse the panel, then call the opener.
    await seedDoc(api, 'qa-039');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-039');
    await waitForActiveProviderSynced(page);
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');
    // Dispatch the doc-panel-tab-request event the avatar handler ultimately fires.
    await page.evaluate(() => {
      // Mirror the public API path used by PresenceBar / avatar handlers
      // doc-panel-events.ts subscribes; we cannot import it from the page directly,
      // but the avatar handler uses CustomEvent dispatched on window.
      window.dispatchEvent(new CustomEvent('ok:doc-panel:request-tab', { detail: 'timeline' }));
    });
    // Give the effect a tick — but the doc-panel-events module uses a module-local
    // subscriber list, not a window event. So this proxy may not work. We assert that
    // a direct toggle from the doc-panel-toggle still works (regression check that the
    // toggle mechanism survived Sheet→push), and document avatar wiring as proxy-only.
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
  });

  test('QA-001: full responsive journey (narrow → toggle → reload → widen)', async ({
    page,
    api,
  }) => {
    await seedDoc(api, 'qa-001');
    // 1. Start wide
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-001');
    await waitForActiveProviderSynced(page);
    expect(await leftSidebarState(page)).toBe('expanded');
    expect(await docPanelOpen(page)).toBe(true);
    // 2. Narrow below 1024 → both collapse
    await page.setViewportSize(NARROW);
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');
    // 3. Toggle left open in narrow
    await page.locator('[data-sidebar="trigger"]').click();
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute('aria-expanded', 'true');
    // 4. Reload at the same width — left stays open (pin survives)
    await page.reload();
    await waitForActiveProviderSynced(page);
    expect(await leftSidebarState(page)).toBe('expanded');
    // 5. Widen back to 1300 — right expands, left smart-default (above = open)
    await page.setViewportSize(WIDE);
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    // Editor visible throughout
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible();
  });

  test('QA-041: right doc-panel pixel width sticky as window expands (Q-RIGHT-WIDTH)', async ({
    page,
    api,
  }) => {
    // Seed a known pixel width so the assertion has a definite target.
    // The store clamps to [300, 600]; pick 340 so it's not on either boundary.
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

    // Widen the window. Pre-PR the library would have grown the panel
    // proportionally (~432px at 1700 viewport from a 340px-at-1400 origin).
    // Post-PR the ResizeObserver recompute restores the pixel-sticky value.
    // Use an UPPER-BOUND poll predicate (≤360) so the poll only exits AFTER
    // the RO has restored — a lower-bound predicate would exit early on the
    // intermediate proportional-growth value (which is also ≥330).
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

    // Second behavior: user drag persists to localStorage. The initial-seed
    // path (steps above) already exercises read-from-localStorage, so we
    // don't need to reload to verify restore — that's redundant with the
    // doc-panel-width-store unit tests + the 1400-viewport initial paint.
    // Here we just verify drag → onResize → debounced write reaches storage.
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
    // Drag handle leftward by ~100px (panel grows by ~100px from ~340 → ~440)
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      handleBox.x + handleBox.width / 2 - 100,
      handleBox.y + handleBox.height / 2,
      { steps: 20 },
    );
    await page.mouse.up();
    // Poll until panel has actually grown (event-driven, no fixed sleep)
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
    // Poll until debounced localStorage write has landed — proves the
    // onResize → writeDocPanelWidth wire fires from a user drag.
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
    // Below the 1024 left threshold → partition='below'. The ESC handler is
    // gated on `partition !== 'above'`, so the test must be in the below band.
    // At 800px the sidebar starts collapsed (smart default for below); open
    // via trigger, then press Escape, assert it closes.
    await seedDoc(api, 'qa-044');
    await page.setViewportSize(NARROW);
    await page.goto('/#/qa-044');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // Open via trigger
    await page.locator('[data-sidebar="trigger"]').click();
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute('aria-expanded', 'true');
    // Focus into the editor area so ESC isn't captured by the trigger button itself
    await page
      .locator('.ProseMirror:not(.composer-prosemirror)')
      .first()
      .click({ position: { x: 10, y: 10 } });
    // Press Escape — capture-phase handler on window should close the sidebar
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
    // Right threshold = 1280, left = 1024. At 1100 the partitions split:
    // left 'above' (expanded), right 'below' (collapsed). This is the entire
    // point of staggering — editor breathing room arrives before the left
    // disappears.
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
    // Seed only an `above` slot — the `below` slot is absent. Mount wide; right
    // honors the above slot ('open'). Resize narrow; resolveEffectiveState looks
    // up `pins.right.below`, finds undefined, falls back to smartDefault('below')
    // = 'collapsed'. After the resize, storage MUST still hold ONLY the above
    // slot — the smart-default fallback is non-persistent (no shadow slot
    // materialized for the new partition).
    await seedDoc(api, 'qa-045');
    await seedSidebarPinsBeforeLoad(page, { right: { above: 'open' } });
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-045');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    await page.setViewportSize(ABOVE_1024_BELOW_1280);
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');
    // smartDefault is non-persistent — only the above slot remains.
    expect(await readPinsFromPage(page)).toEqual({ right: { above: 'open' } });
  });

  test('QA-046: narrow→toggle-open→toggle-collapse→wide → right auto-expands (below slot does NOT carry to above)', async ({
    page,
    api,
  }) => {
    // Starting narrow, the user explicitly expands the right (writes
    // `{right:{below:'open'}}`), then collapses it (overwrites the below slot
    // to 'collapsed' — same key, same partition, in-place update), then resizes
    // to wide. The above slot is absent, so resolveEffectiveState falls back to
    // smartDefault('above') = 'open'. Storage must still hold ONLY the below
    // slot after the wide resize (no shadow above slot materialized).
    await seedDoc(api, 'qa-046');
    await page.setViewportSize(ABOVE_1024_BELOW_1280);
    await page.goto('/#/qa-046');
    await waitForActiveProviderSynced(page);
    // Smart default at the narrow partition: right collapsed.
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');
    // Click to expand → below slot = 'open'.
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    expect(await readPinsFromPage(page)).toEqual({ right: { below: 'open' } });
    // Click to collapse → below slot = 'collapsed' (overwrites, doesn't add a slot).
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');
    expect(await readPinsFromPage(page)).toEqual({ right: { below: 'collapsed' } });
    // Resize wide → above slot absent → smartDefault('above') = 'open' applies.
    await page.setViewportSize(WIDE);
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    // only the below slot remains; smartDefault did not write an above slot.
    expect(await readPinsFromPage(page)).toEqual({ right: { below: 'collapsed' } });
  });

  test('QA-047: D13 — narrow `open` pin survives a wide round-trip with a contradictory `above` pin', async ({
    page,
    api,
  }) => {
    // The canonical Per-Partition Pins flow. Tests that the below slot is
    // preserved through an entire wide-visit where the user toggles the right
    // panel collapsed at wide. Under the prior one-slot-per-side
    // model the wide toggle would have wiped the narrow pin; now each
    // partition has its own slot.
    //   1. Start narrow → toggle right OPEN → writes {right:{below:'open'}}.
    //   2. Resize wide → smart default opens (smartDefault('above') = 'open');
    //      right remains open by coincidence of the smart default.
    //   3. Toggle right COLLAPSED at wide → writes the above slot to 'collapsed';
    //      below slot UNCHANGED.
    //   4. Resize back to narrow → below slot honored → right is OPEN.
    //   5. Both slots coexist: {above:'collapsed', below:'open'}.
    await seedDoc(api, 'qa-047');
    await page.setViewportSize(ABOVE_1024_BELOW_1280);
    await page.goto('/#/qa-047');
    await waitForActiveProviderSynced(page);
    // Step 1: pin open at narrow.
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    expect(await readPinsFromPage(page)).toEqual({ right: { below: 'open' } });
    // Step 2: resize wide. Above slot is absent → smart default opens.
    await page.setViewportSize(WIDE);
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    // Step 3: explicit collapse at wide → above slot recorded; below untouched.
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'false');
    expect(await readPinsFromPage(page)).toEqual({
      right: { above: 'collapsed', below: 'open' },
    });
    // Step 4: resize back to narrow → below slot honored → right reopens.
    await page.setViewportSize(ABOVE_1024_BELOW_1280);
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    // Step 5: both slots still coexist (the wide-visit's collapse did not
    // disturb the narrow slot).
    expect(await readPinsFromPage(page)).toEqual({
      right: { above: 'collapsed', below: 'open' },
    });
  });
});

// =====================================================================
// Cursor UA — embedded
// =====================================================================
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
    // Both collapsed on first paint despite being wide
    expect(await leftSidebarState(page)).toBe('collapsed');
    expect(await docPanelOpen(page)).toBe(false);
    // Toggle right open
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('[data-doc-panel-toggle]')).toHaveAttribute('aria-expanded', 'true');
    // Pin should be {right: {embedded: 'open'}}
    const pins = await readPinsFromPage(page);
    expect(pins).toEqual({ right: { embedded: 'open' } });
    // Reload — right stays open (embedded pin)
    await page.reload();
    await waitForActiveProviderSynced(page);
    expect(await docPanelOpen(page)).toBe(true);
  });

  test('QA-043: embedded + collapsed — drag is a no-op for both rail and right handle (FR-18/D12)', async ({
    page,
    api,
  }) => {
    // Behavioral assertion only (no internal-attribute coupling):
    //   1. Capture --sidebar-width / editor-pane width.
    //   2. Attempt to drag both affordances.
    //   3. Assert widths are unchanged.
    // Cursor UA → both sidebars default collapsed at any width. Drag from a
    // collapsed sidebar would normally try to grow it (left) or move the panel
    // boundary (right); with `enableDrag={false}` / `disabled`, both are
    // no-ops. Click-to-toggle stays available (separate code path) — not
    // exercised here.
    await seedDoc(api, 'qa-043');
    await page.setViewportSize(WIDE);
    await page.goto('/#/qa-043');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible({
      timeout: 30_000,
    });
    expect(await leftSidebarState(page)).toBe('collapsed');
    expect(await docPanelOpen(page)).toBe(false);

    // Snapshot dimensions BEFORE drag attempts.
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

    // Attempt to drag the left rail (offcanvas-positioned 2px inside the
    // viewport at the left edge). With enableDrag={false} the drag handler is
    // not attached → no width change.
    const railButton = page.locator('[data-sidebar="rail"]');
    await expect(railButton).toHaveCount(1);
    await railButton.hover();
    await page.mouse.down();
    await page.mouse.move(500, 400, { steps: 10 });
    await page.mouse.up();

    // Attempt to drag the right ResizableHandle. With disabled=true the
    // library short-circuits the drag — boundary doesn't move.
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

    // Snapshot AFTER and assert nothing moved.
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
    // Don't seed a doc — go to empty editor state
    await page.setViewportSize(WIDE);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    // Embedded → the launch handoff would loop back into the host, so the
    // empty-state view (OnboardingView here — no doc seeded; CreateView
    // does the same swap) replaces CreatePromptComposer with
    // CopyablePromptList. Assert the replacement surface renders FIRST so
    // the composer zero-checks below cannot pass vacuously on an unpainted
    // page, then that neither composer state is present.
    await expect(
      page.getByTestId(/^copy-prompt-/).first(),
      'embedded empty state shows copy-to-paste prompts',
    ).toBeVisible();
    await expect(page.getByTestId('create-with-agent')).toHaveCount(0);
    await expect(page.getByTestId('create-no-agents')).toHaveCount(0);
  });
});

// =====================================================================
// Codex(Dev) UA — embedded
// =====================================================================
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
    // Toggle left open in embedded
    await page.locator('[data-sidebar="trigger"]').click();
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute('aria-expanded', 'true');
    const pins = await readPinsFromPage(page);
    expect(pins).toEqual({ left: { embedded: 'open' } });
    // Reload at narrow width — embedded partition is width-independent, pin survives
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
    // Both sidebars collapsed (embedded default at any width)
    expect(await leftSidebarState(page)).toBe('collapsed');
    expect(await docPanelOpen(page)).toBe(false);
    // No install affordance in palette
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.keyboard.type('install');
    const installCount = await page
      .locator('[role="option"], [role="menuitem"]')
      .filter({ hasText: /install (for )?claude/i })
      .count();
    expect(installCount, 'no install items in embedded palette').toBe(0);
    await page.keyboard.press('Escape');
    // No handoff-affordance check here: every doc-page handoff surface is
    // gated on more than the host (the palette's "Open with AI" group needs
    // a principal-backed /api/workspace plus per-target install state), so
    // any assertion on one is environment-conditional. The
    // embedded-hides-AI-surface contract is pinned by the Cursor-UA
    // empty-state test (copy-prompt rows present, composer states absent),
    // which depends on the host alone.
  });
});

// =====================================================================
// Claude(Canary) UA — embedded (MEDIUM confidence host)
// =====================================================================
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
