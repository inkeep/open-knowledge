import type { ElementHandle, Locator, Page } from '@playwright/test';
import {
  type ApiHelpers,
  CORNER_STACK_TEST_ID,
  expect,
  expectDocumentOpen,
  expectEditorHidden,
  FEEDBACK_NUDGE_KEY,
  feedbackCard,
  identityOf,
  openDesktopLayout,
  openWebLayout,
  SAME_NODE,
  seedFeedbackEligibleDocs,
  seedFeedbackNudgeStateBeforeLoad,
  setHeaderPane,
  test,
  type WorkerServer,
} from './_helpers';
import { emitOnboardingToast, installUpdateEventOverlay } from './fixtures/update-event-overlay';

const WIDE = { width: 1440, height: 900 } as const;
const FEEDBACK_LATCH_TIMEOUT_MS = 15_000;
const SETTINGS_DIALOG_TIMEOUT_MS = 15_000;
const MENU_OPENS_ABOVE_CARD_PX = 200;
const MENU_OPENS_INSIDE_CARD_START_PX = 10;
const CORNER_STACK = `[data-testid="${CORNER_STACK_TEST_ID}"]`;
const DIALOG_LAYER = '[role="dialog"], [data-slot="dialog-overlay"]';
const PATH_FAILURE_SUMMARY = 'could not write ~/.zshrc';

type Host = 'web' | 'desktop';

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

async function rectOf(target: Locator): Promise<Rect> {
  return await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
}

function centerOf(rect: Rect): Point {
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
}

function overlapOf(a: Rect, b: Rect): Rect | null {
  const overlap = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return overlap.left < overlap.right && overlap.top < overlap.bottom ? overlap : null;
}

function contains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  );
}

async function landsIn(page: Page, point: Point, selector: string): Promise<boolean> {
  return await page.evaluate(
    ({ x, y, selector }) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && hit.closest(selector) !== null;
    },
    { ...point, selector },
  );
}

async function paintsOnTopAt(page: Page, point: Point, selector: string): Promise<boolean> {
  return await page.evaluate(
    ({ x, y, selector }) => {
      const body = document.body;
      const pointerLock = body.style.pointerEvents;
      body.style.pointerEvents = 'auto';
      const hit = document.elementFromPoint(x, y);
      body.style.pointerEvents = pointerLock;
      return hit !== null && hit.closest(selector) !== null;
    },
    { ...point, selector },
  );
}

async function readFeedbackDismissed(page: Page): Promise<unknown> {
  return await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw === null ? 'missing' : (JSON.parse(raw) as { dismissed?: unknown }).dismissed;
  }, FEEDBACK_NUDGE_KEY);
}

async function openWithFeedbackShowing(
  page: Page,
  api: ApiHelpers,
  workerServer: WorkerServer,
  slug: string,
  host: Host,
): Promise<Locator> {
  const docName = await seedFeedbackEligibleDocs(
    api,
    `corner-layering-${slug}-w${test.info().workerIndex}`,
  );
  await seedFeedbackNudgeStateBeforeLoad(page);
  if (host === 'web') {
    await openWebLayout(page, docName, WIDE);
  } else {
    await installUpdateEventOverlay(page);
    await openDesktopLayout(page, workerServer, docName, {
      viewport: WIDE,
      terminalPlacement: 'bottom',
    });
  }
  await expectDocumentOpen(page, docName);
  const card = feedbackCard(page);
  await expect(card).toBeVisible({ timeout: FEEDBACK_LATCH_TIMEOUT_MS });
  return card;
}

async function handleOf(card: Locator): Promise<ElementHandle<Element>> {
  const handle = await card.elementHandle();
  if (handle === null) throw new Error('expected the showing card to resolve to an element');
  return handle;
}

async function closeControlCenterOf(card: Locator): Promise<Point> {
  return centerOf(await rectOf(card.getByRole('button', { name: 'Close', exact: true })));
}

