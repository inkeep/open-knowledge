import type { Locator, Page } from '@playwright/test';
import {
  TERMINAL_PLACEMENT_KEY,
  type TerminalPlacement,
} from '../../../src/lib/terminal-placement-store';
import { acpCatalogBody } from './acp-catalog.ts';
import { openDesktopHeader } from './app-header-host.ts';
import { expect } from './fixtures.ts';
import { waitForActiveProviderSynced } from './provider.ts';

export type HeaderPane = 'editor' | 'agents' | 'terminal';

export interface LayoutViewport {
  readonly width: number;
  readonly height: number;
}

export interface DesktopLayoutOptions {
  readonly viewport: LayoutViewport;
  readonly terminalPlacement: TerminalPlacement;
}

const BOOT_TIMEOUT_MS = 30_000;

export const EDITOR_PANE_CARD = '[data-slot="pane-card"][data-pane="editor"]';
export const CHAT_PANE_CARD = '[data-slot="pane-card"][data-pane="agents"]';

export function terminalPaneCard(placement: TerminalPlacement): string {
  return `[data-slot="pane-card"][data-pane="terminal"][data-placement="${placement}"]`;
}

export function headerPaneButton(page: Page, pane: HeaderPane): Locator {
  return page.getByTestId(`header-pane-button-${pane}`);
}

export async function stubAgentCatalog(page: Page): Promise<void> {
  await page.route('**/api/acp/catalog', (route) => route.fulfill({ json: acpCatalogBody([]) }));
}

export async function presetTerminalPlacement(
  page: Page,
  placement: TerminalPlacement,
): Promise<void> {
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: TERMINAL_PLACEMENT_KEY,
    value: placement,
  });
}

export async function openWebLayout(
  page: Page,
  docName: string,
  viewport: LayoutViewport,
): Promise<void> {
  await stubAgentCatalog(page);
  await page.setViewportSize(viewport);
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(headerPaneButton(page, 'editor')).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
}

export async function openDesktopLayout(
  page: Page,
  workerServer: { baseURL: string; contentDir: string },
  docName: string,
  { viewport, terminalPlacement }: DesktopLayoutOptions,
): Promise<void> {
  await stubAgentCatalog(page);
  await presetTerminalPlacement(page, terminalPlacement);
  await page.setViewportSize(viewport);
  await openDesktopHeader(page, workerServer, docName, {});
  await expect(headerPaneButton(page, 'terminal')).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
}

export async function setHeaderPane(page: Page, pane: HeaderPane, on: boolean): Promise<void> {
  const button = headerPaneButton(page, pane);
  if ((await button.getAttribute('aria-pressed')) !== String(on)) await button.click();
  await expect(button).toHaveAttribute('aria-pressed', String(on));
}

export async function runPaletteCommand(
  page: Page,
  query: string,
  commandId: string,
): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.locator('[data-slot="command-input"]');
  await expect(input).toBeFocused();
  await input.fill(query);
  const row = page.getByTestId(`command-palette-${commandId}`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator('[data-slot="command-list"]')).toBeHidden();
}

export async function expectEditorHidden(page: Page): Promise<void> {
  await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator(EDITOR_PANE_CARD)).toHaveAttribute('inert', '');
  await expect(page.locator(EDITOR_PANE_CARD)).toHaveCSS('visibility', 'hidden');
}

export async function arrangeTerminalAlone(
  page: Page,
  placement: TerminalPlacement,
): Promise<void> {
  await setHeaderPane(page, 'agents', false);
  await setHeaderPane(page, 'terminal', true);
  await setHeaderPane(page, 'editor', false);
  await expectEditorHidden(page);
  await expect(page.locator(terminalPaneCard(placement))).toBeVisible();
}
