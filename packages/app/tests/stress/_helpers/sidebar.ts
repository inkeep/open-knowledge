/**
 * Sidebar interaction helpers.
 *
 * Locators must be scoped to `[data-slot="sidebar-container"]` to avoid
 * Playwright strict-mode violations against the EditorHeader, which displays
 * the active document name as text and would otherwise also match.
 *
 * Hash-URL navigation is the preferred cold-nav path — reach for
 * `page.goto(`${BASE}/#/${docName}`)` first. `sidebarFileButton` exists for
 * tests that exercise the click-the-sidebar user journey explicitly.
 */

import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures.ts';

/**
 * Sidebar-scoped locator for the file-row button matching `name` exactly.
 * Use for tests that need to click through the sidebar user journey.
 */
export function sidebarFileButton(page: Page, name: string): Locator {
  const sidebar = page.locator('[data-slot="sidebar-container"]');
  return sidebar.getByText(name, { exact: true });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sidebarTreeItem(page: Page, name: string): Locator {
  return page
    .locator('[data-slot="sidebar-container"]')
    .getByRole('treeitem', { name, exact: true });
}

function activeEditorTabButton(page: Page, name: string): Locator {
  return page.locator('[data-active-tab="true"]').getByRole('button', { name, exact: true });
}

/**
 * Budget for the create-commit pipeline (rename-input commit → server
 * round-trip → sidebar tree refresh → tab activation → route update). The
 * stages converge at different times under load, so each wait below gets the
 * full budget. An explicit per-assertion timeout OVERRIDES the config-level
 * `expect.timeout`, so this must never be lower than the environment's
 * default budget (15s on CI) — and locally it must exceed the 5s default,
 * which a cold-boot create (first run after a fresh install seeds the Vite
 * cache and the git-aware rename path) demonstrably blows through.
 */
const CREATE_CONVERGED_TIMEOUT = process.env.CI ? 15_000 : 10_000;

/**
 * Create a folder through the sidebar's New folder flow with an explicit
 * name, and return only once the app has fully converged: sidebar row
 * rendered, folder tab active, and the URL on the folder route.
 *
 * Folder-create navigates into the new folder, so the route flips to
 * `#/<name>/` (trailing slash). The three converged signals land in
 * pipeline order but at load-dependent times — asserting only one of them
 * (or asserting the URL with a short budget) races the others; a bare
 * `toHaveURL` here is exactly what exhausted retries on CI. Callers chain
 * their scenario-specific assertions after this resolves.
 *
 * For DEFAULT-named creates (commit without typing), use the poll-based
 * commit helpers in `file-tree-create.e2e.ts` — a default create can
 * auto-commit by blur before the rename input is ever visible, which this
 * helper's unconditional fill would miss.
 */
export async function createFolderViaSidebar(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  const input = page.getByRole('textbox', { name: /rename New Folder/i });
  await expect(input).toBeVisible({ timeout: CREATE_CONVERGED_TIMEOUT });
  await input.fill(name);
  await input.press('Enter');

  await expect(sidebarTreeItem(page, name)).toBeVisible({ timeout: CREATE_CONVERGED_TIMEOUT });
  await expect(activeEditorTabButton(page, `${name}/`)).toBeVisible({
    timeout: CREATE_CONVERGED_TIMEOUT,
  });
  await expect(page).toHaveURL(new RegExp(`#/${escapeRegExp(name)}/$`), {
    timeout: CREATE_CONVERGED_TIMEOUT,
  });
}

/**
 * File counterpart of {@link createFolderViaSidebar}: create a markdown file
 * through the sidebar's New file flow with an explicit name and await full
 * convergence (sidebar row, active tab, doc route `#/<name>` without the
 * `.md` extension).
 */
export async function createFileViaSidebar(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  const input = page.getByRole('textbox', { name: /rename Untitled\.md/i });
  await expect(input).toBeVisible({ timeout: CREATE_CONVERGED_TIMEOUT });
  await input.fill(name);
  await input.press('Enter');

  await expect(sidebarTreeItem(page, `${name}.md`)).toBeVisible({
    timeout: CREATE_CONVERGED_TIMEOUT,
  });
  await expect(activeEditorTabButton(page, `${name}.md`)).toBeVisible({
    timeout: CREATE_CONVERGED_TIMEOUT,
  });
  await expect(page).toHaveURL(new RegExp(`#/${escapeRegExp(name)}$`), {
    timeout: CREATE_CONVERGED_TIMEOUT,
  });
}
