import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type {
  ThreadClientFrame,
  ThreadServerFrame,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import type { Locator, Page, WebSocketRoute } from '@playwright/test';
import { PANE_CARD_GAP_PX } from '../../src/components/ui/pane-card';
import { SCROLL_PIN_SLACK_PX } from '../../src/editor/document-scrollports';
import {
  acpCatalogBody,
  dockUnit,
  expect,
  placeCaretAtEndOfText,
  readEditorCaretLine,
  switchColorThemeAndSettleFade,
  test,
  waitForActiveProviderSynced,
} from './_helpers';
import { startHiddenChatAgent } from './hidden-chat-transport.test-helper';

const EDITOR_CARD = '[data-slot="pane-card"][data-pane="editor"]';
const CHAT_CARD = '[data-slot="pane-card"][data-pane="agents"]';
const TERMINAL_CARD = '[data-slot="pane-card"][data-pane="terminal"]';
const AGENTS_PANEL_MOUNT = '[data-agents-panel-mount]';
const AGENTS_HEADER_BUTTON = 'header-pane-button-agents';
const TOP_BAR_PX = 44;
const BOOT_TIMEOUT_MS = 30_000;
const PX_TOLERANCE = 1;

const DOC_MARKDOWN = `---
title: "Pane cards"
description: "Fixture doc for the editor, chat and terminal card geometry"
---

# Pane cards

Body text so the document column renders real content while the cards are measured.`;

interface Rect {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly height: number;
  readonly width: number;
}

async function rectOf(locator: Locator): Promise<Rect> {
  return locator.evaluate((element) => {
    const r = element.getBoundingClientRect();
    return {
      top: r.top,
      left: r.left,
      right: r.right,
      bottom: r.bottom,
      height: r.height,
      width: r.width,
    };
  });
}

async function openDoc(
  page: Page,
  api: { seedDocs: (docs: Array<{ name: string; markdown: string }>) => Promise<void> },
  width: number,
) {
  const docName = `editor-pane-cards-${width}-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible({
    timeout: BOOT_TIMEOUT_MS,
  });
  return docName;
}

async function openChat(page: Page): Promise<void> {
  const agentsButton = page.getByTestId(AGENTS_HEADER_BUTTON);
  await expect(agentsButton).toHaveAttribute('aria-pressed', 'false', { timeout: BOOT_TIMEOUT_MS });
  await agentsButton.click();
  await expect(agentsButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(AGENTS_PANEL_MOUNT)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await expect(page.locator('[data-dragging="true"]')).toHaveCount(0);
}

async function dispatchAskAiShortcut(locator: Locator): Promise<boolean> {
  return locator.evaluate((element, isMac) => {
    const event = new KeyboardEvent('keydown', {
      key: 'l',
      code: 'KeyL',
      metaKey: isMac,
      ctrlKey: !isMac,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, process.platform === 'darwin');
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + PX_TOLERANCE);
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/acp/catalog', (route) => route.fulfill({ json: acpCatalogBody([]) }));
});

test('the editor and chat cards stand side by side, full height, one gap apart, under matching 44px top bars', async ({
  page,
  api,
}) => {
  await openDoc(page, api, 1400);
  await expect
    .poll(() => page.locator('[data-doc-panel-toggle]').getAttribute('aria-expanded'), {
      timeout: 10_000,
    })
    .toBe('true');
  await openChat(page);

  const editorCard = page.locator(EDITOR_CARD);
  const chatCard = page.locator(CHAT_CARD);
  await expect(editorCard).toBeVisible();
  await expect(chatCard).toBeVisible();
  const [editor, chat] = await Promise.all([rectOf(editorCard), rectOf(chatCard)]);

  expect(
    Math.abs(chat.top - editor.top),
    'the chat card top lines up with the editor card',
  ).toBeLessThanOrEqual(PX_TOLERANCE);
  expect(
    Math.abs(chat.bottom - editor.bottom),
    'the chat card runs the full height of the editor card',
  ).toBeLessThanOrEqual(PX_TOLERANCE);
  expect(
    Math.abs(chat.left - editor.right - PANE_CARD_GAP_PX),
    'one gap separates the two cards',
  ).toBeLessThanOrEqual(PX_TOLERANCE);

  const tabRow = editorCard.locator('header[data-editor-header]');
  const sidePanelHeader = editorCard.locator('[data-doc-panel-header]');
  const chatBar = chatCard.locator('[data-terminal-tab-row]');
  const [tabRowRect, sidePanelHeaderRect, chatBarRect] = await Promise.all([
    rectOf(tabRow),
    rectOf(sidePanelHeader),
    rectOf(chatBar),
  ]);
  for (const [label, bar, cardTop] of [
    ['tab row', tabRowRect, editor.top],
    ['side panel header', sidePanelHeaderRect, editor.top],
    ['chat top bar', chatBarRect, chat.top],
  ] as const) {
    expect(
      Math.abs(bar.height - TOP_BAR_PX),
      `${label} is ${TOP_BAR_PX}px tall`,
    ).toBeLessThanOrEqual(PX_TOLERANCE);
    expect(Math.abs(bar.top - cardTop), `${label} sits at the top of its card`).toBeLessThanOrEqual(
      PX_TOLERANCE,
    );
  }
  await expect(tabRow.locator('[data-doc-panel-toggle]')).toHaveCount(1);
  await expect(page.locator('[data-doc-panel-toggle]')).toHaveCount(1);
  const [tabCanvasRect, tabGroupRect, newTabRect, toggleRect] = await Promise.all([
    rectOf(tabRow.locator('[data-editor-header-tab-canvas]')),
    rectOf(tabRow.locator('[data-editor-pane-tab-group]').last()),
    rectOf(tabRow.getByTestId('editor-new-tab-button')),
    rectOf(tabRow.locator('[data-doc-panel-toggle]')),
  ]);
  expect(
    Math.abs(tabGroupRect.right - tabCanvasRect.right),
    'the tab group still spans to the end of the tab canvas under the toggle',
  ).toBeLessThanOrEqual(PX_TOLERANCE);
  expect(newTabRect.right, 'the new tab button ends before the toggle').toBeLessThanOrEqual(
    toggleRect.left + PX_TOLERANCE,
  );

  for (const card of [editorCard, chatCard]) {
    const clipping = await card.evaluate((element) => {
      const clippers: string[] = [];
      let cur: Element | null = element.parentElement;
      while (cur != null && cur !== document.body) {
        if (getComputedStyle(cur).overflow !== 'visible') clippers.push(cur.className.toString());
        cur = cur.parentElement;
      }
      return clippers;
    });
    expect(clipping, 'nothing between the cards and the window clips their shadows').toEqual([]);
  }

  await expect(page.locator(TERMINAL_CARD), 'the web draws no terminal card').toHaveCount(0);
  await expect(
    dockUnit(page, 'terminal'),
    'the web never turns the terminal unit on',
  ).toHaveAttribute('hidden', '');
  await noSidewaysScroll(page);
});

test('at 320px nothing scrolls sideways and the web still draws no terminal card', async ({
  page,
  api,
}) => {
  await openDoc(page, api, 320);
  await expect(page.locator(EDITOR_CARD)).toBeVisible();
  await expect(page.locator(TERMINAL_CARD)).toHaveCount(0);
  await noSidewaysScroll(page);
});

test('the last selected component stands alone below 48rem and widening restores both cards', async ({
  page,
  api,
}) => {
  await openDoc(page, api, 769);
  await openChat(page);
  const editorHandle = await page.locator(EDITOR_CARD).elementHandle();
  const chatHandle = await page.locator(CHAT_CARD).elementHandle();
  if (editorHandle == null || chatHandle == null) throw new Error('component cards did not mount');
  const savedWideVisibility = await page.evaluate(() => ({
    editor: localStorage.getItem('ok-editor-visible-v1'),
    chat: JSON.parse(localStorage.getItem('ok-agent-session-order-v1') ?? '{}').agentPanelVisible as
      | boolean
      | undefined,
  }));
  const measurements: Array<{ width: number; editor: Rect; chat: Rect }> = [];

  for (const width of [768, 767, 320, 768, 769, 768, 767, 768, 769]) {
    await page.setViewportSize({ width, height: 800 });
    const editor = page.locator(EDITOR_CARD);
    const chat = page.locator(CHAT_CARD);
    if (width < 768) {
      await expect(editor).toBeHidden();
      await expect(chat).toBeVisible();
      await expect(editor).toHaveAttribute('inert', '');
      await expect(page.getByTestId('header-pane-button-agents')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(page.getByTestId('header-pane-button-editor')).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      expect((await rectOf(chat)).width).toBeGreaterThan(width - 32);
      if (width === 767) {
        await test.info().attach('selected-chat-767', {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
        await page.getByTestId('header-pane-button-agents').click();
        await expect(chat).toBeVisible();
        expect(await chat.evaluate((element, original) => element === original, chatHandle)).toBe(
          true,
        );
        await page.getByTestId('header-pane-button-editor').click();
        await expect(editor).toBeVisible();
        await expect(chat).toBeHidden();
        expect(
          await editor.evaluate((element, original) => element === original, editorHandle),
        ).toBe(true);
        await page.getByTestId('header-pane-button-agents').click();
        await expect(chat).toBeVisible();
      }
    } else {
      await expect(editor).toBeVisible();
      await expect(chat).toBeVisible();
    }
    measurements.push({ width, editor: await rectOf(editor), chat: await rectOf(chat) });
    await noSidewaysScroll(page);
  }
  expect(
    await page.evaluate(() => ({
      editor: localStorage.getItem('ok-editor-visible-v1'),
      chat: JSON.parse(localStorage.getItem('ok-agent-session-order-v1') ?? '{}')
        .agentPanelVisible as boolean | undefined,
    })),
  ).toEqual(savedWideVisibility);
  await test.info().attach('component-bounds', {
    body: JSON.stringify({ measurements, savedWideVisibility }, null, 2),
    contentType: 'application/json',
  });
});

test('working in an already visible Editor wins the next narrow selection', async ({
  page,
  api,
}) => {
  await openDoc(page, api, 1400);
  await openChat(page);
  const editor = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
  await editor.click();
  await page.keyboard.type(' working in Editor');
  await expect(editor).toContainText('working in Editor');

  await page.setViewportSize({ width: 767, height: 800 });

  await expect(page.locator(EDITOR_CARD)).toBeVisible();
  await expect(page.locator(CHAT_CARD)).toBeHidden();
});

test('hiding and showing chat never remounts the open editor', async ({ page, api }) => {
  await openDoc(page, api, 1400);
  const editor = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
  const editorHandle = await editor.elementHandle();
  if (editorHandle == null) throw new Error('no editor to follow across the chat toggles');

  await openChat(page);
  await page.getByTestId(AGENTS_HEADER_BUTTON).click();
  await expect(page.getByTestId(AGENTS_HEADER_BUTTON)).toHaveAttribute('aria-pressed', 'false');
  await openChat(page);

  expect(await editorHandle.evaluate((element) => element.isConnected)).toBe(true);
  expect(
    await editor.evaluate((current, followed) => current === followed, editorHandle),
    'the same editor element is still the open editor',
  ).toBe(true);
});

test('hiding selected chat in a narrow workspace returns to Editor and keeps the wide layout', async ({
  page,
  api,
}) => {
  await openDoc(page, api, 1400);
  await openChat(page);
  const editor = page.locator(EDITOR_CARD);
  const chat = page.locator(CHAT_CARD);
  const chatHandle = await chat.elementHandle();
  if (chatHandle === null) throw new Error('Chat card is missing');

  await page.setViewportSize({ width: 767, height: 800 });
  await page.getByTestId(AGENTS_HEADER_BUTTON).click();
  await expect(chat).toBeVisible();
  await page.keyboard.press('ControlOrMeta+l');

  await expect(editor).toBeVisible();
  await expect(chat).toBeHidden();
  await expect(page.getByTestId(AGENTS_HEADER_BUTTON)).toHaveAttribute('aria-pressed', 'false');
  await page.setViewportSize({ width: 1400, height: 800 });
  await expect(chat).toBeVisible();
  expect(await chat.evaluate((element, original) => element === original, chatHandle)).toBe(true);
});

test('Hide Editor leaves a narrow project intentionally empty until Editor is reopened', async ({
  page,
  api,
}) => {
  await openDoc(page, api, 767);
  const editor = page.locator(EDITOR_CARD);
  const chat = page.locator(CHAT_CARD);
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.locator('[data-slot="command-input"]');
  await input.fill('hide editor');
  const hideEditor = page.getByTestId('command-palette-toggle-editor');
  await expect(hideEditor).toContainText('Hide Editor');
  await hideEditor.click();

  await expect(page.locator('[data-nothing-open]')).toBeVisible();
  await expect(editor).toBeHidden();
  await expect(chat).toBeHidden();
  await expect(page.getByTestId('header-pane-button-editor')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.reload();
  await expect(page.locator('[data-nothing-open]')).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await page.getByTestId('nothing-open-editor').click();
  await expect(editor).toBeVisible();
});

test('the narrow palette labels and hides the visible Chat without changing wide intent', async ({
  page,
  api,
}) => {
  await openDoc(page, api, 767);
  await page.getByTestId(AGENTS_HEADER_BUTTON).click();
  await expect(page.locator(CHAT_CARD)).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.locator('[data-slot="command-input"]');
  await input.fill('agents');
  const toggle = page.getByTestId('command-palette-toggle-agent-panel');
  await expect(toggle).toContainText('Hide Agents');
  await toggle.click();

  await expect(page.locator(EDITOR_CARD)).toBeVisible();
  await expect(page.locator(CHAT_CARD)).toBeHidden();
  await page.setViewportSize({ width: 1400, height: 800 });
  await expect(page.locator(CHAT_CARD)).toBeHidden();
});

test('Hide Editor chooses an already open Chat and respects a later explicit Chat Hide', async ({
  page,
  api,
}) => {
  await openDoc(page, api, 1400);
  await openChat(page);
  await page.setViewportSize({ width: 767, height: 800 });
  await page.getByTestId('header-pane-button-editor').click();
  await expect(page.locator(EDITOR_CARD)).toBeVisible();

  const hideEditor = async () => {
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('[data-slot="command-input"]').fill('hide editor');
    const command = page.getByTestId('command-palette-toggle-editor');
    await expect(command).toContainText('Hide Editor');
    await command.click();
  };

  await hideEditor();
  await expect(page.locator(CHAT_CARD)).toBeVisible();
  await expect(page.locator(EDITOR_CARD)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+l');
  await expect(page.locator(EDITOR_CARD)).toBeVisible();
  await hideEditor();
  await expect(page.locator('[data-nothing-open]')).toBeVisible();
  await page.setViewportSize({ width: 1400, height: 800 });
  await expect(page.locator(EDITOR_CARD)).toBeVisible();
  await expect(page.locator(CHAT_CARD)).toBeVisible();
});

test('a narrow Chat visit remains eligible after reload when Editor is hidden', async ({
  page,
  api,
}) => {
  await openDoc(page, api, 767);
  await page.getByTestId(AGENTS_HEADER_BUTTON).click();
  await expect(page.locator(CHAT_CARD)).toBeVisible();
  await page.getByTestId('header-pane-button-editor').click();
  await page.reload();
  await expect(page.locator(EDITOR_CARD)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await expect(page.getByTestId('web-project-name')).toBeVisible({ timeout: BOOT_TIMEOUT_MS });

  await page.keyboard.press('ControlOrMeta+k');
  await page.locator('[data-slot="command-input"]').fill('hide editor');
  await page.getByTestId('command-palette-toggle-editor').click();

  await expect(page.locator(CHAT_CARD)).toBeVisible();
  await expect(page.locator('[data-nothing-open]')).toHaveCount(0);
});

test('a narrow Chat Hide remains excluded from Editor fallback after reload', async ({
  page,
  api,
}) => {
  await openDoc(page, api, 1400);
  await openChat(page);
  await page.setViewportSize({ width: 767, height: 800 });
  await page.getByTestId(AGENTS_HEADER_BUTTON).click();
  await page.keyboard.press('ControlOrMeta+l');
  await expect(page.locator(EDITOR_CARD)).toBeVisible();
  await page.reload();
  await expect(page.locator(EDITOR_CARD)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await expect(page.getByTestId('web-project-name')).toBeVisible({ timeout: BOOT_TIMEOUT_MS });

  await page.keyboard.press('ControlOrMeta+k');
  await page.locator('[data-slot="command-input"]').fill('hide editor');
  await page.getByTestId('command-palette-toggle-editor').click();

  await expect(page.locator('[data-nothing-open]')).toBeVisible();
  await expect(page.locator(CHAT_CARD)).toBeHidden();
});

test('refresh restores the selected narrow component without changing wide visibility', async ({
  page,
  api,
}) => {
  await openDoc(page, api, 767);
  const editor = page.locator(EDITOR_CARD);
  const chat = page.locator(CHAT_CARD);
  const wideVisibilityBefore = await page.evaluate(() => ({
    editor: localStorage.getItem('ok-editor-visible-v1'),
    chat: JSON.parse(localStorage.getItem('ok-agent-session-order-v1') ?? '{}').agentPanelVisible as
      | boolean
      | undefined,
  }));

  await page.getByTestId(AGENTS_HEADER_BUTTON).click();
  await expect(chat).toBeVisible();
  await expect(editor).toBeHidden();
  await page.reload();

  await expect(page.getByTestId(AGENTS_HEADER_BUTTON)).toHaveAttribute('aria-pressed', 'true', {
    timeout: BOOT_TIMEOUT_MS,
  });
  await expect(chat).toBeVisible();
  await expect(editor).toBeHidden();
  expect(
    await page.evaluate(() => ({
      editor: localStorage.getItem('ok-editor-visible-v1'),
      chat: JSON.parse(localStorage.getItem('ok-agent-session-order-v1') ?? '{}')
        .agentPanelVisible as boolean | undefined,
    })),
  ).toEqual(wideVisibilityBefore);
});

test('refresh preserves an intentional empty narrow workspace', async ({ page, api }) => {
  await openDoc(page, api, 767);
  const sessionKey = await page.evaluate(() =>
    Object.keys(sessionStorage).find((key) => key.startsWith('ok-narrow-workspace-v1:')),
  );
  if (sessionKey === undefined) throw new Error('narrow session record was not written');
  await page.evaluate((key) => {
    sessionStorage.setItem(key, JSON.stringify({ version: 1, selected: null }));
  }, sessionKey);

  await page.reload();

  await expect(page.locator('[data-nothing-open]')).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await expect(page.locator(EDITOR_CARD)).toBeHidden();
  await expect(page.locator(CHAT_CARD)).toBeHidden();
  await expect(page.getByTestId('nothing-open-editor')).toBeVisible();
});

test('a malformed narrow record falls back to Editor and becomes usable', async ({ page, api }) => {
  await openDoc(page, api, 767);
  const sessionKey = await page.evaluate(() =>
    Object.keys(sessionStorage).find((key) => key.startsWith('ok-narrow-workspace-v1:')),
  );
  if (sessionKey === undefined) throw new Error('narrow session record was not written');
  await page.evaluate((key) => sessionStorage.setItem(key, '{broken'), sessionKey);

  await page.reload();

  await expect(page.locator(EDITOR_CARD)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await expect(page.getByTestId('header-pane-button-editor')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect
    .poll(() =>
      page.evaluate((key) => {
        try {
          return JSON.parse(sessionStorage.getItem(key) ?? '{}');
        } catch {
          return {};
        }
      }, sessionKey),
    )
    .toMatchObject({ version: 1, selected: 'editor' });
});

test('an unavailable Terminal in the narrow record falls back to Editor', async ({ page, api }) => {
  await openDoc(page, api, 767);
  const sessionKey = await page.evaluate(() =>
    Object.keys(sessionStorage).find((key) => key.startsWith('ok-narrow-workspace-v1:')),
  );
  if (sessionKey === undefined) throw new Error('narrow session record was not written');
  await page.evaluate((key) => {
    sessionStorage.setItem(key, JSON.stringify({ version: 1, selected: 'terminal' }));
  }, sessionKey);

  await page.reload();

  await expect(page.locator(EDITOR_CARD)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await expect(page.locator(TERMINAL_CARD)).toHaveCount(0);
  await expect
    .poll(() => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? '{}'), sessionKey))
    .toMatchObject({ version: 1, selected: 'editor' });
  await expect(page.getByTestId('header-pane-button-editor')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('a narrow workspace remains usable when session storage is unavailable', async ({
  page,
  api,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('Storage denied', 'SecurityError');
      },
    });
  });
  await openDoc(page, api, 767);
  expect(
    await page.evaluate(() => {
      try {
        sessionStorage.getItem('unavailable-storage-probe');
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  await page.reload();

  await expect(page.locator(EDITOR_CARD)).toBeVisible();
  await expect(page.getByTestId('header-pane-button-editor')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByTestId(AGENTS_HEADER_BUTTON).click();
  await expect(page.locator(CHAT_CARD)).toBeVisible();
  await page.getByTestId('header-pane-button-editor').click();
  await expect(page.locator(EDITOR_CARD)).toBeVisible();
});

test('a second browser tab starts with Editor instead of another tab’s narrow selection', async ({
  page,
  api,
}) => {
  await openDoc(page, api, 767);
  await page.getByTestId(AGENTS_HEADER_BUTTON).click();
  await expect(page.locator(CHAT_CARD)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        for (const storage of [sessionStorage, localStorage]) {
          const key = Object.keys(storage).find((item) =>
            item.startsWith('ok-narrow-workspace-v1:'),
          );
          if (key !== undefined) return JSON.parse(storage.getItem(key) ?? '{}');
        }
        return null;
      }),
    )
    .toMatchObject({ version: 1, selected: 'agents' });

  const otherTab = await page.context().newPage();
  try {
    await otherTab.setViewportSize({ width: 767, height: 800 });
    await otherTab.goto(new URL(page.url()).origin);
    await expect(otherTab.locator(EDITOR_CARD)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
    await expect(otherTab.getByTestId('header-pane-button-editor')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(otherTab.locator(CHAT_CARD)).toBeHidden();
    await expect(page.locator(CHAT_CARD)).toBeVisible();
  } finally {
    await otherTab.close();
  }
});

test('a new document deep link selects Editor after a narrow Chat visit', async ({ page, api }) => {
  const source = `narrow-deep-link-source-${test.info().workerIndex}`;
  const destination = `narrow-deep-link-${test.info().workerIndex}`;
  await api.seedDocs([
    { name: source, markdown: '# Deep link source\n' },
    { name: destination, markdown: '# Deep link destination\n' },
  ]);
  await page.setViewportSize({ width: 767, height: 800 });
  await page.goto(`/#/${source}`);
  await waitForActiveProviderSynced(page);
  await page.getByTestId(AGENTS_HEADER_BUTTON).click();
  await expect(page.locator(CHAT_CARD)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const key = Object.keys(sessionStorage).find((item) =>
          item.startsWith('ok-narrow-workspace-v1:'),
        );
        return key === undefined ? null : JSON.parse(sessionStorage.getItem(key) ?? '{}');
      }),
    )
    .toMatchObject({ version: 1, selected: 'agents' });

  await page.goto(`${new URL(page.url()).origin}/?deep-link=1#/${destination}`);

  await expect(page.locator(EDITOR_CARD)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await expect(page.locator(CHAT_CARD)).toBeHidden();
  await expect(page.getByTestId('header-pane-button-editor')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toContainText(
    'Deep link destination',
  );
  await page.reload();
  await expect(page.getByTestId('header-pane-button-editor')).toHaveAttribute(
    'aria-pressed',
    'true',
    { timeout: BOOT_TIMEOUT_MS },
  );
  await expect(page.locator(CHAT_CARD)).toBeHidden();
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toContainText(
    'Deep link destination',
    { timeout: BOOT_TIMEOUT_MS },
  );
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#/${source}$`));
  await expect(page.locator('[data-editor-activity-mount][data-doc-name]').first()).toHaveAttribute(
    'data-doc-name',
    source,
    { timeout: BOOT_TIMEOUT_MS },
  );
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`#/${destination}$`));
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toContainText(
    'Deep link destination',
    { timeout: BOOT_TIMEOUT_MS },
  );
  await expect(page.locator(CHAT_CARD)).toBeHidden();
});

