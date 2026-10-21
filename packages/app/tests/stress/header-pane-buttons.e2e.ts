import { realpathSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import type { ApiHelpers, DesktopHeaderHost, WorkerServer } from './_helpers';
import {
  dockUnitRect,
  expect,
  headerPaneButton,
  openDesktopHeader,
  presetTerminalPlacement,
  stubAgentCatalog,
  terminalPaneCard,
  test,
  waitForActiveProviderSynced,
} from './_helpers';
import {
  installHandoffMocks,
  readCapturedHandoff,
  readDockStateRequests,
  releaseHeldDockState,
} from './fixtures/handoff-mocks';

type Pane = 'agents' | 'terminal';
type PaneState = 'shown' | 'hidden';

const AGENTS_MOUNT = '[data-agents-panel-mount]';
const TERMINAL_MOUNT = '[data-terminal-panel-mount]';
const TERMINAL_CARD = '[data-slot="pane-card"][data-pane="terminal"]';
const BOOT_TIMEOUT_MS = 30_000;
const DOC_TEXT = 'The quick brown fox jumps over the lazy dog.';

async function paneExtentPx(page: Page, pane: Pane): Promise<number> {
  const rect = await dockUnitRect(page, pane);
  if (rect === null) return 0;
  if (pane === 'agents') return rect.width;
  return (await page.locator(TERMINAL_CARD).getAttribute('data-placement')) === 'bottom'
    ? rect.height
    : rect.width;
}

async function expectPane(page: Page, pane: Pane, state: PaneState): Promise<void> {
  if (state === 'shown') {
    await expect.poll(() => paneExtentPx(page, pane)).toBeGreaterThan(0);
  } else {
    await expect.poll(() => paneExtentPx(page, pane)).toBe(0);
  }
  await expect(headerPaneButton(page, pane)).toHaveAttribute(
    'aria-pressed',
    String(state === 'shown'),
  );
}

async function expectFocusKept(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const active = document.activeElement;
        return active === null || active === document.body ? 'lost' : 'kept';
      }),
    )
    .toBe('kept');
}

async function expectPaneKeepingFocus(page: Page, pane: Pane, state: PaneState): Promise<void> {
  await expectPane(page, pane, state);
  await expectFocusKept(page);
}

async function waitForFocusInPane(page: Page, pane: Pane): Promise<void> {
  const container = pane === 'agents' ? AGENTS_MOUNT : TERMINAL_MOUNT;
  await expect
    .poll(
      () =>
        page.evaluate((selector) => document.activeElement?.closest(selector) != null, container),
      { timeout: BOOT_TIMEOUT_MS },
    )
    .toBe(true);
}

async function clickPaneButton(page: Page, pane: Pane, expected: PaneState): Promise<void> {
  await headerPaneButton(page, pane).click();
  await expectPaneKeepingFocus(page, pane, expected);
}

async function bringBackWithOneClick(
  page: Page,
  pane: Pane,
  preferredExtent: number,
): Promise<void> {
  await headerPaneButton(page, pane).click();
  await expectPane(page, pane, 'shown');
  await expect.poll(() => paneExtentPx(page, pane)).toBeCloseTo(preferredExtent, -1);
  await waitForFocusInPane(page, pane);
}

async function focusDocument(page: Page): Promise<void> {
  const editor = page.locator('.tiptap-editor .ProseMirror').first();
  await expect(editor).toContainText(DOC_TEXT, { timeout: BOOT_TIMEOUT_MS });
  await editor.click();
  await expect(editor).toBeFocused();
}

async function seedDoc(api: ApiHelpers, slug: string): Promise<string> {
  const name = `header-pane-${slug}-${test.info().workerIndex}`;
  await api.seedDocs([{ name, markdown: `# ${name}\n\n${DOC_TEXT}\n` }]);
  return name;
}

