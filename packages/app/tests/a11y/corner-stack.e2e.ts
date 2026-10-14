import AxeBuilder from '@axe-core/playwright';
import type { ElementHandle, JSHandle, Locator, Page } from '@playwright/test';
import {
  type ApiHelpers,
  arrangeTerminalAlone,
  CHAT_PANE_CARD,
  CORNER_STACK_TEST_ID,
  contrastRatioOf,
  cornerStack,
  expect,
  expectDocumentOpen,
  feedbackCard,
  headerPaneButton,
  NEWSLETTER_USED_UP,
  newsletterCard,
  noticeWithText,
  openDesktopLayout,
  openWebLayout,
  readContrastPair,
  seedFeedbackEligibleDocs,
  seedFeedbackNudgeStateBeforeLoad,
  seedNewsletterStateBeforeLoad,
  setHeaderPane,
  terminalPaneCard,
  test,
  type WorkerServer,
} from '../stress/_helpers';
import {
  emitUpdateEvent,
  installUpdateEventOverlay,
} from '../stress/fixtures/update-event-overlay';

const WIDE = { width: 1440, height: 900 } as const;
const VERSION = '9.9.9';
const DOWNLOAD_URL = 'https://openknowledge.ai/download';
const RELEASE_URL = 'https://openknowledge.ai/changelog';
const STACK_NAME = 'Updates and feedback';
const STACK = `[data-testid="${CORNER_STACK_TEST_ID}"]`;
const BOTTOM_TERMINAL = terminalPaneCard('bottom');
const ANY_TERMINAL = '[data-pane="terminal"], .xterm';
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const FEEDBACK_LATCH_TIMEOUT_MS = 15_000;
const HARNESS_TIMEOUT_MS = 30_000;
const MAX_TAB_PRESSES = 40;
const CHAT_AGENT = { source: 'registry', id: 'codex-acp', name: 'Codex' } as const;
const TAB_STOP_CANDIDATES =
  'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';
const LIVE_REGION =
  '[role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"], [aria-live]:not([aria-live="off"]), output';

type Host = 'web' | 'desktop';

interface LiveRegion {
  readonly role: string | null;
  readonly live: string | null;
  readonly isUpdateNotice: boolean;
  readonly text: string;
}

async function openWithFeedbackShowing(
  page: Page,
  api: ApiHelpers,
  slug: string,
): Promise<Locator> {
  const docName = await seedFeedbackEligibleDocs(
    api,
    `corner-a11y-${slug}-w${test.info().workerIndex}`,
  );
  await seedFeedbackNudgeStateBeforeLoad(page);
  await openWebLayout(page, docName, WIDE);
  await expectDocumentOpen(page, docName);
  const card = feedbackCard(page);
  await expect(card).toBeVisible({ timeout: FEEDBACK_LATCH_TIMEOUT_MS });
  return card;
}

async function openDesktop(
  page: Page,
  api: ApiHelpers,
  workerServer: WorkerServer,
  slug: string,
): Promise<void> {
  const docName = `corner-a11y-${slug}-w${test.info().workerIndex}`;
  await api.seedDocs([
    { name: docName, markdown: `# ${docName}\n\nA document under the corner stack.\n` },
  ]);
  await installUpdateEventOverlay(page);
  await openDesktopLayout(page, workerServer, docName, {
    viewport: WIDE,
    terminalPlacement: 'bottom',
  });
  await expectDocumentOpen(page, docName);
}

async function emitInstallFailed(page: Page): Promise<Locator> {
  await emitUpdateEvent(page, 'onUpdateRelaunchFailed', {
    version: VERSION,
    downloadUrl: DOWNLOAD_URL,
  });
  const notice = noticeWithText(page, `Update to ${VERSION} didn't install.`);
  await expect(notice).toBeVisible();
  return notice;
}

