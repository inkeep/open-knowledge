import type { Page } from '@playwright/test';
import type { TerminalPlacement } from '../../src/lib/terminal-placement-store';
import type { ApiHelpers, WorkerServer } from './_helpers';
import {
  CHAT_PANE_CARD,
  EDITOR_PANE_CARD,
  expect,
  expectEditorHidden,
  headerPaneButton,
  openDesktopHeader,
  presetTerminalPlacement,
  setHeaderPane,
  stubAgentCatalog,
  terminalPaneCard,
  test,
  waitForActiveProviderSynced,
} from './_helpers';

type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

const RIGHT_TERMINAL_PANE_CARD = terminalPaneCard('right');
const BOOT_TIMEOUT_MS = 30_000;
const THREAD_FIRST_RENDER_TIMEOUT_MS = 60_000;
const DOC_TEXT = 'The quick brown fox jumps over the lazy dog.';
const BOTTOM_TERMINAL_CARD =
  '[data-slot="pane-card"][data-pane="terminal"][data-placement="bottom"]';
const PANELS = '[data-editor-area-panels]';
const EDITOR_COLUMN = '[data-editor-row="outer"] > [data-panel]';
const EDITOR_REGION = '[data-editor-region]';
const MIN_CARD_PX = 100;

async function boxOf(page: Page, selector: string): Promise<Box> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`${selector} has no layout box`);
  return box;
}

function threadRootSelector(threadId: string): string {
  return `[data-session-id="${threadId}"] [data-agent-thread-root]`;
}

async function widthOf(page: Page, selector: string): Promise<number> {
  return await page.evaluate((s) => {
    const element = document.querySelector(s);
    if (element === null) throw new Error(`${s} is not rendered`);
    return element.getBoundingClientRect().width;
  }, selector);
}

function otherDocName(slug: string): string {
  return `editor-pane-${slug}-other-${test.info().workerIndex}`;
}

async function seedDoc(api: ApiHelpers, slug: string, extraParagraphs = 0): Promise<string> {
  const name = `editor-pane-${slug}-${test.info().workerIndex}`;
  const filler = Array.from(
    { length: extraParagraphs },
    (_, i) => `Paragraph ${i + 1}. ${DOC_TEXT}`,
  );
  const other = otherDocName(slug);
  await api.seedDocs([
    { name, markdown: [`# ${name}`, DOC_TEXT, ...filler].join('\n\n') },
    { name: other, markdown: `# ${other}\n\nThe other document.\n` },
  ]);
  return name;
}

async function waitForDocument(page: Page): Promise<void> {
  await expect(page.locator('.tiptap-editor .ProseMirror').first()).toContainText(DOC_TEXT, {
    timeout: BOOT_TIMEOUT_MS,
  });
}