async function openWeb(page: Page, api: ApiHelpers, slug: string): Promise<string> {
  const name = await seedDoc(api, slug);
  await stubAgentCatalog(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/#/${name}`);
  await waitForActiveProviderSynced(page);
  await expect(headerPaneButton(page, 'agents')).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await expect(headerPaneButton(page, 'terminal')).toHaveCount(0);
  await expectPane(page, 'agents', 'hidden');
  await focusDocument(page);
  return name;
}

async function openDesktop(
  page: Page,
  api: ApiHelpers,
  workerServer: WorkerServer,
  slug: string,
  {
    viewport = { width: 1600, height: 900 },
    host = {},
  }: { viewport?: { width: number; height: number }; host?: DesktopHeaderHost } = {},
): Promise<string> {
  const name = await seedDoc(api, slug);
  await stubAgentCatalog(page);
  await page.setViewportSize(viewport);
  await openDesktopHeader(page, workerServer, name, host);
  await expect(headerPaneButton(page, 'terminal')).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await expectPane(page, 'agents', 'hidden');
  await expectPane(page, 'terminal', 'hidden');
  await focusDocument(page);
  return name;
}

async function runPalette(page: Page, query: string, commandId: string): Promise<void> {
  await focusDocument(page);
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.locator('[data-slot="command-input"]');
  await expect(input).toBeFocused();
  await input.fill(query);
  const row = page.getByTestId(`command-palette-${commandId}`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator('[data-slot="command-list"]')).toBeHidden();
}

async function openThread(page: Page, title: string): Promise<void> {
  await page.waitForFunction(() => Boolean(window.__acpThreadHarness), null, {
    timeout: BOOT_TIMEOUT_MS,
  });
  await page.evaluate((threadTitle) => {
    const harness = window.__acpThreadHarness;
    if (harness === undefined) throw new Error('ACP thread harness is not installed');
    harness.openThread({
      agent: { id: 'header-pane-agent', name: 'Header Pane Agent', source: 'registry' },
      title: threadTitle,
    });
  }, title);
}

function viewportOf(page: Page): { width: number; height: number } {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('the page has no viewport');
  return viewport;
}

type Rgb = readonly [number, number, number];

interface ToggleLook {
  readonly icon: Rgb;
  readonly background: Rgb;
  readonly outlineStyle: string;
  readonly outlineWidthPx: number;
  readonly outlineColor: Rgb;
  readonly boxShadow: string;
}

interface ChromiumButton {
  readonly role: unknown;
  readonly internalRole: unknown;
  readonly pressed: unknown;
}

interface DividerPaint {
  readonly width: number;
  readonly height: number;
  readonly line: Rgb;
  readonly backdrop: Rgb;
  readonly fill: readonly [number, number, number, number];
}

const SHORTCUT_PLATFORMS = [
  {
    platform: 'darwin',
    navigatorPlatform: 'MacIntel',
    agents: { glyph: '⌘ L', spoken: 'Command L' },
    terminal: { glyph: '⌘ J', spoken: 'Command J' },
  },
  {
    platform: 'linux',
    navigatorPlatform: 'Linux x86_64',
    agents: { glyph: 'Ctrl L', spoken: 'Control L' },
    terminal: { glyph: 'Ctrl J', spoken: 'Control J' },
  },
] as const;

function contrastRatio(first: Rgb, second: Rgb): number {
  const luminance = (color: Rgb) => {
    const [red = 0, green = 0, blue = 0] = color.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

async function readToggleLook(button: Locator): Promise<ToggleLook> {
  await expect
    .poll(() => button.evaluate((element) => element.getAnimations({ subtree: true }).length))
    .toBe(0);
  return await button.evaluate((element) => {
    const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('the page has no color conversion context');
    const toRgba = (color: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
      return [red, green, blue, alpha / 255];
    };
    const layers: Array<[number, number, number, number]> = [];
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const layer = toRgba(getComputedStyle(node).backgroundColor);
      layers.push(layer);
      if (layer[3] === 1) break;
    }
    const base = layers.pop();
    if (base === undefined || base[3] !== 1) throw new Error('the button has no opaque backdrop');
    const background = layers.reduceRight<[number, number, number]>(
      (below, [red, green, blue, alpha]) => [
        red * alpha + below[0] * (1 - alpha),
        green * alpha + below[1] * (1 - alpha),
        blue * alpha + below[2] * (1 - alpha),
      ],
      [base[0], base[1], base[2]],
    );
    const icon = element.querySelector('svg');
    if (icon === null) throw new Error('the button has no icon');
    const style = getComputedStyle(element);
    const [iconRed, iconGreen, iconBlue] = toRgba(getComputedStyle(icon).color);
    const [outlineRed, outlineGreen, outlineBlue] = toRgba(style.outlineColor);
    return {
      icon: [iconRed, iconGreen, iconBlue],
      background: background.map(Math.round) as [number, number, number],
      outlineStyle: style.outlineStyle,
      outlineWidthPx: Number.parseFloat(style.outlineWidth),
      outlineColor: [outlineRed, outlineGreen, outlineBlue],
      boxShadow: style.boxShadow,
    };
  });
}

async function readDividerPaint(page: Page): Promise<DividerPaint> {
  const divider = page.getByTestId('header-pane-divider');
  await expect(divider).toBeVisible();
  const box = await divider.boundingBox();
  if (box === null) throw new Error('the divider has no layout box');
  const clip = {
    x: Math.floor(box.x) - 3,
    y: Math.floor(box.y + box.height / 2),
    width: Math.ceil(box.width) + 6,
    height: 1,
  };
  const png = await page.screenshot({ clip, scale: 'css', animations: 'disabled' });
  const { row, fill } = await divider.evaluate(async (element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', {
      willReadFrequently: true,
    });
    if (context === null) throw new Error('the page has no pixel reading context');
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, 1).data;
    const row = Array.from({ length: bitmap.width }, (_, column): [number, number, number] => [
      pixels[column * 4] ?? 0,
      pixels[column * 4 + 1] ?? 0,
      pixels[column * 4 + 2] ?? 0,
    ]);
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = getComputedStyle(element).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
    return { row, fill: [red, green, blue, alpha / 255] as [number, number, number, number] };
  }, png.toString('base64'));
  const backdrop = row[0];
  if (backdrop === undefined) throw new Error('the divider screenshot has no pixels');
  const line = row.reduce(
    (strongest, pixel) =>
      contrastRatio(pixel, backdrop) > contrastRatio(strongest, backdrop) ? pixel : strongest,
    backdrop,
  );
  return { width: box.width, height: box.height, line, backdrop, fill };
}

async function readChromiumHeaderButton(page: Page, name: string): Promise<ChromiumButton> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: "document.querySelector('header[data-app-header]')",
    });
    if (result.objectId === undefined) throw new Error('the app header is missing');
    const { nodes } = await cdp.send('Accessibility.queryAXTree', {
      objectId: result.objectId,
      accessibleName: name,
      role: 'button',
    });
    expect(nodes, `one "${name}" button in Chromium's header tree`).toHaveLength(1);
    const node = nodes[0];
    return {
      role: node?.role?.value,
      internalRole: node?.chromeRole?.value,
      pressed: node?.properties?.find((property) => property.name === 'pressed')?.value.value,
    };
  } finally {
    await cdp.detach();
  }
}

function resourcesButton(page: Page): Locator {
  return page
    .locator('header[data-app-header]')
    .getByRole('button', { name: 'Resources', exact: true });
}

async function tabFromResourcesTo(page: Page, pane: Pane | 'editor'): Promise<void> {
  const tooltipBubbles = page.locator('[data-slot="tooltip-content"]');
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await expect(tooltipBubbles).toHaveCount(0);
  await resourcesButton(page).focus();
  await expect(resourcesButton(page)).toBeFocused();
  await expect(tooltipBubbles).toHaveCount(1);
  const stepsAfterResources = { editor: 1, agents: 2, terminal: 3 } as const;
  for (let step = 0; step < stepsAfterResources[pane]; step += 1) {
    await page.keyboard.press('Tab');
  }
  await expect(headerPaneButton(page, pane)).toBeFocused();
}

async function expectFocusTooltip(
  page: Page,
  pane: Pane,
  name: string,
  shortcut: { readonly glyph: string; readonly spoken: string },
): Promise<void> {
  const button = headerPaneButton(page, pane);
  await expect(button).toHaveAttribute('aria-describedby', /.+/);
  const tooltipId = await button.getAttribute('aria-describedby');
  const tooltip = page.getByRole('tooltip').and(page.locator(`[id="${tooltipId}"]`));
  await expect(tooltip).toHaveText(`${name} ${shortcut.glyph}`);
  const bubble = page.locator('[data-slot="tooltip-content"]').filter({ has: tooltip });
  await expect(bubble).toBeVisible();
  await expect(bubble.locator(':scope > kbd')).toHaveText(shortcut.glyph);
  await expect(bubble.locator(':scope > kbd')).toHaveAttribute('aria-label', shortcut.spoken);
  await expect(button).toHaveAccessibleDescription(`${name} ${shortcut.spoken}`);
}

async function movePointerOffHeader(page: Page): Promise<void> {
  const { width, height } = viewportOf(page);
  await page.mouse.move(width / 2, height - 40);
}

test.setTimeout(180_000);