async function emitWhatsNew(page: Page): Promise<void> {
  await emitUpdateEvent(page, 'onWhatsNew', { version: VERSION, releaseUrl: RELEASE_URL });
}

async function tabStops(page: Page): Promise<JSHandle<HTMLElement[]>> {
  return await page.evaluateHandle(
    (candidates) =>
      Array.from(document.querySelectorAll<HTMLElement>(candidates)).filter(
        (el) =>
          el.tabIndex >= 0 &&
          !el.matches(':disabled') &&
          el.closest('[inert]') === null &&
          el.getClientRects().length > 0 &&
          getComputedStyle(el).visibility === 'visible',
      ),
    TAB_STOP_CANDIDATES,
  );
}

async function lastTabStopBeforeStack(page: Page): Promise<ElementHandle<HTMLElement>> {
  const stops = await tabStops(page);
  const last = await stops.evaluateHandle((list, stackSelector) => {
    const stack = document.querySelector(stackSelector);
    if (stack === null) throw new Error('the corner stack is not in the page');
    const before = list.filter(
      (el) =>
        !stack.contains(el) &&
        (el.compareDocumentPosition(stack) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    );
    const found = before.at(-1);
    if (found === undefined) throw new Error('no tab stop precedes the corner stack');
    return found;
  }, STACK);
  await stops.dispose();
  const element = last.asElement();
  if (element === null) throw new Error('expected the last tab stop to be an element');
  return element;
}

async function sameTabStopsOutsideCard(
  page: Page,
  card: Locator,
  before: JSHandle<HTMLElement[]>,
  after: JSHandle<HTMLElement[]>,
): Promise<{ readonly before: number; readonly after: number; readonly identical: boolean }> {
  const cardElement = await card.elementHandle();
  if (cardElement === null) throw new Error('expected the card to be in the page');
  try {
    return await page.evaluate(
      ({ previous, next, within }) => {
        const outside = (list: HTMLElement[]) => list.filter((el) => !within.contains(el));
        const was = outside(previous);
        const now = outside(next);
        return {
          before: was.length,
          after: now.length,
          identical: was.length === now.length && was.every((el, index) => el === now[index]),
        };
      },
      { previous: before, next: after, within: cardElement },
    );
  } finally {
    await cardElement.dispose();
  }
}

async function focusedElement(page: Page): Promise<JSHandle<Element | null>> {
  return await page.evaluateHandle(() => document.activeElement);
}

async function stillFocused(focused: JSHandle<Element | null>): Promise<boolean> {
  return await focused.evaluate((el) => el !== null && el === document.activeElement);
}

async function focusIsInside(page: Page, selector: string): Promise<boolean> {
  return await page.evaluate((within) => document.activeElement?.closest(within) != null, selector);
}

async function liveRegionsIn(scope: Locator): Promise<LiveRegion[]> {
  return await scope.evaluate((root, selector) => {
    const regions = [root, ...Array.from(root.querySelectorAll(selector))].filter((el) =>
      el.matches(selector),
    );
    return regions.map((el) => ({
      role: el.getAttribute('role'),
      live: el.getAttribute('aria-live'),
      isUpdateNotice: el.matches('[data-testid^="update-notice-"]'),
      text: el.textContent?.trim() ?? '',
    }));
  }, LIVE_REGION);
}

async function seriousOrCriticalViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).include(STACK).analyze();
  return results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
}

function threadRosterDelivered(page: Page): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('thread socket never delivered its roster')),
      HARNESS_TIMEOUT_MS,
    );
    page.on('websocket', (socket) => {
      if (!socket.url().includes('/collab/thread')) return;
      socket.on('framereceived', (frame) => {
        if (typeof frame.payload !== 'string') return;
        if (!frame.payload.includes('"op":"threads"')) return;
        clearTimeout(timer);
        resolve();
      });
    });
  });
}