test('search and history reveal their documents from narrow Chat', async ({ page, api }) => {
  const first = `narrow-history-${test.info().workerIndex}`;
  const second = `narrow-search-${test.info().workerIndex}`;
  await api.seedDocs([
    { name: first, markdown: '# History destination\n' },
    { name: second, markdown: '# Search destination\n' },
  ]);
  await page.setViewportSize({ width: 767, height: 800 });
  await page.goto(`/#/${first}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toContainText(
    'History destination',
  );
  await openChat(page);

  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.locator('[data-slot="command-input"]').fill(second);
  await page.getByTestId(`command-palette-nav-file-${second}`).click();
  await expect(page).toHaveURL(new RegExp(`#/${second}$`));
  await expect(page.locator(EDITOR_CARD)).toBeVisible();
  await expect(page.locator(CHAT_CARD)).toBeHidden();
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toContainText(
    'Search destination',
  );

  await openChat(page);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#/${first}$`));
  await expect(page.locator(EDITOR_CARD)).toBeVisible();
  await expect(page.locator(CHAT_CARD)).toBeHidden();
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toContainText(
    'History destination',
  );
});

test('a late seeded Chat thread does not replace an explicit document destination', async ({
  page,
  context,
  api,
  workerServer,
}) => {
  const first = `roster-seed-source-${test.info().workerIndex}`;
  const second = `roster-seed-destination-${test.info().workerIndex}`;
  await api.seedDocs([
    { name: first, markdown: '# Roster source\n' },
    { name: second, markdown: '# Roster destination\n' },
  ]);
  const fixture = await startHiddenChatAgent(workerServer);
  const heldRoster: string[] = [];
  const heldCreated: string[] = [];
  const createRequests: ThreadClientFrame[] = [];
  let threadSocket: WebSocketRoute | null = null;
  const getThreadSocket = () => threadSocket;
  let holdRoster = true;
  let createdThreadId: string | null = null;

  await page.addInitScript((agentId) => {
    localStorage.setItem(
      'ok-acp-registered-agents-v1',
      JSON.stringify({
        agents: [{ source: 'custom', id: agentId, name: 'Hidden activity fixture' }],
        defaultKey: `custom:${agentId}`,
      }),
    );
  }, fixture.agentId);
  await context.routeWebSocket(/\/collab\/thread$/, (socket) => {
    threadSocket = socket;
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (typeof message === 'string') {
        const frame = JSON.parse(message) as ThreadClientFrame;
        if (frame.op === 'create') createRequests.push(frame);
      }
      server.send(message);
    });
    server.onMessage((message) => {
      if (typeof message !== 'string') {
        socket.send(message);
        return;
      }
      const frame = JSON.parse(message) as ThreadServerFrame;
      if (frame.op === 'threads' && holdRoster) heldRoster.push(message);
      else if (
        frame.op === 'created' &&
        frame.reqId === (createRequests[0]?.op === 'create' ? createRequests[0].reqId : null)
      ) {
        heldCreated.push(message);
        createdThreadId = frame.info.threadId;
      } else socket.send(message);
    });
  });

  try {
    await fixture.closeThread(fixture.threadId);
    await page.setViewportSize({ width: 767, height: 800 });
    await page.goto(`/#/${first}`);
    await waitForActiveProviderSynced(page);
    await expect.poll(() => heldRoster.length).toBeGreaterThan(0);
    const roster = JSON.parse(heldRoster[0]) as ThreadServerFrame;
    expect(roster.op).toBe('threads');
    if (roster.op === 'threads') expect(roster.threads).toEqual([]);
    expect(createRequests).toHaveLength(0);

    await openChat(page);
    expect(createRequests).toHaveLength(0);
    const deliver = getThreadSocket();
    if (deliver === null) throw new Error('thread route was not established');
    holdRoster = false;
    for (const frame of heldRoster) deliver.send(frame);
    await expect.poll(() => createRequests.length).toBe(1);
    await expect.poll(() => heldCreated.length).toBe(1);
    expect(createRequests[0]).toMatchObject({ agent: { source: 'custom', id: fixture.agentId } });

    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, `#/${second}`);
    await expect(page.locator(EDITOR_CARD)).toBeVisible();
    await expect(page.locator(CHAT_CARD)).toBeHidden();
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toContainText(
      'Roster destination',
    );

    const editorSurface = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
    await editorSurface.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' typed before restore');
    for (const frame of heldCreated) deliver.send(frame);
    if (createdThreadId === null) throw new Error('seeded thread was not created');
    await expect(page.locator(CHAT_CARD).locator(`[data-tab-id="${createdThreadId}"]`)).toHaveCount(
      1,
    );
    expect(createRequests).toHaveLength(1);
    await expect(page.locator(EDITOR_CARD)).toBeVisible();
    await expect(page.locator(CHAT_CARD)).toBeHidden();
    await expect(page.getByTestId('header-pane-button-editor')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(editorSurface).toBeFocused();
    await page.keyboard.type(' and after');
    await expect(editorSurface).toContainText('typed before restore and after');
  } finally {
    try {
      if (createdThreadId !== null) await fixture.closeThread(createdThreadId);
    } finally {
      await fixture.close();
    }
  }
});

