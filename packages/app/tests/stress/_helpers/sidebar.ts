
import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures.ts';

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

const CREATE_CONVERGED_TIMEOUT = process.env.CI ? 15_000 : 10_000;

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