async function openWeb(page: Page, api: ApiHelpers, slug: string, extraParagraphs = 0) {
  const name = await seedDoc(api, slug, extraParagraphs);
  await stubAgentCatalog(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/#/${name}`);
  await waitForActiveProviderSynced(page);
  await expect(headerPaneButton(page, 'editor')).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await waitForDocument(page);
  return name;
}

async function openDesktop(
  page: Page,
  api: ApiHelpers,
  workerServer: WorkerServer,
  slug: string,
  placement: TerminalPlacement,
) {
  const name = await seedDoc(api, slug);
  await stubAgentCatalog(page);
  await presetTerminalPlacement(page, placement);
  await page.setViewportSize({ width: 1600, height: 900 });
  await openDesktopHeader(page, workerServer, name, {});
  await expect(headerPaneButton(page, 'terminal')).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await waitForDocument(page);
  return name;
}

async function expectEditorColumnEmpty(page: Page): Promise<void> {
  await expect.poll(() => widthOf(page, EDITOR_COLUMN)).toBeLessThanOrEqual(1);
}

async function expectFillsRow(page: Page, selectors: readonly string[]): Promise<void> {
  await expect
    .poll(async () => {
      const boxes = await Promise.all(selectors.map((s) => boxOf(page, s)));
      return Math.min(...boxes.flatMap((b) => [b.width, b.height]));
    })
    .toBeGreaterThanOrEqual(MIN_CARD_PX);
  await expect
    .poll(async () => {
      const panels = await boxOf(page, PANELS);
      const boxes = await Promise.all(selectors.map((s) => boxOf(page, s)));
      const left = Math.min(...boxes.map((b) => b.x));
      const right = Math.max(...boxes.map((b) => b.x + b.width));
      return Math.round(Math.abs(left - panels.x) + Math.abs(panels.x + panels.width - right));
    })
    .toBeLessThanOrEqual(2);
}

test.describe('the Editor header button', () => {
  test('sits first in the Panels group, names itself Editor and shows no shortcut', async ({
    page,
    api,
  }) => {
    await openWeb(page, api, 'order');
    const names = await page
      .getByRole('group', { name: 'Panels' })
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label')));
    expect(names).toEqual(['Editor', 'Agents']);
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');

    await headerPaneButton(page, 'editor').hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toHaveText('Editor');
    await expect(tooltip.locator('[data-slot="kbd"]')).toHaveCount(0);
  });

  test('keyboard activation hides the editor keeping focus on the button, and shows it moving focus into the editor', async ({
    page,
    api,
  }) => {
    await openWeb(page, api, 'keyboard');
    await headerPaneButton(page, 'editor').focus();
    await page.keyboard.press('Enter');
    await expectEditorHidden(page);
    await expect(headerPaneButton(page, 'editor')).toBeFocused();

    await page.keyboard.press('Space');
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(EDITOR_PANE_CARD)).not.toHaveAttribute('inert', '');
    await expect(page.locator(EDITOR_REGION)).toBeFocused();
  });

  test('hiding and showing brings back the same editor, tabs and scroll position without reloading', async ({
    page,
    api,
  }) => {
    await openWeb(page, api, 'same-instance', 80);
    await setHeaderPane(page, 'agents', true);
    const scroller = page.getByTestId('editor-scroll-container').first();
    await expect(scroller).toBeVisible();
    await scroller.evaluate((el) => {
      el.scrollTop = 900;
    });
    const before = await page.evaluate(() => {
      const editor = document.querySelector('.tiptap-editor .ProseMirror') as
        | (HTMLElement & { __editorPaneMark?: string })
        | null;
      if (editor === null) throw new Error('no editor');
      editor.__editorPaneMark = 'kept';
      return {
        tabs: [...document.querySelectorAll('[data-editor-tab-id]')].map((t) =>
          t.getAttribute('data-editor-tab-id'),
        ),
      };
    });
    const scrollBefore = await scroller.evaluate((el) => el.scrollTop);
    expect(scrollBefore).toBeGreaterThan(0);

    await setHeaderPane(page, 'editor', false);
    await expectEditorHidden(page);
    await setHeaderPane(page, 'editor', true);

    await expect(page.locator(EDITOR_PANE_CARD)).not.toHaveAttribute('inert', '');
    const after = await page.evaluate(() => {
      const editor = document.querySelector('.tiptap-editor .ProseMirror') as
        | (HTMLElement & { __editorPaneMark?: string })
        | null;
      return {
        mark: editor?.__editorPaneMark ?? null,
        tabs: [...document.querySelectorAll('[data-editor-tab-id]')].map((t) =>
          t.getAttribute('data-editor-tab-id'),
        ),
      };
    });
    expect(after.mark).toBe('kept');
    expect(after.tabs).toEqual(before.tabs);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(scrollBefore);
  });

  test('chat alone fills the row, and the file list, checkout line and Ask AI box go with the editor', async ({
    page,
    api,
  }) => {
    await openWeb(page, api, 'chat-alone');
    await setHeaderPane(page, 'agents', true);
    const chatWidthBefore = await widthOf(page, CHAT_PANE_CARD);

    await setHeaderPane(page, 'editor', false);
    await expectEditorHidden(page);
    await expectEditorColumnEmpty(page);
    await expectFillsRow(page, [CHAT_PANE_CARD]);
    await expect(page.locator('[data-editor-file-list-slot]')).not.toBeInViewport();
    await expect(
      page.getByRole('region', { name: /Document statistics|Editor status bar/ }),
    ).not.toBeVisible();

    await setHeaderPane(page, 'editor', true);
    await expect.poll(() => widthOf(page, CHAT_PANE_CARD)).toBeCloseTo(chatWidthBefore, 0);
  });
});