test('an independent same-agent thread reveals Chat after a pending seed loses its socket', async ({
  page,
  context,
  api,
  workerServer,
}) => {
  const source = `same-agent-source-${test.info().workerIndex}`;
  const destination = `same-agent-destination-${test.info().workerIndex}`;
  await api.seedDocs([
    { name: source, markdown: '# Same-agent source\n' },
    { name: destination, markdown: '# Same-agent destination\n' },
  ]);
  const fixture = await startHiddenChatAgent(workerServer);
  let socketGeneration = 0;
  let seedRequestId: string | null = null;
  const createRequestIds: string[] = [];
  const browserCreatedThreadIds: string[] = [];
  let initialRoster: ThreadServerFrame | null = null;
  let firstSocket: WebSocketRoute | null = null;
  let reconnectList: { server: WebSocketRoute; message: string } | null = null;
  let independentThreadId: string | null = null;
  let observedReconnectRoster: ThreadServerFrame | null = null;
  const getInitialRoster = () => initialRoster;
  const getFirstSocket = () => firstSocket;
  const getReconnectList = () => reconnectList;
  const getObservedReconnectRoster = () => observedReconnectRoster;

  await page.addInitScript((agentId) => {
    localStorage.setItem(
      'ok-acp-registered-agents-v1',
      JSON.stringify({
        agents: [{ source: 'custom', id: agentId, name: 'Hidden activity fixture' }],
        defaultKey: `custom:${agentId}`,
      }),
    );
  }, fixture.agentId);
  await context.routeWebSocket(/\/collab\/thread$/, (socket) => {
    const generation = ++socketGeneration;
    const server = socket.connectToServer();
    if (generation === 1) firstSocket = socket;
    socket.onMessage((message) => {
      if (typeof message !== 'string') {
        server.send(message);
        return;
      }
      const frame = JSON.parse(message) as ThreadClientFrame;
      if (frame.op === 'create') {
        createRequestIds.push(frame.reqId);
        if (generation === 1 && seedRequestId === null) {
          seedRequestId = frame.reqId;
          return;
        }
      }
      if (generation > 1 && frame.op === 'list') {
        reconnectList = { server, message };
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => {
      if (typeof message === 'string') {
        const frame = JSON.parse(message) as ThreadServerFrame;
        if (generation === 1 && frame.op === 'threads' && initialRoster === null)
          initialRoster = frame;
        if (generation > 1 && frame.op === 'threads') observedReconnectRoster = frame;
        if (frame.op === 'created' && createRequestIds.includes(frame.reqId))
          browserCreatedThreadIds.push(frame.info.threadId);
      }
      socket.send(message);
    });
  });

  try {
    await fixture.closeThread(fixture.threadId);
    await page.setViewportSize({ width: 767, height: 800 });
    await page.goto(`/#/${source}`);
    await waitForActiveProviderSynced(page);
    await expect
      .poll(getInitialRoster, { timeout: BOOT_TIMEOUT_MS })
      .toMatchObject({ op: 'threads', threads: [] });
    expect(createRequestIds).toHaveLength(0);

    await openChat(page);
    await expect.poll(() => seedRequestId).not.toBeNull();
    expect(createRequestIds).toHaveLength(1);
    const openedSocket = getFirstSocket();
    if (openedSocket === null) throw new Error('initial socket was not established');
    await openedSocket.close();
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, `#/${destination}`);
    await expect(page.locator(EDITOR_CARD)).toBeVisible();
    await expect(page.locator(CHAT_CARD)).toBeHidden();
    await expect.poll(() => reconnectList, { timeout: BOOT_TIMEOUT_MS }).not.toBeNull();

    independentThreadId = await fixture.createThread();
    expect(independentThreadId).not.toBe(fixture.threadId);
    const roster = getInitialRoster();
    if (roster?.op !== 'threads') throw new Error('initial roster missing');
    expect(roster.threads.map((thread) => thread.threadId)).not.toContain(independentThreadId);
    const heldList = getReconnectList();
    if (heldList === null) throw new Error('reconnect list was not held');
    heldList.server.send(heldList.message);
    await expect
      .poll(() => observedReconnectRoster, { timeout: BOOT_TIMEOUT_MS })
      .toMatchObject({ op: 'threads' });
    const reconnectRoster = getObservedReconnectRoster();
    if (reconnectRoster?.op !== 'threads') throw new Error('reconnect roster missing');
    expect(reconnectRoster.threads.map((thread) => thread.threadId)).toContain(independentThreadId);
    await expect(
      page.locator(CHAT_CARD).locator(`[data-tab-id="${independentThreadId}"]`),
    ).toHaveCount(1);
    await expect(page.locator(CHAT_CARD)).toBeVisible();
    await expect(page.getByTestId(AGENTS_HEADER_BUTTON)).toHaveAttribute('aria-pressed', 'true');
    expect(createRequestIds).toHaveLength(1);
  } finally {
    try {
      for (const threadId of browserCreatedThreadIds) await fixture.closeThread(threadId);
      if (independentThreadId !== null) await fixture.closeThread(independentThreadId);
    } finally {
      await fixture.close();
    }
  }
});

test('a disconnected document destination leaves error recovery and header navigation visible', async ({
  page,
  context,
  api,
  workerServer,
}) => {
  const first = `connected-destination-${test.info().workerIndex}`;
  const second = `disconnected-destination-${test.info().workerIndex}`;
  await api.seedDocs([
    { name: first, markdown: '# Connected document\n' },
    { name: second, markdown: '# Disconnected document\n' },
  ]);
  const fixture = await startHiddenChatAgent(workerServer);
  try {
    await page.addInitScript((agentId) => {
      localStorage.setItem(
        'ok-acp-registered-agents-v1',
        JSON.stringify({
          agents: [{ source: 'custom', id: agentId, name: 'Hidden activity fixture' }],
          defaultKey: `custom:${agentId}`,
        }),
      );
    }, fixture.agentId);
    let disconnectDestination = false;
    await context.routeWebSocket(/collab/, (socket) => {
      if (disconnectDestination) {
        socket.close();
        return;
      }
      socket.connectToServer();
    });
    await page.setViewportSize({ width: 767, height: 800 });
    await page.goto(`/#/${first}`);
    await waitForActiveProviderSynced(page);
    await openChat(page);
    await expect(
      page.locator(CHAT_CARD).locator(`[data-tab-id="${fixture.threadId}"]`),
    ).toHaveCount(1);
    disconnectDestination = true;

    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, `#/${second}`);

    await expect(page.locator(EDITOR_CARD)).toBeVisible();
    await expect(page.locator(CHAT_CARD)).toBeHidden();
    const error = page.locator('[data-slot="document-error-boundary"]');
    await expect(error).toContainText('Connection dropped', { timeout: BOOT_TIMEOUT_MS });
    const tryAgain = error.getByRole('button', { name: 'Try again' });
    await expect(tryAgain).toBeVisible();
    expect(
      await tryAgain.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return hit !== null && button.contains(hit);
      }),
    ).toBe(true);
    await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
    await expect(page.getByTestId('header-pane-button-editor')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const errorHandle = await error.elementHandle();
    if (errorHandle === null) throw new Error('document recovery did not mount');
    const editorButton = page.getByTestId('header-pane-button-editor');
    await editorButton.click();
    await expect(editorButton).toBeFocused();
    await expect(editorButton).toHaveAttribute('aria-pressed', 'true');
    await expect(error.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(await error.evaluate((element, original) => element === original, errorHandle)).toBe(
      true,
    );
  } finally {
    await fixture.close();
  }
});

