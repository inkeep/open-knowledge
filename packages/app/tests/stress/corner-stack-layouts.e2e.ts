import type { Locator, Page } from '@playwright/test';
import type { TerminalPlacement } from '../../src/lib/terminal-placement-store';
import {
  type ApiHelpers,
  arrangeTerminalAlone,
  CHAT_PANE_CARD,
  expect,
  expectDocumentOpen,
  expectEditorHidden,
  FLOATING_AND_HIT_TESTABLE,
  feedbackCard,
  headerPaneButton,
  noticeWithText,
  openDesktopLayout,
  openWebLayout,
  placementOf,
  seedFeedbackEligibleDocs,
  seedFeedbackNudgeStateBeforeLoad,
  setHeaderPane,
  sidebarTrigger,
  terminalPaneCard,
  test,
  type WorkerServer,
} from './_helpers';
import {
  emitUpdateEvent,
  installUpdateEventOverlay,
  readRelaunchCalls,
} from './fixtures/update-event-overlay';

const WIDE = { width: 1440, height: 900 } as const;
const FEEDBACK_LATCH_TIMEOUT_MS = 15_000;
const VERSION = '9.9.9';

type Host = 'web' | 'desktop';

interface Layout {
  readonly name: string;
  readonly host: Host;
  readonly terminalPlacement?: TerminalPlacement;
  readonly arrange: (page: Page) => Promise<void>;
}

async function openWithFeedbackShowing(
  page: Page,
  api: ApiHelpers,
  workerServer: WorkerServer,
  slug: string,
  host: Host,
  terminalPlacement: TerminalPlacement,
): Promise<Locator> {
  const docName = await seedFeedbackEligibleDocs(
    api,
    `corner-layouts-${slug}-w${test.info().workerIndex}`,
  );
  await seedFeedbackNudgeStateBeforeLoad(page);
  if (host === 'web') await openWebLayout(page, docName, WIDE);
  else await openDesktopLayout(page, workerServer, docName, { viewport: WIDE, terminalPlacement });
  await expectDocumentOpen(page, docName);
  const card = feedbackCard(page);
  await expect(card).toBeVisible({ timeout: FEEDBACK_LATCH_TIMEOUT_MS });
  return card;
}

const LAYOUTS: readonly Layout[] = [
  {
    name: 'web, editor shown with the file sidebar open',
    host: 'web',
    arrange: async (page) => {
      await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');
      await expect(sidebarTrigger(page)).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('nav#app-file-sidebar')).toBeVisible();
    },
  },
  {
    name: 'web, editor hidden with chat alone',
    host: 'web',
    arrange: async (page) => {
      await setHeaderPane(page, 'agents', true);
      await setHeaderPane(page, 'editor', false);
      await expectEditorHidden(page);
      await expect(page.locator(CHAT_PANE_CARD)).toBeVisible();
    },
  },
  {
    name: 'web, editor and chat hidden so Nothing open shows',
    host: 'web',
    arrange: async (page) => {
      await setHeaderPane(page, 'agents', false);
      await setHeaderPane(page, 'editor', false);
      await expectEditorHidden(page);
      await expect(page.getByRole('region', { name: 'Nothing open', exact: true })).toBeVisible();
    },
  },
  {
    name: 'desktop, editor hidden with the terminal alone at the bottom',
    host: 'desktop',
    terminalPlacement: 'bottom',
    arrange: (page) => arrangeTerminalAlone(page, 'bottom'),
  },
  {
    name: 'desktop, editor hidden with the terminal alone on the right',
    host: 'desktop',
    terminalPlacement: 'right',
    arrange: (page) => arrangeTerminalAlone(page, 'right'),
  },
  {
    name: 'desktop, editor hidden with chat and the terminal',
    host: 'desktop',
    terminalPlacement: 'bottom',
    arrange: async (page) => {
      await setHeaderPane(page, 'terminal', true);
      await setHeaderPane(page, 'agents', true);
      await setHeaderPane(page, 'editor', false);
      await expectEditorHidden(page);
      await expect(page.locator(terminalPaneCard('bottom'))).toBeVisible();
      await expect(page.locator(CHAT_PANE_CARD)).toBeVisible();
    },
  },
];

test.describe('a showing card in every pane layout', () => {
  for (const { name, host, terminalPlacement = 'bottom', arrange } of LAYOUTS) {
    test(`${name}: the feedback card stays visible and clickable`, async ({
      page,
      api,
      workerServer,
    }) => {
      const card = await openWithFeedbackShowing(
        page,
        api,
        workerServer,
        name.replaceAll(/[^a-z]+/g, '-'),
        host,
        terminalPlacement,
      );

      await arrange(page);

      await expect(card).toBeVisible();
      expect(await placementOf(card)).toEqual(FLOATING_AND_HIT_TESTABLE);
      const notGreat = card.getByRole('radio', { name: 'Not great' });
      await notGreat.click();
      await expect(notGreat).toHaveAttribute('aria-checked', 'true');
      await expect(card.getByPlaceholder('Tell us more (optional)')).toBeVisible();
    });
  }
});

test.describe('acting on an update with the editor hidden', () => {
  test('Relaunch on a ready update, with the terminal alone at the bottom, shows the relaunching state in the corner', async ({
    page,
    api,
    workerServer,
  }) => {
    const docName = `corner-layouts-relaunch-w${test.info().workerIndex}`;
    await api.seedDocs([{ name: docName, markdown: `# ${docName}\n\nA terminal session.\n` }]);
    await installUpdateEventOverlay(page);
    await openDesktopLayout(page, workerServer, docName, {
      viewport: WIDE,
      terminalPlacement: 'bottom',
    });
    await expectDocumentOpen(page, docName);
    await arrangeTerminalAlone(page, 'bottom');

    await emitUpdateEvent(page, 'onUpdateDownloaded', { version: VERSION });
    const ready = noticeWithText(page, `Version ${VERSION} ready to install`);
    await expect(ready).toBeVisible();
    expect(await placementOf(ready)).toEqual(FLOATING_AND_HIT_TESTABLE);
    await ready.getByRole('button', { name: 'Relaunch', exact: true }).click();

    const relaunching = noticeWithText(page, 'Relaunching to install the update…');
    await expect(relaunching).toBeVisible();
    await expect(relaunching.getByRole('button')).toHaveCount(0);
    expect(await placementOf(relaunching)).toEqual(FLOATING_AND_HIT_TESTABLE);
    expect(await readRelaunchCalls(page)).toBe(1);
    await expectEditorHidden(page);
  });
});
