import type { Locator, Page } from '@playwright/test';
import {
  type ApiHelpers,
  cornerStack,
  cornerStackColumn,
  EDITOR_PANE_CARD,
  expect,
  FLOATING_AND_HIT_TESTABLE,
  feedbackCard,
  placementOf,
  REACHABLE,
  reachOf,
  seedFeedbackEligibleDocs,
  seedFeedbackNudgeStateBeforeLoad,
  sidebarTrigger,
  stubAgentCatalog,
  test,
  waitForActiveProviderSynced,
} from './_helpers';

const CHROME_VANILLA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const EMBEDDED_HOSTS = [
  { host: 'Cursor', userAgent: `${CHROME_VANILLA} Cursor/1.2.3` },
  { host: 'Codex', userAgent: `${CHROME_VANILLA} Codex(Dev)/26.513.31313` },
  { host: 'Claude', userAgent: `${CHROME_VANILLA} Claude(Canary)/1.0.0` },
] as const;

const WIDE = { width: 1440, height: 900 } as const;
const NARROW = { width: 800, height: 900 } as const;
const SHORT = { width: 720, height: 480 } as const;

const SEND_FAILED_TOAST = 'Something went wrong sending your feedback. Please try again.';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

async function openWithEligibleFeedback(
  page: Page,
  api: ApiHelpers,
  slug: string,
  viewport: { width: number; height: number },
): Promise<Locator> {
  const docName = await seedFeedbackEligibleDocs(api, `${slug}-w${test.info().workerIndex}`);
  await seedFeedbackNudgeStateBeforeLoad(page);
  await stubAgentCatalog(page);
  await page.setViewportSize(viewport);
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible({
    timeout: 30_000,
  });
  const card = feedbackCard(page);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('region', { name: 'Share feedback', exact: true })).toHaveCount(1);
  return card;
}

async function expectFileSidebarCollapsed(page: Page) {
  await expect(sidebarTrigger(page)).toHaveAttribute('aria-expanded', 'false');
}