test('a deleted document destination returns to a surviving editor without claiming success', async ({
  page,
  api,
  workerServer,
}) => {
  const first = `deleted-source-${test.info().workerIndex}`;
  const second = `deleted-destination-${test.info().workerIndex}`;
  await api.seedDocs([
    { name: first, markdown: '# Existing source\n' },
    { name: second, markdown: '# Existing destination\n' },
  ]);
  const fixture = await startHiddenChatAgent(workerServer);
  try {
    await page.addInitScript((agentId) => {
      localStorage.setItem(
        'ok-acp-registered-agents-v1',
        JSON.stringify({
          agents: [{ source: 'custom', id: agentId, name: 'Hidden activity fixture' }],
          defaultKey: `custom:${agentId}`,
        }),
      );
    }, fixture.agentId);
    await page.setViewportSize({ width: 767, height: 800 });
    await page.goto(`/#/${first}`);
    await waitForActiveProviderSynced(page);
    await openChat(page);
    await expect(
      page.locator(CHAT_CARD).locator(`[data-tab-id="${fixture.threadId}"]`),
    ).toHaveCount(1);

    const deletion = await fetch(`${workerServer.baseURL}/api/delete-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'file', path: second }),
    });
    expect(deletion.ok).toBe(true);
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, `#/${second}`);

    await expect(page.locator(EDITOR_CARD)).toBeVisible();
    await expect(page.locator(CHAT_CARD)).toBeHidden();
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toContainText(
      'Existing source',
    );
    await expect(page).toHaveURL(new RegExp(`#/${first}$`));
    await expect(page.getByRole('button', { name: `${second}.md`, exact: true })).toHaveCount(0);
    await expect(page.getByTestId('header-pane-button-editor')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
  } finally {
    await fixture.close();
  }
});

test('the side panel names its dividers and keeps the current outline heading readable in every theme', async ({
  page,
  api,
}) => {
  await openDoc(page, api, 1400);
  const toggle = page.locator('[data-doc-panel-toggle]');
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await expect(page.locator('#doc-panel')).toBeVisible();
  await expect(page.getByRole('separator', { name: 'Resize document panel' })).toHaveAttribute(
    'aria-controls',
    'doc-panel',
  );

  const current = page.locator('#doc-panel [aria-current="location"]').first();
  await expect(current).toBeVisible();
  for (const theme of [
    'dracula',
    'catppuccin-frappe',
    'catppuccin-latte',
    'monokai',
    'gruvbox',
    'solarized',
  ]) {
    await switchColorThemeAndSettleFade(page, theme);
    const audit = await new AxeBuilder({ page })
      .include('#doc-panel [aria-current="location"]')
      .withRules(['color-contrast'])
      .analyze();
    expect(audit.violations, `${theme}: current outline heading contrast`).toEqual([]);
  }
});

for (const mode of ['source', 'visual'] as const) {
  test(`a narrow Chat visit keeps the ${mode} editor mode, caret, scroll, bytes and undo`, async ({
    page,
    api,
  }) => {
    const docName = `editor-pane-cards-mode-${mode}-${test.info().workerIndex}`;
    const paragraphs = Array.from({ length: 60 }, (_, index) => `Mode paragraph ${index}`).join(
      '\n\n',
    );
    await api.seedDocs([{ name: docName, markdown: `# Mode ${mode}\n\n${paragraphs}\n` }]);
    const readDocument = async () => {
      const response = await page.request.get(
        `/api/document?docName=${encodeURIComponent(docName)}`,
      );
      expect(response.ok()).toBe(true);
      return ((await response.json()) as { content: string }).content;
    };
    await page.setViewportSize({ width: 767, height: 800 });
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    const seededBytes = await readDocument();
    const modeToggle = page.getByRole('radio', {
      name: mode === 'source' ? 'Markdown source' : 'Visual editor',
    });
    if (mode === 'source') await modeToggle.click();
    await expect(modeToggle).toHaveAttribute('aria-checked', 'true');
    const surface =
      mode === 'source'
        ? page.locator(`${EDITOR_CARD} .cm-content`)
        : page.locator(`${EDITOR_CARD} .ProseMirror:not(.composer-prosemirror)`).first();
    await expect(surface).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
    const lineEndKey = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End';
    if (mode === 'source') {
      await surface.focus();
      await expect(surface).toBeFocused();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('End');
    } else {
      await surface.locator('p').last().click();
      await page.keyboard.press(lineEndKey);
    }
    await page.keyboard.type(' edited');
    await expect.poll(readDocument).toContain('Mode paragraph 59 edited');
    const scrollTopOf = () =>
      surface.evaluate((element) => {
        for (let node = element.parentElement; node; node = node.parentElement) {
          const overflowY = getComputedStyle(node).overflowY;
          if (
            (overflowY === 'auto' || overflowY === 'scroll') &&
            node.scrollHeight > node.clientHeight + 1
          ) {
            return node.scrollTop;
          }
        }
        return 0;
      });
    const editorScrollport = surface.locator(
      'xpath=ancestor::*[@data-testid="editor-scroll-container"]',
    );
    await waitForComposerViewportInset(page, surface);
    const viewportBefore = await parkScrollportNearEnd(editorScrollport, 41);
    const bytesBefore = await readDocument();
    const scrollBefore = await scrollTopOf();
    expect(scrollBefore).toBeGreaterThan(0);

    await page.getByTestId(AGENTS_HEADER_BUTTON).click();
    await expect(page.locator(CHAT_CARD)).toBeVisible();
    await expect(page.locator(EDITOR_CARD)).toBeHidden();
    await waitForAnimationsFinished(surface);
    await page.getByTestId('header-pane-button-editor').click();
    await expect(page.locator(EDITOR_CARD)).toBeVisible();
    await expect(page.locator(CHAT_CARD)).toBeHidden();

    await expect(modeToggle).toHaveAttribute('aria-checked', 'true');
    await expect(surface).toBeVisible();
    expect(await readDocument()).toBe(bytesBefore);
    await waitForComposerViewportInset(page, surface);
    await test.info().attach('viewport-round-trip', {
      body: JSON.stringify({
        mode,
        before: viewportBefore,
        after: await readScrollportExtent(editorScrollport),
      }),
      contentType: 'application/json',
    });
    await expect.poll(scrollTopOf).toBeGreaterThanOrEqual(scrollBefore - 2);
    expect(await scrollTopOf()).toBeLessThanOrEqual(scrollBefore + 2);

    await surface.focus();
    const caret = await surface.evaluate(readEditorCaretLine, mode);
    expect(caret.collapsed).toBe(true);
    expect(caret.text.endsWith('Mode paragraph 59 edited')).toBe(true);
    expect(caret.atParagraphEnd).toBe(true);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(readDocument).not.toContain('Mode paragraph 59 edited');
    expect(await readDocument()).toBe(seededBytes);
    await page.keyboard.press('ControlOrMeta+Shift+Z');
    await expect.poll(readDocument).toBe(bytesBefore);
  });
}

test('repeated Chat selection, Chat Hide and Hide Editor keep the same thread, draft and session', async ({
  page,
  context,
  api,
  workerServer,
}) => {
  const docName = `narrow-same-session-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: '# Same session\n' }]);
  const fixture = await startHiddenChatAgent(workerServer);
  const createRequests: string[] = [];
  await context.routeWebSocket(/\/collab\/thread$/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (typeof message === 'string' && (JSON.parse(message) as { op?: string }).op === 'create') {
        createRequests.push(message);
      }
      server.send(message);
    });
    server.onMessage((message) => socket.send(message));
  });
  try {
    await page.setViewportSize({ width: 767, height: 800 });
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    const wideVisibility = () =>
      page.evaluate(() => ({
        editor: localStorage.getItem('ok-editor-visible-v1'),
        chat:
          (JSON.parse(localStorage.getItem('ok-agent-session-order-v1') ?? '{}')
            .agentPanelVisible as boolean | undefined) ?? false,
      }));
    const wideBefore = await wideVisibility();
    const chatButton = page.getByTestId(AGENTS_HEADER_BUTTON);
    const editorButton = page.getByTestId('header-pane-button-editor');
    const chat = page.locator(CHAT_CARD);
    const editor = page.locator(EDITOR_CARD);
    await chatButton.click();
    await expect(chat).toBeVisible();
    await chat.locator(`[role="tab"][data-tab-id="${fixture.threadId}"]`).click();
    const composer = chat.getByRole('textbox', { name: 'Message Hidden activity fixture' });
    const threadSurface = composer.locator('xpath=ancestor::*[@data-session-id][1]');
    await composer.click();
    await page.keyboard.insertText('Narrow draft');
    const sessionId = await threadSurface.getAttribute('data-session-id');
    expect(sessionId).not.toBeNull();
    const expectSameThread = async () => {
      await expect(chat).toBeVisible();
      await expect(editor).toBeHidden();
      await expect(chatButton).toHaveAttribute('aria-pressed', 'true');
      await expect(composer).toContainText('Narrow draft');
      await expect(threadSurface).toHaveAttribute('data-session-id', sessionId ?? '');
    };

    for (let press = 0; press < 3; press += 1) await chatButton.click();
    await expectSameThread();
    await chatButton.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expectSameThread();

    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('[data-slot="command-input"]').fill('agents');
    await page.getByTestId('command-palette-toggle-agent-panel').click();
    await expect(editor).toBeVisible();
    await expect(chat).toBeHidden();
    await chatButton.click();
    await expectSameThread();

    await composer.click();
    await page.keyboard.press('ControlOrMeta+l');
    await expect(editor).toBeVisible();
    await expect(chat).toBeHidden();
    await chatButton.click();
    await expectSameThread();

    await editorButton.click();
    await expect(editor).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('[data-slot="command-input"]').fill('hide editor');
    await page.getByTestId('command-palette-toggle-editor').click();
    await expectSameThread();

    expect(createRequests).toEqual([]);
    expect(await wideVisibility()).toEqual(wideBefore);
  } finally {
    await fixture.close();
  }
});

test('a narrow Chat visit does not reopen Chat that was explicitly closed on the wide layout', async ({
  page,
  api,
}) => {
  await openDoc(page, api, 1400);
  await openChat(page);
  const chatButton = page.getByTestId(AGENTS_HEADER_BUTTON);
  await chatButton.click();
  await expect(chatButton).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator(CHAT_CARD)).toBeHidden();

  await page.setViewportSize({ width: 767, height: 800 });
  await chatButton.click();
  await expect(page.locator(CHAT_CARD)).toBeVisible();
  await page.getByTestId('header-pane-button-editor').click();
  await expect(page.locator(EDITOR_CARD)).toBeVisible();
  await chatButton.click();
  await expect(page.locator(CHAT_CARD)).toBeVisible();

  await page.setViewportSize({ width: 1400, height: 800 });
  await expect(page.locator(EDITOR_CARD)).toBeVisible();
  await expect(page.locator(CHAT_CARD)).toBeHidden();
  await expect(chatButton).toHaveAttribute('aria-pressed', 'false');
});

test('two tabs keep their own narrow selections across refresh while edits converge', async ({
  page,
  api,
}) => {
  const docName = await openDoc(page, api, 767);
  const readSelection = (target: Page) =>
    target.evaluate(() => {
      const key = Object.keys(sessionStorage).find((item) =>
        item.startsWith('ok-narrow-workspace-v1:'),
      );
      return key === undefined ? null : JSON.parse(sessionStorage.getItem(key) ?? '{}');
    });
  await page.getByTestId(AGENTS_HEADER_BUTTON).click();
  await expect(page.locator(CHAT_CARD)).toBeVisible();
  await expect.poll(() => readSelection(page)).toMatchObject({ selected: 'agents' });

  const otherTab = await page.context().newPage();
  try {
    await otherTab.route('**/api/acp/catalog', (route) =>
      route.fulfill({ json: acpCatalogBody([]) }),
    );
    await otherTab.setViewportSize({ width: 767, height: 800 });
    await otherTab.goto(page.url());
    await waitForActiveProviderSynced(otherTab);
    await otherTab.getByTestId(AGENTS_HEADER_BUTTON).click();
    await expect(otherTab.locator(CHAT_CARD)).toBeVisible();
    await otherTab.getByTestId('header-pane-button-editor').click();
    await expect(otherTab.locator(EDITOR_CARD)).toBeVisible();
    await expect.poll(() => readSelection(otherTab)).toMatchObject({ selected: 'editor' });
    const otherEditor = otherTab.locator('.ProseMirror:not(.composer-prosemirror)').first();
    await otherEditor.click();
    await otherTab.keyboard.press('ControlOrMeta+End');
    await otherTab.keyboard.type(' converged from the other tab');

    await page.reload();
    await expect(page.getByTestId(AGENTS_HEADER_BUTTON)).toHaveAttribute('aria-pressed', 'true', {
      timeout: BOOT_TIMEOUT_MS,
    });
    await expect(page.locator(CHAT_CARD)).toBeVisible();
    await otherTab.reload();
    await expect(otherTab.getByTestId('header-pane-button-editor')).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: BOOT_TIMEOUT_MS },
    );
    await expect(otherTab.locator(CHAT_CARD)).toBeHidden();
    await expect(otherTab.locator('.ProseMirror:not(.composer-prosemirror)').first()).toContainText(
      'converged from the other tab',
      { timeout: BOOT_TIMEOUT_MS },
    );

    await page.getByTestId('header-pane-button-editor').click();
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toContainText(
      'converged from the other tab',
    );
    await expect(
      page.locator('[data-editor-activity-mount][data-doc-name]').first(),
    ).toHaveAttribute('data-doc-name', docName);
    await expect(otherTab.locator(CHAT_CARD)).toBeHidden();
  } finally {
    await otherTab.close();
  }
});

test('opening and refreshing below 48rem raises no page error and leaves wide preferences alone', async ({
  page,
  api,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const docName = `narrow-fresh-open-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: '# Fresh narrow open\n' }]);
  for (const width of [767, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    const readWideIntent = () => ({
      editor: localStorage.getItem('ok-editor-visible-v1'),
      chat:
        (
          JSON.parse(localStorage.getItem('ok-agent-session-order-v1') ?? '{}') as {
            agentPanelVisible?: boolean;
          }
        ).agentPanelVisible ?? false,
    });
    const wideBefore = await page.evaluate(readWideIntent);
    await expect(page.locator(EDITOR_CARD)).toBeVisible();
    await expect(page.locator(TERMINAL_CARD)).toHaveCount(0);
    await page.getByTestId(AGENTS_HEADER_BUTTON).click();
    await expect(page.locator(CHAT_CARD)).toBeVisible();
    await page.reload();
    await expect(page.locator(CHAT_CARD)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
    await page.getByTestId('header-pane-button-editor').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(EDITOR_CARD)).toBeVisible();
    await expect(page.locator(TERMINAL_CARD)).toHaveCount(0);
    await noSidewaysScroll(page);
    expect(await page.evaluate(readWideIntent)).toEqual(wideBefore);
  }
  expect(errors).toEqual([]);
});

