import type { Locator, Page } from '@playwright/test';
import {
  arrangeTerminalAlone,
  CHAT_PANE_CARD,
  CORNER_STACK_TEST_ID,
  EDITOR_PANE_CARD,
  expect,
  expectDocumentOpen,
  expectEditorHidden,
  feedbackCard,
  headerPaneButton,
  identityOf,
  noticeWithText,
  openDesktopLayout,
  openWebLayout,
  runPaletteCommand,
  SAME_NODE,
  seedFeedbackEligibleDocs,
  seedFeedbackNudgeStateBeforeLoad,
  setHeaderPane,
  sidebarTrigger,
  terminalPaneCard,
  test,
} from './_helpers';
import {
  emitUpdateEvent,
  installUpdateEventOverlay,
  readRelaunchCalls,
} from './fixtures/update-event-overlay';

const WIDE = { width: 1440, height: 900 } as const;
const FEEDBACK_LATCH_TIMEOUT_MS = 15_000;
const ONBOARDING_TIMEOUT_MS = 15_000;
const VERSION = '9.9.9';
const RELAUNCHING = 'Relaunching to install the update…';
const DRAFT = 'The file list keeps hiding my notes.';

interface LayoutStep {
  readonly name: string;
  readonly act: (page: Page) => Promise<void>;
}

function onboardingChecklist(page: Page): Locator {
  return page.getByRole('region', { name: 'Get set up', exact: true });
}

async function homeOf(element: Locator) {
  await expect(element.page().getByTestId(CORNER_STACK_TEST_ID)).toBeAttached();
  return await element.evaluate(
    (el, stackTestId) => ({
      inSidebarFooter: el.closest('[data-slot="sidebar-footer"]') !== null,
      inCornerStack: el.closest(`[data-testid="${stackTestId}"]`) !== null,
    }),
    CORNER_STACK_TEST_ID,
  );
}

const IN_SIDEBAR_FOOTER = { inSidebarFooter: true, inCornerStack: false };

const FEEDBACK_DRAFT_STEPS: readonly LayoutStep[] = [
  {
    name: 'hide the editor',
    act: async (page) => {
      await setHeaderPane(page, 'editor', false);
      await expectEditorHidden(page);
    },
  },
  {
    name: 'show the editor',
    act: async (page) => {
      await setHeaderPane(page, 'editor', true);
      await expect(page.locator(EDITOR_PANE_CARD)).toBeVisible();
    },
  },
  {
    name: 'collapse the file sidebar',
    act: async (page) => {
      await sidebarTrigger(page).click();
      await expect(sidebarTrigger(page)).toHaveAttribute('aria-expanded', 'false');
    },
  },
  {
    name: 'reopen the file sidebar',
    act: async (page) => {
      await sidebarTrigger(page).click();
      await expect(sidebarTrigger(page)).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('nav#app-file-sidebar')).toBeVisible();
    },
  },
  {
    name: 'open chat',
    act: async (page) => {
      await setHeaderPane(page, 'agents', true);
      await expect(page.locator(CHAT_PANE_CARD)).toBeVisible();
    },
  },
  {
    name: 'close chat',
    act: async (page) => {
      await setHeaderPane(page, 'agents', false);
      await expect(page.locator(CHAT_PANE_CARD)).toBeHidden();
    },
  },
];

const RELAUNCH_STEPS: readonly LayoutStep[] = [
  {
    name: 'show the editor',
    act: async (page) => {
      await setHeaderPane(page, 'editor', true);
      await expect(page.locator(EDITOR_PANE_CARD)).toBeVisible();
    },
  },
  {
    name: 'hide the editor',
    act: async (page) => {
      await setHeaderPane(page, 'editor', false);
      await expectEditorHidden(page);
    },
  },
  {
    name: 'hide the terminal',
    act: async (page) => {
      await setHeaderPane(page, 'terminal', false);
      await expect(page.getByRole('region', { name: 'Nothing open', exact: true })).toBeVisible();
    },
  },
  {
    name: 'show the terminal',
    act: async (page) => {
      await setHeaderPane(page, 'terminal', true);
      await expect(page.locator(terminalPaneCard('bottom'))).toBeVisible();
    },
  },
  {
    name: 'move the terminal to the right',
    act: async (page) => {
      await runPaletteCommand(page, 'move terminal', 'move-terminal');
      await expect(page.locator(terminalPaneCard('right'))).toBeVisible();
    },
  },
  {
    name: 'move the terminal back to the bottom',
    act: async (page) => {
      await runPaletteCommand(page, 'move terminal', 'move-terminal');
      await expect(page.locator(terminalPaneCard('bottom'))).toBeVisible();
    },
  },
];

