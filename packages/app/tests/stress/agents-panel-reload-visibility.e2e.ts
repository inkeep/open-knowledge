import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { HISTORY_PANEL_WIDTH_PX } from '../../src/hooks/use-history-presentation-mode';
import { expect, test } from './_helpers';

const AGENTS_PANEL_MOUNT = '[data-agents-panel-mount]';
const AGENTS_REVEAL_TAB = '[data-terminal-reveal="right"]';
const COLLAPSE_AGENT_PANEL_BUTTON = 'Collapse agent panel';
const SESSIONS_CHUNK_GLOB = '**/src/components/SessionsHost*';
const CONFIG_RESPONSE_GLOB = '**/api/config';
const AGENTS_ORDER_STORAGE_KEY = 'ok-agent-session-order-v1';
const SEED_AGENT_ID = 'panel-level-fixture-agent';
const BOOT_TIMEOUT_MS = 30_000;
const ROSTER_TIMEOUT_MS = 30_000;
const EMPTY_AGENT_CATALOG = { agents: [], stale: false, maxThreads: 8 };

interface ThreadFrame {
  op: string;
  reqId?: string;
  threads?: Array<{ threadId: string; archived?: boolean }>;
  info?: { threadId: string };
}

type SocketFrameSender = (frame: Record<string, unknown>) => void;

interface FrameRecorder {
  readonly frames: ThreadFrame[];
  unparseableCount: number;
}

type RouteMarkRoute = 'config-response' | 'roster-frame' | 'sessions-chunk-response';

interface RouteMark {
  route: RouteMarkRoute;
  at: number;
}

function relativeLuminance(channels: readonly number[]): number {
  const [red, green, blue] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

async function readComputedColor(
  locator: Locator,
  property: 'color' | 'backgroundColor',
): Promise<readonly [number, number, number, number]> {
  return locator.evaluate((element, colorProperty) => {
    const color = getComputedStyle(element)[colorProperty];
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not create a color conversion context');
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data) as [number, number, number, number];
  }, property);
}

async function readEffectiveBackground(
  locator: Locator,
): Promise<readonly [number, number, number, number]> {
  return locator.evaluate((element) => {
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not create a color conversion context');
    const layers: Array<[number, number, number, number]> = [];
    let current: Element | null = element;
    while (current !== null) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = getComputedStyle(current).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      const layer = Array.from(context.getImageData(0, 0, 1, 1).data) as [
        number,
        number,
        number,
        number,
      ];
      layers.push(layer);
      if (layer[3] === 255) break;
      current = current.parentElement;
    }
    const base = layers.at(-1);
    if (base === undefined || base[3] !== 255) {
      throw new Error('Contrast background has no opaque ancestor');
    }
    const composite = [...base] as [number, number, number, number];
    for (let index = layers.length - 2; index >= 0; index -= 1) {
      const layer = layers[index];
      if (layer === undefined) continue;
      const alpha = layer[3] / 255;
      for (let channel = 0; channel < 3; channel += 1) {
        composite[channel] = layer[channel] * alpha + composite[channel] * (1 - alpha);
      }
    }
    return composite;
  });
}

async function expectContrast(
  foreground: Locator,
  background: Locator,
  minimum: number,
): Promise<void> {
  const foregroundColor = await readComputedColor(foreground, 'color');
  const backgroundColor = await readEffectiveBackground(background);
  const foregroundAlpha = foregroundColor[3] / 255;
  const composite = foregroundColor
    .slice(0, 3)
    .map(
      (channel, index) =>
        channel * foregroundAlpha + backgroundColor[index] * (1 - foregroundAlpha),
    );
  const foregroundLuminance = relativeLuminance(composite);
  const backgroundLuminance = relativeLuminance(backgroundColor.slice(0, 3));
  const ratio =
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
  expect(ratio).toBeGreaterThanOrEqual(minimum);
}

function observedOrder(marks: RouteMark[]): RouteMarkRoute[] {
  const seen = new Set<RouteMarkRoute>();
  const order: RouteMarkRoute[] = [];
  for (const mark of marks) {
    if (seen.has(mark.route)) continue;
    seen.add(mark.route);
    order.push(mark.route);
  }
  return order;
}

