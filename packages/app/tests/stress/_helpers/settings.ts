/**
 * Settings-dialog helpers.
 *
 * The dialog straddles a bundle boundary that every spec reaching a settings
 * panel has to budget for. `SettingsDialogShell` ships in the main bundle, so
 * the frame and the sidebar paint on the same frame as the hash write, while
 * the entire body sits behind ONE `React.lazy` chunk under a single Suspense
 * boundary. A worker's first open therefore pays a cold dev-server transform of
 * the whole schema-form graph, an order of magnitude slower than the warm
 * reopen and well past the config's default expect budget.
 *
 * That cost is a property of the chunk, not of any one spec, so the budget for
 * it lives here rather than in each caller. A visible `settings-dialog` proves
 * only that the shell painted; it says nothing about the body.
 */

import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures.ts';

/**
 * Budget for any wait on content INSIDE the lazy settings body: a panel's own
 * test id, a field row, a scope badge.
 *
 * NOT for a plugin toggle's readiness. That is a distinct budget owned by
 * `setPluginEnabled`, which gates on the config binding rather than the lazy
 * chunk -- putting this constant on a toggle wait re-conflates the two.
 *
 * Sized for the cold transform above rather than for the warm case, and
 * deliberately generous, because putting the long budget on the outcome a test
 * actually needs is what keeps every later assertion short and failing by name.
 * Waits on the shell (`settings-dialog`, sidebar rows, search results) do NOT
 * belong here, since those are main-bundle and paint immediately.
 */
export const SETTINGS_PANEL_TIMEOUT_MS = 30_000;

/**
 * Budget for a plugin toggle to leave the `disabled` state it renders in until
 * the project config binding syncs. Separate from the chunk budget because it
 * is a CRDT round-trip rather than a transform, and it only starts once the
 * body has already painted.
 *
 * Shaped like `CREATE_CONVERGED_TIMEOUT` in `sidebar.ts`, for the reason stated
 * there: an inline `timeout:` OVERRIDES the config's `expect.timeout`, so any
 * number below the platform budget is a NARROWING. On CI this is deliberately
 * EQUAL to that budget, which makes the override inert there and leaves its only
 * real effect the widening of the 5s local default. Raise it if the config's CI
 * budget is ever raised — left behind, it would quietly become the very defect
 * this module exists to prevent.
 */
const PLUGIN_BINDING_TIMEOUT_MS = process.env.CI ? 15_000 : 10_000;

/** Wait for a lazily-rendered settings panel body to paint. */
export async function waitForSettingsPanel(page: Page, panelTestId: string): Promise<void> {
  await expect(page.getByTestId(panelTestId)).toBeVisible({
    timeout: SETTINGS_PANEL_TIMEOUT_MS,
  });
}

/**
 * Deep-link to a settings section and wait for its panel body.
 *
 * `#settings/<section>` is the app's own navigation surface and the body
 * dispatches on the section id alone, so the panel is selected on the dialog's
 * open edge, with no sidebar interaction and no dependency on the THIS PROJECT
 * group staying `disabled` until `collabUrl` resolves.
 *
 * `panelTestId` is explicit rather than derived, because a panel's test id is
 * authored inside its own section component: `preferences` renders
 * `settings-project-preferences`, so a string transform of the section id would
 * silently wait on an id that never attaches.
 */
export async function openSettingsSection(
  page: Page,
  sectionId: string,
  panelTestId: string,
): Promise<void> {
  await page.goto(`/#settings/${sectionId}`);
  await waitForSettingsPanel(page, panelTestId);
}

/**
 * Deep-link to the project Plugins panel and wait for its body.
 *
 * This REPLACES the page: it is a plain `goto`, so nothing in session history
 * precedes the dialog. A spec that asserts on the dialog's `history.back()`
 * close needs the land-then-push-the-hash variant instead — see
 * `openProjectPluginsViaHashPush` in `plugin-enable-notice.e2e.ts`. The two are
 * not merged because the difference IS the thing that spec asserts on.
 */
export async function openProjectPluginsPanel(page: Page): Promise<void> {
  await openSettingsSection(page, 'plugins-manage', 'settings-plugins-manage');
}

/**
 * The enable/disable switch for one plugin on the project Plugins panel.
 *
 * Module-private on purpose. Every caller wants a plugin driven to a KNOWN
 * state, which is `setPluginEnabled`; handing out the bare locator invites the
 * ungated `aria-checked` read that function exists to prevent.
 */
function pluginToggle(page: Page, pluginId: string): Locator {
  return page.getByTestId(`settings-plugin-toggle-${pluginId}`);
}

/**
 * Drive a plugin's switch to `on`, tolerating whatever state a sibling test
 * left behind.
 *
 * The enabled gate is load-bearing, not defensive. The switch renders
 * `disabled` and unchecked until its binding is ready, so an `aria-checked`
 * read before then reports `false` even for a plugin that is already ON. The
 * branch below would then skip its click and wait out an assertion on a value
 * moving the other way, which is a deterministic wrong outcome rather than
 * merely a slow one. Gating on enabled subsumes a visibility wait too, since a
 * toggle inside an unresolved chunk is not enabled either.
 *
 * Callers must already be on the Plugins panel: this gate is budgeted for the
 * config binding, not for the lazy chunk. The confirming assertion inherits the
 * config expect budget, which is higher on CI than a short inline override.
 */
export async function setPluginEnabled(page: Page, pluginId: string, on: boolean): Promise<void> {
  const toggle = pluginToggle(page, pluginId);
  await expect(toggle).toBeEnabled({ timeout: PLUGIN_BINDING_TIMEOUT_MS });
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(on));
}