test.describe('filling the space on the mocked desktop', () => {
  async function expectBottomTerminalBesideChat(page: Page): Promise<void> {
    await expectFillsRow(page, [BOTTOM_TERMINAL_CARD, CHAT_PANE_CARD]);
    await expect
      .poll(
        async () =>
          (await boxOf(page, PANELS)).height - (await boxOf(page, BOTTOM_TERMINAL_CARD)).height,
      )
      .toBeLessThanOrEqual(2);
    await expect(headerPaneButton(page, 'terminal')).toHaveAttribute('aria-pressed', 'true');
    await expect(headerPaneButton(page, 'agents')).toHaveAttribute('aria-pressed', 'true');
  }

  test('a bottom terminal takes the full height alone, then keeps its column beside chat', async ({
    page,
    api,
    workerServer,
  }) => {
    await openDesktop(page, api, workerServer, 'bottom', 'bottom');
    await setHeaderPane(page, 'terminal', true);
    const heightBefore = (await boxOf(page, BOTTOM_TERMINAL_CARD)).height;

    await setHeaderPane(page, 'editor', false);
    await expectEditorHidden(page);
    await expect
      .poll(async () => {
        const panels = await boxOf(page, PANELS);
        const terminal = await boxOf(page, BOTTOM_TERMINAL_CARD);
        return Math.round(Math.abs(panels.height - terminal.height));
      })
      .toBeLessThanOrEqual(2);
    await expectFillsRow(page, [BOTTOM_TERMINAL_CARD]);

    await setHeaderPane(page, 'agents', true);
    await expectBottomTerminalBesideChat(page);

    await setHeaderPane(page, 'editor', true);
    await expect
      .poll(async () => (await boxOf(page, BOTTOM_TERMINAL_CARD)).height)
      .toBeCloseTo(heightBefore, 0);
  });

  test('hiding the editor beside chat, or opening a bottom terminal beside chat alone, keeps the terminal on screen', async ({
    page,
    api,
    workerServer,
  }) => {
    await openDesktop(page, api, workerServer, 'bottom-chat-first', 'bottom');
    await setHeaderPane(page, 'terminal', true);
    await setHeaderPane(page, 'agents', true);
    await setHeaderPane(page, 'editor', false);
    await expectEditorHidden(page);
    await expectBottomTerminalBesideChat(page);

    await setHeaderPane(page, 'terminal', false);
    await expectFillsRow(page, [CHAT_PANE_CARD]);
    await setHeaderPane(page, 'terminal', true);
    await expectBottomTerminalBesideChat(page);
  });

  test('a right terminal alone fills the row', async ({ page, api, workerServer }) => {
    await openDesktop(page, api, workerServer, 'right-alone', 'right');
    await setHeaderPane(page, 'terminal', true);

    await setHeaderPane(page, 'editor', false);
    await expectEditorHidden(page);
    await expectEditorColumnEmpty(page);
    await expectFillsRow(page, [RIGHT_TERMINAL_PANE_CARD]);
  });

  test('a right terminal and chat share the row in proportion, and widths dragged while hidden are put back on show', async ({
    page,
    api,
    workerServer,
  }) => {
    await openDesktop(page, api, workerServer, 'right-and-chat', 'right');
    await setHeaderPane(page, 'terminal', true);
    await setHeaderPane(page, 'agents', true);
    const terminalBefore = await widthOf(page, RIGHT_TERMINAL_PANE_CARD);
    const chatBefore = await widthOf(page, CHAT_PANE_CARD);
    const sidePanelBefore = await widthOf(page, '#doc-panel');

    await setHeaderPane(page, 'editor', false);
    await expectEditorHidden(page);
    await expectEditorColumnEmpty(page);
    await expectFillsRow(page, [RIGHT_TERMINAL_PANE_CARD, CHAT_PANE_CARD]);
    await expect
      .poll(
        async () =>
          (await widthOf(page, RIGHT_TERMINAL_PANE_CARD)) / (await widthOf(page, CHAT_PANE_CARD)),
      )
      .toBeCloseTo(terminalBefore / chatBefore, 1);

    const divider = page.locator('[data-agents-panel-resize-handle]');
    const bounds = await divider.boundingBox();
    if (bounds === null) throw new Error('no divider between terminal and chat');
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x - 150, bounds.y + bounds.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => widthOf(page, CHAT_PANE_CARD)).toBeGreaterThan(chatBefore + 100);
    await expectFillsRow(page, [RIGHT_TERMINAL_PANE_CARD, CHAT_PANE_CARD]);

    await setHeaderPane(page, 'editor', true);
    await expect.poll(() => widthOf(page, CHAT_PANE_CARD)).toBeCloseTo(chatBefore, 0);
    await expect.poll(() => widthOf(page, RIGHT_TERMINAL_PANE_CARD)).toBeCloseTo(terminalBefore, 0);
    await expect.poll(() => widthOf(page, '#doc-panel')).toBeCloseTo(sidePanelBefore, 0);
  });
});

