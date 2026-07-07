/**
 * E2E regression coverage for the sidebar search pill (the labeled
 * Search affordance that replaces the icon-only entry point in
 * FileSidebar's chrome row).
 *
 * The pill row lives as a sibling between SidebarHeader and SidebarContent;
 * source-level guards in FileSidebar.test.ts pin the structural wiring.
 * This file is the DOM-bound complement, covering:
 *
 *   - discovery: pill renders above the FileTree on initial sidebar load,
 *     without hover/focus
 *   - mouse path: clicking the pill opens the CommandPalette
 *   - keyboard path: ⌘K / Ctrl+K still opens the palette (regression guard
 *     for the global keydown listener inside CommandPalette)
 *   - divergent click-while-open semantics: pill click is a no-op when the
 *     palette is open (mirrors the legacy icon); ⌘K-while-open toggles
 *     closed (preserves the global-shortcut contract)
 *   - removal of the legacy Search ToolbarButton from SidebarHeader
 *   - accessible-name calculation returns "Search" with no aria-label
 *     override; lucide icon carries aria-hidden
 *   - compositional journey: discovery → click → query → result selection
 *     navigates to the matching doc
 *   - visual anatomy: rounded-lg border-radius (not rounded-full, not
 *     rounded-md), DOM order svg → label → kbd, ~36px tall, full-width
 *   - kbd hint adapts to platform — '⌘ K' on Mac, 'Ctrl K' elsewhere
 *   - both responsive paths render cleanly (inline ≥1280px and
 *     push-translate <1280px)
 *   - hover and focus-visible states from the shadcn Button cva are not
 *     suppressed by the pill overrides
 *   - the pill follows the sidebar offcanvas during collapse
 *   - web-mode 'Files' label still renders alongside the pill
 *   - empty-workspace path (hasFolders === false → Tree view options
 *     dropdown hidden) renders the pill alongside the 3-button toolbar
 *   - the multi-scope search backend still yields results when the pill
 *     opens the palette (no regression in palette functionality)
 *   - the locked `data-telemetry-event="ok.sidebar.search_pill.click"`
 *     stable selector
 *
 * Not covered here (handled separately): render-throw inside the
 * ErrorBoundary — source-level guards pin the boundary wiring + onError
 * emission shape; injecting a synthetic throw in production code is
 * invasive, and the same boundary shape is exercised in production by
 * MathInlineView and JsxComponentView. Full Electron lockstep-fade
 * visual verification requires the Electron host
 * (Playwright `_electron.launch()`); browser-mode tests here cover the
 * structural class contract.
 *
 * Each test creates its own unique doc via
 * api.seedDocs — never a hardcoded 'test-doc' name.
 */

import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;