async function waitForRouteMark(
  marks: RouteMark[],
  route: RouteMarkRoute,
  timeoutMessage: string,
): Promise<void> {
  const deadline = Date.now() + ROSTER_TIMEOUT_MS;
  while (!marks.some((mark) => mark.route === route)) {
    if (Date.now() >= deadline) throw new Error(timeoutMessage);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function withThreadSocket<T>(
  port: number,
  run: (send: SocketFrameSender, frames: ThreadFrame[], recorder: FrameRecorder) => Promise<T>,
): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/collab/thread`);
  const recorder: FrameRecorder = { frames: [], unparseableCount: 0 };
  ws.addEventListener('message', (ev) => {
    try {
      recorder.frames.push(JSON.parse(String(ev.data)) as ThreadFrame);
    } catch {
      recorder.unparseableCount += 1;
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('thread socket open timeout')), 15_000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('thread socket failed to open'));
    });
  });
  try {
    return await run((frame) => ws.send(JSON.stringify(frame)), recorder.frames, recorder);
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

async function latestRoster(
  send: SocketFrameSender,
  frames: ThreadFrame[],
  recorder: FrameRecorder,
  timeoutMs = 10_000,
): Promise<Array<{ threadId: string; archived?: boolean }>> {
  send({ op: 'list' });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = frames.filter((frame) => frame.op === 'threads').at(-1);
    if (snapshot?.threads) return snapshot.threads;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `thread roster never arrived (${recorder.unparseableCount} unparseable frame(s) observed)`,
  );
}

async function purgeLiveThreads(port: number): Promise<void> {
  const live = (await withThreadSocket(port, latestRoster)).filter(
    (thread) => thread.archived !== true,
  );
  for (const thread of live) {
    await withThreadSocket(port, async (send, frames, recorder) => {
      send({ op: 'close', threadId: thread.threadId });
      const closeDeadline = Date.now() + 20_000;
      let archived = false;
      let discarded = false;
      while (Date.now() < closeDeadline) {
        const errored = recorder.frames.find((frame) => frame.op === 'error');
        if (errored) {
          throw new Error(
            `purge close rejected for ${thread.threadId}: ${JSON.stringify(errored)}`,
          );
        }
        const snapshot = frames.filter((frame) => frame.op === 'threads').at(-1);
        const entry = snapshot?.threads?.find((t) => t.threadId === thread.threadId);
        if (entry === undefined) {
          discarded = true;
          break;
        }
        if (entry.archived === true) {
          archived = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!archived && !discarded) {
        throw new Error(
          `purge close confirmation never arrived for ${thread.threadId} (${recorder.unparseableCount} unparseable frame(s) observed)`,
        );
      }
      if (discarded) return;
      send({ op: 'delete', threadId: thread.threadId });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const errored = recorder.frames.find((frame) => frame.op === 'error');
        if (errored) {
          throw new Error(
            `purge delete rejected for ${thread.threadId}: ${JSON.stringify(errored)}`,
          );
        }
        const snapshot = frames.filter((frame) => frame.op === 'threads').at(-1);
        if (snapshot?.threads && !snapshot.threads.some((t) => t.threadId === thread.threadId)) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `purge delete confirmation never arrived for ${thread.threadId} (${recorder.unparseableCount} unparseable frame(s) observed)`,
      );
    });
  }
  const remaining = (await withThreadSocket(port, latestRoster)).filter(
    (thread) => thread.archived !== true,
  );
  if (remaining.length > 0) {
    throw new Error(
      `live threads survived the roster purge: ${remaining.map((t) => t.threadId).join(', ')}`,
    );
  }
}

async function seedLiveThread(port: number, contentDir: string): Promise<void> {
  const agentsFile = join(contentDir, '.ok', 'local', 'acp-agents.json');
  mkdirSync(dirname(agentsFile), { recursive: true });
  writeFileSync(
    agentsFile,
    `${JSON.stringify(
      [{ id: SEED_AGENT_ID, name: 'Panel Level Fixture', command: '/bin/false' }],
      null,
      2,
    )}\n`,
  );

  await withThreadSocket(port, async (send, frames) => {
    send({ op: 'create', reqId: 'e2e-seed-1', agent: { source: 'custom', id: SEED_AGENT_ID } });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const created = frames.find(
        (frame) => frame.op === 'created' && frame.reqId === 'e2e-seed-1',
      );
      if (created?.info) return;
      const errored = frames.find((frame) => frame.op === 'error');
      if (errored) throw new Error(`seed create failed: ${JSON.stringify(errored)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('seed create never returned a created frame');
  });
}

async function stubAgentCatalog(page: Page): Promise<void> {
  await page.route('**/api/acp/catalog', (route) => route.fulfill({ json: EMPTY_AGENT_CATALOG }));
}