async function openThread(page: Page, title: string): Promise<string> {
  await page.waitForFunction(() => Boolean(window.__acpThreadHarness), null, {
    timeout: BOOT_TIMEOUT_MS,
  });
  const threadId = await page.evaluate((threadTitle) => {
    const harness = window.__acpThreadHarness;
    if (harness === undefined) throw new Error('ACP thread harness is not installed');
    return harness.openThread({
      agent: { id: 'editor-pane-agent', name: 'Editor Pane Agent', source: 'registry' },
      title: threadTitle,
    });
  }, title);
  await expect(page.locator(threadRootSelector(threadId))).toBeVisible({
    timeout: THREAD_FIRST_RENDER_TIMEOUT_MS,
  });
  return threadId;
}

async function pushAgentMessage(page: Page, threadId: string, text: string): Promise<void> {
  await page.evaluate(
    ({ id, message }) => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      harness.pushUpdates(id, [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: message } },
      ] as Parameters<typeof harness.pushUpdates>[1]);
    },
    { id: threadId, message: text },
  );
}

type ThreadColumnPart = 'header' | 'transcript' | 'composer';

async function threadColumn(
  page: Page,
  threadId: string,
  part: ThreadColumnPart = 'header',
): Promise<{ width: number; centerOffset: number }> {
  return await page.locator(threadRootSelector(threadId)).evaluate((root, which) => {
    if (!(root instanceof HTMLElement)) throw new Error('no thread root');
    const rootBox = root.getBoundingClientRect();
    const contentBox = (element: Element | null | undefined) => {
      if (!(element instanceof HTMLElement)) throw new Error(`no thread ${which}`);
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const left = box.left + Number.parseFloat(style.paddingLeft);
      const right = box.right - Number.parseFloat(style.paddingRight);
      return { left, width: right - left };
    };
    const composer = root.querySelector('[data-testid="agent-thread-composer"]');
    const box =
      which === 'header'
        ? contentBox(root.firstElementChild)
        : which === 'transcript'
          ? contentBox(root.querySelector('[data-testid="agent-thread-transcript"]'))
          : contentBox(
              [...root.children].find((child) => composer !== null && child.contains(composer)),
            );
    return {
      width: box.width,
      centerOffset: Math.abs(box.left + box.width / 2 - (rootBox.left + rootBox.width / 2)),
    };
  }, part);
}

