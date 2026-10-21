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
export const DOCK_WORKSPACE = '[data-dock-workspace]';

const PANE_LABELS: Readonly<Record<HeaderPane, string>> = {
  editor: 'Editor',
  agents: 'Agents',
  terminal: 'Terminal',
};

export interface DockUnitRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DockSeamDrag {
  readonly dx?: number;
  readonly dy?: number;
  readonly grabOffsetPx?: number;
  readonly whileDragging?: () => Promise<void>;
}

export function terminalPaneCard(placement: TerminalPlacement): string {
  return `[data-slot="pane-card"][data-pane="terminal"][data-placement="${placement}"]`;
}

export function headerPaneButton(page: Page, pane: HeaderPane): Locator {
  return page.getByTestId(`header-pane-button-${pane}`);
}

export function dockUnit(page: Page, pane: HeaderPane): Locator {
  return page.locator(`[data-dock-unit="${pane}"]`);
}

export function dockSeam(page: Page, trailingPane: HeaderPane): Locator {
  return page
    .locator('[data-dock-seam]')
    .and(page.getByRole('separator', { name: `Resize ${PANE_LABELS[trailingPane]}`, exact: true }));
}

export async function dockUnitRect(page: Page, pane: HeaderPane): Promise<DockUnitRect | null> {
  return await page.evaluate((selector) => {
    const unit = document.querySelector(selector);
    if (!(unit instanceof HTMLElement) || unit.hidden || unit.hasAttribute('data-dock-unit-off')) {
      return null;
    }
    const { x, y, width, height } = unit.getBoundingClientRect();
    return { x, y, width, height };
  }, `[data-dock-unit="${pane}"]`);
}

export async function expectDockUnitOff(page: Page, pane: HeaderPane): Promise<void> {
  const unit = dockUnit(page, pane);
  await expect(unit).toHaveAttribute('data-dock-unit-off', '');
  await expect(unit).toHaveAttribute('inert', '');
  await expect(unit).toBeHidden();
}

export async function dragDockSeam(
  page: Page,
  seam: Locator,
  { dx = 0, dy = 0, grabOffsetPx = 0, whileDragging }: DockSeamDrag = {},
): Promise<void> {
  const box = await seam.boundingBox();
  if (box === null) throw new Error('the dock seam has no layout box');
  const acrossRow = (await seam.getAttribute('data-dock-seam')) === 'row';
  const x = box.x + box.width / 2 + (acrossRow ? grabOffsetPx : 0);
  const y = box.y + box.height / 2 + (acrossRow ? 0 : grabOffsetPx);
  const workspace = page.locator(DOCK_WORKSPACE);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(workspace).toHaveAttribute('data-dragging', '');
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await whileDragging?.();
  await page.mouse.up();
  await expect(workspace).not.toHaveAttribute('data-dragging');
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