function nextRosterDelivery(page: Page, marks?: RouteMark[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('thread socket never delivered its roster')),
      ROSTER_TIMEOUT_MS,
    );
    page.on('websocket', (socket) => {
      if (!socket.url().includes('/collab/thread')) return;
      socket.on('framereceived', (frame) => {
        if (typeof frame.payload !== 'string') return;
        if (!frame.payload.includes('"op":"threads"')) return;
        marks?.push({ route: 'roster-frame', at: Date.now() });
        clearTimeout(timer);
        resolve();
      });
    });
  });
}

function settleAfterRoster(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
}

async function openAppWithRoster(page: Page): Promise<void> {
  const roster = nextRosterDelivery(page);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__acpThreadHarness), null, {
    timeout: BOOT_TIMEOUT_MS,
  });
  await roster;
  await settleAfterRoster(page);
}

async function openAgentsPanel(page: Page): Promise<void> {
  const mount = page.locator(AGENTS_PANEL_MOUNT);
  const revealTab = page.locator(AGENTS_REVEAL_TAB);
  await expect
    .poll(async () => (await mount.isVisible()) || (await revealTab.isVisible()), {
      timeout: BOOT_TIMEOUT_MS,
    })
    .toBe(true);
  const revealed = await revealTab.isVisible();
  if (revealed) {
    await revealTab.click({ timeout: 5_000 }).catch(() => {});
  }
  await expect(mount).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  if (revealed) {
    await expect
      .poll(
        () =>
          page.evaluate(() => document.activeElement?.closest('[data-agents-panel-mount]') != null),
        { timeout: 10_000 },
      )
      .toBe(true);
  }
  await settleAfterRoster(page);
}

async function resizeAgentsPanel(page: Page, targetWidth: number): Promise<void> {
  const mount = page.locator(AGENTS_PANEL_MOUNT);
  const panel = mount.locator('xpath=ancestor::*[@data-slot="resizable-panel"][1]');
  const handle = panel.locator('xpath=preceding-sibling::*[1]');
  await expect(handle).toHaveAttribute('data-slot', 'resizable-handle');
  await handle.focus();
  const currentWidth = await mount.evaluate((element) => element.getBoundingClientRect().width);
  const grows = currentWidth < targetWidth;
  for (let index = 0; index < 20; index += 1) {
    const width = await mount.evaluate((element) => element.getBoundingClientRect().width);
    if (grows ? width >= targetWidth : width <= targetWidth) break;
    await page.keyboard.press(grows ? 'ArrowLeft' : 'ArrowRight');
    await settleAfterRoster(page);
  }
  const observedWidth = await mount.evaluate((element) => element.getBoundingClientRect().width);
  if (grows) expect(observedWidth).toBeGreaterThanOrEqual(targetWidth);
  else expect(observedWidth).toBeLessThanOrEqual(targetWidth);
}

async function waitForAgentsHostSettled(page: Page): Promise<void> {
  await expect(page.locator(`${AGENTS_PANEL_MOUNT} [role="tablist"]`)).toHaveCount(1, {
    timeout: BOOT_TIMEOUT_MS,
  });
}

async function settleAgentsHostAfterReload(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(window.__acpThreadHarness), null, {
    timeout: BOOT_TIMEOUT_MS,
  });
  await waitForAgentsHostSettled(page);
}

async function collapseAgentsPanel(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: COLLAPSE_AGENT_PANEL_BUTTON })
    .click({ timeout: BOOT_TIMEOUT_MS });
  await expect(page.locator(AGENTS_REVEAL_TAB)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await settleAfterRoster(page);
}

async function expectPersistedPanelLevel(page: Page, level: boolean): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate((key) => {
          const raw = window.localStorage.getItem(key);
          if (raw === null) return null;
          const record = JSON.parse(raw) as Record<string, unknown>;
          return typeof record.agentPanelVisible === 'boolean' ? record.agentPanelVisible : null;
        }, AGENTS_ORDER_STORAGE_KEY),
      { timeout: BOOT_TIMEOUT_MS },
    )
    .toBe(level);
}

async function reloadAndSettle(page: Page, marks?: RouteMark[]): Promise<void> {
  const roster = nextRosterDelivery(page, marks);
  await page.reload();
  await roster;
  await settleAfterRoster(page);
}

test.setTimeout(180_000);

