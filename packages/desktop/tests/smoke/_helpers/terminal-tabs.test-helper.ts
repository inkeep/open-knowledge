import type { Locator, Page } from '@playwright/test';
import { expect } from './smoke-test';

export const terminalTabs = (page: Page): Locator =>
  page.getByRole('tablist', { name: 'Terminal sessions' }).getByRole('tab');

export const terminalTabRow = (page: Page): Locator =>
  page
    .locator('[data-terminal-tab-row]')
    .filter({ has: page.getByRole('tablist', { name: 'Terminal sessions' }) });

export const terminalTabById = (page: Page, id: string): Locator =>
  page
    .getByRole('tablist', { name: 'Terminal sessions' })
    .locator(`[role="tab"][data-tab-id="${id}"]`);

export async function terminalTabIds(page: Page): Promise<string[]> {
  const ids = await terminalTabs(page).evaluateAll((tabs) =>
    tabs.map((tab) => tab.getAttribute('data-tab-id')),
  );
  if (ids.some((id) => id === null)) throw new Error('terminal tab is missing data-tab-id');
  return ids as string[];
}

export function findNewTerminalTabId(
  beforeIds: readonly string[],
  afterIds: readonly string[],
): string {
  const before = new Set(beforeIds);
  const created = afterIds.filter((id) => !before.has(id));
  if (created.length !== 1) {
    throw new Error(
      `expected exactly one new tab; before=${JSON.stringify(beforeIds)} after=${JSON.stringify(afterIds)}`,
    );
  }
  return created[0] as string;
}

export async function openBareTerminalTab(
  page: Page,
  waitUntilReady: () => Promise<void>,
  timeout = 25_000,
): Promise<string> {
  const beforeIds = await terminalTabIds(page);
  await page.getByTestId('terminal-new-chat-menu').click();
  await page.getByRole('menuitem', { name: 'Terminal' }).click();
  await expect.poll(() => terminalTabIds(page), { timeout }).toHaveLength(beforeIds.length + 1);

  const createdId = findNewTerminalTabId(beforeIds, await terminalTabIds(page));
  await expect(terminalTabById(page, createdId)).toHaveAttribute('aria-selected', 'true', {
    timeout,
  });
  await waitUntilReady();
  return createdId;
}

export async function renameTerminalTab(page: Page, tab: Locator, label: string): Promise<void> {
  await tab.dblclick();
  const input = page.getByRole('textbox', { name: /^Rename/ });
  await input.fill(label);
  await input.press('Enter');
  await expect(tab).toHaveText(label);
}

export async function expectTerminalTabOrder(
  page: Page,
  expectedIds: readonly string[],
  timeout = 5_000,
): Promise<void> {
  await expect.poll(() => terminalTabIds(page), { timeout }).toEqual(expectedIds);
}