test.describe('the Agents button follows every chat show/hide path on the web', () => {
  test('narrowing an Editor-only workspace keeps explicitly hidden Chat hidden', async ({
    page,
    api,
  }) => {
    await openWeb(page, api, 'editor-only-narrow-chat');
    await clickPaneButton(page, 'agents', 'shown');
    await clickPaneButton(page, 'agents', 'hidden');
    await page.setViewportSize({ width: 767, height: 800 });
    await expect(page.locator('[data-pane="editor"]')).toBeVisible();
    await expectPane(page, 'agents', 'hidden');
  });

  test('a wide palette Editor reveal remains selected when narrowing', async ({ page, api }) => {
    await openWeb(page, api, 'narrow-palette-editor');
    await clickPaneButton(page, 'agents', 'shown');
    await runPalette(page, 'editor', 'toggle-editor');
    await expect(page.locator('[data-pane="editor"]')).toBeHidden();
    await expectPane(page, 'agents', 'shown');
    await headerPaneButton(page, 'agents').focus();
    await expect(headerPaneButton(page, 'agents')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+k');
    const input = page.locator('[data-slot="command-input"]');
    await expect(input).toBeFocused();
    await input.fill('editor');
    const showEditor = page.getByTestId('command-palette-toggle-editor');
    await expect(showEditor).toContainText('Show Editor');
    await showEditor.click();
    await expect(page.locator('[data-pane="editor"]')).toBeVisible();
    await page.setViewportSize({ width: 767, height: 800 });
    await expect(page.locator('[data-pane="editor"]')).toBeVisible();
    await expectPane(page, 'agents', 'hidden');
    await page.setViewportSize({ width: 1600, height: 900 });
    await expectPane(page, 'agents', 'shown');
  });

  test('palette Show Agents and Hide Agents', async ({ page, api }) => {
    await openWeb(page, api, 'palette-agents');
    await runPalette(page, 'agents', 'toggle-agent-panel');
    await expectPane(page, 'agents', 'shown');
    await runPalette(page, 'agents', 'toggle-agent-panel');
    await expectPane(page, 'agents', 'hidden');
  });

  test('Cmd/Ctrl+L with nothing selected shows and hides chat', async ({ page, api }) => {
    await openWeb(page, api, 'mod-l');
    await page.keyboard.press('ControlOrMeta+l');
    await expectPaneKeepingFocus(page, 'agents', 'shown');
    await waitForFocusInPane(page, 'agents');
    await page.keyboard.press('ControlOrMeta+l');
    await expectPaneKeepingFocus(page, 'agents', 'hidden');
  });

  test('Cmd/Ctrl+L from the narrow Editor header focuses the empty Agents surface', async ({
    page,
    api,
  }) => {
    await openWeb(page, api, 'narrow-keyboard-agents-focus');
    await page.setViewportSize({ width: 767, height: 800 });

    const editorHeader = headerPaneButton(page, 'editor');
    await editorHeader.focus();
    await expect(editorHeader).toBeFocused();

    await page.keyboard.press('ControlOrMeta+l');

    await expectPane(page, 'agents', 'shown');
    await waitForFocusInPane(page, 'agents');
  });

  test('Shift+Cmd/Ctrl+J reveals chat and leaves an open chat open', async ({ page, api }) => {
    await openWeb(page, api, 'new-session');
    const agentSettings = page.getByTestId('settings-dialog');
    await page.keyboard.press('ControlOrMeta+Shift+j');
    await expectPaneKeepingFocus(page, 'agents', 'shown');
    await expect(agentSettings).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(agentSettings).toBeHidden();
    await focusDocument(page);
    await page.keyboard.press('ControlOrMeta+Shift+j');
    await expectPaneKeepingFocus(page, 'agents', 'shown');
  });

  test('a new live thread reveals chat, and closing the last tab hides it', async ({
    page,
    api,
  }) => {
    await openWeb(page, api, 'auto-reveal');
    await openThread(page, 'First header thread');
    await expectPane(page, 'agents', 'shown');
    await openThread(page, 'Second header thread');
    await expectPane(page, 'agents', 'shown');
    await expect(page.locator(AGENTS_MOUNT).getByRole('tab')).toHaveCount(2);
    await page.getByRole('button', { name: 'Close Second header thread' }).click();
    await expectPane(page, 'agents', 'shown');
    await page.getByRole('button', { name: 'Close First header thread' }).click();
    await expectPane(page, 'agents', 'hidden');
  });

  test('closing the last narrow chat thread does not reopen it with the wide layout', async ({
    page,
    api,
  }) => {
    await openWeb(page, api, 'narrow-close-thread');
    await openThread(page, 'Narrow close thread');
    await expectPane(page, 'agents', 'shown');
    await page.setViewportSize({ width: 767, height: 800 });
    await headerPaneButton(page, 'agents').click();
    await expectPane(page, 'agents', 'shown');
    await page.getByRole('button', { name: 'Close Narrow close thread' }).click();
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');
    await page.setViewportSize({ width: 1600, height: 900 });
    await expectPane(page, 'agents', 'hidden');
  });

  test('sending a comment to the open chat reveals chat', async ({ page, api }) => {
    const name = await openWeb(page, api, 'comment-send');
    const created = await page.request.post('/api/comments', {
      data: { docName: name, quote: 'brown fox', body: 'Is the fox really brown?' },
    });
    expect(created.ok()).toBe(true);
    await openThread(page, 'Comment destination thread');
    await expectPane(page, 'agents', 'shown');
    await clickPaneButton(page, 'agents', 'hidden');

    await page.getByRole('tab', { name: 'Comments' }).click();
    const comments = page.locator('#panel-comments');
    await expect(comments.getByTestId('thread-comment-body')).toHaveText(
      'Is the fox really brown?',
      { timeout: BOOT_TIMEOUT_MS },
    );
    const queued = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/comment' &&
        (response.request().postData() ?? '').includes('"queue"'),
    );
    await comments.getByRole('checkbox', { name: 'Send this comment' }).click();
    expect((await queued).ok()).toBe(true);
    await expect(comments.getByRole('checkbox', { name: "Don't send this comment" })).toBeVisible({
      timeout: BOOT_TIMEOUT_MS,
    });
    await comments.getByRole('button', { name: 'Send to chat' }).click();
    await expectPane(page, 'agents', 'shown');
  });

  test('a web reload keeps the button matching chat', async ({ page, api }) => {
    await openWeb(page, api, 'reload');
    await clickPaneButton(page, 'agents', 'shown');
    await page.reload();
    await waitForActiveProviderSynced(page);
    await expectPane(page, 'agents', 'shown');
    await clickPaneButton(page, 'agents', 'hidden');
    await page.reload();
    await waitForActiveProviderSynced(page);
    await expectPane(page, 'agents', 'hidden');
  });
});