test('a second client edit made while narrow Chat is selected appears once and keeps local undo coherent', async ({
  page,
  browser,
  api,
}) => {
  const docName = `narrow-remote-edit-${test.info().workerIndex}`;
  await api.seedDocs([{ name: docName, markdown: '# Remote edit\n\nShared line.' }]);
  await page.setViewportSize({ width: 767, height: 800 });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  const editorA = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
  await editorA.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' local edit');
  await expect(editorA).toContainText('Shared line. local edit');
  await page.getByTestId(AGENTS_HEADER_BUTTON).click();
  await expect(page.locator(CHAT_CARD)).toBeVisible();
  await expect(page.locator(EDITOR_CARD)).toBeHidden();

  const clientB = await browser.newContext();
  try {
    const pageB = await clientB.newPage();
    await pageB.route('**/api/acp/catalog', (route) => route.fulfill({ json: acpCatalogBody([]) }));
    await pageB.setViewportSize({ width: 1400, height: 800 });
    await pageB.goto(`${new URL(page.url()).origin}/#/${docName}`);
    await waitForActiveProviderSynced(pageB);
    const editorB = pageB.locator('.ProseMirror:not(.composer-prosemirror)').first();
    await expect(editorB).toContainText('local edit');
    await editorB.locator('h1').click();
    await pageB.keyboard.press('End');
    await pageB.keyboard.type(' from B');
    await expect(editorB).toContainText('Remote edit from B');

    const occurrences = (text: string | null, needle: string) =>
      (text ?? '').split(needle).length - 1;
    await page.getByTestId('header-pane-button-editor').click();
    await expect(page.locator(EDITOR_CARD)).toBeVisible();
    await expect(editorA).toContainText('Remote edit from B');
    expect(occurrences(await editorA.textContent(), 'from B')).toBe(1);
    expect(occurrences(await editorA.textContent(), 'local edit')).toBe(1);

    await editorA.locator('p').last().click();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(editorA).not.toContainText('local edit');
    await expect(editorA).toContainText('Remote edit from B');
    await expect(editorB).not.toContainText('local edit');

    await page.setViewportSize({ width: 1400, height: 800 });
    await expect(page.locator(EDITOR_CARD)).toBeVisible();
    await expect(editorA).toContainText('Remote edit from B');
    expect(occurrences(await editorA.textContent(), 'from B')).toBe(1);
    await expect(editorA).not.toContainText('local edit');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(editorA).toContainText('Shared line. local edit');
    await expect(editorB).toContainText('local edit');
  } finally {
    await clientB.close();
  }
});