test.describe('cards survive layout changes', () => {
  test('a feedback draft keeps its card, rating and text across editor, sidebar and chat changes', async ({
    page,
    api,
  }) => {
    const docName = await seedFeedbackEligibleDocs(
      api,
      `corner-survival-draft-w${test.info().workerIndex}`,
    );
    await seedFeedbackNudgeStateBeforeLoad(page);
    await openWebLayout(page, docName, WIDE);
    await expectDocumentOpen(page, docName);

    const card = feedbackCard(page);
    await expect(card).toBeVisible({ timeout: FEEDBACK_LATCH_TIMEOUT_MS });
    const notGreat = card.getByRole('radio', { name: 'Not great' });
    await notGreat.click();
    const draft = card.getByPlaceholder('Tell us more (optional)');
    await draft.fill(DRAFT);
    const before = await card.elementHandle();
    if (before === null) throw new Error('expected the feedback card element');

    for (const step of FEEDBACK_DRAFT_STEPS) {
      await test.step(step.name, async () => {
        await step.act(page);
        await expect(card).toBeVisible();
        expect(await identityOf(before, card)).toEqual(SAME_NODE);
        await expect(notGreat).toHaveAttribute('aria-checked', 'true');
        await expect(draft).toHaveValue(DRAFT);
      });
    }
  });

  test('a held relaunch keeps its notice across editor, terminal and terminal-placement changes', async ({
    page,
    api,
    workerServer,
  }) => {
    const docName = `corner-survival-relaunch-w${test.info().workerIndex}`;
    await api.seedDocs([{ name: docName, markdown: `# ${docName}\n\nA terminal session.\n` }]);
    await installUpdateEventOverlay(page);
    await openDesktopLayout(page, workerServer, docName, {
      viewport: WIDE,
      terminalPlacement: 'bottom',
    });
    await expectDocumentOpen(page, docName);
    await arrangeTerminalAlone(page, 'bottom');

    await emitUpdateEvent(page, 'onUpdateDownloaded', { version: VERSION });
    await noticeWithText(page, `Version ${VERSION} ready to install`)
      .getByRole('button', { name: 'Relaunch', exact: true })
      .click();
    const relaunching = noticeWithText(page, RELAUNCHING);
    await expect(relaunching).toBeVisible();
    await expect(relaunching.getByRole('button')).toHaveCount(0);
    expect(await readRelaunchCalls(page)).toBe(1);
    const before = await relaunching.elementHandle();
    if (before === null) throw new Error('expected the relaunching notice element');

    for (const step of RELAUNCH_STEPS) {
      await test.step(step.name, async () => {
        await step.act(page);
        await expect(relaunching).toBeVisible();
        expect(await identityOf(before, relaunching)).toEqual(SAME_NODE);
        await expect(relaunching).toHaveText(RELAUNCHING);
        await expect(relaunching.getByRole('button')).toHaveCount(0);
      });
    }
  });
});

test.describe('the onboarding checklist stays in the file sidebar', () => {
  test('the checklist renders in the sidebar footer, an update notice goes to the corner, and hiding the editor hides only the checklist', async ({
    page,
    api,
    workerServer,
  }) => {
    const docName = `corner-survival-onboarding-w${test.info().workerIndex}`;
    await api.seedDocs([{ name: docName, markdown: `# ${docName}\n\nA new project.\n` }]);
    await installUpdateEventOverlay(page, { freshlyCreated: true });
    await openDesktopLayout(page, workerServer, docName, {
      viewport: WIDE,
      terminalPlacement: 'bottom',
    });
    await expectDocumentOpen(page, docName);

    const checklist = onboardingChecklist(page);
    await expect(checklist).toBeVisible({ timeout: ONBOARDING_TIMEOUT_MS });
    await expect(checklist).toHaveCount(1);
    expect(await homeOf(checklist)).toEqual(IN_SIDEBAR_FOOTER);

    await emitUpdateEvent(page, 'onUpdateDownloaded', { version: VERSION });
    const ready = noticeWithText(page, `Version ${VERSION} ready to install`);
    await expect(ready).toBeVisible();
    await expect(checklist).toBeVisible();
    await expect(checklist).toHaveCount(1);
    expect(await homeOf(checklist)).toEqual(IN_SIDEBAR_FOOTER);

    await setHeaderPane(page, 'editor', false);
    await expectEditorHidden(page);
    await expect(checklist).toBeHidden();
    await expect(ready).toBeVisible();

    await setHeaderPane(page, 'editor', true);
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');
    await expect(checklist).toBeVisible();
    expect(await homeOf(checklist)).toEqual(IN_SIDEBAR_FOOTER);
    await expect(ready).toBeVisible();
  });
});