test.describe('feedback card in the corner stack, web host', () => {
  test.use({ userAgent: CHROME_VANILLA });

  test('floats in the corner stack over the panes with the file sidebar open', async ({
    page,
    api,
  }) => {
    const card = await openWithEligibleFeedback(page, api, 'corner-feedback-wide', WIDE);

    await expect(sidebarTrigger(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('nav#app-file-sidebar')).toBeVisible();
    await expect(page.locator(EDITOR_PANE_CARD)).toBeVisible();
    expect(await placementOf(card)).toEqual(FLOATING_AND_HIT_TESTABLE);
  });

  test('holds only the feedback card when there is no desktop bridge', async ({ page, api }) => {
    const card = await openWithEligibleFeedback(page, api, 'corner-feedback-nobridge', WIDE);
    const stack = cornerStack(page);

    expect(await page.evaluate(() => 'okDesktop' in window)).toBe(false);
    await expect(stack.getByTestId('update-notices-list')).toHaveCount(0);
    expect(
      await cornerStackColumn(page).evaluate((el) =>
        Array.from(el.children).map((child) => child.getAttribute('aria-label')),
      ),
    ).toEqual(['Share feedback']);
    await expect(card).toBeVisible();
  });

  test('shows without opening the file sidebar in an 800px window', async ({ page, api }) => {
    const card = await openWithEligibleFeedback(page, api, 'corner-feedback-narrow', NARROW);

    await expectFileSidebarCollapsed(page);
    expect(await placementOf(card)).toEqual(FLOATING_AND_HIT_TESTABLE);
  });

  test('picking a rating grows the card upward from the corner', async ({ page, api }) => {
    const card = await openWithEligibleFeedback(page, api, 'corner-feedback-grow', WIDE);
    const before = await card.boundingBox();
    if (before === null) throw new Error('feedback card has no box before the rating');

    await card.getByRole('radio', { name: 'Not great' }).click();
    await expect(card.getByPlaceholder('Tell us more (optional)')).toBeVisible();

    const after = await card.boundingBox();
    if (after === null) throw new Error('feedback card has no box after the rating');
    expect(Math.abs(after.y + after.height - (before.y + before.height))).toBeLessThanOrEqual(1);
    expect(after.y).toBeLessThan(before.y);
    expect(after.x).toBeGreaterThanOrEqual(0);
    expect(after.y).toBeGreaterThanOrEqual(0);
    expect(after.x + after.width).toBeLessThanOrEqual(WIDE.width);
    expect(after.y + after.height).toBeLessThanOrEqual(WIDE.height);
  });

  test('in the smallest desktop window the expanded card keeps Close below the header and scrolls inside itself to Send', async ({
    page,
    api,
  }) => {
    const card = await openWithEligibleFeedback(page, api, 'corner-feedback-short', SHORT);
    await card.getByRole('radio', { name: 'Not great' }).click();
    await expect(card.getByPlaceholder('Tell us more (optional)')).toBeVisible();

    expect(await card.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    expect(await reachOf(card.getByRole('button', { name: 'Close', exact: true }))).toEqual(
      REACHABLE,
    );
    expect(await reachOf(card.getByRole('radio', { name: 'Not great' }))).toEqual(REACHABLE);

    const box = await card.boundingBox();
    if (box === null) throw new Error('feedback card has no box in the short window');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 200);
    await expect.poll(() => card.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    const send = card.getByRole('button', { name: 'Send', exact: true });
    await send.scrollIntoViewIfNeeded();
    expect(await reachOf(send)).toEqual(REACHABLE);
  });

  test('a click just outside the card reaches what is underneath', async ({ page, api }) => {
    const card = await openWithEligibleFeedback(page, api, 'corner-feedback-edge', WIDE);

    const hits = await card.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const stack = el.closest('[data-testid="corner-card-stack"]');
      const probes = {
        above: [rect.left + rect.width / 2, rect.top - 4],
        end: [rect.right + 4, rect.top + rect.height / 2],
      } as const;
      return Object.fromEntries(
        Object.entries(probes).map(([side, [x, y]]) => {
          const hit = document.elementFromPoint(x, y);
          return [side, hit !== null && stack?.contains(hit) === false];
        }),
      );
    });
    expect(hits).toEqual({ above: true, end: true });
  });

  test('a failed send shows the usual error toast bottom-right and keeps the answer', async ({
    page,
    api,
  }) => {
    const sentBodies: string[] = [];
    await page.route('**/api/feedback', async (route) => {
      const request = route.request();
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: CORS_HEADERS });
        return;
      }
      sentBodies.push(request.postData() ?? '');
      await route.fulfill({ status: 500, headers: CORS_HEADERS, json: { error: 'unavailable' } });
    });
    const card = await openWithEligibleFeedback(page, api, 'corner-feedback-fail', WIDE);
    const draft = 'The corner card should keep this draft.';

    await card.getByRole('radio', { name: 'Not great' }).click();
    await card.getByPlaceholder('Tell us more (optional)').fill(draft);
    await card.getByRole('button', { name: 'Send' }).click();

    await expect(
      page.locator("[data-sonner-toaster][data-x-position='right']").getByText(SEND_FAILED_TOAST),
    ).toBeVisible();
    expect(sentBodies).toHaveLength(1);
    expect(JSON.parse(sentBodies[0] ?? '{}')).toMatchObject({
      rating: 'negative',
      message: draft,
      source: 'proactive_card',
    });
    await expect(card).toBeVisible();
    await expect(card.getByRole('radio', { name: 'Not great' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(card.getByPlaceholder('Tell us more (optional)')).toHaveValue(draft);
  });
});

for (const { host, userAgent } of EMBEDDED_HOSTS) {
  test.describe(`feedback card in the corner stack, ${host} embedded host`, () => {
    test.use({ userAgent });

    test('shows while the file sidebar stays collapsed', async ({ page, api }) => {
      const card = await openWithEligibleFeedback(
        page,
        api,
        `corner-feedback-${host.toLowerCase()}`,
        WIDE,
      );

      await expectFileSidebarCollapsed(page);
      expect(await placementOf(card)).toEqual(FLOATING_AND_HIT_TESTABLE);
    });
  });
}
