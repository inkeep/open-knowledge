import type { Locator, Page } from '@playwright/test';
import {
  type ApiHelpers,
  arrangeTerminalAlone,
  CORNER_STACK_TEST_ID,
  cornerStack,
  EDITOR_PANE_CARD,
  expect,
  expectDocumentOpen,
  feedbackCard,
  type LayoutViewport,
  openDesktopLayout,
  openWebLayout,
  seedFeedbackEligibleDocs,
  seedFeedbackNudgeStateBeforeLoad,
  sidebarTrigger,
  terminalPaneCard,
  test,
  type WorkerServer,
} from './_helpers';

const DESK_GUTTER_PX = 8;
const CARD_MARGIN_PX = 4;
const STACK_INSET_PX = DESK_GUTTER_PX + CARD_MARGIN_PX;
const STACK_WIDTH_PX = 352;
const CORNER_PROBE_PX = STACK_INSET_PX + 12;
const FEEDBACK_LATCH_TIMEOUT_MS = 15_000;

const WIDE = { width: 1440, height: 900 } as const;
const NARROW = { width: 800, height: 900 } as const;

type Host = 'web' | 'desktop';

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
}

interface CornerSurface {
  readonly name: string;
  readonly slug: string;
  readonly host: Host;
  readonly viewport: LayoutViewport;
  readonly selector: string;
  readonly arrange: (page: Page) => Promise<void>;
  readonly beforeClick: (page: Page) => Promise<void>;
  readonly afterClick: (page: Page) => Promise<void>;
}

async function rectOf(locator: Locator): Promise<Rect> {
  return await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width };
  });
}

async function viewportOf(page: Page): Promise<LayoutViewport> {
  return await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
}

async function startBottomInsetsOf(page: Page, locator: Locator) {
  const [rect, viewport] = await Promise.all([rectOf(locator), viewportOf(page)]);
  return {
    start: Math.round(rect.left),
    bottom: Math.round(viewport.height - rect.bottom),
    width: Math.round(rect.width),
  };
}

async function endBottomInsetsOf(page: Page, locator: Locator) {
  const [rect, viewport] = await Promise.all([rectOf(locator), viewportOf(page)]);
  return {
    end: Math.round(viewport.width - rect.right),
    bottom: Math.round(viewport.height - rect.bottom),
    width: Math.round(rect.width),
  };
}

async function insideViewport(page: Page, locator: Locator) {
  const [rect, viewport] = await Promise.all([rectOf(locator), viewportOf(page)]);
  return {
    start: rect.left >= 0,
    top: rect.top >= 0,
    end: rect.right <= viewport.width,
    bottom: rect.bottom <= viewport.height,
  };
}

const INSIDE_VIEWPORT = { start: true, top: true, end: true, bottom: true };

async function openLayout(
  page: Page,
  workerServer: WorkerServer,
  host: Host,
  docName: string,
  viewport: LayoutViewport,
): Promise<void> {
  if (host === 'web') await openWebLayout(page, docName, viewport);
  else
    await openDesktopLayout(page, workerServer, docName, { viewport, terminalPlacement: 'bottom' });
  await expectDocumentOpen(page, docName);
}

async function openWithFeedbackShowing(
  page: Page,
  api: ApiHelpers,
  workerServer: WorkerServer,
  slug: string,
  host: Host,
  viewport: LayoutViewport,
): Promise<Locator> {
  const docName = await seedFeedbackEligibleDocs(
    api,
    `corner-geometry-${slug}-w${test.info().workerIndex}`,
  );
  await seedFeedbackNudgeStateBeforeLoad(page);
  await openLayout(page, workerServer, host, docName, viewport);
  const card = feedbackCard(page);
  await expect(card).toBeVisible({ timeout: FEEDBACK_LATCH_TIMEOUT_MS });
  return card;
}

async function openWithNoCard(
  page: Page,
  api: ApiHelpers,
  workerServer: WorkerServer,
  slug: string,
  host: Host,
  viewport: LayoutViewport,
): Promise<void> {
  const docName = `corner-geometry-${slug}-w${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: `# ${docName}\n\nNothing in the corner.\n` }]);
  await openLayout(page, workerServer, host, docName, viewport);
}