test.describe('chat history navigation', () => {
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => window.__acpThreadHarness?.reset());
  });

  test('chat history unifies live navigation with the selected tab', async ({ page }) => {
    await stubAgentCatalog(page);
    await openAppWithRoster(page);
    const threadIds = await page.evaluate(() => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      return [
        harness.openThread({
          agent: { id: 'history-a', name: 'First Agent', source: 'registry' },
          title: 'Alpha planning conversation',
        }),
        harness.openThread({
          agent: { id: 'history-b', name: 'Second Agent', source: 'registry' },
          title: 'Beta implementation conversation',
          status: 'running',
        }),
      ];
    });

    await openAgentsPanel(page);
    const panel = page.locator(AGENTS_PANEL_MOUNT);
    const tabs = panel.getByRole('tab');
    await expect(tabs).toHaveCount(2);
    const initialTitles = await tabs.allTextContents();

    await panel.getByRole('button', { name: 'Chat history' }).click();
    const alphaRow = page.locator(`[data-testid="agent-thread-history-open-${threadIds[0]}"]`);
    const betaRow = page.locator(`[data-testid="agent-thread-history-open-${threadIds[1]}"]`);
    await expect(alphaRow).not.toContainText('First Agent');
    await expect(betaRow).not.toContainText('Running');
    await expect(betaRow).toHaveAttribute('aria-current', 'true');
    const alphaListItem = alphaRow.locator('xpath=..');
    await expectContrast(alphaRow.locator('span').last(), alphaListItem, 4.5);
    await expectContrast(betaRow.locator('span').last(), betaRow.locator('xpath=..'), 4.5);
    const accessibility = await new AxeBuilder({ page })
      .include('[data-testid="agent-thread-history-panel"]')
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await alphaRow.hover();
    await expectContrast(alphaRow, alphaListItem, 4.5);
    const alphaRename = page.getByTestId(`agent-thread-history-rename-${threadIds[0]}`);
    await expectContrast(alphaRename, alphaListItem, 4.5);
    await alphaRename.hover();
    await expectContrast(alphaRename, alphaListItem, 4.5);
    await expectContrast(betaRow, betaRow.locator('xpath=..'), 4.5);
    await page.evaluate(() => {
      document.documentElement.dataset.colorTheme = 'solarized';
      document.documentElement.style.colorScheme = 'light';
    });
    await alphaRow.hover();
    await expectContrast(alphaRow, alphaListItem, 4.5);
    await expectContrast(alphaRename, alphaListItem, 4.5);
    await alphaRename.hover();
    await expectContrast(alphaRename, alphaListItem, 4.5);
    await expectContrast(betaRow, betaRow.locator('xpath=..'), 4.5);
    const solarizedAccessibility = await new AxeBuilder({ page })
      .include('[data-testid="agent-thread-history-panel"]')
      .analyze();
    expect(solarizedAccessibility.violations).toEqual([]);

    await alphaRow.click();
    await expect(panel.getByRole('tab', { name: /Alpha planning conversation/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(tabs).toHaveText(initialTitles);

    if ((await page.getByTestId('agent-thread-history-panel').count()) === 0) {
      await panel.getByRole('button', { name: 'Chat history' }).click();
    }
    await expect(alphaRow).toHaveAttribute('aria-current', 'true');
  });

  test('empty chat history fills and centers within the panel body', async ({ page }) => {
    await stubAgentCatalog(page);
    await openAppWithRoster(page);
    await page.evaluate(() => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      harness.openThread({
        agent: { id: 'empty-history', name: 'Empty History', source: 'registry' },
      });
    });
    await openAgentsPanel(page);
    await page.evaluate(() => window.__acpThreadHarness?.reset());
    const panel = page.locator(AGENTS_PANEL_MOUNT);
    await expect(panel.getByRole('tab')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Chat history' }).click();

    const history = page.getByTestId('agent-thread-history-panel');
    const content = history.locator('[data-sidebar="content"]');
    const status = history.getByRole('status');
    const heading = status.getByRole('heading', { name: 'No chats yet.' });
    const [contentBox, statusBox, headingBox] = await Promise.all([
      content.boundingBox(),
      status.boundingBox(),
      heading.boundingBox(),
    ]);
    expect(contentBox).not.toBeNull();
    expect(statusBox).not.toBeNull();
    expect(headingBox).not.toBeNull();
    if (contentBox === null || statusBox === null || headingBox === null) return;
    expect(Math.abs(statusBox.y - contentBox.y)).toBeLessThanOrEqual(2);
    expect(Math.abs(statusBox.height - contentBox.height)).toBeLessThanOrEqual(4);
    const contentCenter = contentBox.y + contentBox.height / 2;
    const headingCenter = headingBox.y + headingBox.height / 2;
    expect(Math.abs(headingCenter - contentCenter)).toBeLessThanOrEqual(2);
  });

  test('chat history searches titles and groups conversations by local date', async ({ page }) => {
    await stubAgentCatalog(page);
    await openAppWithRoster(page);
    await page.evaluate(() => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      const now = Date.now();
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(23, 59, 0, 0);
      harness.openThread({
        threadId: 'history-live-architecture',
        agent: { id: 'history-live', name: 'Live Agent', source: 'registry' },
        title: 'Architecture planning',
        status: 'running',
      });
      harness.openThread({
        threadId: 'history-archived-architecture',
        agent: { id: 'history-archive', name: 'Archive Agent', source: 'registry' },
        title: 'Past ARCHITECTURE review',
        status: 'exited',
      });
      harness.openThread({
        threadId: 'history-release',
        agent: { id: 'history-release', name: 'Release Agent', source: 'registry' },
        title: 'Release checklist',
        status: 'ready',
      });
      harness.frame({
        op: 'threads',
        threads: [
          {
            threadId: 'history-live-architecture',
            agent: { id: 'history-live', name: 'Live Agent', source: 'registry' },
            title: 'Architecture planning',
            status: 'running',
            createdAt: now - 2_000,
            lastActivityAt: now - 1_000,
            modes: null,
            configOptions: null,
            lastSeq: -1,
            archived: false,
          },
          {
            threadId: 'history-archived-architecture',
            agent: { id: 'history-archive', name: 'Archive Agent', source: 'registry' },
            title: 'Past ARCHITECTURE review',
            status: 'exited',
            createdAt: yesterday.getTime(),
            lastActivityAt: yesterday.getTime(),
            modes: null,
            configOptions: null,
            lastSeq: -1,
            archived: true,
          },
          {
            threadId: 'history-release',
            agent: { id: 'history-release', name: 'Release Agent', source: 'registry' },
            title: 'Release checklist',
            status: 'ready',
            createdAt: now - 4_000,
            lastActivityAt: now - 3_000,
            modes: null,
            configOptions: null,
            lastSeq: -1,
            archived: false,
          },
        ],
      });
    });

    await openAgentsPanel(page);
    const panel = page.locator(AGENTS_PANEL_MOUNT);
    await expect(panel.getByRole('tab')).toHaveCount(2);
    await panel.getByRole('button', { name: 'Chat history' }).click();
    await expect(page.getByRole('list', { name: 'Today' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Older' })).toBeVisible();

    await page.getByRole('searchbox', { name: 'Search chat history' }).fill('  aRcHi  ');

    await expect(
      page.getByTestId('agent-thread-history-open-history-live-architecture'),
    ).toBeVisible();
    await expect(
      page.getByTestId('agent-thread-history-open-history-archived-architecture'),
    ).toBeVisible();
    await expect(page.getByTestId('agent-thread-history-open-history-release')).toHaveCount(0);
    const archivedRow = page.getByTestId('agent-thread-history-open-history-archived-architecture');
    const archivedListItem = archivedRow.locator('xpath=..');
    await expectContrast(archivedRow.locator('span').last(), archivedListItem, 4.5);
    await archivedRow.hover();
    const archivedRename = page.getByTestId(
      'agent-thread-history-rename-history-archived-architecture',
    );
    await expectContrast(archivedRename, archivedListItem, 4.5);
    await archivedRename.hover();
    await expectContrast(archivedRename, archivedListItem, 4.5);
    const archivedDelete = page.getByTestId(
      'agent-thread-history-delete-history-archived-architecture',
    );
    await expect(archivedDelete).not.toHaveAttribute('aria-disabled');
    await archivedDelete.hover();
    await expectContrast(archivedDelete, archivedListItem, 3);
    await page.evaluate(() => {
      document.documentElement.dataset.colorTheme = 'solarized';
    });
    await archivedRow.hover();
    await expectContrast(archivedRename, archivedListItem, 4.5);
    await archivedDelete.hover();
    await expectContrast(archivedDelete, archivedListItem, 3);
    const accessibility = await new AxeBuilder({ page })
      .include('[data-testid="agent-thread-history-panel"]')
      .analyze();
    expect(accessibility.violations).toEqual([]);
  });

  test('chat history renders in dark, pseudo-locale, RTL, and reduced-motion modes', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.addInitScript(() => window.localStorage.setItem('ok-theme-v1', 'dark'));
    await stubAgentCatalog(page);

    const roster = nextRosterDelivery(page);
    await page.goto('/?lang=pseudo');
    await page.waitForFunction(() => Boolean(window.__acpThreadHarness), null, {
      timeout: BOOT_TIMEOUT_MS,
    });
    await roster;
    await settleAfterRoster(page);
    await page.evaluate(() => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      const threadId = harness.openThread({
        threadId: 'history-render-matrix',
        agent: { id: 'pseudo-dark', name: 'Pseudo Agent', source: 'registry' },
        title: 'A deliberately long archived conversation title for the RTL action overlay',
        status: 'exited',
      });
      const now = Date.now();
      harness.frame({
        op: 'threads',
        threads: [
          {
            threadId,
            agent: { id: 'pseudo-dark', name: 'Pseudo Agent', source: 'registry' },
            title: 'A deliberately long archived conversation title for the RTL action overlay',
            status: 'exited',
            createdAt: now,
            lastActivityAt: now,
            modes: null,
            configOptions: null,
            lastSeq: -1,
            archived: true,
          },
        ],
      });
    });
    const mount = page.locator(AGENTS_PANEL_MOUNT);
    if (await page.locator(AGENTS_REVEAL_TAB).isVisible()) {
      await page.locator(AGENTS_REVEAL_TAB).click();
    }
    await expect(mount).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
    await mount.getByTestId('agent-thread-history').click();
    const historyPanel = page.getByTestId('agent-thread-history-panel');
    await expect(historyPanel).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/dark/);
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
      true,
    );
    const pseudoPlaceholder = await historyPanel
      .locator('input[name="chat-history-search"]')
      .getAttribute('placeholder');
    expect(pseudoPlaceholder).not.toBe('Search chats');
    await page.evaluate(() => {
      document.documentElement.dir = 'rtl';
    });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const row = page.getByTestId('agent-thread-history-open-history-render-matrix');
    const listItem = row.locator('xpath=..');
    const timestamp = row.locator('span').last();
    await expectContrast(timestamp, listItem, 4.5);
    await listItem.hover({ position: { x: 8, y: 18 } });
    await expectContrast(row, listItem, 4.5);
    await expect(timestamp).toHaveCSS('transition-duration', '0s');
    const rename = page.getByTestId('agent-thread-history-rename-history-render-matrix');
    await listItem.hover();
    expect(await rename.evaluate((element) => element.matches(':hover'))).toBe(false);
    await expectContrast(rename, listItem, 4.5);
    await rename.hover();
    await expectContrast(rename, listItem, 4.5);
    const deleteButton = page.getByTestId('agent-thread-history-delete-history-render-matrix');
    await deleteButton.hover();
    await expectContrast(deleteButton, listItem, 3);
    const listItemBounds = await listItem.boundingBox();
    if (listItemBounds === null) {
      throw new Error('Expected the RTL history row to have layout bounds');
    }
    const renameBounds = await rename.boundingBox();
    if (renameBounds === null) {
      throw new Error('Expected the RTL history rename action to have layout bounds');
    }
    expect(renameBounds.x - listItemBounds.x).toBeLessThan(52);
    const panelAccessibility = await new AxeBuilder({ page })
      .include('[data-testid="agent-thread-history-panel"]')
      .analyze();
    expect(panelAccessibility.violations).toEqual([]);
    await deleteButton.click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    const dialogAccessibility = await new AxeBuilder({ page })
      .include('[role="alertdialog"]')
      .analyze();
    expect(dialogAccessibility.violations).toEqual([]);
  });

  test('shrinking a docked history view closes history before the active chat', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await stubAgentCatalog(page);
    await openAppWithRoster(page);
    await page.evaluate(() => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      harness.openThread({
        threadId: 'history-responsive-alpha',
        agent: { id: 'responsive-alpha', name: 'First Agent', source: 'registry' },
        title: 'Alpha planning conversation with a deliberately long translated-width title',
      });
      harness.openThread({
        threadId: 'history-responsive-beta',
        agent: { id: 'responsive-beta', name: 'Second Agent', source: 'registry' },
        title: 'Beta implementation conversation',
      });
    });
    await openAgentsPanel(page);
    await resizeAgentsPanel(page, 700);

    const mount = page.locator(AGENTS_PANEL_MOUNT);
    await mount.getByRole('button', { name: 'Chat history' }).click();
    const history = page.getByTestId('agent-thread-history-panel');
    await expect(history).toHaveAttribute('data-history-mode', 'docked');
    const historySurfaceBounds = await page
      .getByTestId('agent-thread-history-surface')
      .boundingBox();
    expect(historySurfaceBounds?.width).toBeCloseTo(HISTORY_PANEL_WIDTH_PX, 1);
    await history.getByRole('searchbox', { name: 'Search chat history' }).fill('Alpha');
    await page.getByTestId('agent-thread-history-open-history-responsive-alpha').click();
    await expect(history).toBeVisible();
    await expect(
      mount.getByRole('tab', {
        name: /Alpha planning conversation with a deliberately long translated-width title/,
      }),
    ).toHaveAttribute('aria-selected', 'true');

    await resizeAgentsPanel(page, 500);

    await expect(history).toHaveCount(0);
    await expect(mount.getByTestId('agent-panel-session-surface')).not.toHaveAttribute('inert');
    await expect(
      mount.getByRole('tab', {
        name: /Alpha planning conversation with a deliberately long translated-width title/,
      }),
    ).toHaveAttribute('aria-selected', 'true');
  });

  test('dragging a covered agent pane closed leaves the reveal control available', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await stubAgentCatalog(page);
    await openAppWithRoster(page);
    await page.evaluate(() => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      harness.openThread({
        threadId: 'history-drag-close',
        agent: { id: 'drag-close', name: 'First Agent', source: 'registry' },
        title: 'Drag close conversation',
      });
    });
    await openAgentsPanel(page);
    await resizeAgentsPanel(page, 500);

    const mount = page.locator(AGENTS_PANEL_MOUNT);
    await mount.getByRole('button', { name: 'Chat history' }).click();
    await expect(page.getByTestId('agent-thread-history-panel')).toHaveAttribute(
      'data-history-mode',
      'cover',
    );
    const history = page.getByTestId('agent-thread-history-panel');
    const historyBounds = await history.boundingBox();
    const mountBounds = await mount.boundingBox();
    expect(historyBounds).not.toBeNull();
    expect(mountBounds).not.toBeNull();
    expect(Math.abs((historyBounds?.x ?? 0) - (mountBounds?.x ?? 0))).toBeLessThanOrEqual(2);
    expect(Math.abs((historyBounds?.y ?? 0) - (mountBounds?.y ?? 0))).toBeLessThanOrEqual(2);
    expect(Math.abs((historyBounds?.width ?? 0) - (mountBounds?.width ?? 0))).toBeLessThanOrEqual(
      2,
    );
    expect(Math.abs((historyBounds?.height ?? 0) - (mountBounds?.height ?? 0))).toBeLessThanOrEqual(
      2,
    );

    await history.getByRole('searchbox', { name: 'Search chat history' }).focus();
    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(
          () =>
            document.activeElement?.closest('[data-testid="agent-panel-session-surface"]') != null,
        ),
      ).toBe(false);
    }

    await history.getByRole('button', { name: 'Back' }).click();
    await expect(history).toHaveCount(0);
    await expect(mount.getByRole('button', { name: 'Chat history' })).toBeFocused();
    await mount.getByRole('button', { name: 'Chat history' }).click();
    await expect(history).toHaveAttribute('data-history-mode', 'cover');

    const panel = mount.locator('xpath=ancestor::*[@data-slot="resizable-panel"][1]');
    const handle = panel.locator('xpath=preceding-sibling::*[1]');
    const handleBounds = await handle.boundingBox();
    expect(handleBounds).not.toBeNull();
    const handleX = (handleBounds?.x ?? 0) + (handleBounds?.width ?? 0) / 2;
    const handleY = (handleBounds?.y ?? 0) + (handleBounds?.height ?? 0) / 2;
    await page.mouse.move(handleX, handleY);
    await page.mouse.down();
    await page.mouse.move(1598, handleY, { steps: 10 });
    await page.mouse.up();

    await expect(page.locator('[data-dragging="true"]')).toHaveCount(0);
    const reveal = page.locator(AGENTS_REVEAL_TAB);
    await expect(reveal).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
    await reveal.click();
    await expect(page.locator(AGENTS_PANEL_MOUNT)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
    await expect(page.getByTestId('agent-thread-history-panel')).toBeVisible();
  });
});

