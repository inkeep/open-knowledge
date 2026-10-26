import type { Page } from '@playwright/test';
import { AGENT_PRESENCE_STALE_MS } from '../../src/lib/agent-presence';
import { type ApiHelpers, expect, test, waitForActiveProviderSynced } from './_helpers';

const NARROW_VIEWPORT = { width: 320, height: 720 };
const FOLDED_WITHOUT_PRESENCE_VIEWPORT = { width: 240, height: 720 };

test.use({ locale: 'en-US' });

async function recordInsertions(page: Page, selectors: readonly string[]) {
  return page.evaluateHandle((targets) => {
    const counts = targets.map(() => 0);
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          targets.forEach((target, index) => {
            if (node.matches(target) || node.querySelector(target) !== null) counts[index] += 1;
          });
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
    return counts;
  }, selectors);
}

async function collapseWithPresence(page: Page, api: ApiHelpers) {
  const docName = `header-presence-${crypto.randomUUID()}`;
  await api.seedDocs([{ name: docName, markdown: '# Header presence\n' }]);
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await page.evaluate(() => document.fonts.ready);

  const header = page.locator('[data-app-header]');
  const settings = header.getByRole('button', { name: 'Settings', exact: true });
  const trigger = header.getByTestId('header-overflow-actions-trigger');
  const menu = page.locator('[data-header-overflow-actions]');
  const badge = page.locator('[data-presence-badge="agent"]');
  const share = header.getByRole('button', { name: 'Share doc', exact: true });
  const presenceBar = header.locator('[data-slot="presence-bar"]');

  await page.setViewportSize(NARROW_VIEWPORT);
  await expect(settings).toBeVisible();
  await expect(trigger).toHaveCount(0);
  await expect(badge).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.clock.setFixedTime(Date.now());
  await api.writeAsAgent(docName, '# Header presence\n\nAgent update.\n', {
    agentId: `header-agent-${crypto.randomUUID()}`,
    agentName: 'Header agent',
    clientName: 'codex',
  });
  await expect(badge).toBeVisible();
  await page.setViewportSize(NARROW_VIEWPORT);
  await expect(trigger).toBeVisible();
  await expect(settings).toHaveCount(0);
  return { header, settings, trigger, menu, badge, share, presenceBar };
}

test('expired presence restores inline header actions with the menu closed', async ({
  page,
  api,
}) => {
  const { settings, trigger } = await collapseWithPresence(page, api);

  await page.clock.setFixedTime(Date.now() + AGENT_PRESENCE_STALE_MS);

  await expect(settings).toBeVisible();
  await expect(trigger).toHaveCount(0);
  expect(page.viewportSize()).toEqual(NARROW_VIEWPORT);
});

test('expired presence keeps the open header menu until dismissal then restores inline actions', async ({
  page,
  api,
}) => {
  const { settings, trigger, menu, badge } = await collapseWithPresence(page, api);
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(badge).toBeVisible();
  const openMenu = await menu.evaluateHandle((element) => element);
  const menuSettings = menu.getByRole('button', { name: 'Settings', exact: true });
  await menuSettings.focus();
  await expect(menuSettings).toBeFocused();

  await page.clock.setFixedTime(Date.now() + AGENT_PRESENCE_STALE_MS);
  await expect(badge).toHaveCount(0);
  await expect(menu).toBeVisible();
  expect(await openMenu.evaluate((element) => element.isConnected)).toBe(true);
  await expect(menuSettings).toBeFocused();

  await trigger.click();
  await expect(menu).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(trigger).toHaveCount(0);
  expect(page.viewportSize()).toEqual(NARROW_VIEWPORT);
  await openMenu.dispose();
});

test('unchanged fresh presence keeps header actions folded across menu and resize updates', async ({
  page,
  api,
}) => {
  const { settings, trigger, menu, badge } = await collapseWithPresence(page, api);
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(badge).toBeVisible();
  await trigger.click();
  await expect(menu).toHaveCount(0);

  for (const width of [319, 320]) {
    await page.setViewportSize({ width, height: NARROW_VIEWPORT.height });
    await expect(trigger).toBeVisible();
    await expect(settings).toHaveCount(0);
  }

  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(badge).toBeVisible();
});

test('expired presence keeps focus on the More actions trigger while the header stays folded', async ({
  page,
  api,
}) => {
  await page.clock.install();
  const { settings, trigger, menu } = await collapseWithPresence(page, api);
  await page.setViewportSize(FOLDED_WITHOUT_PRESENCE_VIEWPORT);
  await expect(trigger).toBeVisible();
  await expect(settings).toHaveCount(0);
  await trigger.focus();
  await expect(trigger).toBeFocused();

  await page.clock.setFixedTime(Date.now() + AGENT_PRESENCE_STALE_MS);
  await page.clock.runFor(AGENT_PRESENCE_STALE_MS);

  await expect(trigger).toBeFocused();
  await expect(trigger).toBeVisible();
  await expect(settings).toHaveCount(0);

  const insertions = await recordInsertions(page, [
    '[data-header-overflow-actions]',
    '[data-presence-badge="agent"]',
  ]);
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  const [menuInsertions, badgeInsertions] = await insertions.evaluate((counts) => counts);
  expect(menuInsertions).toBeGreaterThan(0);
  expect(badgeInsertions).toBe(0);
  await insertions.dispose();
});

test('dismissing the header menu after presence expiry moves focus to the first restored header action', async ({
  page,
  api,
}) => {
  const { settings, trigger, menu, badge, share, presenceBar } = await collapseWithPresence(
    page,
    api,
  );
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(badge).toBeVisible();
  const menuShare = menu.getByRole('button', { name: 'Share doc', exact: true });
  await menuShare.focus();
  await expect(menuShare).toBeFocused();

  await page.clock.setFixedTime(Date.now() + AGENT_PRESENCE_STALE_MS);
  await expect(badge).toHaveCount(0);
  await expect(menu).toBeVisible();
  await expect(menuShare).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(trigger).toHaveCount(0);
  await expect(presenceBar).toHaveCount(0);
  await expect(share).toBeFocused();
});

test('expired presence that unfolds the header moves trigger focus to the first restored header action', async ({
  page,
  api,
}) => {
  const { settings, trigger, share, presenceBar } = await collapseWithPresence(page, api);
  await trigger.focus();
  await expect(trigger).toBeFocused();

  await page.clock.setFixedTime(Date.now() + AGENT_PRESENCE_STALE_MS);
  await expect(settings).toBeVisible();
  await expect(trigger).toHaveCount(0);
  await expect(presenceBar).toHaveCount(0);
  await expect(share).toBeFocused();
});

test('expired presence leaves focus outside the header where it was', async ({ page, api }) => {
  const { settings, trigger } = await collapseWithPresence(page, api);
  const editorView = page.locator('.ProseMirror:not(.composer-prosemirror)');
  await editorView.getByText('Agent update.').click();
  await expect(editorView).toBeFocused();

  await page.clock.setFixedTime(Date.now() + AGENT_PRESENCE_STALE_MS);
  await expect(settings).toBeVisible();
  await expect(trigger).toHaveCount(0);
  expect(await page.evaluate(() => window.__activeEditor?.view.hasFocus())).toBe(true);
});
