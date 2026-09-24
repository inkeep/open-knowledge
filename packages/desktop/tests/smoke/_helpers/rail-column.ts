import { expect, type Page } from '@playwright/test';
import {
  expectSettledReading,
  RAIL_LAYOUT_SETTLE_TIMEOUT_MS,
  type SettleBudget,
} from './settled-reading';

export type RailSettleBound =
  | { timeout?: number; budget?: undefined }
  | { budget: SettleBudget; timeout?: undefined };

export type CollapsedWidthOptions = { column: string } & RailSettleBound;

export async function waitForCollapsedWidth(
  readWidth: () => Promise<number>,
  { column, timeout = RAIL_LAYOUT_SETTLE_TIMEOUT_MS, budget }: CollapsedWidthOptions,
): Promise<void> {
  await expectSettledReading(
    readWidth,
    (width) => expect(width).toBe(0),
    budget === undefined
      ? { reading: 'width', of: column, timeout }
      : { reading: 'width', of: column, budget },
  );
}

export async function readRailColumnWidth(page: Page, selector: string): Promise<number> {
  const widths = await page
    .locator(selector)
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width));
  const [width] = widths;
  if (widths.length !== 1 || width === undefined) {
    throw new Error(`expected exactly one ${selector}, found ${widths.length}`);
  }
  return width;
}

export async function expectCollapsedRailColumn(
  page: Page,
  selector: string,
  bound: RailSettleBound = {},
): Promise<void> {
  await waitForCollapsedWidth(() => readRailColumnWidth(page, selector), {
    column: selector,
    ...bound,
  });
}
