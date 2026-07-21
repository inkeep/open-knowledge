/**
 * Open-in-Agent handoff matrix.
 *
 * Entry point: the file-sidebar right-click "Open with AI" submenu
 * (`OpenInAgentContextSubmenu`, mounted inside `FileTree`'s row context menu).
 * The top-toolbar Open-with-AI trigger was removed when Ask AI became the
 * single editor entry point; this is the surviving deep-link handoff surface.
 * It renders the SAME target set with the same `claude-cowork` exclusion
 * (`VISIBLE_TARGETS`) the old toolbar menu used, so every cell's dispatch
 * coverage carries over — only the way the menu is OPENED
 * changes (right-click the seeded doc's sidebar row → expand the "Open with AI"
 * submenu → click `file-tree-open-in-<target>`).
 *
 * Per-target rows carry `data-testid="file-tree-open-in-<target.id>"`
 * (e.g. `file-tree-open-in-cursor`); seeded in-app agent rows carry
 * `file-tree-open-in-thread-<agent.id>`. Desktop rows are gated by ENABLEMENT
 * (the Configure-agents toggle), not install detection: Desktop targets are OFF
 * by default, so a cell that expects a Desktop row seeds an enable override via
 * `enableDesktopTargets` before boot. Install state only decides, for an enabled
 * row, whether selecting it dispatches (installed) or opens the installer (not).
 *
 * Cell coverage:
 *   - Cells 1, 4: cowork-UI-hidden invariant — `claude-cowork` is filtered
 *     out of the submenu by `VISIBLE_TARGETS` even when enabled + `claude: true`.
 *     Dispatch by ID still works through `KNOWN_TARGETS` (covered by
 *     `useHandoffDispatch.test.ts`); these cells guard only the render-surface
 *     hide. Cells 2, 8: happy paths for enabled + installed targets.
 *   - Cell 3: an enabled-but-not-installed Desktop target still renders
 *     (visibility is enablement-based) and selecting it opens the installer
 *     instead of dispatching.
 *   - Cell 5: Web Cursor happy path — POSTs to `/api/handoff` (target:
 *     `cursor`, with `workspacePath`) and asserts on the captured request.
 *     Server owns the `cursor <path>` + `open <url>` recipe; renderer just
 *     builds the URL and POSTs. This cell is the web mirror of cell 2.
 *   - Cell 7: with Desktop off and nothing installed, every per-target row is
 *     hidden, but the seeded in-app agent rows still render.
 * Each cell maps to the numbered scenarios in that section. Mocking at the
 * `window.okDesktop` bridge boundary (Electron host) + `page.route` on
 * `/api/installed-agents` (web host) via `fixtures/handoff-mocks.ts`.
 *
 * Key choices (debated at implementation time):
 *   - Real-server handoff dispatch is mocked. CI runners generally do not
 *     have Claude / Codex / Cursor installed, and even if they did, dispatching
 *     the URL would black-box the assertion. The mock lets us assert the exact
 *     dispatched URL, the call count, and the order.
 *   - Anchor-click swallowed for handoff schemes via `HTMLAnchorElement.
 *     prototype.click` override. Without this, Chromium would attempt to
 *     navigate to `claude://` etc., triggering a protocol-handler dialog
 *     (ignored in headless) OR a real navigation to `https://claude.ai/...`
 *     (would leave the app). See `handoff-mocks.ts` for the full rationale.
 *   - Cell 3 seeds an enable override for a Desktop target the probe reports NOT
 *     installed, then asserts the row still renders (visibility is enablement-
 *     based) and that selecting it opens the installer rather than dispatching a
 *     handoff.
 *
 * Host-specific notes:
 *   - Electron host cells MUST inject `window.okDesktop` via `addInitScript`
 *     BEFORE `page.goto(...)`. Setting it after hydration would race with
 *     `useCollabUrl` + `useWorkspace` boot logic.
 *   - Web host cells leave `window.okDesktop` undefined. The app falls
 *     through to `GET /api/workspace` (served by the real worker server)
 *     and `GET /api/installed-agents` (intercepted by the fixture).
 *   - The submenu's per-file `input` is built from the right-clicked node's
 *     `docName` + the workspace resolved via `GET /api/workspace` (host-
 *     agnostic — the worker server serves it in both host modes). With the
 *     workspace resolved the rows are enabled, not "No workspace"-disabled.
 */

import { realpathSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';
import {
  type HandoffMockConfig,
  installHandoffMocks,
  readCapturedHandoff,
} from './fixtures/handoff-mocks';

const DOC_NAME = 'handoff-test-doc';
const DOC_MARKDOWN = '# Handoff Test Doc\n\nBody paragraph for the handoff matrix.';

/**
 * Resolve the worker's contentDir to its canonical path. On macOS the tmpdir
 * (`/var/folders/...`) is a symlink to `/private/var/folders/...`. The server's
 * `/api/workspace` handler calls `realpathSync`, so web-host cells see the
 * resolved path; Electron-host cells see whatever we inject into
 * `bridge.config.projectPath`. Using `realpathSync` on both sides keeps the
 * test deterministic regardless of the symlink shape on the runner.
 */
function resolvedContentDir(contentDir: string): string {
  try {
    return realpathSync(contentDir);
  } catch {
    return contentDir;
  }
}

/** Sidebar-scoped locator for the seeded doc's tree row. The handoff entry
 *  point lives on this row's right-click context menu. */
function seededDocRow(page: Page) {
  return page
    .locator('[data-slot="sidebar-container"]')
    .getByRole('treeitem', { name: `${DOC_NAME}.md`, exact: true });
}

async function seedAndNavigate(
  page: Page,
  api: { seedDocs: (docs: Array<{ name: string; markdown: string }>) => Promise<void> },
): Promise<void> {
  await api.seedDocs([{ name: DOC_NAME, markdown: DOC_MARKDOWN }]);
  await page.goto(`/#/${DOC_NAME}`);
  await waitForActiveProviderSynced(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  // The handoff submenu lives on the sidebar row's context menu; wait until
  // the row has rendered before exercising it. (Both host paths populate the
  // sidebar from `GET /api/documents` served by the worker server.)
  await expect(seededDocRow(page)).toBeVisible({ timeout: 15_000 });
}

/**
 * Right-click the seeded doc's sidebar row and expand its "Open with AI"
 * submenu so the `file-tree-open-in-*` rows are mounted + actionable.
 *
 * The submenu is a Radix `DropdownMenuSub` whose `DropdownMenuSubContent`
 * only mounts once the submenu trigger ("Open with AI", `role="menuitem"`)
 * is opened. Clicking the trigger opens it deterministically (hover-open can
 * race the row-context-menu's own open animation under CI load).
 */
async function openHandoffSubmenu(page: Page): Promise<void> {
  await seededDocRow(page).click({ button: 'right' });
  const submenuTrigger = page.getByRole('menuitem', { name: 'Open with AI' });
  await expect(submenuTrigger).toBeVisible({ timeout: 10_000 });
  await submenuTrigger.click();
}

/**
 * Enable Desktop targets in the Configure-agents store before boot. Desktop
 * hand-offs are OFF by default (opt-in), so a cell that expects a Desktop row
 * must enable it first — the same override the user writes by flipping the
 * toggle in Settings → Configure agents. Visibility now derives from enablement,
 * not install detection; install state only decides dispatch-vs-installer.
 *
 * Call BEFORE `page.goto(...)` — `addInitScript` runs on the fresh document.
 */
async function enableDesktopTargets(page: Page, targetIds: readonly string[]): Promise<void> {
  await page.addInitScript((ids: readonly string[]) => {
    const overrides: Record<string, boolean> = {};
    for (const id of ids) overrides[`desktop:${id}`] = true;
    window.localStorage.setItem('ok-acp-enabled-agents-v1', JSON.stringify(overrides));
  }, targetIds);
}

/**
 * Register in-app agents in the Configure-agents store before boot. Seeding was
 * retired — per-agent thread rows now render for the user's ENABLED in-app
 * agents — so a cell that expects a thread row registers it here, the same store
 * `registerAgent` writes when the user turns one on in Settings. Call BEFORE
 * `page.goto(...)`.
 */
async function registerInAppAgents(
  page: Page,
  agents: ReadonlyArray<{ source: string; id: string; name: string }>,
): Promise<void> {
  await page.addInitScript((list: ReadonlyArray<{ source: string; id: string }>) => {
    const first = list[0];
    window.localStorage.setItem(
      'ok-acp-registered-agents-v1',
      JSON.stringify({ agents: list, defaultKey: first ? `${first.source}:${first.id}` : null }),
    );
  }, agents);
}

/**
 * Wait until the install-state probe has resolved. Before the probe lands,
 * the submenu filters out every `installed: null` row and shows the
 * "Checking for installed agents" hint, so the installed rows the cells assert
 * on are absent until the probe settles.
 *
 * - Electron host: `detectProtocolCalls.length` grows to 3 once each unique
 *   scheme has been probed (the fixture mock resolves each immediately).
 * - Web host: the fixture's `window.fetch` wrapper sets
 *   `installedAgentsFetchResolved` after the single `/api/installed-agents`
 *   response lands. The React hook's state update is microtask-cheap; we
 *   rely on Playwright's internal retry window for the assertions that follow.
 */
async function waitForProbeSettled(page: Page, host: 'electron' | 'web'): Promise<void> {
  if (host === 'electron') {
    await expect
      .poll(async () => (await readCapturedHandoff(page)).detectProtocolCalls.length, {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(3);
    return;
  }
  await expect
    .poll(
      async () => {
        return await page.evaluate(() => {
          // biome-ignore lint/suspicious/noExplicitAny: test-only global attachment.
          const mocks = (window as any).__handoffMocks__;
          return Boolean(mocks?.installedAgentsFetchResolved);
        });
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

test.describe('handoff — 8-cell matrix', () => {
  test('cell 1: Electron — claude-cowork row stays hidden even when Claude Desktop is installed', async ({
    page,
    api,
    workerServer,
  }) => {
    // Cowork is UI-hidden by VISIBLE_TARGETS regardless of install state.
    // Dispatch by ID (deep links, programmatic callers) still works through
    // KNOWN_TARGETS in `useHandoffDispatch`, so this test guards only the
    // render-surface invariant: the row must not appear in the submenu.
    const cfg: HandoffMockConfig = {
      host: 'electron',
      install: { claude: true, codex: true, cursor: true },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: resolvedContentDir(workerServer.contentDir),
    };
    await installHandoffMocks(page, cfg);
    // Desktop rows are opt-in — enable the visible targets so their rows render.
    await enableDesktopTargets(page, ['claude-code', 'codex', 'cursor']);
    await seedAndNavigate(page, api);

    await waitForProbeSettled(page, 'electron');
    await openHandoffSubmenu(page);

    // Enabled sibling rows render…
    await expect(page.getByTestId('file-tree-open-in-claude-code')).toBeVisible();
    await expect(page.getByTestId('file-tree-open-in-codex')).toBeVisible();
    await expect(page.getByTestId('file-tree-open-in-cursor')).toBeVisible();

    // …but the cowork row is filtered out by VISIBLE_TARGETS even when enabled +
    // `claude: true`. No way to click it, no way to dispatch from the UI.
    await expect(page.getByTestId('file-tree-open-in-claude-cowork')).toHaveCount(0);
  });

  test('cell 2: Electron Cursor two-step spawn → single prompt URL dispatch + success toast', async ({
    page,
    api,
    workerServer,
  }) => {
    const cfg: HandoffMockConfig = {
      host: 'electron',
      install: { claude: true, codex: true, cursor: true },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: resolvedContentDir(workerServer.contentDir),
    };
    await installHandoffMocks(page, cfg);
    await enableDesktopTargets(page, ['claude-code', 'codex', 'cursor']);
    await seedAndNavigate(page, api);

    await waitForProbeSettled(page, 'electron');
    await openHandoffSubmenu(page);
    await page.getByTestId('file-tree-open-in-cursor').click();

    // Dispatch goes through POST /api/handoff with target='cursor' + URL +
    // workspacePath. Server-side recipe orchestrates `cursor <path>` + URL.
    await expect
      .poll(async () => (await readCapturedHandoff(page)).handoffApiCalls.length, {
        timeout: 5_000,
      })
      .toBe(1);
    const captured = await readCapturedHandoff(page);
    const call = captured.handoffApiCalls[0];
    expect(call?.target).toBe('cursor');
    expect(call?.workspacePath).toBe(resolvedContentDir(workerServer.contentDir));
    const u = new URL(call?.url ?? '');
    expect(u.protocol).toBe('cursor:');
    expect(u.hostname).toBe('anysphere.cursor-deeplink');
    expect(u.pathname).toBe('/prompt');
    expect(u.searchParams.get('mode')).toBe('agent');
    // Prompt is threaded through all scopes via Cursor's double-
    // encoded text= param. precedent #25 invariant preserved — the URL
    // never carries file content / `file=` attach (the prompt is a short
    // directive composed by the dispatch hook). Agent still grounds via OK MCP.
    expect(u.searchParams.get('text')).toBeTruthy();
    expect(u.searchParams.get('workspace')).toBeTruthy();

    await expect(page.getByText('Opened in Cursor.')).toBeVisible();
  });

  test('cell 3: Electron enabled-but-not-installed Desktop target renders and routes to its installer', async ({
    page,
    api,
    workerServer,
  }) => {
    // Codex is enabled in Configure agents but the probe reports it not
    // installed. Visibility is enablement-based now (not install-based), so the
    // row renders anyway; selecting it opens the installer (openInstallUrl →
    // openExternal) instead of dispatching a handoff.
    const cfg: HandoffMockConfig = {
      host: 'electron',
      install: { claude: true, codex: false, cursor: true },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: resolvedContentDir(workerServer.contentDir),
    };
    await installHandoffMocks(page, cfg);
    await enableDesktopTargets(page, ['codex', 'cursor']);
    await seedAndNavigate(page, api);

    await waitForProbeSettled(page, 'electron');
    await openHandoffSubmenu(page);

    // Enabled → visible, even though codex is not installed on this host.
    const codexRow = page.getByTestId('file-tree-open-in-codex');
    await expect(codexRow).toBeVisible();
    await codexRow.click();

    // Not installed → the installer opens; no handoff dispatch fires.
    await expect
      .poll(async () => (await readCapturedHandoff(page)).openExternalCalls.length, {
        timeout: 5_000,
      })
      .toBe(1);
    const captured = await readCapturedHandoff(page);
    expect(captured.openExternalCalls[0]).toBe('https://openai.com/codex');
    expect(captured.handoffApiCalls.length).toBe(0);
  });

  test('cell 4: Web — claude-cowork row stays hidden even when probe reports installed', async ({
    page,
    api,
    workerServer,
  }) => {
    // Web mirror of cell 1: cowork is filtered out of the submenu by
    // VISIBLE_TARGETS regardless of `/api/installed-agents` response. Programmatic
    // dispatch by ID still works for power users; the UI surface does not
    // expose the row.
    const cfg: HandoffMockConfig = {
      host: 'web',
      install: { claude: true, codex: true, cursor: true },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: resolvedContentDir(workerServer.contentDir),
    };
    await installHandoffMocks(page, cfg);
    await enableDesktopTargets(page, ['claude-code', 'codex', 'cursor']);
    await seedAndNavigate(page, api);

    await waitForProbeSettled(page, 'web');
    await openHandoffSubmenu(page);

    await expect(page.getByTestId('file-tree-open-in-claude-code')).toBeVisible();
    await expect(page.getByTestId('file-tree-open-in-claude-cowork')).toHaveCount(0);
  });

  test('cell 5: Web Cursor happy path → POST /api/handoff (target=cursor, workspacePath) + cursor:// URL', async ({
    page,
    api,
    workerServer,
  }) => {
    // Web host POSTs to /api/handoff same as Electron — the renderer is
    // transport-agnostic. Server-side recipe orchestrates `cursor <path>` +
    // URL. The fixture intercepts the POST and captures the body.
    const cfg: HandoffMockConfig = {
      host: 'web',
      install: { claude: true, codex: true, cursor: true },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: resolvedContentDir(workerServer.contentDir),
    };
    await installHandoffMocks(page, cfg);
    await enableDesktopTargets(page, ['claude-code', 'codex', 'cursor']);
    await seedAndNavigate(page, api);

    await waitForProbeSettled(page, 'web');
    await openHandoffSubmenu(page);

    // Cursor row is rendered because it is enabled in Configure agents; the
    // probe says `cursor: true`, so selecting it dispatches (rather than routing
    // to the installer).
    await page.getByTestId('file-tree-open-in-cursor').click();

    await expect
      .poll(async () => (await readCapturedHandoff(page)).handoffApiCalls.length, {
        timeout: 5_000,
      })
      .toBe(1);
    const captured = await readCapturedHandoff(page);
    const call = captured.handoffApiCalls[0];
    expect(call?.target).toBe('cursor');
    expect(call?.workspacePath).toBe(resolvedContentDir(workerServer.contentDir));
    const u = new URL(call?.url ?? '');
    expect(u.protocol).toBe('cursor:');
    expect(u.hostname).toBe('anysphere.cursor-deeplink');
    expect(u.pathname).toBe('/prompt');
    expect(u.searchParams.get('mode')).toBe('agent');
    // Prompt is threaded through all scopes via Cursor's double-
    // encoded text= param. precedent #25 invariant preserved — the URL
    // never carries file content / `file=` attach (the prompt is a short
    // directive composed by the dispatch hook). Agent still grounds via OK MCP.
    expect(u.searchParams.get('text')).toBeTruthy();
    expect(u.searchParams.get('workspace')).toBeTruthy();

    await expect(page.getByText('Opened in Cursor.')).toBeVisible();

    // Web host has no bridge openExternal surface — and the renderer doesn't
    // fire URLs directly anymore (server does), so neither bridge is invoked.
    expect(captured.openExternalCalls.length).toBe(0);
    expect(captured.anchorClicks.length).toBe(0);
  });

  test('cell 7: Web — every per-target Desktop row hidden, seeded in-app agent rows still offered, no claude.ai fallback', async ({
    page,
    api,
    workerServer,
  }) => {
    const cfg: HandoffMockConfig = {
      host: 'web',
      install: { claude: false, codex: false, cursor: false },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: resolvedContentDir(workerServer.contentDir),
    };
    await installHandoffMocks(page, cfg);
    // The user has an enabled in-app agent (seeding is retired; enablement is the
    // source of truth), so its per-agent thread row is offered below.
    await registerInAppAgents(page, [{ source: 'registry', id: 'claude-acp', name: 'Claude' }]);
    await seedAndNavigate(page, api);

    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await waitForProbeSettled(page, 'web');
    await openHandoffSubmenu(page);

    // Every per-target Desktop row is hidden (Desktop is opt-in and nothing is
    // enabled here), and there's no claude.ai web fallback. The submenu is still
    // not a dead end: the enabled in-app agent is server-hosted, so its per-agent
    // thread row renders even with zero installed editors (the old generic "Start
    // an agent" row + "no installed agents" hint are gone).
    for (const id of ['claude-cowork', 'claude-code', 'codex', 'cursor']) {
      await expect(page.getByTestId(`file-tree-open-in-${id}`)).toHaveCount(0);
    }
    await expect(page.getByTestId('open-in-agent-claude-web-fallback')).toHaveCount(0);
    await expect(page.getByTestId('file-tree-open-in-thread-claude-acp')).toBeVisible();
    await expect(page.getByTestId('file-tree-open-in-empty')).toHaveCount(0);

    // Defensive: the menu render path must not have thrown.
    expect(consoleErrors.filter((e) => !e.includes('net::') && !e.includes('favicon'))).toEqual([]);

    // No dispatches should have fired.
    const captured = await readCapturedHandoff(page);
    expect(captured.anchorClicks).toEqual([]);
    expect(captured.openExternalCalls).toEqual([]);
  });

  test('cell 8: Electron Cursor handoff failure → failure toast + error telemetry line', async ({
    page,
    api,
    workerServer,
  }) => {
    const cfg: HandoffMockConfig = {
      host: 'electron',
      install: { claude: true, codex: true, cursor: true },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: resolvedContentDir(workerServer.contentDir),
    };
    await installHandoffMocks(page, cfg);
    // Override the default /api/handoff intercept to return 422 (Cursor not
    // installed on this host). The renderer's `dispatchHandoff` maps 422 to
    // `{ok:false, reason:'not-installed'}` which surfaces the failure toast
    // + telemetry error line.
    await page.unroute('**/api/handoff');
    await page.route('**/api/handoff', async (route) => {
      await route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'urn:ok:error:handoff-target-not-installed',
          title: 'Cursor CLI not found on this machine.',
          status: 422,
          target: 'cursor',
        }),
      });
    });
    await enableDesktopTargets(page, ['claude-code', 'codex', 'cursor']);
    await seedAndNavigate(page, api);

    await waitForProbeSettled(page, 'electron');
    await openHandoffSubmenu(page);
    await page.getByTestId('file-tree-open-in-cursor').click();

    await expect
      .poll(async () => (await readCapturedHandoff(page)).handoffApiCalls.length, {
        timeout: 5_000,
      })
      .toBe(1);

    // Failure toast + Retry button visible (sonner error toast).
    await expect(page.getByText("Couldn't reach Cursor — try again?")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

    const captured = await readCapturedHandoff(page);
    // Renderer no longer fires openExternal / anchor clicks (server does).
    expect(captured.openExternalCalls).toEqual([]);

    // Telemetry: one error line with the not-installed reason.
    expect(captured.recordHandoffCalls.length).toBe(1);
    const [line] = captured.recordHandoffCalls;
    expect(line?.target).toBe('cursor');
    expect(line?.host).toBe('electron');
    expect(line?.outcome).toBe('error');
    expect(line?.reason).toBe('not-installed');
  });
});