async function waitForAnimationsFinished(target: Locator): Promise<void> {
  await target.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
}

function readScrollportExtent(scrollport: Locator) {
  return scrollport.evaluate((element) => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
  }));
}

async function parkScrollportNearEnd(scrollport: Locator, endOffsetPx: number) {
  await expect
    .poll(() => scrollport.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(endOffsetPx);
  await scrollport.evaluate((element, offset) => {
    element.scrollTop = element.scrollHeight - element.clientHeight - offset;
  }, endOffsetPx);
  const extent = await readScrollportExtent(scrollport);
  expect(extent.scrollHeight - extent.clientHeight - extent.scrollTop).toBe(endOffsetPx);
  return extent;
}

async function waitForComposerViewportInset(page: Page, inset: Locator): Promise<void> {
  await expect(page.getByTestId('bottom-composer')).toBeVisible();
  await expect
    .poll(() =>
      inset.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).getPropertyValue('--ask-composer-height')),
      ),
    )
    .toBeGreaterThan(0);
  await Promise.all([
    waitForAnimationsFinished(inset),
    waitForAnimationsFinished(page.getByTestId('bottom-composer')),
  ]);
}

async function expectChatVisitToPreserveViewport(
  page: Page,
  scrollport: Locator,
  inset: Locator,
): Promise<void> {
  await waitForComposerViewportInset(page, inset);
  const before = await parkScrollportNearEnd(scrollport, 41);
  await page.getByTestId(AGENTS_HEADER_BUTTON).click();
  await expect(page.locator(CHAT_CARD)).toBeVisible();
  await expect(page.locator(EDITOR_CARD)).toBeHidden();
  await waitForAnimationsFinished(inset);
  await page.getByTestId('header-pane-button-editor').click();
  await expect(page.locator(EDITOR_CARD)).toBeVisible();
  await expect(page.locator(CHAT_CARD)).toBeHidden();
  await waitForComposerViewportInset(page, inset);
  const after = await readScrollportExtent(scrollport);
  await test.info().attach('consumer-viewport-round-trip', {
    body: JSON.stringify({ before, after }),
    contentType: 'application/json',
  });
  expect(after.scrollTop).toBeGreaterThanOrEqual(before.scrollTop - 2);
  expect(after.scrollTop).toBeLessThanOrEqual(before.scrollTop + 2);
}

