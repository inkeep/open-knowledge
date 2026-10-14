import type { Locator, Page } from '@playwright/test';
import {
  type ApiHelpers,
  CORNER_STACK_TEST_ID,
  expect,
  expectDocumentOpen,
  expectEditorHidden,
  FEEDBACK_NUDGE_KEY,
  feedbackCard,
  NEWSLETTER_KEY,
  noticeList,
  noticeWithText,
  openDesktopLayout,
  openWebLayout,
  seedFeedbackEligibleDocs,
  setHeaderPane,
  stubAgentCatalog,
  test,
  type WorkerServer,
} from './_helpers';
import { emitUpdateEvent, installUpdateEventOverlay } from './fixtures/update-event-overlay';

const WEB_EDITOR_VISIBLE_KEY = 'ok-editor-visible-v1';
const PAGE_LIST_READY_MEASURE = 'ok/startup/page-list-ready';
const VERSION = '9.9.9';
const RELEASE_URL = 'https://openknowledge.ai/changelog';
const WIDE = { width: 1440, height: 900 } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

type EditorLayout = 'editor shown' | 'editor hidden';

const EDITOR_LAYOUTS: readonly EditorLayout[] = ['editor shown', 'editor hidden'];

interface SavedFeedbackState {
  readonly firstSeenAt: number | null;
  readonly shownAt: number | null;
  readonly dismissed: boolean;
}

interface SavedNewsletterState {
  readonly subscribed: boolean;
  readonly dismissed: boolean;
  readonly shownVersions: readonly string[];
}

interface SeenFeedback {
  readonly name: string;
  readonly saved: (now: number) => SavedFeedbackState;
}

interface SeenNewsletter {
  readonly name: string;
  readonly saved: SavedNewsletterState;
}

const ELIGIBLE_FEEDBACK = (now: number): SavedFeedbackState => ({
  firstSeenAt: now - 30 * DAY_MS,
  shownAt: null,
  dismissed: false,
});

const SEEN_FEEDBACK: readonly SeenFeedback[] = [
  {
    name: 'already shown',
    saved: (now) => ({
      firstSeenAt: now - 30 * DAY_MS,
      shownAt: now - 20 * DAY_MS,
      dismissed: false,
    }),
  },
  {
    name: 'dismissed',
    saved: (now) => ({ firstSeenAt: now - 30 * DAY_MS, shownAt: null, dismissed: true }),
  },
];

const USED_UP_NEWSLETTER: readonly SeenNewsletter[] = [
  { name: 'subscribed', saved: { subscribed: true, dismissed: false, shownVersions: [] } },
  { name: 'dismissed', saved: { subscribed: false, dismissed: true, shownVersions: [] } },
  {
    name: 'shown for three versions',
    saved: { subscribed: false, dismissed: false, shownVersions: ['9.6.0', '9.7.0', '9.8.0'] },
  },
  {
    name: 'already shown for this version',
    saved: { subscribed: false, dismissed: false, shownVersions: [VERSION] },
  },
];

function slugOf(...parts: readonly string[]): string {
  return `corner-seen-${parts.join('-').replace(/[^a-z0-9]+/gi, '-')}-w${test.info().workerIndex}`;
}

async function seedLocalStorageBeforeLoad(page: Page, key: string, raw: string): Promise<void> {
  await page.addInitScript(
    ({ key, raw }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, raw);
    },
    { key, raw },
  );
}

async function readSavedState(page: Page, key: string): Promise<string | null> {
  return await page.evaluate((key) => window.localStorage.getItem(key), key);
}

async function pageListSettled(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((name) => performance.getEntriesByName(name).length, PAGE_LIST_READY_MEASURE),
    )
    .toBe(1);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

function anyFeedbackCard(page: Page): Locator {
  return page.getByRole('region', { name: 'Share feedback', exact: true, includeHidden: true });
}

function anyNewsletterCard(page: Page): Locator {
  return page.getByRole('region', { name: 'Stay in the loop', exact: true, includeHidden: true });
}