test.describe('the Terminal button follows every terminal show/hide path on the mocked desktop', () => {
  test('narrowing keeps Terminal hidden after a wide keyboard Hide', async ({
    page,
    api,
    workerServer,
  }) => {
    await openDesktop(page, api, workerServer, 'narrow-keyboard-terminal-hide');
    await page.keyboard.press('Control+Backquote');
    await expectPaneKeepingFocus(page, 'terminal', 'shown');
    await waitForFocusInPane(page, 'terminal');
    await page.keyboard.press('Control+Backquote');
    await expectPaneKeepingFocus(page, 'terminal', 'hidden');
    await page.setViewportSize({ width: 767, height: 800 });
    await expect(page.locator('[data-pane="editor"]')).toBeVisible();
    await expectPane(page, 'terminal', 'hidden');
  });

  test('narrowing an Editor-only workspace keeps a hidden Terminal hidden', async ({
    page,
    api,
    workerServer,
  }) => {
    await openDesktop(page, api, workerServer, 'editor-only-narrow');
    await clickPaneButton(page, 'terminal', 'shown');
    await clickPaneButton(page, 'terminal', 'hidden');
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');
    await page.setViewportSize({ width: 767, height: 800 });
    await expect(page.locator('[data-pane="editor"]')).toBeVisible();
    await expectPane(page, 'terminal', 'hidden');
    await expectPane(page, 'agents', 'hidden');
    await page.setViewportSize({ width: 1600, height: 900 });
    await expect(page.locator('[data-pane="editor"]')).toBeVisible();
    await expectPane(page, 'terminal', 'hidden');
  });

  test('a narrow terminal visit does not add Terminal to the restored wide layout', async ({
    page,
    api,
    workerServer,
  }) => {
    await presetTerminalPlacement(page, 'bottom');
    await openDesktop(page, api, workerServer, 'narrow-terminal-visit', {
      viewport: { width: 769, height: 800 },
    });
    await clickPaneButton(page, 'agents', 'shown');
    await page.setViewportSize({ width: 767, height: 800 });
    await expect(page.locator('[data-pane="editor"]')).toBeHidden();
    await expectPane(page, 'agents', 'shown');

    await headerPaneButton(page, 'terminal').click();
    await expectPane(page, 'terminal', 'shown');
    await expect(page.locator('[data-pane="editor"]')).toBeHidden();
    await expect(page.locator('[data-pane="agents"]')).toBeHidden();
    await expect(page.locator('[data-pane="terminal"][data-placement="bottom"]')).toBeVisible();

    await page.setViewportSize({ width: 769, height: 800 });
    await expect(page.locator('[data-pane="editor"]')).toBeVisible();
    await expectPane(page, 'agents', 'shown');
    await expectPane(page, 'terminal', 'hidden');
    await expect(page.locator(TERMINAL_CARD)).toHaveAttribute('data-placement', 'bottom');
    await page.setViewportSize({ width: 767, height: 800 });
    await expectPane(page, 'terminal', 'shown');
    await expect(page.locator('[data-pane="editor"]')).toBeHidden();
  });

  test('palette Show Terminal and Hide Terminal', async ({ page, api, workerServer }) => {
    await openDesktop(page, api, workerServer, 'palette-terminal');
    await runPalette(page, 'terminal', 'toggle-terminal');
    await expectPane(page, 'terminal', 'shown');
    await runPalette(page, 'terminal', 'toggle-terminal');
    await expectPane(page, 'terminal', 'hidden');
  });

  test('palette New Terminal shows the terminal and Kill Terminal on the last session hides it', async ({
    page,
    api,
    workerServer,
  }) => {
    await openDesktop(page, api, workerServer, 'new-kill');
    await runPalette(page, 'new terminal', 'new-terminal');
    await expectPane(page, 'terminal', 'shown');
    await runPalette(page, 'new terminal', 'new-terminal');
    await expectPane(page, 'terminal', 'shown');
    const sessions = page.getByRole('tab', { name: /^Terminal/ });
    await expect(sessions).toHaveCount(2);
    await runPalette(page, 'kill terminal', 'kill-terminal');
    await expect(sessions).toHaveCount(1);
    await expectPane(page, 'terminal', 'shown');
    await runPalette(page, 'kill terminal', 'kill-terminal');
    await expectPane(page, 'terminal', 'hidden');
  });

  test('Ctrl+` shows and hides the terminal', async ({ page, api, workerServer }) => {
    await openDesktop(page, api, workerServer, 'ctrl-backquote');
    await page.keyboard.press('Control+Backquote');
    await expectPaneKeepingFocus(page, 'terminal', 'shown');
    await waitForFocusInPane(page, 'terminal');
    await page.keyboard.press('Control+Backquote');
    await expectPaneKeepingFocus(page, 'terminal', 'hidden');
  });

  for (const placement of ['bottom', 'right'] as const) {
    test(`closing the last tab hides a ${placement} terminal`, async ({
      page,
      api,
      workerServer,
    }) => {
      await presetTerminalPlacement(page, placement);
      await openDesktop(page, api, workerServer, `last-tab-${placement}`);
      await clickPaneButton(page, 'terminal', 'shown');
      await page.getByRole('button', { name: /^Close Terminal/ }).click();
      await expectPane(page, 'terminal', 'hidden');
    });
  }

  test('a terminal launch from Open with AI shows the terminal and keeps it shown', async ({
    page,
    api,
    workerServer,
  }) => {
    const name = await openDesktop(page, api, workerServer, 'launch');
    const docRow = page
      .locator('[data-slot="sidebar-container"]')
      .getByRole('treeitem', { name: `${name}.md`, exact: true });
    for (const before of ['hidden', 'shown'] as const) {
      await expectPane(page, 'terminal', before);
      await docRow.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Open with AI' }).click();
      await page.getByTestId('file-tree-open-in-terminal-claude').click();
      await expectPane(page, 'terminal', 'shown');
      await waitForFocusInPane(page, 'terminal');
    }
  });

  test('a narrow file action selects Terminal and preserves the wide layout', async ({
    page,
    api,
    workerServer,
  }) => {
    const name = await openDesktop(page, api, workerServer, 'narrow-file-terminal-launch', {
      viewport: { width: 767, height: 800 },
    });
    await page.locator('[data-sidebar="trigger"]').click();
    const docRow = page
      .locator('[data-slot="sidebar-container"]')
      .getByRole('treeitem', { name: `${name}.md`, exact: true });
    await docRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open with AI' }).click();
    await page.getByTestId('file-tree-open-in-terminal-claude').click();

    await expectPane(page, 'terminal', 'shown');
    await expect
      .poll(async () => (await readCapturedHandoff(page)).terminalCreateCalls.length)
      .toBe(1);
    const [terminalLaunch] = (await readCapturedHandoff(page)).terminalCreateCalls;
    expect(terminalLaunch?.launchCli).toBe('claude');
    expect(JSON.stringify(terminalLaunch?.launchCommand)).toContain(name);
    await expect(page.locator('[data-pane="editor"]')).toBeHidden();
    await expect(page.locator('[data-pane="agents"]')).toBeHidden();
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'false');
    await expect(headerPaneButton(page, 'agents')).toHaveAttribute('aria-pressed', 'false');
    await page.setViewportSize({ width: 1600, height: 900 });
    await expect(page.locator('[data-pane="editor"]')).toBeVisible();
    await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');
    await expectPane(page, 'terminal', 'hidden');
  });

  test('moving an open terminal between bottom and right keeps the button on', async ({
    page,
    api,
    workerServer,
  }) => {
    await presetTerminalPlacement(page, 'bottom');
    await openDesktop(page, api, workerServer, 'move');
    await clickPaneButton(page, 'terminal', 'shown');
    await waitForFocusInPane(page, 'terminal');
    await expect(page.locator(terminalPaneCard('bottom'))).toBeVisible();
    await runPalette(page, 'move terminal', 'move-terminal');
    await expect(page.locator(terminalPaneCard('right'))).toBeVisible();
    await expect(page.locator(terminalPaneCard('bottom'))).toHaveCount(0);
    await expectPane(page, 'terminal', 'shown');
    await runPalette(page, 'move terminal', 'move-terminal');
    await expect(page.locator(terminalPaneCard('bottom'))).toBeVisible();
    await expect(page.locator(terminalPaneCard('right'))).toHaveCount(0);
    await expectPane(page, 'terminal', 'shown');
  });
});

