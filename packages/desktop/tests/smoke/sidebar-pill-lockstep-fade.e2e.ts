/**
 * Sidebar search pill Electron-mode lockstep-fade smoke.
 *
 * Drives the real Electron binary via Playwright's `_electron` API and
 * verifies the Electron-only opacity gate on FileSidebar's chrome row:
 *
 *   - The h-12 toolbar row carries `opacity-0` when the sidebar is
 *     collapsed (`shouldFadeChrome && 'opacity-0'`).
 *   - The new sidebar-search-pill row, sibling between SidebarHeader and
 *     SidebarContent, also carries `opacity-0` under the same condition.
 *   - Both rows carry the identical `motion-safe:transition-opacity
 *     motion-safe:duration-100 motion-safe:ease-out` transition.
 *
 * Browser-mode tests (`sidebar-search-pill.e2e.ts`) do NOT exercise this
 * path because `isElectronHost` evaluates false in browser mode and the
 * opacity-0 class never applies — only the sidebar's offcanvas slide
 * carries the row away (verified there). The class set IS structurally
 * pinned by source-level guards in `FileSidebar.test.ts` (count-based:
 * `fadeApplications.length >= 2` + `motionSafeMatches.length >= 2`),
 * but those guards prove "the class set appears twice in the source,"
 * not "the runtime evaluation actually applies both classes in Electron
 * at the same time." This smoke closes that gap.
 *
 * Skip conditions match the existing desktop smoke pattern:
 *   - `OK_DESKTOP_E2E_SMOKE !== '1'` — opt-in gate.
 *   - `process.platform !== 'darwin'` — driver uses macOS `open(1)`.
 *   - `out/main/index.js` missing — needs a prior `bun run build:desktop`.
 */

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