test.describe('what draws over a showing card', () => {
  test("the file sidebar's modal context menu draws over the card, and a click on the card's Close control only closes the menu", async ({
    page,
    api,
    workerServer,
  }) => {
    const card = await openWithFeedbackShowing(page, api, workerServer, 'menu', 'web');
    const before = await handleOf(card);
    const cardRect = await rectOf(card);
    const closeCenter = await closeControlCenterOf(card);

    await page.mouse.click(
      cardRect.left + MENU_OPENS_INSIDE_CARD_START_PX,
      cardRect.top - MENU_OPENS_ABOVE_CARD_PX,
      { button: 'right' },
    );
    const menu = page.locator('[role="menu"]');
    await expect(menu.getByTestId('empty-space-menu-new-file')).toBeVisible();
    const menuRect = await rectOf(menu);
    const overlap = overlapOf(menuRect, cardRect);
    if (overlap === null) throw new Error('expected the context menu to overlap the card');
    expect(await landsIn(page, centerOf(overlap), '[role="menu"]')).toBe(true);
    expect(await paintsOnTopAt(page, centerOf(overlap), '[role="menu"]')).toBe(true);
    expect(contains(menuRect, closeCenter)).toBe(false);
    expect(await landsIn(page, closeCenter, CORNER_STACK)).toBe(false);

    await page.mouse.click(closeCenter.x, closeCenter.y);

    await expect(menu).toHaveCount(0);
    await expect(card).toBeVisible();
    expect(await identityOf(before, card)).toEqual(SAME_NODE);
    expect(await readFeedbackDismissed(page)).toBe(false);
  });

  test("Settings draws its dialog layer over the card, and a click at the card's Close control leaves the card in place", async ({
    page,
    api,
    workerServer,
  }) => {
    const card = await openWithFeedbackShowing(page, api, workerServer, 'settings', 'web');
    const before = await handleOf(card);
    const cardCenter = centerOf(await rectOf(card));
    const closeCenter = await closeControlCenterOf(card);

    await page.getByTestId('header-settings-button').click();
    const dialog = page.getByTestId('settings-dialog');
    await expect(dialog).toBeVisible({ timeout: SETTINGS_DIALOG_TIMEOUT_MS });
    expect(await landsIn(page, cardCenter, DIALOG_LAYER)).toBe(true);
    expect(await paintsOnTopAt(page, cardCenter, DIALOG_LAYER)).toBe(true);
    expect(await landsIn(page, closeCenter, CORNER_STACK)).toBe(false);

    await page.mouse.click(closeCenter.x, closeCenter.y);

    await expect(dialog).toHaveCount(0);
    await expect(card).toBeVisible();
    expect(await identityOf(before, card)).toEqual(SAME_NODE);
    expect(await readFeedbackDismissed(page)).toBe(false);
  });

  test('a startup-integrations toast shows bottom-left over the card, and closing it leaves the card in place', async ({
    page,
    api,
    workerServer,
  }) => {
    const card = await openWithFeedbackShowing(page, api, workerServer, 'toast', 'desktop');
    const before = await handleOf(card);

    await emitOnboardingToast(page, {
      kind: 'startup-reclaim',
      mcp: { status: 'none' },
      path: { status: 'failed', summary: PATH_FAILURE_SUMMARY },
    });

    const toast = page
      .locator('[data-sonner-toaster][data-x-position="left"][data-y-position="bottom"]')
      .locator('[data-sonner-toast]')
      .filter({ hasText: `PATH install failed: ${PATH_FAILURE_SUMMARY}` });
    await expect(toast).toBeVisible();
    await expect
      .poll(async () => {
        const overlap = overlapOf(await rectOf(toast), await rectOf(card));
        return overlap !== null && (await landsIn(page, centerOf(overlap), '[data-sonner-toast]'));
      })
      .toBe(true);

    await toast.getByRole('button', { name: 'Close toast', exact: true }).click();

    await expect(toast).toHaveCount(0);
    await expect(card).toBeVisible();
    expect(await identityOf(before, card)).toEqual(SAME_NODE);
  });
});

test.describe('what a showing card draws over', () => {
  test('the card draws over Nothing open', async ({ page, api, workerServer }) => {
    const card = await openWithFeedbackShowing(page, api, workerServer, 'nothing-open', 'web');

    await setHeaderPane(page, 'agents', false);
    await setHeaderPane(page, 'editor', false);
    await expectEditorHidden(page);
    const nothingOpen = page.getByRole('region', { name: 'Nothing open', exact: true });
    await expect(nothingOpen).toBeVisible();

    const cardCenter = centerOf(await rectOf(card));
    expect(contains(await rectOf(nothingOpen), cardCenter)).toBe(true);
    expect(await landsIn(page, cardCenter, CORNER_STACK)).toBe(true);
  });
});
