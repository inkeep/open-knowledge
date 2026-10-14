import { type ElementHandle, expect, type Locator, type Page } from '@playwright/test';

export const CORNER_STACK_TEST_ID = 'corner-card-stack';

const DOCUMENT_OPEN_TIMEOUT_MS = 30_000;

export interface CardPlacement {
  readonly inFileSidebar: boolean;
  readonly inEditorCard: boolean;
  readonly inInertSubtree: boolean;
  readonly centerHitsCard: boolean;
}

export const FLOATING_AND_HIT_TESTABLE: CardPlacement = {
  inFileSidebar: false,
  inEditorCard: false,
  inInertSubtree: false,
  centerHitsCard: true,
};

export function cornerStack(page: Page): Locator {
  return page.getByRole('region', { name: 'Updates and feedback', exact: true });
}

export function sidebarTrigger(page: Page): Locator {
  return page.locator('[data-sidebar="trigger"]').first();
}

export function cornerStackColumn(page: Page): Locator {
  return cornerStack(page).getByTestId('corner-card-stack-column');
}

export interface ControlReach {
  readonly belowHeader: boolean;
  readonly insideViewport: boolean;
  readonly centerHitsControl: boolean;
}

export const REACHABLE: ControlReach = {
  belowHeader: true,
  insideViewport: true,
  centerHitsControl: true,
};

export async function reachOf(control: Locator): Promise<ControlReach> {
  return await control.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const headerBottom = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      belowHeader: rect.top >= headerBottom,
      insideViewport:
        rect.left >= 0 &&
        rect.right <= window.innerWidth &&
        rect.top >= 0 &&
        rect.bottom <= window.innerHeight,
      centerHitsControl: hit !== null && el.contains(hit),
    };
  });
}

export function feedbackCard(page: Page): Locator {
  return cornerStack(page).getByRole('region', { name: 'Share feedback', exact: true });
}

export function noticeList(page: Page): Locator {
  return cornerStack(page).getByTestId('update-notices-list');
}

export function newsletterCard(page: Page): Locator {
  return noticeList(page).getByRole('region', { name: 'Stay in the loop', exact: true });
}

export function noticeWithText(page: Page, text: string): Locator {
  return noticeList(page).getByRole('status').filter({ hasText: text });
}

export async function placementOf(card: Locator): Promise<CardPlacement> {
  return await card.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      inFileSidebar: el.closest('nav#app-file-sidebar') !== null,
      inEditorCard: el.closest('[data-slot="pane-card"][data-pane="editor"]') !== null,
      inInertSubtree: el.closest('[inert]') !== null,
      centerHitsCard: hit !== null && el.contains(hit),
    };
  });
}

export async function identityOf(before: ElementHandle<Element>, current: Locator) {
  const now = await current.elementHandle();
  return await before.evaluate(
    (el, other) => ({ connected: el.isConnected, sameNode: el === other }),
    now,
  );
}

export const SAME_NODE = { connected: true, sameNode: true };

export async function expectDocumentOpen(page: Page, docName: string): Promise<void> {
  await expect(page.locator('.tiptap-editor .ProseMirror').first()).toContainText(docName, {
    timeout: DOCUMENT_OPEN_TIMEOUT_MS,
  });
}