test.describe('sidebar search pill — Electron lockstep-fade smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Driver uses macOS open(1) and chrome stack is darwin-only in v0.');
  test.skip(
    !BUILD_EXISTS,
    `Main build missing at ${MAIN_ENTRY} — run "bun run build:desktop" first.`,
  );

  test('expanded → neither row opacity-0; collapsed → BOTH rows opacity-0 (lockstep)', async ({
    captureStderrFor,
  }) => {
    const docName = `sidebar-pill-${randomUUID()}`;
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-sidebar-pill-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
    );
    writeFileSync(
      join(projectDir, `${docName}.md`),
      '# Sidebar Pill Lockstep Fade Smoke\n\nFixture for chrome-row collapse verification.\n',
    );

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDirFor(projectDir)}`],
      timeout: 30_000,
    });
    captureStderrFor(app, { cleanupDirs: [projectDir] });

    // Wait for Navigator (cold-launch first window).
    const firstWindow = await app.firstWindow({ timeout: 15_000 });
    expect(firstWindow).toBeDefined();

    // Open editor via deep-link.
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
    // Capture into a const so closures below keep the narrowed type
    // (biome auto-formats `editorPage!.evaluate(...)` to `page.evaluate(...)`
    // which widens the return to `... | undefined`).
    const page = editorPage;

    // Confirm Electron-mode detection — the opacity gate is keyed on
    // `isElectronHost = window.okDesktop != null`. If this is false the
    // entire test premise fails (we're not actually in Electron mode).
    const isElectronHost = await page.evaluate(
      () => typeof window !== 'undefined' && window.okDesktop != null,
    );
    expect(isElectronHost).toBe(true);

    // Wait for the sidebar to render in expanded state — pill must be
    // present + visible in the DOM before the collapse toggle works.
    const pill = page.getByRole('button', { name: /^Search/ });
    await pill.waitFor({ state: 'visible', timeout: 10_000 });

    // The toolbar row is the inner div that holds the ToolbarButtons,
    // and the pill row is its sibling div between SidebarHeader and
    // SidebarContent. Locate both via stable structural selectors.
    //
    // Toolbar row: an `[data-slot="sidebar-header"]` is the parent;
    // the toolbar inner div is its direct child carrying the
    // `[&>*]:[-webkit-app-region:no-drag]` class fragment in Electron
    // mode. We read the SidebarHeader itself — the opacity gate is on
    // the header element's own className, applied via the
    // `shouldFadeChrome && 'opacity-0'` line in FileSidebar.tsx.
    const collectFadeState = async () => {
      return page.evaluate(() => {
        const header = document.querySelector('[data-slot="sidebar-header"]') as HTMLElement | null;
        // Pill row: the SidebarSearchBar's ancestor div that lives between
        // SidebarHeader and SidebarContent. The pill button itself has the
        // accessible name "Search"; walk up until we hit a div whose
        // sibling is `[data-slot="sidebar-content"]` (matches the
        // sibling-between-header-and-content placement in FileSidebar.tsx).
        const pillButton = document.querySelector(
          'button[data-telemetry-event="ok.sidebar.search_pill.click"]',
        );
        let pillRow: HTMLElement | null = null;
        if (pillButton) {
          let node: HTMLElement | null = pillButton.parentElement as HTMLElement | null;
          while (node) {
            const next = node.nextElementSibling as HTMLElement | null;
            if (next?.dataset?.slot === 'sidebar-content') {
              pillRow = node;
              break;
            }
            node = node.parentElement as HTMLElement | null;
          }
        }
        return {
          sidebarState:
            document.querySelector('[data-slot="sidebar"]')?.getAttribute('data-state') ?? null,
          headerHasOpacity0: header?.classList.contains('opacity-0') ?? null,
          headerHasTransition: header?.className.includes('motion-safe:transition-opacity') ?? null,
          pillRowHasOpacity0: pillRow?.classList.contains('opacity-0') ?? null,
          pillRowHasTransition:
            pillRow?.className.includes('motion-safe:transition-opacity') ?? null,
          pillRowFound: pillRow !== null,
          headerFound: header !== null,
        };
      });
    };

    // Expanded state — neither row should carry opacity-0.
    const expanded = await collectFadeState();
    expect(expanded.headerFound).toBe(true);
    expect(expanded.pillRowFound).toBe(true);
    expect(expanded.sidebarState).toBe('expanded');
    expect(expanded.headerHasOpacity0).toBe(false);
    expect(expanded.pillRowHasOpacity0).toBe(false);
    // Both rows should still carry the transition class so a subsequent
    // collapse animates rather than flips.
    expect(expanded.headerHasTransition).toBe(true);
    expect(expanded.pillRowHasTransition).toBe(true);

    // Toggle collapse via the file-sidebar SidebarTrigger, located by
    // `data-sidebar="trigger"` — the "Hide Files" accessible name is shared
    // with SidebarRail, so a role+name locator is strict-mode-ambiguous.
    // The native View → Show/Hide Sidebar menu item (⌥⌘S) owns the keyboard
    // path in Electron and is unit-tested via `buildMenuTemplate` in
    // menu.test.ts. This routes through the same useSidebar() state that
    // drives the className conditional — no DOM-level mutation, real click.
    await page.locator('[data-sidebar="trigger"]').first().click();

    // Wait for sidebar-state attribute to flip to 'collapsed'. The
    // shadcn Sidebar primitive applies this synchronously to data-state.
    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            document.querySelector('[data-slot="sidebar"]')?.getAttribute('data-state'),
          ),
        { intervals: [50, 50, 100, 200, 500], timeout: 5_000 },
      )
      .toBe('collapsed');

    // Sample a few frames into the animation — the 100ms fade plus
    // motion-safe means by ~200ms in normal-motion mode BOTH rows should
    // have opacity-0 applied. We assert the CLASS presence, not the
    // computed opacity, because the assertion is "both classes apply in
    // lockstep" not "the visual midpoint of the fade is identical"
    // (which is a flake-prone visual claim).
    await expect
      .poll(
        async () => {
          const s = await collectFadeState();
          return s.headerHasOpacity0 && s.pillRowHasOpacity0;
        },
        { intervals: [50, 50, 100, 200], timeout: 2_000 },
      )
      .toBe(true);

    // Final affirmative sample for the artifact.
    const collapsed = await collectFadeState();
    expect(collapsed.sidebarState).toBe('collapsed');
    expect(collapsed.headerHasOpacity0).toBe(true);
    expect(collapsed.pillRowHasOpacity0).toBe(true);
    expect(collapsed.headerHasTransition).toBe(true);
    expect(collapsed.pillRowHasTransition).toBe(true);
  });
});
