import { expect, type Page } from '@playwright/test';
import { expectSettledReading, pollSettledReading, type SettleBudget } from './settled-reading';

export type DockPane = 'editor' | 'agents' | 'terminal';

export type TerminalHome = 'bottom' | 'right';

export interface TerminalHomeReading {
  readonly placement: string | null;
  readonly geometry: TerminalHome | null;
  readonly painted: boolean;
}

export interface StoredDockArrangement {
  readonly key: string;
  readonly value: string | null;
}

export const TERMINAL_CARD =
  '[data-dock-unit="terminal"] [data-slot="pane-card"][data-pane="terminal"]';

export function terminalHomeProbe(settledAt: TerminalHome | null): TerminalHomeReading | false {
  const shownBox = (element: Element | null | undefined): DOMRect | null => {
    if (element == null || !element.checkVisibility()) return null;
    if (getComputedStyle(element).visibility !== 'visible') return null;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 ? box : null;
  };
  const near = (from: number, to: number): boolean => Math.abs(from - to) <= 1;
  const unit = document.querySelector('[data-dock-unit="terminal"]');
  const placement =
    unit
      ?.querySelector('[data-slot="pane-card"][data-pane="terminal"]')
      ?.getAttribute('data-placement') ?? null;
  const editor = shownBox(document.querySelector('[data-dock-unit="editor"]'));
  const terminal = shownBox(unit);
  let geometry: TerminalHome | null = null;
  if (editor !== null && terminal !== null) {
    if (
      terminal.top >= editor.bottom &&
      near(terminal.left, editor.left) &&
      near(terminal.right, editor.right)
    ) {
      geometry = 'bottom';
    } else if (
      terminal.left >= editor.right &&
      near(terminal.top, editor.top) &&
      near(terminal.bottom, editor.bottom)
    ) {
      geometry = 'right';
    }
  }
  const painted = Array.from(unit?.querySelectorAll('section[aria-label="Terminal"]') ?? []).some(
    (section) =>
      shownBox(section) !== null &&
      (section.querySelector('.xterm-rows')?.textContent ?? '').length > 0,
  );
  const reading: TerminalHomeReading = { placement, geometry, painted };
  if (settledAt === null) return reading;
  return placement === settledAt && geometry === settledAt && painted ? reading : false;
}

export async function readTerminalHome(page: Page): Promise<TerminalHomeReading> {
  const reading = await page.evaluate(terminalHomeProbe, null);
  if (reading === false) {
    throw new Error(
      'the terminal home probe answered false to a plain read, which it never does, so the renderer ran a different probe than this module ships',
    );
  }
  return reading;
}

export function storedDockArrangementsProbe(): StoredDockArrangement[] {
  const arrangements: StoredDockArrangement[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith('ok-dock-arrangement-v1:')) {
      arrangements.push({ key, value: localStorage.getItem(key) });
    }
  }
  return arrangements;
}

export function dockUnitWidth(page: Page, pane: DockPane): Promise<number> {
  return page
    .locator(`#dock-unit-${pane}`)
    .evaluate((element) => element.getBoundingClientRect().width);
}

export async function storedDockArrangement(
  page: Page,
  { timeout }: { timeout: number },
): Promise<StoredDockArrangement> {
  let stored: StoredDockArrangement | undefined;
  await pollSettledReading(
    async () => {
      const arrangements = await page.evaluate(storedDockArrangementsProbe);
      stored = arrangements[0];
      return arrangements.length;
    },
    { reading: 'stored arrangement count', of: 'the project dock arrangement', timeout },
  ).toBe(1);
  if (stored === undefined) throw new Error('the stored dock arrangement vanished between reads');
  return stored;
}

export async function expectStoredDockArrangementChanged(
  page: Page,
  since: StoredDockArrangement,
  budget: SettleBudget,
): Promise<void> {
  await expectSettledReading(
    () => page.evaluate(storedDockArrangementsProbe),
    (arrangements) => {
      expect(arrangements.map(({ key }) => key)).toEqual([since.key]);
      expect(arrangements[0]?.value).not.toBe(since.value);
    },
    { reading: 'stored arrangement', of: since.key, budget },
  );
}
