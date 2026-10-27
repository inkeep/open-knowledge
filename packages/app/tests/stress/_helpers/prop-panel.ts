import type { Locator, Page } from '@playwright/test';

export async function openPropPanel(page: Page): Promise<Locator> {
  const wrapper = page.locator('[data-jsx-component]').first();
  await wrapper.waitFor({ state: 'visible', timeout: 5000 });
  await wrapper.hover();
  const gear = wrapper.locator('button[aria-label*="properties"]').first();
  await gear.waitFor({ state: 'visible', timeout: 5000 });
  await gear.click({ force: true });
  const panel = page.locator('[data-prop-panel]').first();
  await panel.waitFor({ state: 'visible', timeout: 5000 });
  return panel;
}