test('a narrow Chat visit preserves the standalone text viewport', async ({
  page,
  workerServer,
}) => {
  const docName = `pane-viewport-text-${test.info().workerIndex}.ts`;
  const content = Array.from(
    { length: 120 },
    (_, index) => `export const line${index} = ${index};`,
  ).join('\n');
  await writeFile(join(workerServer.contentDir, docName), `${content}\n`);
  await page.setViewportSize({ width: 767, height: 800 });
  await page.goto(`/#/${docName}`);
  const surface = page.locator('[data-text-doc-editor] .cm-content');
  await expect(surface).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await expect(surface).toContainText('export const line0 = 0;');
  await surface.focus();
  await expect(surface).toBeFocused();
  await page.keyboard.press('ControlOrMeta+End');
  await expect(surface.getByText('export const line119 = 119;', { exact: true })).toBeVisible();
  await expectChatVisitToPreserveViewport(
    page,
    page.locator('[data-text-doc-editor] .cm-scroller'),
    surface,
  );
});

test('a narrow Chat visit preserves the standalone Mermaid source viewport', async ({
  page,
  workerServer,
}) => {
  const docName = `pane-viewport-mermaid-${test.info().workerIndex}.mmd`;
  const content = `flowchart TD\n${Array.from({ length: 120 }, (_, index) => `N${index} --> N${index + 1}`).join('\n')}\n`;
  await writeFile(join(workerServer.contentDir, docName), content);
  await page.setViewportSize({ width: 767, height: 800 });
  await page.goto(`/#/${docName}`);
  const host = page.locator('[data-mermaid-doc-editor]');
  await expect(host).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await page.getByRole('radio', { name: 'Markdown source' }).click();
  const surface = host.locator('.cm-content');
  await expect(surface).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await expect(surface).toContainText('flowchart TD');
  await surface.focus();
  await expect(surface).toBeFocused();
  await page.keyboard.press('ControlOrMeta+End');
  await expect(surface.getByText('N119 --> N120', { exact: true })).toBeVisible();
  await expectChatVisitToPreserveViewport(page, host.locator('.cm-scroller'), host);
});

