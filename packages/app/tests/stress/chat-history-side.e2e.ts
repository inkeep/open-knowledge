import type { Page } from '@playwright/test';
import {
  expect,
  runPaletteCommand,
  stubAgentCatalog,
  test,
  threadRosterDelivered,
} from './_helpers';

const BOOT_TIMEOUT_MS = 30_000;
const AGENTS_PANEL_MOUNT = '[data-agents-panel-mount]';
const HISTORY_SURFACE = '[data-testid="agent-thread-history-surface"]';
const SESSION_SURFACE = '[data-testid="agent-panel-session-surface"]';
const TAB_ROW = `${AGENTS_PANEL_MOUNT} [data-terminal-tab-row]`;

async function openAgentsWithThread(page: Page): Promise<void> {
  await stubAgentCatalog(page);
  await page.setViewportSize({ width: 2200, height: 1000 });
  const roster = threadRosterDelivered(page);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__acpThreadHarness), null, {
    timeout: BOOT_TIMEOUT_MS,
  });
  await roster;
  await page.evaluate(() => {
    const harness = window.__acpThreadHarness;
    if (harness === undefined) throw new Error('ACP thread harness is not installed');
    harness.openThread({
      agent: { id: 'history-side', name: 'Side Agent', source: 'registry' },
      title: 'Side conversation',
    });
  });
  const agents = page.getByTestId('header-pane-button-agents');
  if ((await agents.getAttribute('aria-pressed')) !== 'true') await agents.click();
  await expect(page.locator(AGENTS_PANEL_MOUNT)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
}

function historyToggle(page: Page) {
  return page.locator(AGENTS_PANEL_MOUNT).getByTestId('agent-thread-history');
}

async function openHistory(page: Page): Promise<void> {
  const toggle = historyToggle(page);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.locator(HISTORY_SURFACE)).toBeVisible();
}

async function historySide(page: Page): Promise<'left' | 'right' | 'unsettled'> {
  const [history, session, toggle, row] = await Promise.all([
    page.locator(HISTORY_SURFACE).boundingBox(),
    page.locator(SESSION_SURFACE).boundingBox(),
    historyToggle(page).boundingBox(),
    page.locator(TAB_ROW).boundingBox(),
  ]);
  if (history == null || session == null || toggle == null || row == null) return 'unsettled';
  const toggleNearStart = toggle.x - row.x < row.x + row.width - (toggle.x + toggle.width);
  if (history.x + history.width <= session.x + 1 && toggleNearStart) return 'left';
  if (history.x >= session.x + session.width - 1 && !toggleNearStart) return 'right';
  return 'unsettled';
}

async function expectHistory(page: Page, side: 'left' | 'right'): Promise<void> {
  await expect.poll(() => historySide(page), { timeout: BOOT_TIMEOUT_MS }).toBe(side);
}

async function expectPaletteOffersOnly(
  page: Page,
  offered: string,
  withheld: string,
): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.locator('[data-slot="command-input"]');
  await expect(input).toBeFocused();
  await input.fill('move chat history');
  await expect(page.getByTestId(`command-palette-${offered}`)).toBeVisible();
  await expect(page.getByTestId(`command-palette-${withheld}`)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-slot="command-list"]')).toBeHidden();
}

test.describe('the chat history side', () => {
  test('the palette offers only the move to the other side, and moving docked chat history and its button to the left of the conversation survives a reload', async ({
    page,
  }) => {
    await openAgentsWithThread(page);
    await openHistory(page);
    await expectHistory(page, 'right');
    await expectPaletteOffersOnly(page, 'move-chat-history-left', 'move-chat-history-right');

    await runPaletteCommand(page, 'move chat history left', 'move-chat-history-left');
    await openHistory(page);
    await expectHistory(page, 'left');

    await page.reload();
    await page.waitForFunction(() => Boolean(window.__acpThreadHarness), null, {
      timeout: BOOT_TIMEOUT_MS,
    });
    const agents = page.getByTestId('header-pane-button-agents');
    if ((await agents.getAttribute('aria-pressed')) !== 'true') await agents.click();
    await openHistory(page);
    await expectHistory(page, 'left');
    await expectPaletteOffersOnly(page, 'move-chat-history-right', 'move-chat-history-left');
  });

  test('right-clicking an empty part of the Agents tab strip moves chat history to the other side', async ({
    page,
  }) => {
    await openAgentsWithThread(page);
    await openHistory(page);
    await expectHistory(page, 'right');

    const row = await page.locator(TAB_ROW).boundingBox();
    if (row === null) throw new Error('the Agents tab strip has no layout box');
    await page.mouse.click(row.x + row.width * 0.6, row.y + row.height / 2, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Move chat history to the left' }).click();
    await openHistory(page);
    await expectHistory(page, 'left');
  });

  test('choosing the move from the keyboard leaves focus on the Chat history button at its new end', async ({
    page,
  }) => {
    await openAgentsWithThread(page);
    await openHistory(page);
    await expectHistory(page, 'right');

    await historyToggle(page).focus();
    await page.keyboard.press('Shift+F10');
    const move = page.getByRole('menuitem', { name: 'Move chat history to the left' });
    await expect(move).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(historyToggle(page)).toBeFocused();
    await openHistory(page);
    await expectHistory(page, 'left');
  });
});