async function openWebWithSavedFeedback(
  page: Page,
  api: ApiHelpers,
  slug: string,
  layout: EditorLayout,
  savedFeedback: string,
): Promise<void> {
  const docName = await seedFeedbackEligibleDocs(api, slug);
  await seedLocalStorageBeforeLoad(page, FEEDBACK_NUDGE_KEY, savedFeedback);
  if (layout === 'editor hidden') {
    await seedLocalStorageBeforeLoad(page, WEB_EDITOR_VISIBLE_KEY, 'false');
    await stubAgentCatalog(page);
    await page.setViewportSize(WIDE);
    await page.goto('/');
    await expectEditorHidden(page);
  } else {
    await openWebLayout(page, docName, WIDE);
    await expectDocumentOpen(page, docName);
  }
  await expect(page.getByTestId(CORNER_STACK_TEST_ID)).toBeAttached();
  await pageListSettled(page);
}

async function openDesktopWithSavedNewsletter(
  page: Page,
  api: ApiHelpers,
  workerServer: WorkerServer,
  slug: string,
  layout: EditorLayout,
  savedNewsletter: string | null,
): Promise<void> {
  await api.seedDocs([
    { name: slug, markdown: `# ${slug}\n\nA document under the corner stack.\n` },
  ]);
  if (savedNewsletter !== null) {
    await seedLocalStorageBeforeLoad(page, NEWSLETTER_KEY, savedNewsletter);
  }
  await installUpdateEventOverlay(page);
  await openDesktopLayout(page, workerServer, slug, {
    viewport: WIDE,
    terminalPlacement: 'bottom',
  });
  await expectDocumentOpen(page, slug);
  if (layout === 'editor hidden') {
    await setHeaderPane(page, 'editor', false);
    await expectEditorHidden(page);
  }
  await emitUpdateEvent(page, 'onWhatsNew', { version: VERSION, releaseUrl: RELEASE_URL });
}

test.describe('corner stack: feedback already seen stays hidden', () => {
  for (const layout of EDITOR_LAYOUTS) {
    test(`an eligible feedback prompt shows by the time the page list is ready, ${layout}`, async ({
      page,
      api,
    }) => {
      const saved = JSON.stringify(ELIGIBLE_FEEDBACK(Date.now()));
      await openWebWithSavedFeedback(page, api, slugOf('eligible', layout), layout, saved);

      expect(await feedbackCard(page).isVisible()).toBe(true);
      const stored = JSON.parse((await readSavedState(page, FEEDBACK_NUDGE_KEY)) ?? 'null');
      expect(typeof stored?.shownAt).toBe('number');
    });

    for (const seen of SEEN_FEEDBACK) {
      test(`feedback ${seen.name} is not shown again, ${layout}`, async ({ page, api }) => {
        const saved = JSON.stringify(seen.saved(Date.now()));
        await openWebWithSavedFeedback(page, api, slugOf(seen.name, layout), layout, saved);

        await expect(anyFeedbackCard(page)).toHaveCount(0);
        expect(await readSavedState(page, FEEDBACK_NUDGE_KEY)).toBe(saved);
      });
    }
  }
});

test.describe('corner stack: used-up newsletter offers stay hidden', () => {
  for (const layout of EDITOR_LAYOUTS) {
    test(`with no saved newsletter state, what's new shows the newsletter card, ${layout}`, async ({
      page,
      api,
      workerServer,
    }) => {
      await openDesktopWithSavedNewsletter(
        page,
        api,
        workerServer,
        slugOf('fresh-newsletter', layout),
        layout,
        null,
      );

      await expect(
        noticeList(page).getByRole('region', { name: 'Stay in the loop', exact: true }),
      ).toBeVisible();
      await expect(noticeWithText(page, `Updated to Version ${VERSION}`)).toHaveCount(0);
      await expect
        .poll(async () => JSON.parse((await readSavedState(page, NEWSLETTER_KEY)) ?? 'null'))
        .toMatchObject({ shownVersions: [VERSION] });
    });

    for (const usedUp of USED_UP_NEWSLETTER) {
      test(`newsletter ${usedUp.name} shows the plain update notice instead, ${layout}`, async ({
        page,
        api,
        workerServer,
      }) => {
        const saved = JSON.stringify(usedUp.saved);
        await openDesktopWithSavedNewsletter(
          page,
          api,
          workerServer,
          slugOf(usedUp.name, layout),
          layout,
          saved,
        );

        const plainNotice = noticeWithText(page, `Updated to Version ${VERSION}`);
        await expect(plainNotice).toBeVisible();
        await expect(noticeList(page).locator(':scope > *')).toHaveCount(1);
        await expect(anyNewsletterCard(page)).toHaveCount(0);
        expect(await readSavedState(page, NEWSLETTER_KEY)).toBe(saved);
      });
    }
  }
});