async function focusTheTerminal(page: Page): Promise<void> {
  await page.locator(`${BOTTOM_TERMINAL} .xterm`).click();
  await expect.poll(() => focusIsInside(page, BOTTOM_TERMINAL)).toBe(true);
}

test.describe('the corner stack for keyboard users', () => {
  test('Tab from the last pane control reaches the feedback card, which follows the panes in the page', async ({
    page,
    api,
  }) => {
    const card = await openWithFeedbackShowing(page, api, 'tab-order');

    const order = await page.evaluate((stackSelector) => {
      const stack = document.querySelector(stackSelector);
      if (stack === null) throw new Error('the corner stack is not in the page');
      const panes = [
        document.querySelector('[data-app-main]'),
        ...Array.from(document.querySelectorAll('[data-slot="pane-card"]')),
      ].filter((el): el is Element => el !== null);
      return {
        panes: panes.length,
        stackFollowsEveryPane: panes.every(
          (pane) =>
            !pane.contains(stack) &&
            (pane.compareDocumentPosition(stack) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        ),
      };
    }, STACK);
    expect(order.panes).toBeGreaterThan(1);
    expect(order.stackFollowsEveryPane).toBe(true);

    const lastPaneStop = await lastTabStopBeforeStack(page);
    expect(await lastPaneStop.evaluate((el) => el.closest('[data-app-main]') !== null)).toBe(true);
    await lastPaneStop.focus();
    expect(await lastPaneStop.evaluate((el) => el === document.activeElement)).toBe(true);

    await page.keyboard.press('Tab');
    await expect(card.getByRole('button', { name: 'Close', exact: true })).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    expect(await lastPaneStop.evaluate((el) => el === document.activeElement)).toBe(true);
  });

  test('from a focused bottom terminal with the editor hidden, Ctrl+` leaves the terminal and Tab reaches the install-failed notice without entering it', async ({
    page,
    api,
    workerServer,
  }) => {
    await openDesktop(page, api, workerServer, 'ctrl-backquote');
    await arrangeTerminalAlone(page, 'bottom');
    await focusTheTerminal(page);

    const notice = await emitInstallFailed(page);
    expect(await focusIsInside(page, BOTTOM_TERMINAL)).toBe(true);

    await page.keyboard.press('Control+Backquote');
    await expect(headerPaneButton(page, 'terminal')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('region', { name: 'Nothing open', exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.activeElement?.matches(
              '[data-nothing-open], [data-testid="header-pane-button-editor"]',
            ) === true,
        ),
      )
      .toBe(true);

    const visited: string[] = [];
    let reachedNotice = false;
    for (let press = 0; press < MAX_TAB_PRESSES && !reachedNotice; press += 1) {
      await page.keyboard.press('Tab');
      const zone = await page.evaluate(
        ({ terminal, stack }) => {
          const active = document.activeElement;
          if (active === null || active === document.body) return 'none';
          if (active.closest(terminal) !== null) return 'terminal';
          if (active.closest(stack) !== null) return 'stack';
          return 'other';
        },
        { terminal: ANY_TERMINAL, stack: STACK },
      );
      visited.push(zone);
      reachedNotice = zone === 'stack';
    }

    expect(reachedNotice, `zones Tab passed through: ${visited.join(', ')}`).toBe(true);
    expect(visited).not.toContain('terminal');
    await expect(notice.getByRole('button', { name: 'Dismiss notice', exact: true })).toBeFocused();
  });
});

interface FocusSite {
  readonly name: string;
  readonly focus: (page: Page) => Promise<void>;
}

const FOCUS_SITES: readonly FocusSite[] = [
  {
    name: 'the editor',
    focus: async (page) => {
      const editor = page.locator('.tiptap-editor .ProseMirror').first();
      await editor.click();
      await expect(editor).toBeFocused();
    },
  },
  {
    name: 'the terminal',
    focus: async (page) => {
      await setHeaderPane(page, 'terminal', true);
      await expect(page.locator(BOTTOM_TERMINAL)).toBeVisible();
      await focusTheTerminal(page);
    },
  },
  {
    name: 'the chat composer',
    focus: async (page) => {
      await setHeaderPane(page, 'agents', true);
      await expect(page.locator(CHAT_PANE_CARD)).toBeVisible();
      await page.waitForFunction(() => window.__acpThreadHarness !== undefined, null, {
        timeout: HARNESS_TIMEOUT_MS,
      });
      const threadId = await page.evaluate((agent) => {
        const harness = window.__acpThreadHarness;
        if (harness === undefined) throw new Error('ACP thread harness is not installed');
        return harness.openThread({ agent, title: 'Corner stack focus' });
      }, CHAT_AGENT);
      const composer = page.locator(
        `[data-session-id="${threadId}"] [data-testid="agent-thread-composer"]`,
      );
      await expect(composer).toBeVisible({ timeout: HARNESS_TIMEOUT_MS });
      await composer.focus();
      await expect(composer).toBeFocused();
    },
  },
];

test.describe('an arriving notice never takes focus', () => {
  for (const { name, focus } of FOCUS_SITES) {
    test(`a notice arriving while focus is in ${name} leaves focus there and adds no tab stop outside the card`, async ({
      page,
      api,
      workerServer,
    }) => {
      const roster = threadRosterDelivered(page);
      await openDesktop(
        page,
        api,
        workerServer,
        `no-focus-theft-${name.replaceAll(/[^a-z]+/g, '-')}`,
      );
      await roster;
      await focus(page);
      const focused = await focusedElement(page);
      const before = await tabStops(page);

      const notice = await emitInstallFailed(page);

      expect(await stillFocused(focused)).toBe(true);
      const after = await tabStops(page);
      const comparison = await sameTabStopsOutsideCard(page, notice, before, after);
      expect(comparison.before).toBeGreaterThan(0);
      expect(comparison).toMatchObject({ identical: true });
      await expect(notice.getByRole('button')).toHaveCount(3);
      expect(await stillFocused(focused)).toBe(true);
    });
  }
});

test.describe('the corner stack for screen-reader users', () => {
  test('exactly one region carries the stack name, and it shares no words with the toaster region', async ({
    page,
    api,
    workerServer,
  }) => {
    await openDesktop(page, api, workerServer, 'region-name');
    await emitUpdateEvent(page, 'onUpdateRelaunchFailed', {
      version: VERSION,
      downloadUrl: DOWNLOAD_URL,
    });
    const stack = page.getByTestId(CORNER_STACK_TEST_ID);
    await expect(stack).toBeVisible();

    const stackName = await stack.getAttribute('aria-label');
    if (stackName === null) throw new Error('expected the corner stack to carry a name');
    expect(stackName).not.toContain('Notifications');
    expect(stackName).toBe(STACK_NAME);
    await expect(page.getByRole('region', { name: stackName, exact: true })).toHaveCount(1);

    const toaster = page.getByRole('region', { name: /^Notifications/ });
    await expect(toaster).toHaveCount(1);
    const toasterName = await toaster.getAttribute('aria-label');
    if (toasterName === null) throw new Error('expected the toaster region to carry a name');
    expect(toasterName).not.toContain(stackName);
    expect(stackName).not.toContain(toasterName);
  });

  test('an update notice is the stack only live region and announces politely', async ({
    page,
    api,
    workerServer,
  }) => {
    await openDesktop(page, api, workerServer, 'notice-live-region');
    const notice = await emitInstallFailed(page);

    await expect(notice).toHaveAttribute('role', 'status');
    await expect(notice).toHaveAttribute('aria-live', 'polite');
    expect(await liveRegionsIn(cornerStack(page))).toEqual([
      expect.objectContaining({ role: 'status', live: 'polite', isUpdateNotice: true }),
    ]);
  });

  test('the newsletter card is the region Stay in the loop and adds no live region beyond its status line and, while an error shows, its alert', async ({
    page,
    api,
    workerServer,
  }) => {
    await page.route('**/api/subscribe', (route) => route.abort());
    await openDesktop(page, api, workerServer, 'newsletter-live-regions');
    await emitWhatsNew(page);
    const card = newsletterCard(page);
    await expect(card).toBeVisible();
    await expect(card).toContainText(`Updated to Version ${VERSION}`);

    expect(await liveRegionsIn(cornerStack(page))).toEqual([
      { role: 'status', live: null, isUpdateNotice: false, text: 'Product updates in your inbox.' },
    ]);
    expect(
      await card
        .getByText(`Updated to Version ${VERSION}`, { exact: true })
        .evaluate((el, selector) => el.closest(selector) === null, LIVE_REGION),
    ).toBe(true);

    await card.getByRole('textbox', { name: 'Email address' }).fill('not-an-email');
    await card.getByTestId('subscribe-submit').click();
    await expect(card.getByRole('alert')).toHaveText('Please enter a valid email address.');

    expect(await liveRegionsIn(cornerStack(page))).toEqual([
      { role: 'status', live: null, isUpdateNotice: false, text: 'Product updates in your inbox.' },
      {
        role: 'alert',
        live: null,
        isUpdateNotice: false,
        text: 'Please enter a valid email address.',
      },
    ]);
  });
});

interface ScannedCard {
  readonly name: string;
  readonly host: Host;
  readonly show: (page: Page) => Promise<Locator>;
}

const SCANNED_CARDS: readonly ScannedCard[] = [
  {
    name: 'the feedback card',
    host: 'web',
    show: async (page) => feedbackCard(page),
  },
  {
    name: 'the install-failed notice',
    host: 'desktop',
    show: emitInstallFailed,
  },
  {
    name: 'the newsletter card',
    host: 'desktop',
    show: async (page) => {
      await emitWhatsNew(page);
      const card = newsletterCard(page);
      await expect(card).toBeVisible();
      return card;
    },
  },
];

test.describe('axe over the corner stack', () => {
  for (const { name, host, show } of SCANNED_CARDS) {
    test(`with ${name} showing, axe reports no serious or critical violation`, async ({
      page,
      api,
      workerServer,
    }) => {
      const slug = `axe-${name.replaceAll(/[^a-z]+/g, '-')}`;
      if (host === 'web') await openWithFeedbackShowing(page, api, slug);
      else await openDesktop(page, api, workerServer, slug);
      const card = await show(page);
      await expect(card).toBeVisible();

      const blocking = await seriousOrCriticalViolations(page);
      expect(blocking.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
    });
  }

  test('with the plain Updated to Version X notice showing, color contrast is recorded and nothing else is serious or critical', async ({
    page,
    api,
    workerServer,
  }) => {
    await seedNewsletterStateBeforeLoad(page, NEWSLETTER_USED_UP);
    await openDesktop(page, api, workerServer, 'axe-updated-notice');
    await emitWhatsNew(page);
    const notice = noticeWithText(page, `Updated to Version ${VERSION}`);
    await expect(notice).toBeVisible();

    const blocking = await seriousOrCriticalViolations(page);
    const contrast = blocking.filter((violation) => violation.id === 'color-contrast');
    const others = blocking.filter((violation) => violation.id !== 'color-contrast');
    expect(others.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);

    const pair = await readContrastPair(
      notice.getByText(`Updated to Version ${VERSION}`, { exact: true }),
      notice,
    );
    await test.info().attach('updated-notice color contrast (pre-existing, not gated)', {
      body: JSON.stringify(
        {
          measuredRatio: Math.round(contrastRatioOf(pair) * 100) / 100,
          axe: contrast.flatMap((violation) =>
            violation.nodes.map((node) => node.failureSummary ?? ''),
          ),
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  });
});