test.describe('chat on its own', () => {
  test('opens the requested thread when another thread stays mounted', async ({ page, api }) => {
    await openWeb(page, api, 'thread-root-scope');
    await setHeaderPane(page, 'agents', true);
    const backgroundThreadId = await openThread(page, 'Background');
    await openThread(page, 'Requested');
    await expect(page.locator(threadRootSelector(backgroundThreadId))).toHaveCount(1);
  });

  test('keeps its conversation at a reading width, centered, and goes back to full width beside another pane', async ({
    page,
    api,
  }) => {
    await openWeb(page, api, 'reading-width');
    const threadId = await openThread(page, 'Reading width');
    await expect(headerPaneButton(page, 'agents')).toHaveAttribute('aria-pressed', 'true');
    const besideEditor = await threadColumn(page, threadId);

    await setHeaderPane(page, 'editor', false);
    await expectFillsRow(page, [CHAT_PANE_CARD]);
    for (const part of ['header', 'transcript', 'composer'] as const) {
      await expect
        .poll(async () => (await threadColumn(page, threadId, part)).width)
        .toBeLessThanOrEqual(768);
      expect((await threadColumn(page, threadId, part)).centerOffset).toBeLessThanOrEqual(1);
    }
    expect(await widthOf(page, CHAT_PANE_CARD)).toBeGreaterThan(1200);

    const dataTransfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['hello'], 'hello.txt', { type: 'text/plain' }));
      return transfer;
    });
    const rootSelector = threadRootSelector(threadId);
    await page.locator(rootSelector).dispatchEvent('dragenter', { dataTransfer });
    const overlay = page.getByTestId('agent-thread-drop-overlay');
    await expect(overlay).toBeVisible();
    const rootBox = await boxOf(page, rootSelector);
    const overlayBox = await boxOf(page, '[data-testid="agent-thread-drop-overlay"]');
    expect(Math.abs(overlayBox.x - rootBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(overlayBox.width - rootBox.width)).toBeLessThanOrEqual(1);
    await overlay.click();

    await setHeaderPane(page, 'editor', true);
    await expect
      .poll(async () => (await threadColumn(page, threadId)).width)
      .toBeCloseTo(besideEditor.width, 0);
  });
});

test.describe('Nothing open', () => {
  test('appears when every pane is hidden, with no Ask AI box, and each button opens its pane', async ({
    page,
    api,
  }) => {
    await openWeb(page, api, 'nothing-open');
    await setHeaderPane(page, 'editor', false);
    const screenRegion = page.getByRole('region', { name: 'Nothing open' });
    await expect(screenRegion).toBeVisible();
    await expect(screenRegion).toContainText('Nothing open');
    await expect(screenRegion.getByRole('button')).toHaveText(['Open editor', 'Open agents']);
    await expect(page.getByRole('textbox', { name: /Ask AI/i })).toHaveCount(0);

    await screenRegion.getByRole('button', { name: 'Open agents' }).click();
    await expect(headerPaneButton(page, 'agents')).toHaveAttribute('aria-pressed', 'true');
    await expect(screenRegion).toHaveCount(0);
    await expectFillsRow(page, [CHAT_PANE_CARD]);

    await setHeaderPane(page, 'agents', false);
    await expect(screenRegion).toBeVisible();
    await screenRegion.getByRole('button', { name: 'Open editor' }).focus();
    await page.keyboard.press('Enter');
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');
    await expect(screenRegion).toHaveCount(0);
    await expect(page.locator(EDITOR_REGION)).toBeFocused();
    await waitForDocument(page);
  });

  test('offers Open terminal on the desktop, and it opens the terminal', async ({
    page,
    api,
    workerServer,
  }) => {
    await openDesktop(page, api, workerServer, 'nothing-open-desktop', 'bottom');
    await setHeaderPane(page, 'editor', false);
    const screenRegion = page.getByRole('region', { name: 'Nothing open' });
    await expect(screenRegion.getByRole('button')).toHaveText([
      'Open editor',
      'Open agents',
      'Open terminal',
    ]);

    await screenRegion.getByRole('button', { name: 'Open terminal' }).click();
    await expect(headerPaneButton(page, 'terminal')).toHaveAttribute('aria-pressed', 'true');
    await expect(screenRegion).toHaveCount(0);
    await expectFillsRow(page, [BOTTOM_TERMINAL_CARD]);
  });
});