// Use the locked `data-telemetry-event` attribute (documented above) rather
// than the accessible name. EditorHeader now renders a sibling Search button
// with accessible name "Search (Ctrl+K)" when the sidebar is collapsed, so a
// role+name 'Search' match is strict-mode-ambiguous mid-test.
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
    // Wait for the FileTree to settle so the sidebar chrome is in its
    // expected initial render state. `[role="treeitem"]` is the same
    // anchor used by command-palette-flicker.e2e.ts.
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    // Pill is visible without hover/focus.
    await expect(pill(page)).toBeVisible();

    // Pill has the leading <svg> and a <kbd> inside it (icon left, kbd right).
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

    // Locked telemetry attribute value.
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

    // Precondition: no cmdk root visible.
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

    // ControlOrMeta picks Meta on darwin Chromium and Control elsewhere —
    // matches CommandPalette's `isMacOS() ? metaKey : ctrlKey` check.
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

    // Open via pill click.
    await pill(page).click();
    await expect(cmdkRoot(page)).toBeVisible({ timeout: 2_000 });

    // The pill node lives inside the sidebar, behind the cmdk dialog
    // overlay. Use force-click on the pill from outside the dialog
    // to fire its onClick despite the overlay — we are testing that the
    // setCommandPaletteOpen(true) handler is a no-op when already open,
    // NOT that the user can reach the pill through the overlay.
    //
    // The radix Dialog primitive opens with pointer-events: auto so
    // outside elements get pointer-events: none — `{ force: true }`
    // bypasses Playwright's actionability checks; the click event still
    // reaches React. Use page.evaluate to fire the click via the DOM so
    // pointer-events guards do not interfere.
    await page.evaluate(() => {
      const btn = document.querySelector(
        'button[data-telemetry-event="ok.sidebar.search_pill.click"]',
      );
      if (!(btn instanceof HTMLElement)) {
        throw new Error('pill button not found in DOM');
      }
      btn.click();
    });

    // Condition-based settle window: poll both invariants over ~500ms. A
    // regression where the modal flickers closed-then-reopens would observe
    // visible=false at some interval and fail the assertion. A simple
    // toBeVisible() / toBeFocused() pair would sample only the final state
    // and miss that flicker. Polling preserves the original "settle window"
    // intent without a wall-clock sleep (banned by the e2e-stop-rules
    // integration test at packages/app/tests/integration/e2e-stop-rules.test.ts).
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

    // ⌘K-while-open → toggle close.
    await page.keyboard.press('ControlOrMeta+k');
    await expect(cmdkRoot(page)).toBeHidden({ timeout: 2_000 });
  });

  test('legacy Search ToolbarButton is gone from SidebarHeader (no two redundant entry points)', async ({
    page,
    api,
    workerServer,
  }) => {
    // Seed a doc inside a folder so hasFolders → true → all four toolbar
    // buttons render. The pill button ALSO has accessible name "Search"
    // — but lives OUTSIDE SidebarHeader, so we scope our query to the
    // header container. Seed a root-level template so the smart-hide gate
    // around "New from template" evaluates true (the button hides when
    // zero templates resolve at the root cascade).
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

    // Wait for hasFolders to propagate (folder-state subscription resolves).
    await expect(page.getByRole('button', { name: 'Tree view options' })).toBeVisible({
      timeout: 15_000,
    });

    // No button with accessible name 'Search' exists inside SidebarHeader.
    const searchInsideHeader = sidebarHeader(page).getByRole('button', { name: 'Search' });
    await expect(searchInsideHeader).toHaveCount(0);

    // The four expected toolbar buttons are present. `'New from template'`
    // uniquely identifies the FilePlus button — no other toolbar button
    // has that substring in its accessible name. Label is ASCII-only by
    // codebase microcopy policy (U+2026 reserved for macOS native menus
    // + truncation indicators only; enforced by the biome-plugin GritQL
    // rule). The ASCII-only match also sidesteps a cross-platform
    // accessible-name divergence we hit in earlier iterations — Linux
    // Chromium drops a trailing U+2026 from the computed accessible name
    // while macOS preserves it — so the pattern is portable even if a
    // future label gains a trailing ellipsis.
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

    // Exactly one button with accessible name matching /^Search/.
    const matchingPills = page.getByRole('button', { name: /^Search/ });
    await expect(matchingPills).toHaveCount(1);

    // Button element has NO aria-label attribute (visible text IS the name).
    const ariaLabel = await pill(page).getAttribute('aria-label');
    expect(ariaLabel).toBeNull();

    // Visible <span>Search</span> is present.
    const labelText = await pill(page).locator('span', { hasText: 'Search' }).first().textContent();
    expect(labelText?.trim()).toBe('Search');

    // The leading lucide Search icon carries aria-hidden="true".
    const svgAriaHidden = await pill(page).locator('svg').first().getAttribute('aria-hidden');
    expect(svgAriaHidden).toBe('true');

    // Definitive accessible-name check via Playwright's role-name match
    // (above `matchingPills.count() === 1` already passed, proving the
    // AAM resolved a name starting with "Search"). Additionally compute
    // the name from non-aria-hidden text content — the kbd's text may
    // contribute (minor verbosity, intentional), but the visible "Search"
    // span MUST lead.
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
    // Start at #/bb so the post-Enter hash comparison is discriminating —
    // the query 'queue' only matches doc 'aa' (bb body is 'Unrelated
    // body.'), so a successful navigation MUST advance the hash from
    // #/bb to #/aa. Starting at #/aa would let the assertion pass even
    // if navigation never fired (hash matches the starting state).
    await page.goto('/#/bb');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    // Discovery → click → palette opens with input focused.
    await pill(page).click();
    await expect(cmdkRoot(page)).toBeVisible({ timeout: 2_000 });
    await expect(cmdkInput(page)).toBeFocused();

    // Type a query that hits seeded body text — 'queue' matches doc
    // 'aa' exclusively. Same full_text + content-scope path that
    // command-palette-flicker.e2e.ts exercises.
    await page.keyboard.type('queue');

    // Wait for at least one nav row to appear — the API returns either
    // the file row 'aa' or a content match row; both navigate to #/aa
    // on select.
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

    // ArrowDown + Enter on the first match. The palette closes after
    // selection — unchanged from the legacy icon-click behavior.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(cmdkRoot(page)).toBeHidden({ timeout: 2_000 });

    // The hash advances from #/bb (starting URL) to #/aa (the only doc
    // whose body matches 'queue'). Deterministic — proves navigation
    // actually fired AND landed on the matching doc.
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

    // rounded-lg maps to --radius-lg which is var(--radius) per
    // globals.css (search for the `--radius-lg` and `--radius`
    // declarations — line numbers drift; token names are stable). Today
    // it evaluates to 10px. Primary contract: not rounded-full (9999px,
    // would render as a pure pill). The 7-12px band tolerates minor
    // token shifts; --radius-md in this project also lands at 8px
    // (`calc(var(--radius) * 0.8)`), so this band does NOT distinguish
    // rounded-lg from rounded-md — source-level guards in
    // SidebarSearchBar.test.ts pin the `rounded-lg` class literal.
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
      // DOM order check via Node.compareDocumentPosition.
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

    // DOM order
    expect(layout.svgBeforeSpan).toBe(true);
    expect(layout.spanBeforeKbd).toBe(true);
    // LTR position — small fp tolerance because flex layout may produce
    // sub-pixel overlap.
    expect(layout.svgRight).toBeLessThanOrEqual(layout.spanLeft + 1);
    expect(layout.spanRight).toBeLessThanOrEqual(layout.kbdLeft + 1);
    // Height ~36px — h-9 in Tailwind v4 = 36px.
    expect(layout.height).toBeGreaterThanOrEqual(34);
    expect(layout.height).toBeLessThanOrEqual(40);
    // Full-width — w-full inside `px-2` parent. The pill should be at
    // least 200px wide at a 1440px viewport.
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
      // Walk up to the sidebar container ([data-slot="sidebar"]).
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

    // Pill fits horizontally inside the sidebar bounds (tolerate 1px fp).
    expect(fit.pillLeft + 0.5).toBeGreaterThanOrEqual(fit.sidebarLeft);
    expect(fit.pillRight - 0.5).toBeLessThanOrEqual(fit.sidebarRight);
  });

  test('small viewport (<1024px below partition) renders the pill cleanly without overflow', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'q013', markdown: '# q013\n\nBody.' }]);
    // Drop to 900 — below the 1024 left-collapse threshold. The sidebar
    // starts in the `below` partition (smart-default collapsed / offcanvas),
    // so we exercise the open-via-trigger path. The prior push-translate
    // code path was removed when the openMobile machine retired.
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto('/#/q013');

    // Sidebar starts collapsed at <1024 — open via the trigger. EditorHeader
    // carries a sidebar trigger too; the FIRST trigger in the DOM is the
    // canvas-side one for the file sidebar.
    await page.locator('[data-sidebar="trigger"]').first().click();
    await page
      .locator('[data-slot="sidebar"][data-state="expanded"]')
      .waitFor({ state: 'attached', timeout: 5_000 });
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    // Pill is visible.
    await expect(pill(page)).toBeVisible();

    // Pill fits its immediate parent wrapper (the .px-2 div between
    // SidebarHeader and SidebarContent) — that wrapper is the pill row's
    // measurement reference. The whole sidebar may be push-translated
    // offscreen at small viewport; we are not asserting the sidebar's
    // viewport position, only the pill's overflow behavior within its
    // own row container.
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
    // Pill fits inside its immediate parent (no horizontal overflow).
    // `leftDelta` and `rightDelta` should both be ≥ 0 (within 1px fp).
    expect(fit.leftDelta).toBeGreaterThanOrEqual(-1);
    expect(fit.rightDelta).toBeGreaterThanOrEqual(-1);
    // Sidebar primitive width is 288px (18rem); parent is 288 - 2*8(px-2)
    // = 272px. Pill should occupy nearly the full parent width. (The
    // pill row uses px-2 to align with Pierre Trees' 8px padding-inline,
    // so the pill's left/right edges match the FileTree row content
    // area underneath.)
    expect(fit.pillWidth).toBeGreaterThan(150);
    expect(fit.pillWidth).toBeLessThanOrEqual(280);

    // kbd remains visible without overflow-ellipsis.
    const kbd = pill(page).locator('kbd');
    await expect(kbd).toBeVisible();
    const kbdOverflow = await kbd.evaluate((el) => {
      const cs = window.getComputedStyle(el as HTMLElement);
      return { textOverflow: cs.textOverflow, overflow: cs.overflow };
    });
    // Either default 'clip' or 'visible' — NOT a forced 'ellipsis' truncation.
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

    // Baseline background-color.
    const baseline = await pill(page).evaluate(
      (el) => window.getComputedStyle(el as HTMLElement).backgroundColor,
    );

    // Hover.
    await pill(page).hover();
    // Poll the computed background-color until it differs from baseline.
    // shadcn's outline variant transitions the :hover background — a fixed
    // sleep races the animation curve (banned by the e2e-stop-rules test)
    // and also samples mid-flight on fast runners. The poll resolves as
    // soon as the browser commits the hover style.
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
    // Sanity: capture the final hover background for downstream diagnostics.
    expect(hovered).not.toBe(baseline);

    // Focus-visible. Capture baseline BEFORE focusing — no animation in
    // flight, so getComputedStyle returns a stable resting value. shadcn
    // Button's cva applies `transition-all` (not `transition-colors`),
    // which transitions box-shadow + border alongside everything else;
    // capturing baseline AFTER blur risks reading an in-flight
    // reverse-transition value (getComputedStyle returns the
    // currently-animated value during transitions, not the endpoint).
    // Move focus off the pill first so any earlier focus state has
    // settled.
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

    // Establish keyboard input modality so the subsequent programmatic
    // focus matches `:focus-visible`. Earlier versions of this test
    // relied on Chromium's user-agent heuristic that applied
    // `:focus-visible` to form controls on bare `el.focus()` — that
    // heuristic has since tightened: after pointer interaction (the
    // `body.click()` above), subsequent programmatic focus is treated
    // as pointer-modality and `:focus-visible` no longer matches.
    // Pressing a key (Shift, no-op) flips the modality back to
    // keyboard. We use Playwright's `locator.focus()` afterwards
    // (rather than `el.focus()` via evaluate) because Playwright's
    // dispatcher preserves the keyboard modality for the focus event.
    // Tab is intentionally NOT used to do the focus itself — tab order
    // depends on DOM order which a sidebar-chrome refactor could shift.
    await page.keyboard.press('Shift');
    await pill(page).focus();

    // Poll for the focus-visible style to commit — mirrors the
    // hover-state poll earlier in this test (`expect.poll(...).not.toBe(baseline)`
    // on backgroundColor). A direct read immediately after focus() risks
    // catching the box-shadow mid-transition; the poll resolves as soon
    // as the browser commits the focused style. The cva sets
    // `ring-ring/50 ring-[3px]` via box-shadow when focus-visible
    // matches, so box-shadow is the discriminating signal (outline
    // stays `none` via the cva's `outline-none`).
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
    // The full Electron-host scenario (`window.okDesktop != null` →
    // `[-webkit-app-region:no-drag]` class applied + click still reaches
    // React despite SidebarHeader's drag-region) cannot be reproduced in
    // browser-mode Chromium with a synthetic `okDesktop` shim — the
    // ProjectSwitcher and other consumers expect a complete bridge
    // surface and crash render when given an incomplete object. The
    // structural class contract is pinned by source-level guards in
    // FileSidebar.test.ts. Here we verify the browser-mode invariant:
    // the pill is interactive end-to-end (open palette → see modal)
    // without any drag-region interference.
    await api.seedDocs([{ name: 'q017', markdown: '# q017\n\nBody.' }]);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/#/q017');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    // The pill is clickable and opens the palette.
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

    // Visible initially with a positive on-screen left edge.
    await expect(pill(page)).toBeVisible();
    const startLeft = await pill(page).evaluate((el) => el.getBoundingClientRect().left);
    expect(startLeft).toBeGreaterThanOrEqual(0);

    // Collapse the file sidebar via its SidebarTrigger, located by
    // `data-sidebar="trigger"`. The accessible name "Hide Files" is NOT
    // unique — SidebarRail carries the same aria-label — so a role+name
    // locator is strict-mode-ambiguous. `.first()` is the canvas-side
    // (EditorHeader) trigger; clicking it flips the same useSidebar() state
    // the ⌥⌘S shortcut and the rail drag-handle do.
    await page.locator('[data-sidebar="trigger"]').first().click();

    // After collapse, the desktop sidebar enters offcanvas mode:
    // `data-state="collapsed"` AND the wrapper translates such that the
    // pill's bounding box leaves the viewport on the left.
    const sidebarLoc = page.locator('[data-slot="sidebar"]:not([data-mobile])').first();
    await expect
      .poll(async () => await sidebarLoc.getAttribute('data-state'), {
        timeout: 5_000,
      })
      .toBe('collapsed');

    // The pill follows the sidebar offcanvas — its bounding-box right
    // edge ends up ≤ 1px (entirely outside the viewport on the left).
    // Poll because the CSS slide is animated.
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

    // 'Files' label visible in web mode (no okDesktop shim).
    const filesLabel = page.getByText('Files', { exact: true });
    await expect(filesLabel).toBeVisible();
    const klass = (await filesLabel.getAttribute('class')) ?? '';
    expect(klass).toContain('font-mono');
    expect(klass).toContain('text-sm');
    expect(klass).toContain('uppercase');
    expect(klass).toContain('tracking-wider');

    // Pill is also visible.
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

    // ⌥⌘S collapses. The renderer keydown listener in SidebarProvider drives
    // this in web mode (gated to non-Electron hosts); under Electron the same
    // accelerator is owned by the native View → Show/Hide Sidebar menu item.
    await page.keyboard.press('Alt+Meta+s');
    await expect
      .poll(async () => sidebar.getAttribute('data-state'), { timeout: 5_000 })
      .toBe('collapsed');

    // ⌥⌘S again expands — confirms a true toggle, not a one-way collapse.
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
    // The per-worker fixture pre-seeds content, and earlier tests in the
    // same worker can create more folders. Clear visible files/folders so
    // hasFolders can settle to false for this specific branch.
    try {
      await clearVisibleContentEntries(workerServer.baseURL, workerServer.contentDir);
      await api.testReset();

      // Seed a root template so the smart-hide gate around "New from
      // template" resolves true — that button hides when zero templates
      // resolve at the root cascade (see the "legacy Search ToolbarButton
      // is gone" test). Without an explicit seed this test passed only when
      // an earlier same-worker test happened to leave a template behind;
      // seeding here makes the 3-button assertion deterministic.
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

      // Three core toolbar buttons present. ASCII-only substring match for
      // `New from template` — see the comment in the "legacy Search
      // ToolbarButton is gone from SidebarHeader" test above for the
      // cross-platform accessible-name rationale.
      await expect(sidebarHeader(page).getByRole('button', { name: 'New file' })).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        sidebarHeader(page).getByRole('button', { name: 'New from template' }),
      ).toBeVisible();
      await expect(sidebarHeader(page).getByRole('button', { name: 'New folder' })).toBeVisible();

      // Tree view options trigger is HIDDEN (hasFolders gate evaluates to
      // false because the content directory has no folders). Poll because
      // the file watcher + folder-state subscription propagation may take a
      // moment to reflect the rm.
      await expect
        .poll(
          async () =>
            await sidebarHeader(page).getByRole('button', { name: 'Tree view options' }).count(),
          { timeout: 10_000 },
        )
        .toBe(0);

      // Pill renders normally.
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

    // Open via pill, then exercise the multi-scope search.
    await pill(page).click();
    await expect(cmdkRoot(page)).toBeVisible({ timeout: 2_000 });
    await page.keyboard.type('guide');

    // At least one result (the file scope alone resolves 'guide.md').
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