test('a narrow Chat visit preserves the conflict viewport', async ({ page, api }) => {
  const docName = `pane-viewport-conflict-${test.info().workerIndex}`;
  const file = `${docName}.md`;
  const base = Array.from({ length: 120 }, (_, index) => `Original line ${index}`).join('\n');
  const ours = Array.from({ length: 120 }, (_, index) => `Current line ${index}`).join('\n');
  const theirs = Array.from({ length: 120 }, (_, index) => `Incoming line ${index}`).join('\n');
  await api.seedDocs([{ name: docName, markdown: `${ours}\n` }]);
  await page.route('**/api/sync/conflicts', (route) =>
    route.fulfill({
      json: {
        conflicts: [
          { file, docName, detectedAt: '2026-10-15T00:00:00.000Z', conflict: 'merge-native' },
        ],
      },
    }),
  );
  await page.route('**/api/sync/conflict-content?**', (route) =>
    route.fulfill({
      json: {
        file,
        base,
        ours,
        theirs,
        kind: 'both-modified',
        conflict: 'merge-native',
        conflictKind: 'git',
        resolutionOptions: ['mine', 'theirs', 'content'],
      },
    }),
  );
  await page.setViewportSize({ width: 767, height: 800 });
  await page.goto(`/#/${docName}`);
  const scrollport = page.locator(`${EDITOR_CARD} .conflict-view`);
  await expect(scrollport).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  const inset = scrollport.locator('diffs-container');
  await expect(inset).toHaveCount(1);
  await expect(scrollport.getByText('Current line 0', { exact: true })).toBeAttached();
  await page.getByTestId('header-pane-button-editor').focus();
  await page.keyboard.press('ArrowLeft');
  await expectChatVisitToPreserveViewport(page, scrollport, inset);
});

test('a narrow Chat visit keeps a collapsed Ask AI inactive', async ({ page, api }) => {
  await openDoc(page, api, 767);
  await expect(page.getByTestId('bottom-composer')).toBeVisible();
  await page.getByTestId('ask-ai-collapse').click();
  await expect(page.getByTestId('bottom-composer')).toHaveCount(0);
  await page.getByTestId(AGENTS_HEADER_BUTTON).click();
  await expect(page.locator(CHAT_CARD)).toBeVisible();
  await expect(page.locator(EDITOR_CARD)).toBeHidden();
  const visibleButton = page.getByTestId(AGENTS_HEADER_BUTTON);
  await visibleButton.focus();
  await expect(visibleButton).toBeFocused();
  await page.keyboard.press('ControlOrMeta+Shift+L');
  await expect(visibleButton).toBeFocused();
  const claimed = await dispatchAskAiShortcut(visibleButton);
  expect(claimed).toBe(false);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('open-knowledge:open-ask-ai-composer')),
  );
  await expect(visibleButton).toBeFocused();
  await page.getByTestId('header-pane-button-editor').click();
  await expect(page.locator(EDITOR_CARD)).toBeVisible();
  await expect(page.getByTestId('bottom-composer')).toHaveCount(0);
});

test('hiding a folder editor leaves Ask AI shortcuts unclaimed until it shows', async ({
  page,
  api,
}) => {
  const folder = `pane-folder-${test.info().workerIndex}`;
  await api.seedDocs([{ name: `${folder}/child`, markdown: '# Folder child\n' }]);
  await page.setViewportSize({ width: 767, height: 800 });
  await page.goto(`/#/${folder}`);
  const composer = page.getByTestId('bottom-composer');
  await expect(composer).toBeVisible();
  await expect(composer.getByTestId(`composer-context-chip-file-${folder}`)).toContainText(folder);
  const input = composer.locator('[contenteditable="true"]');
  await expect(input).toHaveCount(1);
  const editorButton = page.getByTestId('header-pane-button-editor');
  await editorButton.focus();
  expect(await dispatchAskAiShortcut(editorButton)).toBe(true);
  await expect(input).toBeFocused();
  await page.keyboard.press('ControlOrMeta+k');
  const paletteInput = page.locator('[data-slot="command-input"]');
  await paletteInput.fill('hide editor');
  await page.getByTestId('command-palette-toggle-editor').click();
  await expect(paletteInput).toBeHidden();
  await expect(page.locator(EDITOR_CARD)).toBeHidden();
  await expect(composer).toHaveCount(1);
  await editorButton.focus();
  await page.keyboard.press('ControlOrMeta+Shift+L');
  await expect(editorButton).toBeFocused();
  expect(await dispatchAskAiShortcut(editorButton)).toBe(false);
  await editorButton.click();
  await expect(composer).toBeVisible();
  await editorButton.focus();
  await page.keyboard.press('ControlOrMeta+Shift+L');
  await expect(input).toBeFocused();
});

for (const endOffsetPx of [SCROLL_PIN_SLACK_PX / 2, SCROLL_PIN_SLACK_PX + 1]) {
  test(`hiding a wide editor beside Chat ${endOffsetPx}px above its end mounts no composer and preserves its viewport`, async ({
    page,
    api,
  }) => {
    const docName = `pane-viewport-wide-${endOffsetPx}-${test.info().workerIndex}`;
    const content = Array.from({ length: 120 }, (_, index) => `Wide paragraph ${index}`).join(
      '  \n',
    );
    await api.seedDocs([{ name: docName, markdown: `# Wide viewport\n\n${content}\n` }]);
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    const surface = page.locator(`${EDITOR_CARD} .ProseMirror:not(.composer-prosemirror)`).first();
    await expect(surface).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
    await openChat(page);
    await expect(page.getByTestId('bottom-composer')).toHaveCount(0);
    await waitForAnimationsFinished(surface);
    const caret = await placeCaretAtEndOfText(page, 'Wide paragraph 119');
    const documentEnd = await page.evaluate(() => {
      const editor = window.__activeEditor;
      if (!editor) throw new Error('The wide editor is not mounted');
      return editor.state.doc.content.size - 1;
    });
    expect(caret.pmCaret).toBe(documentEnd);
    const scrollport = surface.locator('xpath=ancestor::*[@data-testid="editor-scroll-container"]');
    const before = await parkScrollportNearEnd(scrollport, endOffsetPx);
    await page.getByTestId('header-pane-button-editor').click();
    await expect(page.locator(EDITOR_CARD)).toBeHidden();
    await expect(page.locator(CHAT_CARD)).toBeVisible();
    await expect(surface).toBeAttached();
    await waitForAnimationsFinished(surface);
    await expect.soft(page.getByTestId('bottom-composer')).toHaveCount(0);
    await page.getByTestId('header-pane-button-editor').click();
    await expect(page.locator(EDITOR_CARD)).toBeVisible();
    await expect(page.locator(CHAT_CARD)).toBeVisible();
    await expect(page.getByTestId('bottom-composer')).toHaveCount(0);
    await expect
      .poll(() => scrollport.evaluate((element) => element.clientWidth))
      .toBe(before.clientWidth);
    await waitForAnimationsFinished(surface);
    const after = await readScrollportExtent(scrollport);
    await test.info().attach('wide-viewport-round-trip', {
      body: JSON.stringify({ before, after }),
      contentType: 'application/json',
    });
    expect(after.scrollTop).toBeGreaterThanOrEqual(before.scrollTop - 2);
    expect(after.scrollTop).toBeLessThanOrEqual(before.scrollTop + 2);
  });
}
