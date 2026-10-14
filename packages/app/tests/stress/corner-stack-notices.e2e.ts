import type { Locator, Page } from '@playwright/test';
import {
  type ApiHelpers,
  cornerStack,
  EDITOR_PANE_CARD,
  expect,
  expectDocumentOpen,
  FLOATING_AND_HIT_TESTABLE,
  feedbackCard,
  identityOf,
  NEWSLETTER_USED_UP,
  type NewsletterState,
  newsletterCard,
  noticeList,
  noticeWithText,
  openDesktopHeader,
  placementOf,
  REACHABLE,
  reachOf,
  SAME_NODE,
  seedFeedbackEligibleDocs,
  seedFeedbackNudgeStateBeforeLoad,
  seedNewsletterStateBeforeLoad,
  stubAgentCatalog,
  test,
  type WorkerServer,
} from './_helpers';
import {
  emitUpdateEvent,
  installUpdateEventOverlay,
  readRelaunchCalls,
  settleHeldRelaunch,
  type UpdateEventOverlayConfig,
} from './fixtures/update-event-overlay';

const VERSION = '9.9.9';
const DOWNLOAD_URL = 'https://openknowledge.ai/download';
const RELEASE_URL = 'https://openknowledge.ai/changelog';
const WIDE = { width: 1440, height: 900 } as const;
const SHORT = { width: 720, height: 480 } as const;
const UNBROKEN_PATH = `/Users/someone/${'a'.repeat(400)}/OpenKnowledge.app`;

async function seedOneDoc(api: ApiHelpers, slug: string): Promise<string> {
  const name = `corner-notices-${slug}-w${test.info().workerIndex}`;
  await api.seedDocs([{ name, markdown: `# ${name}\n\nA document under the corner stack.\n` }]);
  return name;
}

async function openDesktopWithUpdateEvents(
  page: Page,
  workerServer: WorkerServer,
  docName: string,
  overlay: UpdateEventOverlayConfig = {},
): Promise<void> {
  await stubAgentCatalog(page);
  await page.setViewportSize(WIDE);
  await installUpdateEventOverlay(page, overlay);
  await openDesktopHeader(page, workerServer, docName, {});
  await expectDocumentOpen(page, docName);
  await expect(page.locator('nav#app-file-sidebar')).toBeVisible();
  await expect(page.locator(EDITOR_PANE_CARD)).toBeVisible();
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('expected the card to have a layout box');
  return box;
}

interface NoticeKind {
  readonly kind: string;
  readonly overlay?: UpdateEventOverlayConfig;
  readonly newsletter?: NewsletterState;
  readonly emit?: (page: Page) => Promise<void>;
  readonly card: (page: Page) => Locator;
  readonly buttons?: readonly string[];
}

const NOTICE_KINDS: readonly NoticeKind[] = [
  {
    kind: 'ready to install',
    emit: (page) => emitUpdateEvent(page, 'onUpdateDownloaded', { version: VERSION }),
    card: (page) => noticeWithText(page, `Version ${VERSION} ready to install`),
    buttons: ['Relaunch', 'Dismiss notice'],
  },
  {
    kind: 'getting the latest version',
    emit: (page) => emitUpdateEvent(page, 'onUpdateFetchingLatest', { version: VERSION }),
    card: (page) => noticeWithText(page, 'Getting the latest version…'),
    buttons: [],
  },
  {
    kind: 'install failed',
    emit: (page) =>
      emitUpdateEvent(page, 'onUpdateRelaunchFailed', {
        version: VERSION,
        downloadUrl: DOWNLOAD_URL,
      }),
    card: (page) => noticeWithText(page, `Update to ${VERSION} didn't install.`),
    buttons: ['Retry', 'Download manually', 'Dismiss notice'],
  },
  {
    kind: 'relaunch failed',
    emit: (page) =>
      emitUpdateEvent(page, 'onUpdateRelaunchFailed', { version: VERSION, message: 'disk full' }),
    card: (page) => noticeWithText(page, 'Relaunch failed — please restart manually: disk full'),
    buttons: ['Dismiss notice'],
  },
  {
    kind: 'updates paused',
    emit: (page) => emitUpdateEvent(page, 'onUpdateStuckHint', { downloadUrl: DOWNLOAD_URL }),
    card: (page) => noticeWithText(page, 'Updates paused'),
    buttons: ['Download', 'Dismiss notice'],
  },
  {
    kind: 'checking for updates',
    emit: (page) => emitUpdateEvent(page, 'onUpdateManualCheck', { phase: 'started' }),
    card: (page) => noticeWithText(page, 'Checking for updates…'),
    buttons: ['Dismiss notice'],
  },
  {
    kind: 'settings reset',
    overlay: {
      schemaIncompatibility: { currentBuild: '0.9.0', persistedSchemaVersion: 7, maxSupported: 6 },
    },
    card: (page) =>
      noticeWithText(
        page,
        'Your settings and recent projects were saved by a newer build than this one (v0.9.0). Reset to defaults to continue.',
      ),
    buttons: ['Reset to defaults', 'Dismiss notice'],
  },
  {
    kind: 'updated to version, newsletter used up',
    newsletter: NEWSLETTER_USED_UP,
    emit: (page) =>
      emitUpdateEvent(page, 'onWhatsNew', { version: VERSION, releaseUrl: RELEASE_URL }),
    card: (page) => noticeWithText(page, `Updated to Version ${VERSION}`),
    buttons: ['Release notes', 'Dismiss notice'],
  },
  {
    kind: 'newsletter card',
    emit: (page) =>
      emitUpdateEvent(page, 'onWhatsNew', { version: VERSION, releaseUrl: RELEASE_URL }),
    card: (page) => newsletterCard(page).filter({ hasText: `Updated to Version ${VERSION}` }),
  },
];