async function cornerHit(page: Page, surfaceSelector: string) {
  return await page.evaluate(
    ({ surfaceSelector, probe, stackTestId }) => {
      const hit = document.elementFromPoint(probe, window.innerHeight - probe);
      return {
        inStack: hit?.closest(`[data-testid="${stackTestId}"]`) != null,
        inSurface: hit !== null && document.querySelector(surfaceSelector)?.contains(hit) === true,
      };
    },
    { surfaceSelector, probe: CORNER_PROBE_PX, stackTestId: CORNER_STACK_TEST_ID },
  );
}

const CORNER_COVERED = { inStack: true, inSurface: false };
const CORNER_OPEN = { inStack: false, inSurface: true };

async function clickTheCorner(page: Page, surfaceSelector: string) {
  await page.evaluate(
    ({ surfaceSelector, stackTestId }) => {
      const record = window as Window & { cornerClick?: { inSurface: boolean; inStack: boolean } };
      record.cornerClick = undefined;
      window.addEventListener(
        'click',
        (event) => {
          const target = event.target instanceof Element ? event.target : null;
          record.cornerClick = {
            inSurface:
              target !== null && document.querySelector(surfaceSelector)?.contains(target) === true,
            inStack: target?.closest(`[data-testid="${stackTestId}"]`) != null,
          };
        },
        { capture: true, once: true },
      );
    },
    { surfaceSelector, stackTestId: CORNER_STACK_TEST_ID },
  );
  const viewport = await viewportOf(page);
  await page.mouse.click(CORNER_PROBE_PX, viewport.height - CORNER_PROBE_PX);
  return await page.evaluate(
    () =>
      (window as Window & { cornerClick?: { inSurface: boolean; inStack: boolean } }).cornerClick ??
      null,
  );
}

async function expectEmptyStackWithoutABox(page: Page): Promise<void> {
  const stack = page.getByTestId(CORNER_STACK_TEST_ID);
  await expect(stack).toHaveCount(1);
  await expect(stack).toBeHidden();
  expect(
    await stack.evaluate((el) => ({
      display: getComputedStyle(el).display,
      cards: el.querySelector('[data-testid="corner-card-stack-column"]')?.childElementCount,
    })),
  ).toEqual({ display: 'none', cards: 0 });
  expect(await stack.boundingBox()).toBeNull();
}

async function expectCornerPassesClicksTo(page: Page, surface: CornerSurface): Promise<void> {
  await expectEmptyStackWithoutABox(page);
  expect(await cornerHit(page, surface.selector)).toEqual(CORNER_OPEN);
  await surface.beforeClick(page);
  expect(await clickTheCorner(page, surface.selector)).toEqual({ inSurface: true, inStack: false });
  await surface.afterClick(page);
}

function skillsDock(page: Page): Locator {
  return page.getByTestId('skills-dock');
}

async function terminalHoldsFocus(page: Page): Promise<boolean> {
  return await page.evaluate(
    (selector) => document.querySelector(selector)?.contains(document.activeElement) === true,
    terminalPaneCard('bottom'),
  );
}

const CORNER_SURFACES: readonly CornerSurface[] = [
  {
    name: 'the Skills Studio row at the bottom of the open file sidebar',
    slug: 'skills-row',
    host: 'web',
    viewport: WIDE,
    selector: '[data-testid="skills-dock"]',
    arrange: async (page) => {
      await expect(sidebarTrigger(page)).toHaveAttribute('aria-expanded', 'true');
      await expect(skillsDock(page)).toBeVisible();
    },
    beforeClick: async (page) => {
      await expect(skillsDock(page)).toHaveAttribute('data-state', 'closed');
    },
    afterClick: async (page) => {
      await expect(skillsDock(page)).toHaveAttribute('data-state', 'open');
    },
  },
  {
    name: 'the editor with the file sidebar collapsed',
    slug: 'editor',
    host: 'web',
    viewport: NARROW,
    selector: EDITOR_PANE_CARD,
    arrange: async (page) => {
      await expect(sidebarTrigger(page)).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator(EDITOR_PANE_CARD)).toBeVisible();
    },
    beforeClick: async () => {},
    afterClick: async () => {},
  },
  {
    name: 'the bottom terminal with the editor hidden',
    slug: 'terminal',
    host: 'desktop',
    viewport: WIDE,
    selector: terminalPaneCard('bottom'),
    arrange: (page) => arrangeTerminalAlone(page, 'bottom'),
    beforeClick: async (page) => {
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
      expect(await terminalHoldsFocus(page)).toBe(false);
    },
    afterClick: async (page) => {
      await expect.poll(() => terminalHoldsFocus(page)).toBe(true);
    },
  },
];