test.describe('the Agents button on the mocked desktop', () => {
  test('the palette and the Agents button toggle chat and keep the button in step', async ({
    page,
    api,
    workerServer,
  }) => {
    await openDesktop(page, api, workerServer, 'desktop-agents');
    await runPalette(page, 'agents', 'toggle-agent-panel');
    await expectPane(page, 'agents', 'shown');
    await clickPaneButton(page, 'agents', 'hidden');
    await runPalette(page, 'agents', 'toggle-agent-panel');
    await expectPane(page, 'agents', 'shown');
    await runPalette(page, 'agents', 'toggle-agent-panel');
    await expectPane(page, 'agents', 'hidden');
    await expectPane(page, 'terminal', 'hidden');
  });

  test('Files yields so right Terminal and Chat remain open with a usable Editor', async ({
    page,
    api,
    workerServer,
  }) => {
    await presetTerminalPlacement(page, 'right');
    await openDesktop(page, api, workerServer, 'fit-rule', {
      viewport: { width: 1100, height: 800 },
    });
    await clickPaneButton(page, 'terminal', 'shown');
    await headerPaneButton(page, 'agents').click();
    await expectPaneKeepingFocus(page, 'terminal', 'shown');
    await expectPane(page, 'agents', 'shown');
    await expect(page.locator('[data-sidebar="trigger"]')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect
      .poll(() =>
        page
          .locator('[data-editor-workspace-column]')
          .evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBeGreaterThanOrEqual(300);
  });

  test('information yields while a right Terminal stays open when Chat opens', async ({
    page,
    api,
    workerServer,
  }) => {
    await presetTerminalPlacement(page, 'right');
    await openDesktop(page, api, workerServer, 'info-fit-rule', {
      viewport: { width: 1128, height: 800 },
    });
    const filesTrigger = page.locator('[data-sidebar="trigger"]');
    await filesTrigger.click();
    await expect(filesTrigger).toHaveAttribute('aria-expanded', 'false');
    await page.locator('[data-doc-panel-toggle]').click();
    await expect(page.locator('#doc-panel')).toBeVisible();
    await clickPaneButton(page, 'terminal', 'shown');
    await headerPaneButton(page, 'agents').click();
    await expectPaneKeepingFocus(page, 'terminal', 'shown');
    await expectPane(page, 'agents', 'shown');
    await expect(page.locator('#doc-panel')).not.toBeVisible();
    await expect
      .poll(() =>
        page
          .locator('[data-editor-workspace-column]')
          .evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBeGreaterThanOrEqual(300);
  });
});

test('narrow Terminal Hide returns to Editor without opening Terminal in the wide layout', async ({
  page,
  api,
  workerServer,
}) => {
  await openDesktop(page, api, workerServer, 'narrow-terminal-hide', {
    viewport: { width: 767, height: 800 },
  });
  await headerPaneButton(page, 'terminal').click();
  await expectPane(page, 'terminal', 'shown');
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.locator('[data-slot="command-input"]');
  await input.fill('terminal');
  const toggle = page.getByTestId('command-palette-toggle-terminal');
  await expect(toggle).toContainText('Hide Terminal');
  await toggle.click();

  await expectPane(page, 'terminal', 'hidden');
  await expect(headerPaneButton(page, 'editor')).toHaveAttribute('aria-pressed', 'true');
  await page.setViewportSize({ width: 1600, height: 900 });
  await expectPane(page, 'terminal', 'hidden');
});

test.describe('the pane buttons during the desktop restore wait', () => {
  test('both buttons read off and stay clickable while the saved layout loads, and a click survives the restore', async ({
    page,
    api,
    workerServer,
  }) => {
    const name = await seedDoc(api, 'restore-wait');
    await stubAgentCatalog(page);
    await page.setViewportSize({ width: 1600, height: 900 });
    const restoreTimeouts: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('dock-state restore exceeded')) {
        restoreTimeouts.push(message.text());
      }
    });
    let contentDir = workerServer.contentDir;
    try {
      contentDir = realpathSync(contentDir);
    } catch {}
    await installHandoffMocks(page, {
      host: 'electron',
      install: { claude: false, codex: false, cursor: false },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: contentDir,
      heldDockState: { terminalVisible: true, agentPanelVisible: false },
    });
    await page.goto(`/#/${name}`);

    const agents = headerPaneButton(page, 'agents');
    const terminal = headerPaneButton(page, 'terminal');
    await expect(agents).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
    await expect.poll(() => readDockStateRequests(page)).toBeGreaterThan(0);
    await expect(agents).toHaveAttribute('aria-pressed', 'false');
    await expect(terminal).toHaveAttribute('aria-pressed', 'false');
    await expect(agents).toBeEnabled();
    await expect(terminal).toBeEnabled();

    await agents.click();
    await expect(agents).toHaveAttribute('aria-pressed', 'true');
    await releaseHeldDockState(page);

    await expectPane(page, 'terminal', 'shown');
    await expectPane(page, 'agents', 'shown');
    expect(restoreTimeouts).toEqual([]);
  });

  test('a narrow user selection survives a late desktop dock restore', async ({
    page,
    api,
    workerServer,
  }) => {
    const name = await seedDoc(api, 'narrow-restore-wait');
    await stubAgentCatalog(page);
    await page.setViewportSize({ width: 767, height: 800 });
    let contentDir = workerServer.contentDir;
    try {
      contentDir = realpathSync(contentDir);
    } catch {}
    await installHandoffMocks(page, {
      host: 'electron',
      install: { claude: false, codex: false, cursor: false },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: contentDir,
      heldDockState: { terminalVisible: true, agentPanelVisible: false },
    });
    await page.goto(`/#/${name}`);
    await expect.poll(() => readDockStateRequests(page)).toBeGreaterThan(0);

    await headerPaneButton(page, 'agents').click();
    await expect(headerPaneButton(page, 'agents')).toHaveAttribute('aria-pressed', 'true');
    await releaseHeldDockState(page);

    await expect(headerPaneButton(page, 'agents')).toHaveAttribute('aria-pressed', 'true');
    await expect(headerPaneButton(page, 'terminal')).toHaveAttribute('aria-pressed', 'false');
    await page.setViewportSize({ width: 769, height: 800 });
    await expect(headerPaneButton(page, 'terminal')).toHaveAttribute('aria-pressed', 'true');
    await expect(headerPaneButton(page, 'agents')).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('the pane buttons for keyboard, screen-reader and high-contrast users on the mocked desktop', () => {
  for (const shortcuts of SHORTCUT_PLATFORMS) {
    test(`Tab from Resources reaches Editor, Agents then Terminal, 28px targets whose focus tooltip names the ${shortcuts.platform} shortcut in both states`, async ({
      page,
      api,
      workerServer,
    }) => {
      await page.addInitScript((platform) => {
        Object.defineProperty(navigator, 'platform', { get: () => platform, configurable: true });
      }, shortcuts.navigatorPlatform);
      await openDesktop(page, api, workerServer, `keyboard-${shortcuts.platform}`, {
        host: { platform: shortcuts.platform },
      });

      await tabFromResourcesTo(page, 'editor');
      await page.keyboard.press('Tab');
      await expect(headerPaneButton(page, 'agents')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(headerPaneButton(page, 'terminal')).toBeFocused();
      for (const pane of ['editor', 'agents', 'terminal'] as const) {
        const box = await headerPaneButton(page, pane).boundingBox();
        expect(box, `${pane} button bounds`).toMatchObject({ width: 28, height: 28 });
      }

      const names = { agents: 'Agents', terminal: 'Terminal' } as const;
      for (const pane of ['agents', 'terminal'] as const) {
        await tabFromResourcesTo(page, pane);
        await expect(headerPaneButton(page, pane)).toHaveAttribute('aria-pressed', 'false');
        await expectFocusTooltip(page, pane, names[pane], shortcuts[pane]);
        await page.keyboard.press('Enter');
        await expectPaneKeepingFocus(page, pane, 'shown');
        await waitForFocusInPane(page, pane);
        await tabFromResourcesTo(page, pane);
        await expect(headerPaneButton(page, pane)).toHaveAttribute('aria-pressed', 'true');
        await expectFocusTooltip(page, pane, names[pane], shortcuts[pane]);
      }
    });
  }

  test("the Panels group and Chromium's accessibility tree expose three toggle buttons whose pressed state follows the panes", async ({
    page,
    api,
    workerServer,
  }) => {
    await openDesktop(page, api, workerServer, 'ax-tree');
    const group = page.getByRole('group', { name: 'Panels', exact: true });
    await expect(group).toMatchAriaSnapshot(`
      - group "Panels":
        - button "Editor" [pressed]
        - button "Agents" [pressed=false]
        - button "Terminal" [pressed=false]
    `);
    const plainButton = await readChromiumHeaderButton(page, 'Resources');
    expect(plainButton.role).toBe('button');
    expect(plainButton.pressed).toBeUndefined();
    const agentsBefore = await readChromiumHeaderButton(page, 'Agents');
    expect(agentsBefore.role).toBe('button');
    expect(agentsBefore.internalRole).not.toEqual(plainButton.internalRole);
    expect(agentsBefore.pressed).toBe('false');
    expect(await readChromiumHeaderButton(page, 'Terminal')).toEqual(agentsBefore);

    await clickPaneButton(page, 'agents', 'shown');
    await expect(group).toMatchAriaSnapshot(`
      - group "Panels":
        - button "Editor" [pressed]
        - button "Agents" [pressed]
        - button "Terminal" [pressed=false]
    `);
    expect(await readChromiumHeaderButton(page, 'Agents')).toEqual({
      ...agentsBefore,
      pressed: 'true',
    });
    expect(await readChromiumHeaderButton(page, 'Terminal')).toEqual(agentsBefore);

    await clickPaneButton(page, 'terminal', 'shown');
    expect(await readChromiumHeaderButton(page, 'Terminal')).toEqual({
      ...agentsBefore,
      pressed: 'true',
    });
    await clickPaneButton(page, 'agents', 'hidden');
    expect(await readChromiumHeaderButton(page, 'Agents')).toEqual(agentsBefore);

    const accessibility = await new AxeBuilder({ page })
      .include('[data-testid="header-pane-buttons"]')
      .analyze();
    expect(accessibility.violations).toEqual([]);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`on differs from off in icon and background and never looks like a hovered off button in the ${theme} theme`, async ({
      page,
      api,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((value) => window.localStorage.setItem('ok-theme-v1', value), theme);
      await openWeb(page, api, `look-${theme}`);
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      const agents = headerPaneButton(page, 'agents');

      await movePointerOffHeader(page);
      const off = await readToggleLook(agents);
      await agents.hover();
      const hoveredOff = await readToggleLook(agents);
      await clickPaneButton(page, 'agents', 'shown');
      await waitForFocusInPane(page, 'agents');
      await movePointerOffHeader(page);
      const on = await readToggleLook(agents);

      expect(on.icon, 'on and off icons differ').not.toEqual(off.icon);
      expect(on.background, 'on and off backgrounds differ').not.toEqual(off.background);
      expect(hoveredOff.background).not.toEqual(off.background);
      expect(hoveredOff.background).not.toEqual(on.background);
    });

    test(`every plain header button shows a hover background in the ${theme} theme`, async ({
      page,
      api,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((value) => window.localStorage.setItem('ok-theme-v1', value), theme);
      await openWeb(page, api, `hover-${theme}`);
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      const buttons = page.locator(
        'header[data-app-header] [data-variant^="ghost"]:not([aria-pressed="true"]):has(svg):visible',
      );
      const count = await buttons.count();
      expect(count, 'header buttons to hover').toBeGreaterThanOrEqual(3);
      for (let index = 0; index < count; index += 1) {
        const button = buttons.nth(index);
        const name = (await button.getAttribute('aria-label')) ?? (await button.innerText());
        await movePointerOffHeader(page);
        const off = await readToggleLook(button);
        await button.hover();
        const hovered = await readToggleLook(button);
        expect(
          contrastRatio(hovered.background, off.background),
          `${name} hover against the header`,
        ).toBeGreaterThanOrEqual(1.03);
      }
    });
  }

  for (const theme of ['light', 'dark'] as const) {
    test(`below 48rem the pane buttons sit on one track with the shown pane raised in the ${theme} theme, and widening brings back the separate toggles`, async ({
      page,
      api,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((value) => window.localStorage.setItem('ok-theme-v1', value), theme);
      await openWeb(page, api, `switcher-${theme}`);
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      const group = page.getByRole('group', { name: 'Panels', exact: true });
      const editor = headerPaneButton(page, 'editor');
      const agents = headerPaneButton(page, 'agents');
      await movePointerOffHeader(page);
      const wideIdle = await readToggleLook(agents);
      await expect(group).not.toHaveAttribute('data-pane-switcher');

      await page.setViewportSize({ width: 767, height: 800 });
      await expect(group).toHaveAttribute('data-pane-switcher', '');
      await expect(editor).toHaveAttribute('aria-pressed', 'true');
      await expect(agents).toHaveAttribute('aria-pressed', 'false');
      await movePointerOffHeader(page);
      const shown = await readToggleLook(editor);
      const idle = await readToggleLook(agents);
      await agents.hover();
      const hoveredIdle = await readToggleLook(agents);
      await editor.hover();
      const hoveredShown = await readToggleLook(editor);

      expect(
        contrastRatio(idle.background, wideIdle.background),
        'the track against the header',
      ).toBeGreaterThanOrEqual(1.03);
      expect(
        contrastRatio(shown.background, idle.background),
        'the shown pane against the track',
      ).toBeGreaterThanOrEqual(1.03);
      expect(shown.boxShadow, 'the shown pane is raised').not.toBe('none');
      expect(idle.boxShadow).toBe('none');
      expect(
        contrastRatio(hoveredIdle.background, idle.background),
        'a hovered pane against the track',
      ).toBeGreaterThanOrEqual(1.03);
      expect(hoveredIdle.background).not.toEqual(shown.background);
      const lightness = (color: readonly number[]) =>
        color.reduce((sum, channel) => sum + channel, 0);
      if (theme === 'light') {
        expect(lightness(hoveredIdle.background), 'a hovered pane darkens the track').toBeLessThan(
          lightness(idle.background),
        );
      } else {
        expect(
          lightness(hoveredIdle.background),
          'a hovered pane lightens the track',
        ).toBeGreaterThan(lightness(idle.background));
      }
      expect(hoveredShown.background, 'the shown pane stays raised under the pointer').toEqual(
        shown.background,
      );

      await page.setViewportSize({ width: 1600, height: 900 });
      await expect(group).not.toHaveAttribute('data-pane-switcher');
      await movePointerOffHeader(page);
      expect((await readToggleLook(agents)).background).toEqual(wideIdle.background);
    });
  }

  test('below 48rem forced colors and increased contrast outline only the shown pane on the track', async ({
    page,
    api,
  }) => {
    await openWeb(page, api, 'switcher-high-contrast');
    await page.setViewportSize({ width: 767, height: 800 });
    await expect(page.getByRole('group', { name: 'Panels', exact: true })).toHaveAttribute(
      'data-pane-switcher',
      '',
    );
    const editor = headerPaneButton(page, 'editor');
    const agents = headerPaneButton(page, 'agents');
    await expect(editor).toHaveAttribute('aria-pressed', 'true');

    for (const { media, query } of [
      { media: { forcedColors: 'active' }, query: '(forced-colors: active)' },
      { media: { contrast: 'more' }, query: '(prefers-contrast: more)' },
    ] as const) {
      await page.emulateMedia({ forcedColors: 'none', contrast: 'no-preference', ...media });
      expect(await page.evaluate((mediaQuery) => matchMedia(mediaQuery).matches, query)).toBe(true);
      await movePointerOffHeader(page);
      const shown = await readToggleLook(editor);
      expect(shown.outlineStyle, query).toBe('solid');
      expect(shown.outlineWidthPx, query).toBeGreaterThanOrEqual(1);
      expect(contrastRatio(shown.outlineColor, shown.background), query).toBeGreaterThanOrEqual(3);
      expect((await readToggleLook(agents)).outlineStyle, query).toBe('none');
    }
  });

  test('forced colors and increased contrast outline the on button and leave the off button bare', async ({
    page,
    api,
  }) => {
    await openWeb(page, api, 'high-contrast');
    const agents = headerPaneButton(page, 'agents');
    const readAfterClick = async (state: 'shown' | 'hidden') => {
      await clickPaneButton(page, 'agents', state);
      await movePointerOffHeader(page);
      return await readToggleLook(agents);
    };

    expect((await readAfterClick('shown')).outlineStyle).toBe('none');
    expect((await readAfterClick('hidden')).outlineStyle).toBe('none');

    for (const { media, query } of [
      { media: { forcedColors: 'active' }, query: '(forced-colors: active)' },
      { media: { contrast: 'more' }, query: '(prefers-contrast: more)' },
    ] as const) {
      await page.emulateMedia({ forcedColors: 'none', contrast: 'no-preference', ...media });
      expect(await page.evaluate((mediaQuery) => matchMedia(mediaQuery).matches, query)).toBe(true);
      const on = await readAfterClick('shown');
      expect(on.outlineStyle, query).toBe('solid');
      expect(on.outlineWidthPx, query).toBeGreaterThanOrEqual(1);
      expect(contrastRatio(on.outlineColor, on.background), query).toBeGreaterThanOrEqual(3);
      expect(on.boxShadow, query).toBe('none');
      const off = await readAfterClick('hidden');
      expect(off.outlineStyle, query).toBe('none');
    }
  });

  test('the pane divider stays a visible line against the header when the system forces colors', async ({
    page,
    api,
  }) => {
    await openWeb(page, api, 'divider-forced-colors');
    await movePointerOffHeader(page);

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ forcedColors: 'none', colorScheme });
      const normal = await readDividerPaint(page);
      expect(normal.width, colorScheme).toBe(1);
      const [fillRed, fillGreen, fillBlue, fillAlpha] = normal.fill;
      const expectedLine = [fillRed, fillGreen, fillBlue].map(
        (channel, index) => channel * fillAlpha + (normal.backdrop[index] ?? 0) * (1 - fillAlpha),
      );
      const lineDrift = Math.max(
        ...normal.line.map((channel, index) => Math.abs(channel - (expectedLine[index] ?? 0))),
      );
      expect(
        lineDrift,
        `${colorScheme}: line ${normal.line.join(',')} vs border token ${expectedLine.map(Math.round).join(',')}`,
      ).toBeLessThanOrEqual(2);

      await page.emulateMedia({ forcedColors: 'active', colorScheme });
      expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
      const forced = await readDividerPaint(page);
      expect(forced.width, colorScheme).toBeGreaterThan(0);
      expect(forced.height, colorScheme).toBeGreaterThan(0);
      const ratio = contrastRatio(forced.line, forced.backdrop);
      expect(
        ratio,
        `${colorScheme} forced colors: line ${forced.line.join(',')} on ${forced.backdrop.join(',')} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

interface SampledPane {
  readonly pressed: boolean;
  readonly onScreen: boolean;
}

type SampledFrame = Partial<Record<Pane, SampledPane>>;

interface FrameSamplerWindow {
  __paneFrameSampler?: { stop(): SampledFrame[] };
}

async function startFrameSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const unitOf = (pane: 'agents' | 'terminal') =>
      document.querySelector(`[data-dock-unit="${pane}"]`);
    const paneOnScreen = (pane: 'agents' | 'terminal') => {
      const unit = unitOf(pane);
      if (!(unit instanceof HTMLElement) || unit.hidden) return false;
      if (unit.hasAttribute('data-dock-unit-off')) return false;
      const { width, height } = unit.getBoundingClientRect();
      return width > 0 && height > 0;
    };
    const frames: Array<Partial<Record<'agents' | 'terminal', SampledPane>>> = [];
    let frame = -1;
    let running = true;
    const sample = () => {
      if (!running || frame < 0) return;
      const record: Partial<Record<'agents' | 'terminal', SampledPane>> = {};
      for (const pane of ['agents', 'terminal'] as const) {
        const button = document.querySelector(`[data-testid="header-pane-button-${pane}"]`);
        if (button === null) continue;
        record[pane] = {
          pressed: button.getAttribute('aria-pressed') === 'true',
          onScreen: paneOnScreen(pane),
        };
      }
      frames[frame] = record;
    };
    const observer = new MutationObserver(sample);
    const observed = new Set<Element>();
    const observeTargets = () => {
      for (const pane of ['agents', 'terminal'] as const) {
        const unit = unitOf(pane);
        if (unit === null || observed.has(unit)) continue;
        observed.add(unit);
        observer.observe(unit, {
          attributes: true,
          attributeFilter: ['hidden', 'data-dock-unit-off', 'style'],
        });
      }
    };
    const tick = () => {
      if (!running) return;
      frame += 1;
      observeTargets();
      sample();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    (window as FrameSamplerWindow).__paneFrameSampler = {
      stop: () => {
        running = false;
        observer.disconnect();
        return frames;
      },
    };
  });
  await settleFrames(page);
}

async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let remaining = 5;
        const next = () => {
          remaining -= 1;
          if (remaining === 0) resolve();
          else requestAnimationFrame(next);
        };
        requestAnimationFrame(next);
      }),
  );
}

async function expectEveryFrameMatches(page: Page, panes: readonly Pane[]): Promise<void> {
  await settleFrames(page);
  const frames = await page.evaluate(() => {
    const sampler = (window as FrameSamplerWindow).__paneFrameSampler;
    if (sampler === undefined) throw new Error('the frame sampler is not running');
    return sampler.stop();
  });
  expect(frames.length, 'frames sampled').toBeGreaterThan(10);
  for (const pane of panes) {
    const states = new Set(frames.map((frame) => frame[pane]?.pressed));
    expect([...states].sort(), `${pane} was sampled both on and off`).toEqual([false, true]);
  }
  const mismatches = frames.flatMap((frame, index) =>
    panes.flatMap((pane) => {
      const sampled = frame[pane];
      return sampled !== undefined && sampled.pressed !== sampled.onScreen
        ? [`frame ${index}: ${pane} pressed=${sampled.pressed} on screen=${sampled.onScreen}`]
        : [];
    }),
  );
  expect(mismatches, `mismatched frames out of ${frames.length}`).toEqual([]);
}

test.describe('the pane buttons match their panes in every frame', () => {
  test('chat: header show and hide, an agent auto-open, a header hide and a one-click bring-back', async ({
    page,
    api,
  }) => {
    await openWeb(page, api, 'frames-chat');
    await startFrameSampler(page);

    await clickPaneButton(page, 'agents', 'shown');
    const preferredWidth = await paneExtentPx(page, 'agents');
    await clickPaneButton(page, 'agents', 'hidden');
    await openThread(page, 'Frame sampler thread');
    await expectPane(page, 'agents', 'shown');
    await clickPaneButton(page, 'agents', 'hidden');
    await bringBackWithOneClick(page, 'agents', preferredWidth);

    await expectEveryFrameMatches(page, ['agents']);
  });

  for (const placement of ['bottom', 'right'] as const) {
    test(`${placement} terminal: header show and hide, a one-click bring-back and a header hide`, async ({
      page,
      api,
      workerServer,
    }) => {
      await presetTerminalPlacement(page, placement);
      await openDesktop(page, api, workerServer, `frames-${placement}`);
      await startFrameSampler(page);

      await clickPaneButton(page, 'terminal', 'shown');
      await waitForFocusInPane(page, 'terminal');
      const preferredExtent = await paneExtentPx(page, 'terminal');
      await clickPaneButton(page, 'terminal', 'hidden');
      await bringBackWithOneClick(page, 'terminal', preferredExtent);
      await clickPaneButton(page, 'terminal', 'hidden');

      await expectEveryFrameMatches(page, ['terminal']);
    });
  }

  test('a saved layout restored late shows both panes with their buttons in the same frames', async ({
    page,
    api,
    workerServer,
  }) => {
    const name = await seedDoc(api, 'frames-restore');
    await stubAgentCatalog(page);
    await page.setViewportSize({ width: 1600, height: 900 });
    let contentDir = workerServer.contentDir;
    try {
      contentDir = realpathSync(contentDir);
    } catch {}
    await installHandoffMocks(page, {
      host: 'electron',
      install: { claude: false, codex: false, cursor: false },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: contentDir,
      heldDockState: { terminalVisible: true, agentPanelVisible: true },
    });
    await page.goto(`/#/${name}`);
    await expect(headerPaneButton(page, 'terminal')).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
    await expect.poll(() => readDockStateRequests(page)).toBeGreaterThan(0);
    await expectPane(page, 'agents', 'hidden');
    await expectPane(page, 'terminal', 'hidden');
    await startFrameSampler(page);

    await releaseHeldDockState(page);
    await expectPane(page, 'terminal', 'shown');
    await expectPane(page, 'agents', 'shown');

    await expectEveryFrameMatches(page, ['agents', 'terminal']);
  });
});