test.describe('update notices in the corner stack, fake desktop host', () => {
  for (const { kind, overlay, newsletter, emit, card, buttons } of NOTICE_KINDS) {
    test(`${kind} renders in the corner stack, outside the file sidebar and editor card`, async ({
      page,
      api,
      workerServer,
    }) => {
      const docName = await seedOneDoc(api, kind.replaceAll(/[^a-z]+/g, '-'));
      if (newsletter !== undefined) await seedNewsletterStateBeforeLoad(page, newsletter);
      await openDesktopWithUpdateEvents(page, workerServer, docName, overlay);

      await emit?.(page);

      const notice = card(page);
      await expect(notice).toBeVisible();
      await expect(noticeList(page).locator(':scope > *')).toHaveCount(1);
      expect(await placementOf(notice)).toEqual(FLOATING_AND_HIT_TESTABLE);
      if (buttons !== undefined) {
        await expect(notice.getByRole('button')).toHaveCount(buttons.length);
        for (const name of buttons) {
          await expect(notice.getByRole('button', { name, exact: true })).toBeVisible();
        }
      }
    });
  }

  test('Relaunch shows the relaunching state in the stack and a failed relaunch takes its place', async ({
    page,
    api,
    workerServer,
  }) => {
    const docName = await seedOneDoc(api, 'relaunch-held');
    await openDesktopWithUpdateEvents(page, workerServer, docName);

    await emitUpdateEvent(page, 'onUpdateDownloaded', { version: VERSION });
    const ready = noticeWithText(page, `Version ${VERSION} ready to install`);
    await ready.getByRole('button', { name: 'Relaunch', exact: true }).click();

    const relaunching = noticeWithText(page, 'Relaunching to install the update…');
    await expect(relaunching).toBeVisible();
    await expect(relaunching.getByRole('button')).toHaveCount(0);
    await expect(noticeList(page).locator(':scope > *')).toHaveCount(1);
    expect(await placementOf(relaunching)).toEqual(FLOATING_AND_HIT_TESTABLE);
    expect(await readRelaunchCalls(page)).toBe(1);

    await settleHeldRelaunch(page, { kind: 'reject', message: 'disk full' });

    const failed = noticeWithText(page, 'Relaunch failed — please restart manually: disk full');
    await expect(failed).toBeVisible();
    await expect(relaunching).toHaveCount(0);
    await expect(noticeList(page).locator(':scope > *')).toHaveCount(1);
    expect(await placementOf(failed)).toEqual(FLOATING_AND_HIT_TESTABLE);
  });

  test('a higher-priority notice replaces the shown one in place', async ({
    page,
    api,
    workerServer,
  }) => {
    const docName = await seedOneDoc(api, 'replace-in-place');
    await openDesktopWithUpdateEvents(page, workerServer, docName);

    await emitUpdateEvent(page, 'onUpdateDownloaded', { version: VERSION });
    const ready = noticeWithText(page, `Version ${VERSION} ready to install`);
    await expect(ready).toBeVisible();
    const readyBox = await boxOf(ready);

    await emitUpdateEvent(page, 'onUpdateRelaunchFailed', {
      version: VERSION,
      downloadUrl: DOWNLOAD_URL,
    });

    const failed = noticeWithText(page, `Update to ${VERSION} didn't install.`);
    await expect(failed).toBeVisible();
    await expect(ready).toHaveCount(0);
    await expect(noticeList(page).locator(':scope > *')).toHaveCount(1);
    const failedBox = await boxOf(failed);
    expect(Math.abs(failedBox.x - readyBox.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(failedBox.y + failedBox.height - (readyBox.y + readyBox.height)),
    ).toBeLessThanOrEqual(1);
  });

  test('a notice arriving after the feedback card stacks above it, and dismissing it keeps the feedback card', async ({
    page,
    api,
    workerServer,
  }) => {
    const docName = await seedFeedbackEligibleDocs(
      api,
      `corner-notices-feedback-w${test.info().workerIndex}`,
    );
    await seedFeedbackNudgeStateBeforeLoad(page);
    await openDesktopWithUpdateEvents(page, workerServer, docName);
    const feedback = feedbackCard(page);
    await expect(feedback).toBeVisible({ timeout: 15_000 });
    const feedbackNode = await feedback.elementHandle();
    if (feedbackNode === null) throw new Error('expected the feedback card element');

    await emitUpdateEvent(page, 'onUpdateDownloaded', { version: VERSION });

    const ready = noticeWithText(page, `Version ${VERSION} ready to install`);
    await expect(ready).toBeVisible();
    await expect(feedback).toBeVisible();
    const readyBox = await boxOf(ready);
    const feedbackBox = await boxOf(feedback);
    expect(readyBox.y + readyBox.height).toBeLessThanOrEqual(feedbackBox.y + 0.5);

    await ready.getByRole('button', { name: 'Dismiss notice', exact: true }).click();

    await expect(ready).toHaveCount(0);
    await expect(noticeList(page)).toHaveCount(0);
    await expect(feedback).toBeVisible();
    expect(await identityOf(feedbackNode, feedback)).toEqual(SAME_NODE);
  });

  test('a click in the gap between a notice and the feedback card reaches what is underneath', async ({
    page,
    api,
    workerServer,
  }) => {
    const docName = await seedFeedbackEligibleDocs(
      api,
      `corner-notices-gap-w${test.info().workerIndex}`,
    );
    await seedFeedbackNudgeStateBeforeLoad(page);
    await openDesktopWithUpdateEvents(page, workerServer, docName);
    const feedback = feedbackCard(page);
    await expect(feedback).toBeVisible({ timeout: 15_000 });
    await emitUpdateEvent(page, 'onUpdateDownloaded', { version: VERSION });
    const ready = noticeWithText(page, `Version ${VERSION} ready to install`);
    await expect(ready).toBeVisible();

    const readyBox = await boxOf(ready);
    const feedbackBox = await boxOf(feedback);
    const gapTop = readyBox.y + readyBox.height;
    expect(feedbackBox.y - gapTop).toBeGreaterThan(2);
    const probe = { x: feedbackBox.x + feedbackBox.width / 2, y: (gapTop + feedbackBox.y) / 2 };

    const hit = await cornerStack(page).evaluate((stack, { x, y }) => {
      const el = document.elementFromPoint(x, y);
      return { found: el !== null, inStack: el !== null && stack.contains(el) };
    }, probe);
    expect(hit).toEqual({ found: true, inStack: false });
  });

  test('a click beside a short notice, inside the stack width, reaches what is underneath', async ({
    page,
    api,
    workerServer,
  }) => {
    const docName = await seedOneDoc(api, 'beside-short');
    await openDesktopWithUpdateEvents(page, workerServer, docName);
    await emitUpdateEvent(page, 'onUpdateDownloaded', { version: VERSION });
    const ready = noticeWithText(page, `Version ${VERSION} ready to install`);
    await expect(ready).toBeVisible();

    const readyBox = await boxOf(ready);
    const stackBox = await boxOf(cornerStack(page));
    const besideEnd = readyBox.x + readyBox.width + 12;
    expect(stackBox.x + stackBox.width - besideEnd).toBeGreaterThan(0);
    const probe = { x: besideEnd, y: readyBox.y + readyBox.height / 2 };

    const hit = await cornerStack(page).evaluate((stack, { x, y }) => {
      const el = document.elementFromPoint(x, y);
      return { found: el !== null, inStack: el !== null && stack.contains(el) };
    }, probe);
    expect(hit).toEqual({ found: true, inStack: false });
  });

  test('a long unbroken path in a notice wraps inside the card and keeps Dismiss reachable', async ({
    page,
    api,
    workerServer,
  }) => {
    const docName = await seedOneDoc(api, 'long-path');
    await openDesktopWithUpdateEvents(page, workerServer, docName);
    await page.setViewportSize(SHORT);

    await emitUpdateEvent(page, 'onUpdateRelaunchFailed', {
      version: VERSION,
      message: UNBROKEN_PATH,
    });
    const notice = noticeWithText(page, UNBROKEN_PATH);
    await expect(notice).toBeVisible();

    const overflow = await notice.evaluate((card, text) => {
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node.textContent?.includes(text)) range.selectNodeContents(node);
      }
      const cardRect = card.getBoundingClientRect();
      const textRect = range.getBoundingClientRect();
      return {
        start: Math.round(cardRect.left - textRect.left),
        end: Math.round(textRect.right - cardRect.right),
      };
    }, UNBROKEN_PATH);
    expect(overflow.start).toBeLessThanOrEqual(0);
    expect(overflow.end).toBeLessThanOrEqual(0);
    expect(await reachOf(notice.getByRole('button', { name: 'Dismiss notice' }))).toEqual(
      REACHABLE,
    );
  });
});
