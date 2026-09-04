import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures.ts';

export const SETTINGS_PANEL_TIMEOUT_MS = 30_000;

const PLUGIN_BINDING_TIMEOUT_MS = process.env.CI ? 15_000 : 10_000;

export async function waitForSettingsPanel(page: Page, panelTestId: string): Promise<void> {
  await expect(page.getByTestId(panelTestId)).toBeVisible({
    timeout: SETTINGS_PANEL_TIMEOUT_MS,
  });
}

export async function openSettingsSection(
  page: Page,
  sectionId: string,
  panelTestId: string,
): Promise<void> {
  await page.goto(`/#settings/${sectionId}`);
  await waitForSettingsPanel(page, panelTestId);
}

export async function openProjectPluginsPanel(page: Page): Promise<void> {
  await openSettingsSection(page, 'plugins-manage', 'settings-plugins-manage');
}

function pluginToggle(page: Page, pluginId: string): Locator {
  return page.getByTestId(`settings-plugin-toggle-${pluginId}`);
}

export async function setPluginEnabled(page: Page, pluginId: string, on: boolean): Promise<void> {
  const toggle = pluginToggle(page, pluginId);
  await expect(toggle).toBeEnabled({ timeout: PLUGIN_BINDING_TIMEOUT_MS });
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(on));
}