test.describe('agents panel reload visibility level', () => {
  test.afterEach(async ({ workerServer }) => {
    await purgeLiveThreads(workerServer.port);
  });

  test('a panel closed before a roster-delayed reload stays closed after it (level written by real open and collapse clicks and asserted in localStorage before reload; storage-coercion edge cases are pinned by the co-located DOM suites)', async ({
    page,
    workerServer,
  }) => {
    await purgeLiveThreads(workerServer.port);
    await seedLiveThread(workerServer.port, workerServer.contentDir);
    await stubAgentCatalog(page);
    await openAppWithRoster(page);

    await openAgentsPanel(page);
    await expectPersistedPanelLevel(page, true);
    await collapseAgentsPanel(page);
    await expectPersistedPanelLevel(page, false);

    const marks: RouteMark[] = [];
    await page.route(SESSIONS_CHUNK_GLOB, async (route) => {
      await route.continue();
      marks.push({ route: 'sessions-chunk-response', at: Date.now() });
    });
    await page.route(CONFIG_RESPONSE_GLOB, async (route) => {
      await waitForRouteMark(
        marks,
        'sessions-chunk-response',
        'sessions chunk never preceded the config response',
      );
      await route.continue();
      marks.push({ route: 'config-response', at: Date.now() });
    });

    await reloadAndSettle(page, marks);

    await expect
      .poll(() => observedOrder(marks), { timeout: BOOT_TIMEOUT_MS })
      .toEqual(['sessions-chunk-response', 'config-response', 'roster-frame']);

    await settleAgentsHostAfterReload(page);

    await expect(page.locator(AGENTS_REVEAL_TAB)).toBeVisible();
    await expect(page.locator(AGENTS_PANEL_MOUNT)).not.toBeVisible();
  });

  test('a panel closed before a roster-first reload stays closed and a later thread still reveals (level written by real open and collapse clicks and asserted in localStorage before reload; storage-coercion edge cases are pinned by the co-located DOM suites)', async ({
    page,
    workerServer,
  }) => {
    await purgeLiveThreads(workerServer.port);
    await seedLiveThread(workerServer.port, workerServer.contentDir);
    await stubAgentCatalog(page);
    await openAppWithRoster(page);

    await openAgentsPanel(page);
    await expectPersistedPanelLevel(page, true);
    await collapseAgentsPanel(page);
    await expectPersistedPanelLevel(page, false);

    const marks: RouteMark[] = [];
    await page.route(SESSIONS_CHUNK_GLOB, async (route) => {
      await waitForRouteMark(
        marks,
        'roster-frame',
        'roster frame never preceded the sessions chunk',
      );
      await route.continue();
      marks.push({ route: 'sessions-chunk-response', at: Date.now() });
    });

    await reloadAndSettle(page, marks);

    await expect
      .poll(() => observedOrder(marks), { timeout: BOOT_TIMEOUT_MS })
      .toEqual(['roster-frame', 'sessions-chunk-response']);

    await settleAgentsHostAfterReload(page);

    await expect(page.locator(AGENTS_REVEAL_TAB)).toBeVisible();
    await expect(page.locator(AGENTS_PANEL_MOUNT)).not.toBeVisible();

    await page.evaluate(() => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      harness.openThread({
        agent: { id: 'late-arrival-agent', name: 'Late Arrival', source: 'registry' },
        title: 'Late arrival thread',
      });
    });

    await expect(page.locator(AGENTS_PANEL_MOUNT)).toBeVisible({ timeout: ROSTER_TIMEOUT_MS });
  });

  test('a panel open before a natural reload stays open after it (level written by a real open click and asserted in localStorage before reload; storage-coercion edge cases are pinned by the co-located DOM suites)', async ({
    page,
    workerServer,
  }) => {
    await purgeLiveThreads(workerServer.port);
    await seedLiveThread(workerServer.port, workerServer.contentDir);
    await stubAgentCatalog(page);
    await openAppWithRoster(page);

    await openAgentsPanel(page);
    await expectPersistedPanelLevel(page, true);

    await reloadAndSettle(page);

    await expect(page.locator(AGENTS_PANEL_MOUNT)).toBeVisible();
    await expect(page.locator(AGENTS_REVEAL_TAB)).not.toBeVisible();
  });

  test('a panel open before a roster-first reload stays open after it (level written by a real open click and asserted in localStorage before reload; storage-coercion edge cases are pinned by the co-located DOM suites)', async ({
    page,
    workerServer,
  }) => {
    await purgeLiveThreads(workerServer.port);
    await seedLiveThread(workerServer.port, workerServer.contentDir);
    await stubAgentCatalog(page);
    await openAppWithRoster(page);

    await openAgentsPanel(page);
    await expectPersistedPanelLevel(page, true);

    const marks: RouteMark[] = [];
    await page.route(SESSIONS_CHUNK_GLOB, async (route) => {
      await waitForRouteMark(
        marks,
        'roster-frame',
        'roster frame never preceded the sessions chunk',
      );
      await route.continue();
      marks.push({ route: 'sessions-chunk-response', at: Date.now() });
    });

    await reloadAndSettle(page, marks);

    await expect
      .poll(() => observedOrder(marks), { timeout: BOOT_TIMEOUT_MS })
      .toEqual(['roster-frame', 'sessions-chunk-response']);

    await settleAgentsHostAfterReload(page);

    await expect(page.locator(AGENTS_PANEL_MOUNT)).toBeVisible();
    await expect(page.locator(AGENTS_REVEAL_TAB)).not.toBeVisible();
  });
});