async function expectEditorShownOn(page: Page, docName: string): Promise<void> {
  await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(EDITOR_PANE_CARD)).not.toHaveAttribute('inert', '');
  await expect
    .poll(() => page.evaluate(() => decodeURIComponent(window.location.hash)))
    .toContain(docName);
}

async function quickOpen(page: Page, docName: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.locator('[data-slot="command-input"]');
  await expect(input).toBeFocused();
  await input.fill(docName);
  const row = page.locator(`[data-slot="command-list"] [data-testid^="command-palette-nav-"]`, {
    hasText: docName,
  });
  await expect(row.first()).toBeVisible();
  await row.first().click();
  await expect(page.locator('[data-slot="command-list"]')).toBeHidden();
}

async function hideEditor(page: Page): Promise<void> {
  await setHeaderPane(page, 'editor', false);
  await expectEditorHidden(page);
}

test.describe('deliberate opens show a hidden editor', () => {
  test('quick open of another document and of the active one both show the editor on it', async ({
    page,
    api,
  }) => {
    const active = await openWeb(page, api, 'quick-open');
    const other = otherDocName('quick-open');

    await hideEditor(page);
    await quickOpen(page, other);
    await expectEditorShownOn(page, other);

    await hideEditor(page);
    await quickOpen(page, other);
    await expectEditorShownOn(page, other);
    expect(active).not.toBe(other);
  });

  test('going back shows the editor on the earlier document', async ({ page, api }) => {
    const first = await openWeb(page, api, 'back');
    const second = otherDocName('back');
    for (const docName of [second, first]) {
      await page.evaluate((hash) => {
        window.location.hash = hash;
      }, `#/${docName}`);
      await expectEditorShownOn(page, docName);
    }

    await hideEditor(page);
    await page.goBack();
    await expectEditorShownOn(page, second);
  });

  test('a link in an agent message to the document already open shows the editor', async ({
    page,
    api,
  }) => {
    const name = await openWeb(page, api, 'agent-link');
    await setHeaderPane(page, 'agents', true);
    const threadId = await openThread(page, 'Agent link');
    await pushAgentMessage(page, threadId, `See [the notes](#/${name}).`);
    const link = page.getByTestId('agent-thread-doc-link');
    await expect(link).toBeVisible();

    await hideEditor(page);
    await link.click();
    await expectEditorShownOn(page, name);
  });

  test('follow-the-agent navigation to another document shows the editor', async ({
    page,
    api,
  }) => {
    await openWeb(page, api, 'follow');
    const second = otherDocName('follow');
    await setHeaderPane(page, 'agents', true);
    const threadId = await openThread(page, 'Follow');
    await page.evaluate((id) => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      harness.frame({
        op: 'event',
        threadId: id,
        seq: 0,
        event: { kind: 'turn_started', ts: Date.now() },
      });
    }, threadId);

    await hideEditor(page);
    await page.evaluate(
      ({ id, docName }) => {
        const harness = window.__acpThreadHarness;
        if (harness === undefined) throw new Error('ACP thread harness is not installed');
        harness.pushUpdates(id, [
          {
            sessionUpdate: 'tool_call',
            toolCallId: 'follow-edit',
            title: 'Edit the other document',
            kind: 'edit',
            status: 'completed',
            rawInput: { tool: 'edit', arguments: { docName } },
          },
        ] as Parameters<typeof harness.pushUpdates>[1]);
      },
      { id: threadId, docName: second },
    );
    await expectEditorShownOn(page, second);
  });

  test('a comment marker on the document leaves with the editor and returns with it', async ({
    page,
    api,
  }) => {
    const name = await openWeb(page, api, 'comment-marker');
    const created = await page.request.post('/api/comments', {
      data: { docName: name, quote: 'brown fox', body: 'Is the fox brown?' },
    });
    expect(created.ok()).toBe(true);
    const marker = page.getByRole('button', { name: 'Open comment', exact: true });
    await expect(marker).toBeVisible();

    await hideEditor(page);
    await expect(marker).toHaveCount(0);

    await setHeaderPane(page, 'editor', true);
    await expect(marker).toBeVisible();
  });

  test('the bubble menu over a selection leaves with the editor', async ({ page, api }) => {
    await openWeb(page, api, 'bubble-menu');
    await page.locator('.tiptap-editor .ProseMirror p').first().selectText();
    const bubbleMenu = page.getByTestId('bubble-menu-bar');
    await expect(bubbleMenu).toBeVisible();

    await hideEditor(page);
    await expect(bubbleMenu).toHaveCount(0);
  });

  test('renaming the open document keeps a hidden editor hidden, while an address change from outside shows it', async ({
    page,
    api,
  }) => {
    const first = await openWeb(page, api, 'rename');
    const second = otherDocName('rename');
    await quickOpen(page, second);
    await expectEditorShownOn(page, second);
    await expect(page.locator('[data-editor-tab-id]')).toHaveCount(2);
    await hideEditor(page);
    await page.evaluate(() => {
      const counted = window as unknown as { __hashChanges: number };
      counted.__hashChanges = 0;
      window.addEventListener('hashchange', () => {
        counted.__hashChanges += 1;
      });
    });

    const renamed = `${second}-renamed`;
    const response = await page.request.post('/api/rename-path', {
      data: { kind: 'file', fromPath: second, toPath: renamed },
    });
    expect(response.ok()).toBe(true);
    await expect
      .poll(() => page.evaluate(() => decodeURIComponent(window.location.hash)))
      .toContain(renamed);
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __hashChanges: number }).__hashChanges),
      )
      .toBeGreaterThan(0);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expectEditorHidden(page);

    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, `#/${first}`);
    await expectEditorShownOn(page, first);
  });

  async function runPaletteCommand(page: Page, query: string, commandId: string): Promise<void> {
    await page.keyboard.press('ControlOrMeta+k');
    const input = page.locator('[data-slot="command-input"]');
    await expect(input).toBeFocused();
    await input.fill(query);
    const row = page.getByTestId(`command-palette-${commandId}`);
    await expect(row).toBeVisible();
    await row.click();
  }

  test('Blob Run from the palette shows the editor with the game open', async ({ page, api }) => {
    await openWeb(page, api, 'blob-run');
    await hideEditor(page);
    await runPaletteCommand(page, 'blob', 'open-blob-run');
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-slot="ok-blob-runner"]')).toBeVisible();
  });

  test('Skills from the palette shows the editor with the skills dock open', async ({
    page,
    api,
  }) => {
    await openWeb(page, api, 'skills-dock');
    await hideEditor(page);
    await runPaletteCommand(page, 'skills', 'open-skills');
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('skills-dock')).toBeVisible();
  });

  test('the sidebar view and tree commands from the palette show the editor', async ({
    page,
    api,
  }) => {
    await openWeb(page, api, 'tree-commands');
    await hideEditor(page);
    await runPaletteCommand(page, 'expand', 'expand-all-tree');
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');

    await hideEditor(page);
    await runPaletteCommand(page, 'hidden', 'toggle-show-hidden-files');
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a file created from the palette opens with the editor shown', async ({ page, api }) => {
    await openWeb(page, api, 'palette-new-file');
    await hideEditor(page);
    await runPaletteCommand(page, 'new file', 'new-file');
    const name = `palette-made-${test.info().workerIndex}`;
    const nameInput = page.getByPlaceholder('my-note');
    await expect(nameInput).toBeVisible();
    await nameInput.fill(name);
    await nameInput.press('Enter');
    await expectEditorShownOn(page, name);
  });

  test('asking for a side panel tab from the palette shows the editor', async ({ page, api }) => {
    await openWeb(page, api, 'graph');
    await hideEditor(page);
    await page.keyboard.press('ControlOrMeta+k');
    const input = page.locator('[data-slot="command-input"]');
    await input.fill('graph');
    await page.getByTestId('command-palette-open-graph').click();
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('editor shortcuts show a hidden editor before acting', () => {
  test('the next-tab shortcut shows the editor and switches tabs', async ({ page, api }) => {
    const first = await openWeb(page, api, 'next-tab');
    const second = otherDocName('next-tab');
    const editor = page.locator('.tiptap-editor .ProseMirror').first();
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' kept');
    await expect(editor).toContainText('kept');
    await quickOpen(page, second);
    await expectEditorShownOn(page, second);
    await expect(page.locator('[data-editor-tab-id]')).toHaveCount(2);

    await hideEditor(page);
    await page.keyboard.press('Control+Tab');
    await expectEditorShownOn(page, first);
  });

  test('Rename from the palette shows the editor first, so the inline name field is visible and focused', async ({
    page,
    api,
    workerServer,
  }) => {
    const name = await openDesktop(page, api, workerServer, 'rename-inline', 'bottom');
    await hideEditor(page);
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('[data-slot="command-input"]').fill('Rename');
    await page.getByTestId('command-palette-rename').click();

    const nameField = page.getByRole('textbox', { name: new RegExp(`rename ${name}\\.md`, 'i') });
    await expect(nameField).toBeVisible();
    await expect(nameField).toBeFocused();
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the side panel and file list shortcuts show the editor', async ({ page, api }) => {
    await openWeb(page, api, 'panel-shortcuts');
    await hideEditor(page);
    await page.keyboard.press('ControlOrMeta+Alt+KeyB');
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');

    await hideEditor(page);
    await page.keyboard.press('ControlOrMeta+Alt+KeyS');
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('the editor level is remembered', () => {
  test('a reload keeps a hidden editor hidden, with the document in the address, and reopens to Nothing open', async ({
    page,
    api,
  }) => {
    const name = await openWeb(page, api, 'reload');
    await hideEditor(page);
    await expect(page.getByRole('region', { name: 'Nothing open' })).toBeVisible();

    await page.reload();
    await waitForActiveProviderSynced(page);
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('region', { name: 'Nothing open' })).toBeVisible();
    expect(await page.evaluate(() => decodeURIComponent(window.location.hash))).toContain(name);

    await page
      .getByRole('region', { name: 'Nothing open' })
      .getByRole('button', {
        name: 'Open editor',
      })
      .click();
    await page.reload();
    await waitForActiveProviderSynced(page);
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');
    await waitForDocument(page);
  });

  test('the palette offers Hide Editor, then Show Editor once hidden', async ({ page, api }) => {
    await openWeb(page, api, 'palette-label');
    await page.keyboard.press('ControlOrMeta+k');
    const input = page.locator('[data-slot="command-input"]');
    await input.fill('editor');
    await expect(page.getByTestId('command-palette-toggle-editor')).toContainText('Hide Editor');
    await page.getByTestId('command-palette-toggle-editor').click();
    await expectEditorHidden(page);

    await page.keyboard.press('ControlOrMeta+k');
    await input.fill('editor');
    await expect(page.getByTestId('command-palette-toggle-editor')).toContainText('Show Editor');
    await page.getByTestId('command-palette-toggle-editor').click();
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('dialogs that ride the address bar', () => {
  test('opening and closing Settings leaves a hidden editor hidden', async ({ page, api }) => {
    const name = await openWeb(page, api, 'settings-dialog');
    await hideEditor(page);

    await page.evaluate(() => {
      window.location.hash = '#settings';
    });
    await expect(page.getByTestId('settings-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => decodeURIComponent(window.location.hash)))
      .toContain(name);

    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('region', { name: 'Nothing open' })).toBeVisible();
  });

  test('a template created from Settings opens with the editor shown', async ({ page, api }) => {
    await openWeb(page, api, 'settings-open');
    await hideEditor(page);

    await page.evaluate(() => {
      window.location.hash = '#settings/project-templates';
    });
    await expect(page.getByTestId('settings-dialog')).toBeVisible();
    await page.getByTestId('settings-project-templates-new-button').click();
    const templateName = `pane-template-${test.info().workerIndex}`;
    await page.getByTestId('template-name-input').fill(templateName);
    await page.getByRole('button', { name: 'Create template' }).click();

    await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
    await expectEditorShownOn(page, `.ok/templates/${templateName}`);
  });
});