const ANCHOR_CASES = [
  {
    name: 'a 720x480 desktop window',
    slug: 'anchor-720',
    host: 'desktop',
    viewport: { width: 720, height: 480 },
  },
  { name: 'a 1440x900 web window', slug: 'anchor-1440', host: 'web', viewport: WIDE },
] as const satisfies readonly {
  name: string;
  slug: string;
  host: Host;
  viewport: LayoutViewport;
}[];

test.describe('corner stack geometry', () => {
  for (const { name, slug, host, viewport } of ANCHOR_CASES) {
    test(`in ${name} the stack sits one card margin inside the desk gutter at the bottom-start corner, 22rem wide`, async ({
      page,
      api,
      workerServer,
    }) => {
      const card = await openWithFeedbackShowing(page, api, workerServer, slug, host, viewport);
      const anchored = { start: STACK_INSET_PX, bottom: STACK_INSET_PX, width: STACK_WIDTH_PX };

      const editorCard = await startBottomInsetsOf(page, page.locator(EDITOR_PANE_CARD));
      expect({ start: editorCard.start, bottom: editorCard.bottom }).toEqual({
        start: DESK_GUTTER_PX,
        bottom: DESK_GUTTER_PX,
      });
      expect(await startBottomInsetsOf(page, cornerStack(page))).toEqual(anchored);
      expect(await startBottomInsetsOf(page, card)).toEqual(anchored);
    });
  }

  test('in a 393px phone window the card lies entirely inside the viewport', async ({
    page,
    api,
    workerServer,
  }) => {
    const card = await openWithFeedbackShowing(page, api, workerServer, 'phone', 'web', {
      width: 393,
      height: 852,
    });

    expect(await insideViewport(page, card)).toEqual(INSIDE_VIEWPORT);
  });

  test('in a window narrower than 22rem plus both gutters the stack shrinks to stay inside it', async ({
    page,
    api,
    workerServer,
  }) => {
    const card = await openWithFeedbackShowing(page, api, workerServer, 'narrowest', 'web', {
      width: 300,
      height: 640,
    });
    const stack = cornerStack(page);

    expect((await rectOf(stack)).width).toBeLessThan(STACK_WIDTH_PX);
    expect(await insideViewport(page, stack)).toEqual(INSIDE_VIEWPORT);
    expect(await insideViewport(page, card)).toEqual(INSIDE_VIEWPORT);
  });

  test('in a right-to-left document the stack mirrors to the bottom-right corner', async ({
    page,
    api,
    workerServer,
  }) => {
    await openWithFeedbackShowing(page, api, workerServer, 'rtl', 'web', WIDE);
    const stack = cornerStack(page);
    expect((await startBottomInsetsOf(page, stack)).start).toBe(STACK_INSET_PX);

    await page.evaluate(() => {
      document.documentElement.dir = 'rtl';
    });

    await expect
      .poll(() => endBottomInsetsOf(page, stack))
      .toEqual({ end: STACK_INSET_PX, bottom: STACK_INSET_PX, width: STACK_WIDTH_PX });
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
  });
});

test.describe('an empty corner passes clicks through', () => {
  for (const surface of CORNER_SURFACES) {
    test(`with no card showing, a click in the corner reaches ${surface.name}`, async ({
      page,
      api,
      workerServer,
    }) => {
      await openWithNoCard(
        page,
        api,
        workerServer,
        `empty-${surface.slug}`,
        surface.host,
        surface.viewport,
      );
      await surface.arrange(page);

      await expectCornerPassesClicksTo(page, surface);
    });

    test(`after the last card is dismissed, a click in the corner reaches ${surface.name}`, async ({
      page,
      api,
      workerServer,
    }) => {
      const card = await openWithFeedbackShowing(
        page,
        api,
        workerServer,
        `dismissed-${surface.slug}`,
        surface.host,
        surface.viewport,
      );
      await surface.arrange(page);
      expect(await cornerHit(page, surface.selector)).toEqual(CORNER_COVERED);

      await card.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(card).toHaveCount(0);

      await expectCornerPassesClicksTo(page, surface);
    });
  }
});
